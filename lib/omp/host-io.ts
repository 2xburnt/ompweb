import { randomBytes } from "crypto";
import { HostFsError, type ExecOptions, type ExecResult } from "../hosts/executor";
import type { Host } from "../hosts/registry";

/**
 * Small host-filesystem helpers shared by the omp config/skills/agents
 * services. Everything here goes through the host boundary (host.fs /
 * host.executor): nothing is mirrored to local disk, every read is bounded,
 * and multi-file operations on a remote host are batched into a single POSIX
 * `sh` round trip whose output is framed (random sentinel / NUL) so file
 * names containing spaces or other odd characters are parsed correctly.
 */

export class FileTooLargeError extends Error {
  readonly path: string;
  readonly maxBytes: number;
  constructor(filePath: string, maxBytes: number) {
    super(`${filePath} exceeds ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
    this.path = filePath;
    this.maxBytes = maxBytes;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof HostFsError) return error.code;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** ENOENT/ENOTDIR from either the local Node fs or a remote HostFsError. */
export function isMissingFileError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

/** Run a POSIX shell script on the host with positional arguments. */
export function runHostScript(host: Host, script: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return host.executor.exec(["sh", "-c", script, "sh", ...args], { timeoutMs: 60_000, ...options });
}

/** Read a UTF-8 text file from the host. Missing files read as null; files
 * larger than `maxBytes` raise FileTooLargeError instead of being truncated. */
export async function readTextFile(host: Host, filePath: string, maxBytes: number): Promise<string | null> {
  let data: Buffer;
  try {
    data = await host.fs.readFile(filePath, { maxBytes: maxBytes + 1 });
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (data.length > maxBytes) throw new FileTooLargeError(filePath, maxBytes);
  return data.toString("utf8");
}

/** Which of `paths` exist on the host (symlinks count, like `[ -e ] || [ -L ]`).
 * One round trip on a remote host. */
export async function existingPaths(host: Host, paths: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(paths)];
  const found = new Set<string>();
  if (unique.length === 0) return found;
  if (host.isLocal) {
    await Promise.all(unique.map(async (filePath) => {
      if (await host.fs.exists(filePath)) found.add(filePath);
    }));
    return found;
  }
  // Paths arrive one per line on stdin; hits come back NUL-separated.
  const script = 'while IFS= read -r f; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done';
  const { stdout } = await runHostScript(host, script, [], { input: `${unique.join("\n")}\n` });
  for (const record of stdout.toString("utf8").split("\0")) {
    if (record) found.add(record);
  }
  return found;
}

/** Create a uniquely named directory under `parent` on the host. */
export async function makeHostTempDir(host: Host, parent: string, prefix: string): Promise<string> {
  const dir = host.pathApi.join(parent, `${prefix}${randomBytes(6).toString("hex")}`);
  await host.fs.mkdir(dir);
  return dir;
}

export interface ScannedTextFile {
  /** The scan root the file was found under. */
  root: string;
  path: string;
  content: string;
  /** True when the file was larger than `maxBytes` (content is cut off). */
  truncated: boolean;
}

export interface TextFileScan {
  files: ScannedTextFile[];
  /** Roots that are themselves symbolic links (only reported for "markdown-files"). */
  symlinkRoots: string[];
  /** Roots that exist but could not be listed (permissions, not a directory). */
  unreadableRoots: string[];
  /** Files that exist but could not be read. */
  unreadableFiles: string[];
}

/**
 * "markdown-files": regular, non-hidden `*.md` files directly under each root
 *   (a root that is a symlink is skipped and reported, matching omp's agent
 *   loader).
 * "skill-dirs": `<root>/<entry>/SKILL.md` for every non-hidden directory (or
 *   directory symlink) under each root, matching omp's skill providers.
 */
export type TextFileScanMode = "markdown-files" | "skill-dirs";

const MAX_SCAN_OUTPUT_BYTES = 64 * 1024 * 1024;

async function scanTextFilesLocally(host: Host, roots: readonly string[], mode: TextFileScanMode, maxBytes: number): Promise<TextFileScan> {
  const result: TextFileScan = { files: [], symlinkRoots: [], unreadableRoots: [], unreadableFiles: [] };
  const pathApi = host.pathApi;
  for (const root of roots) {
    if (mode === "markdown-files") {
      try {
        if ((await host.fs.lstat(root)).isSymbolicLink()) {
          result.symlinkRoots.push(root);
          continue;
        }
      } catch (error) {
        if (!isMissingFileError(error)) result.unreadableRoots.push(root);
        continue;
      }
    }
    let entries;
    try {
      entries = await host.fs.readdir(root);
    } catch (error) {
      if (!isMissingFileError(error)) result.unreadableRoots.push(root);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      let filePath: string;
      if (mode === "markdown-files") {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        filePath = pathApi.join(root, entry.name);
      } else {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        filePath = pathApi.join(root, entry.name, "SKILL.md");
      }
      let data: Buffer;
      try {
        data = await host.fs.readFile(filePath, { maxBytes: maxBytes + 1 });
      } catch (error) {
        if (!isMissingFileError(error)) result.unreadableFiles.push(filePath);
        continue;
      }
      result.files.push({ root, path: filePath, content: data.subarray(0, maxBytes).toString("utf8"), truncated: data.length > maxBytes });
    }
  }
  return result;
}

function rootOf(filePath: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (filePath.startsWith(root.endsWith("/") ? root : `${root}/`) && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

async function scanTextFilesRemotely(host: Host, roots: readonly string[], mode: TextFileScanMode, maxBytes: number): Promise<TextFileScan> {
  const result: TextFileScan = { files: [], symlinkRoots: [], unreadableRoots: [], unreadableFiles: [] };
  const sentinel = `--omp-web-${randomBytes(12).toString("hex")}--`;
  // One frame per file: "H <path>\n" + up to MAX bytes + sentinel. Roots that
  // are symlinks ("L") or unreadable ("E") are reported as header-only lines.
  // The inner `sh -c` sees S/MAX through the environment (exported below).
  const emitMarkdown = 'for f; do printf "H %s\\n" "$f"; head -c "$MAX" -- "$f" 2>/dev/null; printf "%s" "$S"; done';
  const emitSkill = 'for d; do f="$d/SKILL.md"; [ -f "$f" ] || continue; printf "H %s\\n" "$f"; head -c "$MAX" -- "$f" 2>/dev/null; printf "%s" "$S"; done';
  const script = [
    'S="$1"; MAX="$2"; MODE="$3"; shift 3',
    "export S MAX",
    'for root in "$@"; do',
    '  if [ "$MODE" = md ] && [ -L "$root" ]; then printf "L %s\\n" "$root"; continue; fi',
    '  [ -e "$root" ] || continue',
    '  if ! [ -d "$root" ] || ! [ -r "$root" ]; then printf "E %s\\n" "$root"; continue; fi',
    '  if [ "$MODE" = md ]; then',
    `    find "$root" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -iname '*.md' -exec sh -c '${emitMarkdown}' sh {} + 2>/dev/null`,
    "  else",
    `    find -L "$root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c '${emitSkill}' sh {} + 2>/dev/null`,
    "  fi",
    "done",
    "exit 0",
  ].join("\n");
  const { stdout } = await runHostScript(
    host,
    script,
    [sentinel, String(maxBytes + 1), mode === "markdown-files" ? "md" : "skill", ...roots],
    { maxBuffer: MAX_SCAN_OUTPUT_BYTES, timeoutMs: 5 * 60_000 },
  );
  const sentinelBuffer = Buffer.from(sentinel, "utf8");
  let offset = 0;
  while (offset < stdout.length) {
    const lineEnd = stdout.indexOf(0x0a, offset);
    if (lineEnd === -1) break;
    const header = stdout.subarray(offset, lineEnd).toString("utf8");
    offset = lineEnd + 1;
    if (header.startsWith("L ")) {
      result.symlinkRoots.push(header.slice(2));
      continue;
    }
    if (header.startsWith("E ")) {
      result.unreadableRoots.push(header.slice(2));
      continue;
    }
    if (!header.startsWith("H ")) break;
    const filePath = header.slice(2);
    const bodyEnd = stdout.indexOf(sentinelBuffer, offset);
    if (bodyEnd === -1) break;
    const body = stdout.subarray(offset, bodyEnd);
    offset = bodyEnd + sentinelBuffer.length;
    const root = rootOf(filePath, roots);
    if (!root) continue;
    result.files.push({ root, path: filePath, content: body.subarray(0, maxBytes).toString("utf8"), truncated: body.length > maxBytes });
  }
  return result;
}

/** Read every matching text file under `roots` (see TextFileScanMode). Local
 * hosts use plain fs calls; remote hosts do it in one round trip. */
export function scanTextFiles(host: Host, roots: readonly string[], mode: TextFileScanMode, maxBytes: number): Promise<TextFileScan> {
  const unique = [...new Set(roots)];
  if (unique.length === 0) return Promise.resolve({ files: [], symlinkRoots: [], unreadableRoots: [], unreadableFiles: [] });
  return host.isLocal ? scanTextFilesLocally(host, unique, mode, maxBytes) : scanTextFilesRemotely(host, unique, mode, maxBytes);
}
