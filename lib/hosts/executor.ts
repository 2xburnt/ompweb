import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";
import { createReadStream, mkdirSync } from "fs";
import * as fsp from "fs/promises";
import { homedir as osHomedir, tmpdir as osTmpdir } from "os";
import path from "path";
import { createInterface } from "readline";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { getOmpWebHome } from "./config";
import { shellJoin, shellQuote } from "./shell";
import type { HostKind, SshHostConfig } from "./types";

/**
 * Process + filesystem boundary for a host. ompweb never copies a host's omp
 * state to local disk: every read is a bounded request against the host's own
 * storage (a local syscall for the local host, a command over a multiplexed
 * OpenSSH connection for a remote host) and every write goes straight back.
 *
 * Remote hosts need nothing beyond `omp`, a POSIX shell and the usual
 * coreutils (find, stat, head, tail, cat, dd, mkdir, rm, mv). GNU and BSD
 * flavors of find/stat are both supported; the flavor is probed once.
 */

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Environment values kept out of the remote command line; see SpawnOptionsLike. */
  secretEnv?: Record<string, string>;
  input?: string | Buffer;
  timeoutMs?: number;
  /** Reject once stdout exceeds this many bytes (default 64 MiB). */
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Resolve with the result on a non-zero exit instead of rejecting. */
  allowFailure?: boolean;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ExecError extends Error {
  readonly argv: string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: Buffer;

  constructor(argv: string[], result: ExecResult, message?: string) {
    const detail = result.stderr.trim().split("\n").slice(-3).join(" | ");
    super(message ?? `${argv[0] ?? "command"} exited with ${result.signal ?? result.code ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    this.name = "ExecError";
    this.argv = argv;
    this.code = result.code;
    this.signal = result.signal;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
  }
}

export type HostFsErrorCode = "ENOENT" | "EACCES" | "ENOTDIR" | "EISDIR" | "EEXIST" | "ENOTEMPTY" | "EUNKNOWN";

export class HostFsError extends Error {
  readonly code: HostFsErrorCode;
  readonly path: string;

  constructor(code: HostFsErrorCode, filePath: string, message?: string) {
    super(message ?? `${code}: ${filePath}`);
    this.name = "HostFsError";
    this.code = code;
    this.path = filePath;
  }
}

export interface SpawnOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Environment values that must not appear in the remote command line.
   *
   * A remote command's arguments are world-readable through /proc on the
   * machine running it, so anything passed as `env` is visible to every user
   * there, and to process accounting and log shippers. Values given here are
   * streamed in over stdin instead and never become part of any argv. Use it
   * for tokens and keys; ordinary settings belong in `env`.
   */
  secretEnv?: Record<string, string>;
}

export type FileType = "file" | "dir" | "symlink" | "other";

export interface FileStat {
  type: FileType;
  size: number;
  mtimeMs: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DirEntry {
  name: string;
  type: FileType;
  size: number;
  mtimeMs: number;
  /** For symlinks: the type of the target; undefined when dangling. */
  targetType?: FileType;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Note: remote hosts report whole-second mtimes (stat %Y / find %T@ floored)
 * so walk, stat and readSlices results always agree for cache keys. */
export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  minDepth?: number;
  maxDepth?: number;
  /** Only files whose name ends with this suffix. */
  suffix?: string;
}

export interface FileSlices {
  size: number;
  mtimeMs: number;
  prefix: Buffer;
  suffix: Buffer;
}

export interface HostFs {
  stat(filePath: string): Promise<FileStat>;
  lstat(filePath: string): Promise<FileStat>;
  exists(filePath: string): Promise<boolean>;
  readdir(dirPath: string): Promise<DirEntry[]>;
  /** Regular files under root; depth 1 = direct children. */
  walkFiles(root: string, options?: WalkOptions): Promise<WalkedFile[]>;
  readFile(filePath: string, options?: { maxBytes?: number }): Promise<Buffer>;
  readHead(filePath: string, bytes: number): Promise<Buffer>;
  /** Prefix + suffix windows of many files in one round trip. Missing files are absent from the result. */
  readSlices(paths: readonly string[], prefixBytes: number, suffixBytes: number): Promise<Map<string, FileSlices>>;
  /** Stream a file line by line without materializing it. */
  forEachLine(filePath: string, onLine: (line: string) => void): Promise<void>;
  /** Atomic replace (temp file + rename in the target directory). */
  writeFile(filePath: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  /** Overwrite bytes at an offset without truncating. */
  writeAt(filePath: string, offset: number, data: Buffer): Promise<void>;
  prependFile(filePath: string, data: Buffer): Promise<void>;
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(filePath: string): Promise<string>;
}

export interface HostProbe {
  home: string;
  tmp: string;
  /** "linux" | "darwin" | "win32" | other lowercased uname */
  platform: string;
}

export interface HostExecutor {
  readonly kind: HostKind;
  /** Human-readable target for logs ("local", "twice@hetz"). */
  readonly label: string;
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  spawn(argv: readonly string[], options?: SpawnOptionsLike): ChildProcessWithoutNullStreams;
  readonly fs: HostFs;
  probe(): Promise<HostProbe>;
  which(binary: string): Promise<string | null>;
  /** ssh client arguments (without the target) for tools that shell out to ssh. */
  sshClientArgs?(): string[];
  /**
   * The command to run under a PTY **on the hub** so `argv` ends up attached to
   * a real terminal on this host. Locally that is just the command; remotely it
   * is `ssh -tt`, which allocates a terminal on the far side. Because the hub's
   * PTY gives the ssh client a controlling terminal, window-size changes
   * propagate all the way to the remote program.
   */
  ptyCommand(argv: readonly string[], options?: SpawnOptionsLike): { file: string; args: string[] };
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const SESSION_READ_CHUNK_BYTES = 1024 * 1024;

// ============================================================================
// Shared process runner
// ============================================================================

function runProcess(
  command: string,
  args: string[],
  spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv },
  options: ExecOptions,
  argvForErrors: string[],
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let failure: Error | null = null;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const result: ExecResult = { stdout: Buffer.concat(stdoutChunks, stdoutBytes), stderr, code, signal };
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 && !options.allowFailure) {
        reject(new ExecError(argvForErrors, result));
        return;
      }
      resolve(result);
    };
    const kill = () => {
      try { child.kill("SIGTERM"); } catch {}
      const forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
      forceTimer.unref?.();
    };
    const onAbort = () => {
      failure = new Error("Command aborted");
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        failure = new Error(`${argvForErrors[0] ?? "command"} timed out after ${options.timeoutMs}ms`);
        kill();
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        if (!failure) failure = new Error(`${argvForErrors[0] ?? "command"} output exceeded ${maxBuffer} bytes`);
        kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr = (stderr + chunk.toString("utf8")).slice(0, STDERR_CAP);
    });
    child.stdin.on("error", () => {
      // EPIPE when the process exits before consuming input; the exit handler reports.
    });
    child.on("error", (error) => {
      failure = error;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function makeStat(type: FileType, size: number, mtimeMs: number, mode: number): FileStat {
  return {
    type,
    size,
    mtimeMs,
    mode,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => type === "symlink",
  };
}

function makeEntry(name: string, type: FileType, size: number, mtimeMs: number, targetType?: FileType): DirEntry {
  return {
    name,
    type,
    size,
    mtimeMs,
    ...(targetType ? { targetType } : {}),
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => type === "symlink",
  };
}

// ============================================================================
// Local executor
// ============================================================================

function nodeStatToFileStat(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; mode: number }): FileStat {
  const type: FileType = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  return makeStat(type, stat.size, stat.mtimeMs, stat.mode);
}

async function readRange(filePath: string, position: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

class LocalFs implements HostFs {
  async stat(filePath: string): Promise<FileStat> {
    return nodeStatToFileStat(await fsp.stat(filePath));
  }

  async lstat(filePath: string): Promise<FileStat> {
    return nodeStatToFileStat(await fsp.lstat(filePath));
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fsp.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(dirPath: string): Promise<DirEntry[]> {
    // Keep the argument opaque to Next's build tracer (user-selected path).
    const readDirectory = Reflect.get(fsp, "readdir") as typeof fsp.readdir;
    const dirents = await readDirectory(dirPath, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (dirent) => {
      const entryPath = path.join(dirPath, dirent.name);
      let type: FileType = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
      let size = 0;
      let mtimeMs = 0;
      let targetType: FileType | undefined;
      try {
        const info = await fsp.lstat(entryPath);
        size = info.size;
        mtimeMs = info.mtimeMs;
        if (type === "other") type = info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
      } catch {
        // Entry vanished between readdir and lstat.
      }
      if (type === "symlink") {
        try {
          const target = await fsp.stat(entryPath);
          targetType = target.isDirectory() ? "dir" : target.isFile() ? "file" : "other";
          size = target.size;
        } catch {
          targetType = undefined;
        }
      }
      return makeEntry(dirent.name, type, size, mtimeMs, targetType);
    }));
    return entries;
  }

  async walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
    const minDepth = options.minDepth ?? 1;
    const maxDepth = options.maxDepth ?? 1;
    const out: WalkedFile[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let dirents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        const readDirectory = Reflect.get(fsp, "readdir") as typeof fsp.readdir;
        dirents = await readDirectory(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const entryPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (depth < maxDepth) await walk(entryPath, depth + 1);
          continue;
        }
        if (!dirent.isFile() || depth < minDepth) continue;
        if (options.suffix && !dirent.name.endsWith(options.suffix)) continue;
        try {
          const info = await fsp.stat(entryPath);
          out.push({ path: entryPath, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // Removed mid-walk.
        }
      }
    };
    await walk(root, 1);
    return out;
  }

  async readFile(filePath: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    if (options.maxBytes === undefined) return fsp.readFile(filePath);
    return readRange(filePath, 0, options.maxBytes);
  }

  readHead(filePath: string, bytes: number): Promise<Buffer> {
    return readRange(filePath, 0, bytes);
  }

  async readSlices(paths: readonly string[], prefixBytes: number, suffixBytes: number): Promise<Map<string, FileSlices>> {
    const result = new Map<string, FileSlices>();
    for (const filePath of paths) {
      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(filePath, "r");
      } catch {
        continue;
      }
      try {
        const info = await handle.stat();
        const prefixLength = Math.min(prefixBytes, info.size);
        const prefix = Buffer.allocUnsafe(prefixLength);
        const prefixRead = prefixLength > 0 ? (await handle.read(prefix, 0, prefixLength, 0)).bytesRead : 0;
        const suffixLength = Math.min(suffixBytes, info.size);
        const suffix = Buffer.allocUnsafe(suffixLength);
        const suffixRead = suffixLength > 0
          ? (await handle.read(suffix, 0, suffixLength, Math.max(0, info.size - suffixLength))).bytesRead
          : 0;
        result.set(filePath, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          prefix: prefix.subarray(0, prefixRead),
          suffix: suffix.subarray(0, suffixRead),
        });
      } catch {
        // Unreadable file: omitted, like a missing one.
      } finally {
        await handle.close();
      }
    }
    return result;
  }

  async forEachLine(filePath: string, onLine: (line: string) => void): Promise<void> {
    const stream = createReadStream(filePath, { highWaterMark: SESSION_READ_CHUNK_BYTES });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) onLine(line);
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  async writeFile(filePath: string, data: string | Buffer, options: { mode?: number } = {}): Promise<void> {
    const temp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(temp, data, options.mode !== undefined ? { mode: options.mode } : undefined);
      await fsp.rename(temp, filePath);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async writeAt(filePath: string, offset: number, data: Buffer): Promise<void> {
    const handle = await fsp.open(filePath, "r+");
    try {
      await handle.write(data, 0, data.length, offset);
    } finally {
      await handle.close();
    }
  }

  async prependFile(filePath: string, data: Buffer): Promise<void> {
    const existing = await fsp.readFile(filePath);
    let mode: number | undefined;
    try {
      mode = (await fsp.stat(filePath)).mode & 0o7777;
    } catch {
      mode = undefined;
    }
    await this.writeFile(filePath, Buffer.concat([data, existing]), mode !== undefined ? { mode } : undefined);
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: options.recursive ?? false });
  }

  async rm(filePath: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await fsp.rm(filePath, { recursive: options.recursive ?? false, force: options.force ?? false });
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  realpath(filePath: string): Promise<string> {
    return fsp.realpath(filePath);
  }
}

export class LocalExecutor implements HostExecutor {
  readonly kind: HostKind = "local";
  readonly label = "local";
  readonly fs: HostFs = new LocalFs();

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [command, ...args] = argv;
    if (!command) return Promise.reject(new Error("exec requires a command"));
    return runProcess(
      command,
      args,
      { cwd: options.cwd, env: sanitizeProjectCommandEnvironment({ ...process.env, ...options.env }) },
      options,
      [...argv],
    );
  }

  spawn(argv: readonly string[], options: SpawnOptionsLike = {}): ChildProcessWithoutNullStreams {
    const [command, ...args] = argv;
    if (!command) throw new Error("spawn requires a command");
    return spawn(command, args, {
      cwd: options.cwd,
      env: sanitizeProjectCommandEnvironment({ ...process.env, ...options.env }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group so callers can SIGTERM/SIGKILL the whole tree (omp
      // launches LSP servers and extension subprocesses).
      detached: process.platform !== "win32",
    });
  }

  ptyCommand(argv: readonly string[]): { file: string; args: string[] } {
    const [file, ...args] = argv;
    if (!file) throw new Error("ptyCommand requires a command");
    return { file, args };
  }

  async probe(): Promise<HostProbe> {
    return { home: osHomedir(), tmp: osTmpdir(), platform: process.platform };
  }

  async which(binary: string): Promise<string | null> {
    const probe = process.platform === "win32" ? ["where", binary] : ["sh", "-c", `command -v -- ${shellQuote(binary)}`];
    try {
      const { stdout } = await this.exec(probe, { timeoutMs: 10_000 });
      const first = stdout.toString("utf8").split(/\r?\n/).find((line) => line.trim());
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// SSH executor
// ============================================================================

type ToolFlavor = "gnu" | "bsd";

interface SshProbe extends HostProbe {
  statFlavor: ToolFlavor;
  findFlavor: ToolFlavor;
}

export interface SshExecutorOptions {
  /** Directory for ControlMaster sockets (default <OMP_WEB_HOME>/ssh). */
  controlDir?: string;
  /** Seconds an idle master connection stays open (default 600). */
  controlPersistSeconds?: number;
  connectTimeoutSeconds?: number;
}

// Non-interactive ssh sessions get a minimal PATH; omp is usually installed
// under one of these.
const REMOTE_PATH_PREFIX = '"$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"';

const FS_ERROR_PATTERNS: Array<[RegExp, HostFsErrorCode]> = [
  [/No such file or directory/i, "ENOENT"],
  [/Permission denied|Operation not permitted/i, "EACCES"],
  [/Not a directory/i, "ENOTDIR"],
  [/Is a directory/i, "EISDIR"],
  [/File exists/i, "EEXIST"],
  [/Directory not empty/i, "ENOTEMPTY"],
];

function toFsError(error: unknown, filePath: string): Error {
  if (error instanceof ExecError) {
    for (const [pattern, code] of FS_ERROR_PATTERNS) {
      if (pattern.test(error.stderr)) return new HostFsError(code, filePath, `${code}: ${filePath}`);
    }
    return new HostFsError("EUNKNOWN", filePath, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parseGnuFileType(value: string): FileType {
  if (value.startsWith("regular")) return "file";
  if (value === "directory") return "dir";
  if (value === "symbolic link") return "symlink";
  return "other";
}

function parseBsdFileType(value: string): FileType {
  if (value === "Regular File") return "file";
  if (value === "Directory") return "dir";
  if (value === "Symbolic Link") return "symlink";
  return "other";
}

function parseFindTypeChar(value: string): FileType | undefined {
  switch (value) {
    case "f": return "file";
    case "d": return "dir";
    case "l": return "symlink";
    case "N": case "L": case "?": return undefined;
    default: return "other";
  }
}

export class SshFs implements HostFs {
  private readonly executor: SshExecutor;

  // Plain field assignment (not a TS parameter property): the test runner
  // executes TypeScript in strip-only mode, which rejects parameter properties.
  constructor(executor: SshExecutor) {
    this.executor = executor;
  }

  private async runScript(script: string, args: string[], filePath: string, options: ExecOptions = {}): Promise<ExecResult> {
    try {
      return await this.executor.exec(["sh", "-c", script, "sh", ...args], { timeoutMs: 60_000, ...options });
    } catch (error) {
      throw toFsError(error, filePath);
    }
  }

  private async statWith(filePath: string, follow: boolean): Promise<FileStat> {
    const { statFlavor } = await this.executor.ready();
    if (statFlavor === "gnu") {
      const { stdout } = await this.runScript(`exec stat ${follow ? "-L " : ""}-c '%F|%s|%Y|%f' -- "$1"`, [filePath], filePath);
      const [type, size, mtime, modeHex] = stdout.toString("utf8").trim().split("|");
      return makeStat(parseGnuFileType(type ?? ""), Number(size), Number(mtime) * 1000, Number.parseInt(modeHex ?? "0", 16) & 0o7777);
    }
    const { stdout } = await this.runScript(`exec stat ${follow ? "-L " : ""}-f '%HT|%z|%m|%p' -- "$1"`, [filePath], filePath);
    const [type, size, mtime, modeOctal] = stdout.toString("utf8").trim().split("|");
    return makeStat(parseBsdFileType(type ?? ""), Number(size), Number(mtime) * 1000, Number.parseInt(modeOctal ?? "0", 8) & 0o7777);
  }

  stat(filePath: string): Promise<FileStat> {
    return this.statWith(filePath, true);
  }

  lstat(filePath: string): Promise<FileStat> {
    return this.statWith(filePath, false);
  }

  async exists(filePath: string): Promise<boolean> {
    const result = await this.runScript('if [ -e "$1" ] || [ -L "$1" ]; then exit 0; else exit 1; fi', [filePath], filePath, { allowFailure: true });
    return result.code === 0;
  }

  async readdir(dirPath: string): Promise<DirEntry[]> {
    const { findFlavor, statFlavor } = await this.executor.ready();
    // A missing/unreadable directory must surface as an error, not an empty list.
    await this.runScript('[ -d "$1" ] || { echo "Not a directory: $1" >&2; exit 20; }; [ -r "$1" ] || { echo "Permission denied: $1" >&2; exit 13; }', [dirPath], dirPath);
    if (findFlavor === "gnu") {
      const { stdout } = await this.runScript(
        `exec find "$1" -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%f\\0'`,
        [dirPath], dirPath, { maxBuffer: DEFAULT_MAX_BUFFER },
      );
      const entries: DirEntry[] = [];
      for (const record of stdout.toString("utf8").split("\0")) {
        if (!record) continue;
        const [typeChar, targetChar, size, mtime, ...nameParts] = record.split("\t");
        const name = nameParts.join("\t");
        if (!name) continue;
        const type = parseFindTypeChar(typeChar ?? "") ?? "other";
        const targetType = type === "symlink" ? parseFindTypeChar(targetChar ?? "") : undefined;
        entries.push(makeEntry(name, type, Number(size), Math.floor(Number.parseFloat(mtime ?? "0")) * 1000, targetType));
      }
      return entries;
    }
    // BSD: stat every entry in one exec batch (lstat semantics), then resolve
    // symlink targets in a second batch.
    const statFormat = statFlavor === "gnu" ? "-c '%F|%s|%Y|%n'" : "-f '%HT|%z|%m|%N'";
    const { stdout } = await this.runScript(
      `exec find "$1" -mindepth 1 -maxdepth 1 -exec stat ${statFormat} -- {} +`,
      [dirPath], dirPath,
    );
    const entries: DirEntry[] = [];
    const symlinks: string[] = [];
    for (const line of stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [type, size, mtime, ...pathParts] = line.split("|");
      const fullPath = pathParts.join("|");
      const name = path.posix.basename(fullPath);
      if (!name) continue;
      const fileType = statFlavor === "gnu" ? parseGnuFileType(type ?? "") : parseBsdFileType(type ?? "");
      entries.push(makeEntry(name, fileType, Number(size), Number(mtime) * 1000));
      if (fileType === "symlink") symlinks.push(fullPath);
    }
    if (symlinks.length > 0) {
      const followFormat = statFlavor === "gnu" ? "-L -c '%F|%n'" : "-L -f '%HT|%N'";
      const result = await this.runScript(
        `while IFS= read -r f; do stat ${followFormat} -- "$f" 2>/dev/null; done`,
        [], dirPath, { input: `${symlinks.join("\n")}\n`, allowFailure: true },
      );
      const targetTypes = new Map<string, FileType>();
      for (const line of result.stdout.toString("utf8").split("\n")) {
        if (!line) continue;
        const [type, ...pathParts] = line.split("|");
        const name = path.posix.basename(pathParts.join("|"));
        targetTypes.set(name, statFlavor === "gnu" ? parseGnuFileType(type ?? "") : parseBsdFileType(type ?? ""));
      }
      return entries.map((entry) => entry.type === "symlink" && targetTypes.has(entry.name)
        ? makeEntry(entry.name, entry.type, entry.size, entry.mtimeMs, targetTypes.get(entry.name))
        : entry);
    }
    return entries;
  }

  async walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
    const { findFlavor, statFlavor } = await this.executor.ready();
    const minDepth = Math.max(1, options.minDepth ?? 1);
    const maxDepth = Math.max(minDepth, options.maxDepth ?? 1);
    const nameFilter = options.suffix ? `-name ${shellQuote(`*${options.suffix}`)} ` : "";
    const exists = await this.runScript('if [ -d "$1" ]; then exit 0; else exit 1; fi', [root], root, { allowFailure: true });
    if (exists.code !== 0) return [];
    if (findFlavor === "gnu") {
      const { stdout } = await this.runScript(
        `exec find "$1" -mindepth ${minDepth} -maxdepth ${maxDepth} -type f ${nameFilter}-printf '%s\\t%T@\\t%p\\0'`,
        [root], root,
      );
      const files: WalkedFile[] = [];
      for (const record of stdout.toString("utf8").split("\0")) {
        if (!record) continue;
        const [size, mtime, ...pathParts] = record.split("\t");
        const filePath = pathParts.join("\t");
        if (!filePath) continue;
        files.push({ path: filePath, size: Number(size), mtimeMs: Math.floor(Number.parseFloat(mtime ?? "0")) * 1000 });
      }
      return files;
    }
    const statFormat = statFlavor === "gnu" ? "-c '%s|%Y|%n'" : "-f '%z|%m|%N'";
    const { stdout } = await this.runScript(
      `exec find "$1" -mindepth ${minDepth} -maxdepth ${maxDepth} -type f ${nameFilter}-exec stat ${statFormat} -- {} +`,
      [root], root,
    );
    const files: WalkedFile[] = [];
    for (const line of stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [size, mtime, ...pathParts] = line.split("|");
      const filePath = pathParts.join("|");
      if (!filePath) continue;
      files.push({ path: filePath, size: Number(size), mtimeMs: Number(mtime) * 1000 });
    }
    return files;
  }

  async readFile(filePath: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const maxBytes = options.maxBytes;
    const script = maxBytes !== undefined ? `exec head -c ${Math.max(0, Math.floor(maxBytes))} -- "$1"` : 'exec cat -- "$1"';
    const { stdout } = await this.runScript(script, [filePath], filePath, {
      maxBuffer: maxBytes !== undefined ? Math.max(1, maxBytes) + 1 : DEFAULT_MAX_BUFFER,
      timeoutMs: 10 * 60_000,
    });
    return stdout;
  }

  async readHead(filePath: string, bytes: number): Promise<Buffer> {
    return this.readFile(filePath, { maxBytes: bytes });
  }

  async readSlices(paths: readonly string[], prefixBytes: number, suffixBytes: number): Promise<Map<string, FileSlices>> {
    const result = new Map<string, FileSlices>();
    if (paths.length === 0) return result;
    const { statFlavor } = await this.executor.ready();
    const sentinel = `\n--omp-web-${randomBytes(12).toString("hex")}--\n`;
    const mtimeCommand = statFlavor === "gnu" ? 'stat -c %Y -- "$f"' : 'stat -f %m -- "$f"';
    // Paths arrive on stdin one per line; the output is a sequence of frames,
    // each "H <size> <mtime> <path>\n" + prefix + sentinel + suffix + sentinel.
    // Files that vanish mid-listing are skipped silently.
    const script = [
      `S=${shellQuote(sentinel)}`,
      "while IFS= read -r f; do",
      '  [ -f "$f" ] || continue',
      '  sz=$(wc -c < "$f" 2>/dev/null | tr -d " ") || continue',
      `  mt=$(${mtimeCommand} 2>/dev/null) || continue`,
      '  printf "H %s %s %s\\n" "$sz" "$mt" "$f"',
      `  head -c ${prefixBytes} -- "$f" 2>/dev/null; printf "%s" "$S"`,
      `  ${suffixBytes > 0 ? `tail -c ${suffixBytes} -- "$f" 2>/dev/null` : ":"}; printf "%s" "$S"`,
      "done",
    ].join("\n");
    const { stdout } = await this.runScript(script, [], paths[0] ?? "", {
      input: `${paths.join("\n")}\n`,
      maxBuffer: Math.max(DEFAULT_MAX_BUFFER, paths.length * (prefixBytes + suffixBytes + 1024) + 1024),
      timeoutMs: 5 * 60_000,
    });
    const sentinelBuffer = Buffer.from(sentinel, "utf8");
    let offset = 0;
    while (offset < stdout.length) {
      const headerEnd = stdout.indexOf(0x0a, offset);
      if (headerEnd === -1) break;
      const header = stdout.subarray(offset, headerEnd).toString("utf8");
      offset = headerEnd + 1;
      const match = /^H (\d+) (\d+) (.*)$/.exec(header);
      if (!match) break;
      const prefixEnd = stdout.indexOf(sentinelBuffer, offset);
      if (prefixEnd === -1) break;
      const prefix = stdout.subarray(offset, prefixEnd);
      offset = prefixEnd + sentinelBuffer.length;
      const suffixEnd = stdout.indexOf(sentinelBuffer, offset);
      if (suffixEnd === -1) break;
      const suffix = stdout.subarray(offset, suffixEnd);
      offset = suffixEnd + sentinelBuffer.length;
      result.set(match[3], {
        size: Number(match[1]),
        mtimeMs: Number(match[2]) * 1000,
        prefix: Buffer.from(prefix),
        suffix: Buffer.from(suffix),
      });
    }
    return result;
  }

  async forEachLine(filePath: string, onLine: (line: string) => void): Promise<void> {
    const child = this.executor.spawn(["cat", "--", filePath]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8");
    });
    const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) onLine(line);
    } finally {
      rl.close();
    }
    const code = await exit;
    if (code !== 0) {
      throw toFsError(new ExecError(["cat", filePath], { stdout: Buffer.alloc(0), stderr, code, signal: null }), filePath);
    }
  }

  async writeFile(filePath: string, data: string | Buffer, options: { mode?: number } = {}): Promise<void> {
    const chmod = options.mode !== undefined ? `chmod ${(options.mode & 0o7777).toString(8)} "$t" && ` : "";
    const script = `t="$1.$$.tmp"; d=$(dirname -- "$1"); [ -d "$d" ] || mkdir -p -- "$d" || exit 1; cat > "$t" && ${chmod}mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 1; }`;
    await this.runScript(script, [filePath], filePath, { input: data, timeoutMs: 10 * 60_000 });
  }

  async writeAt(filePath: string, offset: number, data: Buffer): Promise<void> {
    if (offset < 0 || !Number.isInteger(offset)) throw new Error("writeAt offset must be a non-negative integer");
    // dd with bs=<offset> seek=1 lands the payload exactly at <offset> without
    // truncating; offset 0 needs no seek. BSD dd lacks status=none, so its
    // transfer summary is discarded via 2>/dev/null and the exit code checked.
    const seek = offset > 0 ? `bs=${offset} seek=1` : "";
    await this.runScript(`[ -f "$1" ] || { echo "No such file or directory: $1" >&2; exit 2; }; exec dd of="$1" ${seek} conv=notrunc 2>/dev/null`, [filePath], filePath, { input: data });
  }

  async prependFile(filePath: string, data: Buffer): Promise<void> {
    const script = 't="$1.$$.tmp"; [ -f "$1" ] || { echo "No such file or directory: $1" >&2; exit 2; }; { cat; cat -- "$1"; } > "$t" && mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 1; }';
    await this.runScript(script, [filePath], filePath, { input: data, timeoutMs: 10 * 60_000 });
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.runScript(`exec mkdir ${options.recursive ? "-p " : ""}-- "$1"`, [dirPath], dirPath);
  }

  async rm(filePath: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    await this.runScript(`exec rm ${flags ? `-${flags} ` : ""}-- "$1"`, [filePath], filePath);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.runScript('exec mv -f -- "$1" "$2"', [from, to], from);
  }

  async realpath(filePath: string): Promise<string> {
    const { stdout } = await this.runScript(
      'if command -v realpath >/dev/null 2>&1; then exec realpath -- "$1"; else exec readlink -f -- "$1"; fi',
      [filePath], filePath,
    );
    const resolved = stdout.toString("utf8").replace(/\n$/, "");
    if (!resolved) throw new HostFsError("ENOENT", filePath);
    return resolved;
  }
}

