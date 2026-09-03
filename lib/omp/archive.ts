import { randomBytes } from "crypto";
import { createGunzip, gunzipSync } from "zlib";
import { currentHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import type { SessionHeader } from "../types";
import { getArchivedSessionsDir, getSessionsDir } from "./paths";
import { invalidateSessionFileListCache, readSessionHeader, scanSessionInfoFromSlices, type SessionStatus } from "./session-files";

/**
 * OMP's gc archive (`<agent>/archive/sessions/<project>/<file>.jsonl.gz`) on
 * a host. Listing reads a bounded decompressed prefix of every archive: the
 * local host inflates a bounded compressed window with zlib, a remote host
 * runs ONE shell script that decompresses every archive on the machine and
 * streams back only the first ARCHIVE_PREFIX_BYTES of each. Restoring
 * decompresses in place on the host — the transcript never crosses the wire.
 */

export interface ArchivedSessionRecord {
  key: string;
  id: string;
  cwd: string;
  title?: string;
  created: Date;
  archivedAt: Date;
  messageCount: number;
  firstMessage: string;
  size: number;
  status?: SessionStatus;
}

const ARCHIVE_PREFIX_BYTES = 128 * 1024;
const MAX_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024;
// gzip never expands its input beyond a few bytes per 32 KiB block, so a
// compressed window this much larger than the wanted prefix always inflates
// to at least the prefix (when the file is that long).
const GZIP_PREFIX_SLACK_BYTES = 8 * 1024;
// Archives live two levels below the root (<project>/<file>.jsonl.gz); a few
// extra levels keep hand-organized archives visible without walking a home dir.
const ARCHIVE_WALK_DEPTH = 6;
const ARCHIVE_BATCH = 128;
// Slot-aware header window (matches readSessionHeader's bound).
const RESTORE_HEADER_BYTES = 64 * 1024 + 256;

function normalizeArchiveKey(key: string, pathApi: Host["pathApi"]): string {
  if (!key || key.includes("\\") || key.startsWith("/") || pathApi.isAbsolute(key)) throw new Error("Invalid archive key");
  const normalized = pathApi.posix.normalize(key.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..") || !normalized.endsWith(".jsonl.gz")) {
    throw new Error("Invalid archive key");
  }
  return normalized;
}

/** Inflate up to `limit` bytes from a (possibly truncated) gzip buffer. A
 * truncated input ends in "unexpected end of file"; the bytes decoded before
 * that are exactly the prefix we want, so errors resolve instead of reject. */
function gunzipPrefix(compressed: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      resolve(Buffer.concat(chunks, length));
    };
    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      const part = chunk.subarray(0, Math.min(chunk.length, limit - length));
      chunks.push(part);
      length += part.length;
      if (length >= limit) finish();
    });
    gunzip.on("error", finish);
    gunzip.on("end", finish);
    gunzip.end(compressed);
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ");
}

interface ArchiveFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

function parseArchivePrefix(prefix: Buffer, file: ArchiveFileInfo, archiveRoot: string, pathApi: Host["pathApi"]): ArchivedSessionRecord | undefined {
  const lines = prefix.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return undefined;
  let title: string | undefined;
  let headerIndex = 0;
  try {
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    if (first.type === "title" && typeof first.title === "string") {
      title = first.title || undefined;
      headerIndex = 1;
    }
    const header = JSON.parse(lines[headerIndex]) as SessionHeader;
    if (header.type !== "session" || typeof header.id !== "string") return undefined;
    let messageCount = 0;
    let firstMessage = "";
    for (const line of lines.slice(headerIndex + 1)) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "message" || !entry.message) continue;
        messageCount++;
        if (!firstMessage && entry.message.role === "user") firstMessage = textFromContent(entry.message.content);
      } catch {
        // The final prefix line may be truncated; earlier metadata remains valid.
      }
    }
    const archivedAt = new Date(file.mtimeMs);
    const created = header.timestamp && !Number.isNaN(new Date(header.timestamp).getTime()) ? new Date(header.timestamp) : archivedAt;
    return {
      key: pathApi.relative(archiveRoot, file.path).split(pathApi.sep).join("/"),
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      title: title ?? (typeof header.title === "string" ? header.title : undefined),
      created,
      archivedAt,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      size: file.size,
      status: "unknown",
    };
  } catch {
    return undefined;
  }
}

/**
 * Batch script output format (see remoteArchivePrefixes): one frame per
 * archive, `F <path>\n` + up to N decompressed bytes + `\n<sentinel>\n`.
 * Archives that failed to decompress yield an empty body and are skipped by
 * the header parser; a frame cut short by a killed script is dropped.
 */
