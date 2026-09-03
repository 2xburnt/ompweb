import { NextRequest, NextResponse } from "next/server";
import type { ChildProcessWithoutNullStreams } from "child_process";
// Local-only: fs.watch keeps the inotify/FSEvents-based watcher for the local
// machine; remote hosts are polled through the host fs (see pollRemoteFile).
import { watch as fsWatch, type FSWatcher } from "fs";
import { apiErrorResponse } from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "@/lib/file-access";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
  getStreamSecurityHeaders,
} from "@/lib/file-types";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  validateUploadFileNames,
} from "@/lib/file-upload";
import { parseFormDataWithinLimit, parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { currentHost } from "@/lib/hosts/context";
import type { FileStat } from "@/lib/hosts/executor";
import type { Host } from "@/lib/hosts/registry";
import { withHostRoute } from "@/lib/hosts/route";
import { hostPath } from "@/lib/omp/paths";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview", "watch"] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;
const MAX_UPLOAD_CHECK_REQUEST_BYTES = 1024 * 1024;
/** Remote `watch`: stat poll interval and the bound after which the stream
 * closes (EventSource reconnects, so a long-open viewer keeps working). */
const REMOTE_WATCH_POLL_MS = 2_000;
const REMOTE_WATCH_MAX_MS = 10 * 60_000;

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = hostPath().basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

async function getUploadDirectory(segments: string[], host: Host): Promise<
  { directory: string } | { response: NextResponse }
> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots(host);
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }

  let stat: FileStat;
  try {
    stat = await host.fs.stat(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found", code: "upload_directory_not_found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Upload target is not a directory", code: "upload_target_not_directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides on the host
  // before writes so a symlink inside an allowed root cannot redirect uploads
  // outside it.
  let realDirectory: string;
  try {
    realDirectory = await host.fs.realpath(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found", code: "upload_directory_not_found" }, { status: 404 }) };
  }
  if (!(await isExistingFilePathAllowed(realDirectory, allowedRoots, host))) {
    return { response: NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

// POST /api/files/<dir>?type=upload-check|upload[&conflict=error|overwrite|skip][&host=<id>]
export const POST = withHostRoute(async (
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) => {
  try {
    const host = currentHost();
    const { path: segments } = await params;
    const uploadDirectory = await getUploadDirectory(segments, host);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    const type = request.nextUrl.searchParams.get("type") ?? "upload";

    if (type === "upload-check") {
      let body: { fileNames?: unknown } | null;
      try {
        body = await parseJsonWithinLimit<{ fileNames?: unknown }>(request, MAX_UPLOAD_CHECK_REQUEST_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Upload check request is too large", code: "upload_check_too_large" }, { status: 413 });
        body = null;
      }
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings", code: "invalid_file_names" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames, host);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(await inspectUploadTargets(directory, fileNames, host));
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type", code: "invalid_upload_type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy", code: "invalid_conflict_strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Uploads must total 100MB or less", code: "upload_total_too_large" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller", code: "upload_file_too_large" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less", code: "upload_total_too_large" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames, host);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // One pass over every target (a single round trip on a remote host).
    const inspection = await inspectUploadTargets(directory, fileNames, host);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        code: "upload_conflict",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    const recordError = (file: File, error: unknown) => {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    };

    for (const file of files) {
      const destination = host.pathApi.join(directory, file.name);
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        recordError(file, error);
        continue;
      }

      try {
        // host.fs.writeFile is temp-file + rename on every executor: an
        // overwrite never leaves a half-written file behind, and a new file
        // appears all at once (no separate unlink step needed).
        await host.fs.writeFile(destination, bytes);
        uploaded.push(file.name);
      } catch (error) {
        recordError(file, error);
      }
    }

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a single-range `Range` header against a known size; null = 416. */
function resolveByteRange(rangeHeader: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Terminate a streaming child. Local POSIX children run in their own process
 * group (LocalExecutor.spawn detaches them), so the whole pipeline goes. */
function killChild(host: Host, child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.pid === undefined) return;
  try {
    if (host.isLocal && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Stream a file (or a byte range of it) from the host without ever holding
 * it in memory: `cat` for the full body, `tail | head` for a range so the
 * skipped prefix never crosses the wire. The local Windows machine has no
 * `sh`, so it uses `cat` and drops the prefix in-stream (local disk only).
 * Backpressure: the child's stdout is paused while the response queue is full.
 */
function createHostFileStream(host: Host, filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let skip = 0;
  let remaining = range ? range.end - range.start + 1 : Number.POSITIVE_INFINITY;
  const canUseShell = !(host.isLocal && process.platform === "win32");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (error?: Error) => {
        if (closed) return;
        closed = true;
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      };
      try {
        if (range && canUseShell) {
          child = host.executor.spawn([
            "sh", "-c", 'tail -c +"$2" -- "$1" | head -c "$3"',
            "sh", filePath, String(range.start + 1), String(remaining),
          ]);
        } else {
          if (range) skip = range.start;
          child = host.executor.spawn(["cat", "--", filePath]);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const proc = child;
      proc.stdin.on("error", () => { /* not used */ });
      proc.stdin.end();
      proc.stderr.on("data", () => { /* drained; exit code carries the failure */ });
      proc.stdout.on("data", (chunk: Buffer) => {
        if (closed) return;
        let data = chunk;
        if (skip > 0) {
          if (data.length <= skip) {
            skip -= data.length;
            return;
          }
          data = data.subarray(skip);
          skip = 0;
        }
        if (data.length > remaining) data = data.subarray(0, remaining);
        remaining -= data.length;
        if (data.length > 0) {
          try {
            controller.enqueue(new Uint8Array(data));
          } catch {
            closed = true;
            killChild(host, proc);
            return;
          }
        }
        if (remaining <= 0) {
          finish();
          killChild(host, proc);
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) proc.stdout.pause();
      });
      proc.once("error", (error) => finish(error));
      proc.once("close", (code) => {
        if (closed) return;
        if (code === 0 || remaining <= 0) finish();
        else finish(new Error(`file stream for ${filePath} exited with ${code ?? "signal"}`));
      });
    },
    pull() {
      child?.stdout.resume();
    },
    cancel() {
      closed = true;
      killChild(host, child);
    },
  });
}

function fileHeaders(filePath: string, contentType: string, asDownload: boolean): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(hostPath().basename(filePath), !asDownload, "download"),
    // Shared by the full-body, 206, and 416 paths.
    ...getStreamSecurityHeaders(contentType),
  };
}

/** Range-aware response whose body is produced lazily for the chosen range. */
function serveRanged(
  filePath: string,
  size: number,
  contentType: string,
  rangeHeader: string | null,
  asDownload: boolean,
  body: (range?: ByteRange) => BodyInit,
): Response {
  const headers = fileHeaders(filePath, contentType, asDownload);
  if (!rangeHeader) {
    return new Response(body(), { headers: { ...headers, "Content-Length": String(size) } });
  }
  const range = resolveByteRange(rangeHeader, size);
  if (!range) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  const chunkSize = range.end - range.start + 1;
  return new Response(body(range), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}

/** Large/unbounded content (audio, PDF, downloads): streamed from the host. */
function streamFile(host: Host, filePath: string, stat: FileStat, contentType: string, rangeHeader: string | null, asDownload = false): Response {
  return serveRanged(filePath, stat.size, contentType, rangeHeader, asDownload, (range) => createHostFileStream(host, filePath, range));
}

/** Bounded content already read through the host fs (images). */
function serveBuffer(filePath: string, bytes: Buffer, contentType: string, rangeHeader: string | null): Response {
  return serveRanged(filePath, bytes.length, contentType, rangeHeader, false, (range) =>
    new Uint8Array(range ? bytes.subarray(range.start, range.end + 1) : bytes));
}

type SseSend = (eventName: string, data: Record<string, unknown>) => void;

function sseResponse(start: (send: SseSend, close: () => void) => void, cancel: () => void): Response {
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send: SseSend = (eventName, data) => {
        if (closed) return;
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(payload));
        } catch {
          closed = true; // client disconnected
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
      };
      start(send, close);
    },
    cancel,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Local host: native fs.watch, with the change de-duplicated by mtime/size. */
function watchLocalFile(host: Host, filePath: string, initial: FileStat): Response {
  let watcher: FSWatcher | null = null;
  let lastMtimeMs = initial.mtimeMs;
  let lastSize = initial.size;
  return sseResponse((send, close) => {
    // Send initial ping so client knows connection is live
    send("connected", { filePath, host: host.id, mode: "watch" });
    try {
      watcher = fsWatch(filePath, () => {
        host.fs.stat(filePath).then((s) => {
          // Some platforms emit watch events for file reads/attribute
          // access. Ignore those or the client's refresh read loops.
          if (s.mtimeMs === lastMtimeMs && s.size === lastSize) return;
          lastMtimeMs = s.mtimeMs;
          lastSize = s.size;
          send("change", { mtime: new Date(s.mtimeMs).toISOString(), size: s.size });
        }, () => {
          send("change", { mtime: new Date().toISOString(), size: 0 });
        });
      });
      watcher.on("error", () => close());
    } catch {
      send("error", { message: "Failed to watch file" });
      close();
    }
  }, () => {
    try { watcher?.close(); } catch { /* ignore */ }
  });
}

/** Remote host: no inotify across ssh, so the file is polled with one stat
 * round trip per interval and the same SSE events are emitted. Remote mtimes
 * are whole seconds; a same-second rewrite of identical size is not
 * detected. The stream closes after REMOTE_WATCH_MAX_MS (EventSource
 * reconnects), which bounds idle polling of abandoned viewers. */
function pollRemoteFile(host: Host, filePath: string, initial: FileStat): Response {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastMtimeMs = initial.mtimeMs;
  let lastSize = initial.size;
  let missing = false;
  const startedAt = Date.now();
  return sseResponse((send, close) => {
    send("connected", { filePath, host: host.id, mode: "poll", intervalMs: REMOTE_WATCH_POLL_MS });
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt >= REMOTE_WATCH_MAX_MS) {
        stopped = true;
        close();
        return;
      }
      try {
        const s = await host.fs.stat(filePath);
        missing = false;
        if (s.mtimeMs !== lastMtimeMs || s.size !== lastSize) {
          lastMtimeMs = s.mtimeMs;
          lastSize = s.size;
          send("change", { mtime: new Date(s.mtimeMs).toISOString(), size: s.size });
        }
      } catch {
        if (!missing) {
          missing = true;
          send("change", { mtime: new Date().toISOString(), size: 0 });
        }
      }
      if (!stopped) timer = setTimeout(tick, REMOTE_WATCH_POLL_MS);
    };
    timer = setTimeout(tick, REMOTE_WATCH_POLL_MS);
  }, () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

// GET /api/files/<path>?type=list|read|download|meta|preview|watch[&sessionId=][&host=<id>]
export const GET = withHostRoute(async (
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) => {
  try {
    const host = currentHost();
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const rawType = request.nextUrl.searchParams.get("type") ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return NextResponse.json({ error: "Invalid file request type", code: "invalid_request_type" }, { status: 400 });
    }
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots(host);
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
    const allowedBySessionReference =
      !allowedByRoot &&
      type !== "list" &&
      await isFilePathReferencedBySession(filePath, sessionId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let stat: FileStat;
    try {
      stat = await host.fs.stat(filePath);
    } catch {
      return NextResponse.json({ error: "Not found", code: "file_not_found" }, { status: 404 });
    }

    if (!allowedBySessionReference && !(await isExistingFilePathAllowed(filePath, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    if (type === "read") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Image too large (>10MB)", code: "image_too_large" }, { status: 413 });
        }
        const bytes = await host.fs.readFile(filePath, { maxBytes: IMAGE_PREVIEW_MAX_BYTES });
        return serveBuffer(filePath, bytes, imageMime, request.headers.get("range"));
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        return streamFile(host, filePath, stat, audioMime, request.headers.get("range"));
      }
      const documentMime = getDocumentMime(filePath);
      if (documentMime) {
        return streamFile(host, filePath, stat, documentMime, request.headers.get("range"));
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "File too large for preview (>256KB)", code: "file_too_large_preview" }, { status: 413 });
      }
      const content = (await host.fs.readFile(filePath, { maxBytes: TEXT_PREVIEW_MAX_BYTES })).toString("utf-8");
      const language = getLanguage(filePath);
      return NextResponse.json({ content, language, size: stat.size });
    }

    if (type === "download") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
      return streamFile(host, filePath, stat, mime, request.headers.get("range"), true);
    }

    if (type === "meta") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return NextResponse.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type", code: "preview_unavailable" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)", code: "docx_too_large" }, { status: 413 });
      }

      const bytes = await host.fs.readFile(filePath, { maxBytes: DOCX_PREVIEW_MAX_BYTES });
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { buffer: bytes },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, hostPath().basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file", code: "not_a_file" }, { status: 400 });
      }
      return host.isLocal ? watchLocalFile(host, filePath, stat) : pollRemoteFile(host, filePath, stat);
    }

    // type === "list"
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }

    // One readdir round trip: host entries carry their type (and the target
    // type of symlinks), so no per-entry stat is needed.
    const dirents = await host.fs.readdir(filePath);
    const entries = dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d);
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: isDir ? 0 : d.size, modified: d.mtimeMs ? new Date(d.mtimeMs).toISOString() : "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: filePath, host: host.id });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
