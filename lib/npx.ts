import { execPath } from "process";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";

/**
 * `npx` on a host, through the host's executor. Remote hosts are only
 * guaranteed to have omp and a POSIX shell; when `npx` is not on their PATH
 * the caller gets an NpxUnavailableError (routes map it to HTTP 501) instead
 * of a crash.
 */

export class NpxUnavailableError extends Error {
  readonly code = "npx_unavailable";
  readonly hostId: string;
  constructor(hostId: string) {
    super(`npx is not available on host ${hostId}`);
    this.name = "NpxUnavailableError";
    this.hostId = hostId;
  }
}

/** Non-zero exit; carries the captured output like execFile's error did. */
export class NpxError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, stdout: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "NpxError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Locate `npx-cli.js` shipped with the running Node.js installation.
 *
 * On Windows the `npx` on PATH is actually `npx.cmd`, which Node.js (since
 * 20.12 due to CVE-2024-27980) refuses to spawn from `execFile`/`spawn`
 * without `shell: true`. Going through a shell reintroduces quoting bugs for
 * user-supplied args. Instead we find the real `npx-cli.js` and invoke it
 * directly via the current `node` binary, which works identically on every
 * platform and needs no shell. Only meaningful on the local host, where this
 * process's Node installation is the one that would run npx.
 */
async function findLocalCli(host: Host, name: string): Promise<string | null> {
  const pathApi = host.pathApi;
  const nodeDir = pathApi.dirname(execPath);
  for (const candidate of [
    pathApi.join(nodeDir, "node_modules", "npm", "bin", `${name}-cli.js`),
    pathApi.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", `${name}-cli.js`),
  ]) {
    try {
      if (await host.fs.exists(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

async function resolveNpxArgv(host: Host): Promise<string[] | null> {
  if (host.isLocal) {
    const npxCli = await findLocalCli(host, "npx");
    if (npxCli) return [execPath, npxCli];
  }
  const npx = await host.executor.which("npx");
  return npx ? [npx] : null;
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  /** Environment overrides merged over the host's environment. */
  env?: Record<string, string>;
  host?: Host;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/** True when `npx` can be run on the host. */
export async function isNpxAvailable(host: Host = currentHost()): Promise<boolean> {
  return (await resolveNpxArgv(host)) !== null;
}

/**
 * Invoke `npx <args>` on the host without ever using a shell, so
 * user-controlled arguments are never interpreted as shell syntax.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const host = opts.host ?? currentHost();
  const argv = await resolveNpxArgv(host);
  if (!argv) throw new NpxUnavailableError(host.id);
  const result = await host.executor.exec([...argv, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeout,
    maxBuffer: 16 * 1024 * 1024,
    allowFailure: true,
  });
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr;
  if (result.code !== 0) {
    throw new NpxError(`npx ${args[0] ?? ""} exited with ${result.signal ?? result.code ?? "unknown"}`.trim(), stdout, stderr, result.code);
  }
  return { stdout, stderr };
}