export function parseArchivePrefixBatch(stdout: Buffer, sentinel: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const terminator = Buffer.from(`\n${sentinel}\n`, "utf8");
  let offset = 0;
  while (offset < stdout.length) {
    const end = stdout.indexOf(terminator, offset);
    if (end === -1) break;
    const frame = stdout.subarray(offset, end);
    offset = end + terminator.length;
    const headerEnd = frame.indexOf(0x0a);
    const headerLine = (headerEnd === -1 ? frame : frame.subarray(0, headerEnd)).toString("utf8");
    if (!headerLine.startsWith("F ")) continue;
    const filePath = headerLine.slice(2);
    if (!filePath) continue;
    result.set(filePath, headerEnd === -1 ? Buffer.alloc(0) : frame.subarray(headerEnd + 1));
  }
  return result;
}

/** Decompressed prefixes of many archives in ONE round trip on the host.
 * Paths travel on stdin (one per line); `head -c` bounds each body and
 * `gzip -dc` is stopped by the resulting SIGPIPE. Works with GNU and BSD
 * userlands. */
async function remoteArchivePrefixes(host: Host, paths: string[], limit: number): Promise<Map<string, Buffer>> {
  if (paths.length === 0) return new Map();
  const sentinel = `--omp-web-archive-${randomBytes(12).toString("hex")}--`;
  const script = [
    `S='${sentinel}'`,
    `N=${limit}`,
    "while IFS= read -r f; do",
    '  printf "F %s\\n" "$f"',
    '  gzip -dc -- "$f" 2>/dev/null | head -c "$N"',
    '  printf "\\n%s\\n" "$S"',
    "done",
  ].join("\n");
  const { stdout } = await host.executor.exec(["sh", "-c", script], {
    input: `${paths.join("\n")}\n`,
    maxBuffer: paths.length * (limit + 4096) + 64 * 1024,
    timeoutMs: 5 * 60_000,
  });
  return parseArchivePrefixBatch(stdout, sentinel);
}

async function localArchivePrefix(host: Host, filePath: string, limit: number): Promise<Buffer> {
  const compressed = await host.fs.readFile(filePath, { maxBytes: limit + GZIP_PREFIX_SLACK_BYTES });
  return gunzipPrefix(compressed, limit);
}

export async function listArchivedSessions(archiveRoot = getArchivedSessionsDir(), host: Host = currentHost()): Promise<ArchivedSessionRecord[]> {
  const pathApi = host.pathApi;
  const root = pathApi.resolve(archiveRoot);
  const files = (await host.fs.walkFiles(root, { minDepth: 1, maxDepth: ARCHIVE_WALK_DEPTH, suffix: ".jsonl.gz" }))
    .filter((file) => file.size <= MAX_ARCHIVE_COMPRESSED_BYTES);
  const records: Array<ArchivedSessionRecord | undefined> = [];
  if (host.isLocal) {
    for (const file of files) {
      try {
        records.push(parseArchivePrefix(await localArchivePrefix(host, file.path, ARCHIVE_PREFIX_BYTES), file, root, pathApi));
      } catch {
        records.push(undefined);
      }
    }
  } else {
    for (let i = 0; i < files.length; i += ARCHIVE_BATCH) {
      const batch = files.slice(i, i + ARCHIVE_BATCH);
      const prefixes = await remoteArchivePrefixes(host, batch.map((file) => file.path), ARCHIVE_PREFIX_BYTES);
      for (const file of batch) {
        const prefix = prefixes.get(file.path);
        records.push(prefix ? parseArchivePrefix(prefix, file, root, pathApi) : undefined);
      }
    }
  }
  return records
    .filter((record): record is ArchivedSessionRecord => Boolean(record))
    .sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
}

interface RestorePlan {
  source: string;
  destination: string;
  sourceArtifacts: string;
  destinationArtifacts: string;
}

function planRestore(key: string, sessionsRoot: string, archiveRoot: string, pathApi: Host["pathApi"]): RestorePlan {
  const activeRoot = pathApi.resolve(sessionsRoot);
  const archiveBase = pathApi.resolve(archiveRoot);
  const relative = normalizeArchiveKey(key, pathApi);
  const source = pathApi.resolve(archiveBase, relative);
  const destination = pathApi.resolve(activeRoot, relative.slice(0, -3));
  if (!source.startsWith(`${archiveBase}${pathApi.sep}`) || !destination.startsWith(`${activeRoot}${pathApi.sep}`)) throw new Error("Invalid archive key");
  return {
    source,
    destination,
    // OMP keeps the `.jsonl` suffix on the archived artifacts directory.
    sourceArtifacts: source.slice(0, -3),
    destinationArtifacts: destination.slice(0, -6),
  };
}

