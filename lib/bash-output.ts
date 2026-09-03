/**
 * Secure reader for omp's bash-output temp files. When a bash execution's
 * output is too large for the session, omp writes the full output to
 * `$TMPDIR/pi-bash-<id>.log` on the machine it runs on and records
 * `fullOutputPath` on the bashExecution entry; this module serves that file
 * from the session's host with the same constraints as the upstream pi-web
 * implementation:
 *   - the path must resolve directly inside the host's temp directory,
 *   - the basename must match the `pi-bash-*.log` pattern,
 *   - symlinks are rejected (O_NOFOLLOW + re-stat locally; an lstat-guarded
 *     `cat` on a remote host),
 *   - inline reads are capped; callers stream oversized files instead.
 *
 * Nothing is copied to local disk: a remote file is read through the host's
 * executor in one bounded round trip.
 */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { hostPath } from "./omp/paths";

export const MAX_INLINE_BASH_OUTPUT_BYTES = 5 * 1024 * 1024;

/** Validate a recorded `fullOutputPath` against the host's temp root. Paths
 * are interpreted with the current host's path rules (POSIX on remote hosts). */
export function resolveBashOutputPath(filePath: string, tempRoot: string): string | null {
  const pathApi = hostPath();
  const resolvedPath = pathApi.resolve(filePath);
  if (pathApi.dirname(resolvedPath) !== pathApi.resolve(tempRoot)) return null;
  if (!/^pi-bash-[A-Za-z0-9_-]+\.log$/.test(pathApi.basename(resolvedPath))) return null;
  return resolvedPath;
}

/** Local-host open that refuses to follow symlinks (the remote equivalent is
 * the lstat guard inside the shell scripts below). */
export async function openRegularFileNoFollow(filePath: string) {
  const pathInfo = await lstat(filePath);
  if (!pathInfo.isFile()) throw new Error("Bash output path is not a regular file");

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) throw new Error("Bash output path is not a regular file");
    // On platforms without O_NOFOLLOW (Windows defines none) a symlink swapped
    // between the lstat above and this open would pass the file-type checks.
    // Verify the opened inode is the same one we validated; when the
    // filesystem reports no identity at all (FAT/exFAT give dev=ino=0) the
    // check is meaningless, so fail closed rather than serve an unverifiable
    // file.
    if (
      noFollow === 0
      && (pathInfo.dev === 0 && pathInfo.ino === 0
        || pathInfo.dev !== fileInfo.dev
        || pathInfo.ino !== fileInfo.ino)
    ) {
      throw new Error("Bash output path could not be safely verified");
    }
    return { handle, fileInfo };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// One round trip: refuse symlinks and non-regular files, report the size on
// the first line, then emit the content only when it fits the inline cap.
const REMOTE_READ_SCRIPT = [
  'f="$1"; max="$2"',
  '[ -L "$f" ] && { echo "Bash output path is a symbolic link" >&2; exit 3; }',
  '[ -f "$f" ] || { echo "Bash output path is not a regular file" >&2; exit 2; }',
  'sz=$(wc -c < "$f" 2>/dev/null | tr -d " ") || exit 2',
  'printf "%s\\n" "$sz"',
  '[ "$sz" -gt "$max" ] && exit 0',
  'exec cat -- "$f"',
].join("\n");

const REMOTE_STREAM_SCRIPT = [
  '[ -L "$1" ] && { echo "Bash output path is a symbolic link" >&2; exit 3; }',
  '[ -f "$1" ] || { echo "Bash output path is not a regular file" >&2; exit 2; }',
  'exec cat -- "$1"',
].join("\n");

export async function readUtf8FileWithinLimit(
  filePath: string,
  maxBytes = MAX_INLINE_BASH_OUTPUT_BYTES,
  host: Host = currentHost(),
): Promise<{ tooLarge: true; size: number } | { tooLarge: false; content: string; size: number }> {
  if (!host.isLocal) {
    const { stdout } = await host.executor.exec(["sh", "-c", REMOTE_READ_SCRIPT, "sh", filePath, String(maxBytes)], {
      maxBuffer: maxBytes + 64,
      timeoutMs: 5 * 60_000,
    });
    const newline = stdout.indexOf(0x0a);
    const size = Number.parseInt(stdout.subarray(0, newline === -1 ? stdout.length : newline).toString("utf8"), 10);
    if (!Number.isFinite(size)) throw new Error("Bash output size could not be read");
    if (size > maxBytes) return { tooLarge: true, size };
    const content = newline === -1 ? Buffer.alloc(0) : stdout.subarray(newline + 1);
    return { tooLarge: false, content: content.toString("utf8"), size: content.length };
  }

  const { handle, fileInfo } = await openRegularFileNoFollow(filePath);
  try {
    if (fileInfo.size > maxBytes) return { tooLarge: true, size: fileInfo.size };

    const buffer = Buffer.alloc(fileInfo.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return {
      tooLarge: false,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      size: bytesRead,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Byte stream of a bash output file for downloads (never buffered whole).
 * Local files are opened without following symlinks; remote files stream
 * through an lstat-guarded `cat` on the host.
 */
export async function createBashOutputReadStream(filePath: string, host: Host = currentHost()): Promise<Readable> {
  if (host.isLocal) {
    const { handle } = await openRegularFileNoFollow(filePath);
    return handle.createReadStream();
  }
  // Validate before spawning so a missing/linked path is a rejection rather
  // than an empty download; the script re-checks at open time.
  const info = await host.fs.lstat(filePath);
  if (!info.isFile()) throw new Error("Bash output path is not a regular file");
  const child = host.executor.spawn(["sh", "-c", REMOTE_STREAM_SCRIPT, "sh", filePath]);
  child.stderr.resume();
  child.stdin.end();
  return child.stdout;
}