export class SshExecutor implements HostExecutor {
  readonly kind: HostKind = "ssh";
  readonly label: string;
  readonly fs: HostFs;
  private readonly config: SshHostConfig;
  private readonly controlDir: string;
  private readonly controlPersistSeconds: number;
  private readonly connectTimeoutSeconds: number;
  private probePromise: Promise<SshProbe> | null = null;
  private probed: SshProbe | null = null;

  constructor(config: SshHostConfig, options: SshExecutorOptions = {}) {
    this.config = config;
    this.label = `${config.user ? `${config.user}@` : ""}${config.host}${config.port ? `:${config.port}` : ""}`;
    this.controlDir = options.controlDir ?? path.join(getOmpWebHome(), "ssh");
    this.controlPersistSeconds = options.controlPersistSeconds ?? 600;
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 15;
    this.fs = new SshFs(this);
  }

  /** ssh client arguments (options only, no target). Shared with rsync/scp-style callers. */
  sshClientArgs(): string[] {
    try {
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    } catch {
      // A failed mkdir surfaces as an ssh error on the next command.
    }
    const args = [
      "-o", "BatchMode=yes",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${path.join(this.controlDir, "%C")}`,
      "-o", `ControlPersist=${this.controlPersistSeconds}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", `ConnectTimeout=${this.connectTimeoutSeconds}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "LogLevel=ERROR",
    ];
    if (this.config.port) args.push("-p", String(this.config.port));
    if (this.config.user) args.push("-l", this.config.user);
    if (this.config.identityFile) args.push("-i", this.config.identityFile, "-o", "IdentitiesOnly=yes");
    return args;
  }