// Decompress next to the destination, rename into place, move the artifacts
// dir, then print the restored header window for validation. The archive is
// kept until the caller has validated the header (see restoreRemote).
const REMOTE_RESTORE_SCRIPT = [
  'src="$1"; dst="$2"; srcart="$3"; dstart="$4"; hb="$5"',
  '[ -f "$src" ] || { echo "Archived session not found" >&2; exit 2; }',
  'if [ -e "$dst" ] || [ -e "$dstart" ]; then echo "Active session destination already exists" >&2; exit 3; fi',
  'if [ -e "$srcart" ] && [ ! -d "$srcart" ]; then echo "Archived artifacts are invalid" >&2; exit 4; fi',
  'mkdir -p -- "$(dirname -- "$dst")" || exit 1',
  'tmp="$dst.$$.tmp"',
  'if ! gzip -dc -- "$src" > "$tmp"; then rm -f -- "$tmp"; echo "Archived session is invalid" >&2; exit 5; fi',
  'mv -f -- "$tmp" "$dst" || { rm -f -- "$tmp"; exit 1; }',
  'if [ -d "$srcart" ]; then mkdir -p -- "$(dirname -- "$dstart")" && mv -- "$srcart" "$dstart" || { rm -f -- "$dst"; exit 1; }; fi',
  'exec head -c "$hb" -- "$dst"',
].join("\n");

const REMOTE_ROLLBACK_SCRIPT = [
  'dst="$1"; srcart="$2"; dstart="$3"',
  '[ -d "$dstart" ] && mv -- "$dstart" "$srcart"',
  'rm -f -- "$dst"',
  "exit 0",
].join("\n");

async function restoreRemote(host: Host, plan: RestorePlan): Promise<string> {
  const { stdout } = await host.executor.exec(
    ["sh", "-c", REMOTE_RESTORE_SCRIPT, "sh", plan.source, plan.destination, plan.sourceArtifacts, plan.destinationArtifacts, String(RESTORE_HEADER_BYTES)],
    { timeoutMs: 10 * 60_000, maxBuffer: RESTORE_HEADER_BYTES + 4096 },
  );
  const info = scanSessionInfoFromSlices(plan.destination, { size: stdout.length, mtimeMs: 0, prefix: stdout, suffix: Buffer.alloc(0) }, false);
  if (!info?.id) {
    await host.executor.exec(["sh", "-c", REMOTE_ROLLBACK_SCRIPT, "sh", plan.destination, plan.sourceArtifacts, plan.destinationArtifacts], { allowFailure: true }).catch(() => {});
    throw new Error("Archived session is invalid");
  }
  await host.fs.rm(plan.source, { force: true });
  return info.id;
}

async function restoreLocal(host: Host, plan: RestorePlan): Promise<string> {
  const pathApi = host.pathApi;
  const { source, destination, sourceArtifacts, destinationArtifacts } = plan;
  let sourceStat: Awaited<ReturnType<Host["fs"]["lstat"]>>;
  try {
    sourceStat = await host.fs.lstat(source);
  } catch {
    throw new Error("Archived session not found");
  }
  if (!sourceStat.isFile()) throw new Error("Archived session not found");
  if (await host.fs.exists(destination) || await host.fs.exists(destinationArtifacts)) throw new Error("Active session destination already exists");

  const restored = gunzipSync(await host.fs.readFile(source));
  let destinationCreated = false;
  let artifactsMoved = false;
  try {
    await host.fs.mkdir(pathApi.dirname(destination), { recursive: true });
    // host.fs.writeFile is temp-file + rename: a crash never leaves a torn session.
    await host.fs.writeFile(destination, restored);
    destinationCreated = true;
    if (await host.fs.exists(sourceArtifacts)) {
      if (!(await host.fs.lstat(sourceArtifacts)).isDirectory()) throw new Error("Archived artifacts are invalid");
      await host.fs.mkdir(pathApi.dirname(destinationArtifacts), { recursive: true });
      await host.fs.rename(sourceArtifacts, destinationArtifacts);
      artifactsMoved = true;
    }
    const header = await readSessionHeader(destination, host);
    if (!header?.id) throw new Error("Archived session is invalid");
    await host.fs.rm(source, { force: true });
    return header.id;
  } catch (error) {
    if (artifactsMoved) {
      try { await host.fs.rename(destinationArtifacts, sourceArtifacts); } catch { /* preserve original failure */ }
    }
    if (destinationCreated) {
      try { await host.fs.rm(destination, { force: true }); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}

/** Move an archive back into the active sessions tree on its host and return
 * the restored session's id. */
export async function restoreArchivedSession(
  key: string,
  sessionsRoot = getSessionsDir(),
  archiveRoot = getArchivedSessionsDir(),
  host: Host = currentHost(),
): Promise<string> {
  const plan = planRestore(key, sessionsRoot, archiveRoot, host.pathApi);
  const id = host.isLocal ? await restoreLocal(host, plan) : await restoreRemote(host, plan);
  invalidateSessionFileListCache();
  return id;
}