  private target(): string {
    return this.config.host;
  }

  /** Wrap argv into a POSIX `sh -c` command line that survives any remote login shell. */
  /** Names of the secrets this command expects on stdin, in order. */
  private static secretNames(options: SpawnOptionsLike): string[] {
    return Object.keys(options.secretEnv ?? {});
  }

  /**
   * The lines that must precede a command's real stdin when it carries
   * secrets: one value per line, in the order `secretNames` reports.
   */
  static secretPreamble(options: SpawnOptionsLike): string {
    const secrets = options.secretEnv ?? {};
    const names = Object.keys(secrets);
    if (names.length === 0) return "";
    for (const name of names) {
      if (/[\r\n]/.test(secrets[name])) {
        throw new Error(`Secret ${name} cannot contain a newline: it is delimited by one on the wire`);
      }
    }
    return names.map((name) => `${secrets[name]}\n`).join("");
  }

  remoteCommand(argv: readonly string[], options: SpawnOptionsLike = {}): string {
    const parts = [`export PATH=${REMOTE_PATH_PREFIX}:"$PATH"`];
    if (options.cwd) parts.push(`cd ${shellQuote(options.cwd)} || exit 127`);
    // Secrets arrive on stdin, one line each, and are read into the
    // environment before exec. `read` on a pipe consumes a byte at a time up
    // to the newline, so the command's own stdin is left untouched behind it.
    for (const name of SshExecutor.secretNames(options)) {
      parts.push(`IFS= read -r ${name} || exit 127`, `export ${name}`);
    }
    const envPrefix = options.env && Object.keys(options.env).length > 0
      ? `env ${Object.entries(options.env).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ")} `
      : "";
    parts.push(`exec ${envPrefix}${shellJoin(argv)}`);
    return `sh -c ${shellQuote(parts.join("; "))}`;
  }

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) return Promise.reject(new Error("exec requires a command"));
    const args = [...this.sshClientArgs(), "--", this.target(), this.remoteCommand(argv, { cwd: options.cwd, env: options.env, secretEnv: options.secretEnv })];
    const preamble = SshExecutor.secretPreamble(options);
    const withSecrets = preamble
      ? { ...options, input: preamble + (typeof options.input === "string" ? options.input : options.input?.toString("utf8") ?? "") }
      : options;
    return runProcess("ssh", args, { env: process.env }, { timeoutMs: 120_000, ...withSecrets }, [...argv]);
  }

  spawn(argv: readonly string[], options: SpawnOptionsLike = {}): ChildProcessWithoutNullStreams {
    if (argv.length === 0) throw new Error("spawn requires a command");
    const args = [...this.sshClientArgs(), "--", this.target(), this.remoteCommand(argv, options)];
    const preamble = SshExecutor.secretPreamble(options);
    const child = spawn("ssh", args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    // The remote shell reads these lines before exec, so they must go first.
    if (preamble) child.stdin.write(preamble);
    return child;
  }

  /**
   * `ssh -tt <target> <command>`: the doubled -t forces a remote terminal even
   * though the ssh client's own stdin is a PTY we created rather than the
   * user's console. Window-size changes reach the remote program because the
   * client has a controlling terminal to observe.
   */
  ptyCommand(argv: readonly string[], options: SpawnOptionsLike = {}): { file: string; args: string[] } {
    if (argv.length === 0) throw new Error("ptyCommand requires a command");
    return {
      file: "ssh",
      args: [...this.sshClientArgs(), "-tt", "--", this.target(), this.remoteCommand(argv, options)],
    };
  }

  /** Connectivity + tool-flavor probe; cached after the first success. */
  async ready(): Promise<SshProbe> {
    if (this.probed) return this.probed;
    if (!this.probePromise) {
      this.probePromise = this.runProbe().then(
        (result) => {
          this.probed = result;
          return result;
        },
        (error) => {
          this.probePromise = null;
          throw error;
        },
      );
    }
    return this.probePromise;
  }

  /** Force a fresh probe (used by the hosts API "test connection" action). */
  async reprobe(): Promise<SshProbe> {
    this.probed = null;
    this.probePromise = null;
    return this.ready();
  }

  private async runProbe(): Promise<SshProbe> {
    const script = [
      'printf "%s\\n" "$HOME"',
      'printf "%s\\n" "${TMPDIR:-/tmp}"',
      "uname -s",
      "if stat --version >/dev/null 2>&1; then echo gnu; else echo bsd; fi",
      "if find --version >/dev/null 2>&1; then echo gnu; else echo bsd; fi",
    ].join("; ");
    const { stdout } = await this.exec(["sh", "-c", script], { timeoutMs: 30_000 });
    const [home, tmp, uname, statFlavor, findFlavor] = stdout.toString("utf8").split("\n");
    if (!home) throw new Error("ssh probe returned no home directory");
    const lowered = (uname ?? "").trim().toLowerCase();
    const platform = lowered === "darwin" ? "darwin" : lowered.startsWith("linux") ? "linux" : lowered.includes("mingw") || lowered.includes("msys") || lowered.includes("cygwin") ? "win32" : lowered || "unknown";
    return {
      home: home.trim(),
      tmp: (tmp ?? "/tmp").trim() || "/tmp",
      platform,
      statFlavor: statFlavor?.trim() === "gnu" ? "gnu" : "bsd",
      findFlavor: findFlavor?.trim() === "gnu" ? "gnu" : "bsd",
    };
  }

  async probe(): Promise<HostProbe> {
    const { home, tmp, platform } = await this.reprobe();
    return { home, tmp, platform };
  }

  async which(binary: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec(["sh", "-c", `command -v -- ${shellQuote(binary)}`], { timeoutMs: 30_000 });
      const first = stdout.toString("utf8").split("\n").find((line) => line.trim());
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }
}
