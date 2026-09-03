import { homedir } from "os";
import { currentHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { RpcProcess } from "./rpc-process";

/**
 * Shared short-lived `omp` utility process for global registry/auth queries
 * (get_available_models, get_login_providers, get_state). These commands do
 * not belong to any user session, so they run against a single lazily-started
 * RPC process that is killed after ~60s of inactivity. Access is serialized:
 * the omp RPC loop handles one command at a time anyway, and serialization
 * lets lazy start/idle-kill stay race-free.
 *
 * Real user sessions must use lib/rpc-manager.ts instead — this process runs
 * with --no-session and its agent state is throwaway.
 *
 * One utility process per host: the model registry and auth state live on the
 * machine that runs omp, so a remote host gets its own lazily-started process
 * over ssh.
 */

// Extensions stay ENABLED: they can register models and login providers, and
// omitting them made the web UI's model/provider lists disagree with the CLI's.
// Measured against a real install (omp/17.1.3): ready-frame latency is the same
// either way (~3.6s with vs ~4.0s without over 4 runs each).
const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];
const READY_TIMEOUT_MS = 60_000;
// Longer than the 60s models-cache TTL on purpose: with idle-kill == TTL every
// pause past a minute paid a cold multi-second respawn on top of the stale
// cache. Cost of the longer window is one idle omp process.
const IDLE_KILL_MS = 300_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Minimal mirror of omp's Model (packages/catalog/src/types.ts) — only the
 * fields the models/auth routes read. Everything else passes through opaque. */
export interface OmpModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  thinking?: {
    mode?: string;
    efforts?: string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  input?: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Entry of the get_login_providers response (modes/rpc/rpc-types.ts). */
export interface OmpLoginProvider {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

interface UtilityRpcState {
  proc: RpcProcess | null;
  idleTimer: NodeJS.Timeout | null;
  queue: Promise<void>;
}

declare global {
  var __ompUtilityRpcStates: Map<string, UtilityRpcState> | undefined;
}

function getStates(): Map<string, UtilityRpcState> {
  if (!globalThis.__ompUtilityRpcStates) {
    globalThis.__ompUtilityRpcStates = new Map();
    // Mirror the session registry in lib/rpc-manager.ts: dispose the shared
    // utility omp processes on server shutdown so they do not outlive the server.
    // Idempotent and safe to call any time (clears the idle timers + disposes).
    const cleanup = () => disposeUtilityRpc();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompUtilityRpcStates;
}

function getState(host: Host): UtilityRpcState {
  const states = getStates();
  let state = states.get(host.id);
  if (!state) {
    state = { proc: null, idleTimer: null, queue: Promise.resolve() };
    states.set(host.id, state);
  }
  return state;
}

function disposeState(state: UtilityRpcState): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  const proc = state.proc;
  state.proc = null;
  if (proc) void proc.dispose();
}

/**
 * Tear down the shared utility omp process immediately (skip the idle timer).
 * Registered as a server-shutdown hook in getStates() above (mirroring the
 * session registry in lib/rpc-manager.ts) so the utility processes do not
 * outlive the server; also safe to call any time — it just clears any pending
 * idle kill and disposes the live child. Without a host id, every host's
 * utility process is disposed.
 */
export function disposeUtilityRpc(hostId?: string): void {
  const states = globalThis.__ompUtilityRpcStates;
  if (!states) return;
  if (hostId) {
    const state = states.get(hostId);
    if (state) disposeState(state);
    return;
  }
  for (const state of states.values()) disposeState(state);
}

function scheduleIdleKill(state: UtilityRpcState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    const proc = state.proc;
    state.proc = null;
    if (proc) void proc.dispose();
  }, IDLE_KILL_MS);
  state.idleTimer.unref?.();
}

async function startProcess(state: UtilityRpcState, host: Host): Promise<RpcProcess> {
  const proc = new RpcProcess({
    host,
    cwd: host.home ?? homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    onExit: () => {
      if (state.proc === proc) state.proc = null;
    },
  });
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
  } catch (error) {
    void proc.dispose();
    throw error;
  }
  return proc;
}

/** Run one RPC command on the shared utility process (lazy start, serialized,
 * idle-killed). Rejections from earlier commands never poison the queue. */
export function runUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  host: Host = currentHost(),
): Promise<T> {
  const state = getState(host);
  const run = state.queue.then(async () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    try {
      if (!state.proc || !state.proc.isAlive) {
        await host.ready();
        state.proc = await startProcess(state, host);
      }
      return await state.proc.sendCommand<T>(command, timeoutMs);
    } finally {
      scheduleIdleKill(state);
    }
  });
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run one RPC command on a dedicated throwaway process. Used where the shared
 * process must not be reused — e.g. the models-config connectivity test, which
 * points PI_CODING_AGENT_DIR at a temp dir via `env`.
 *
 * `signal` (optional) aborts the whole lifecycle: a not-yet-ready child is
 * disposed immediately and a pending command is rejected. Callers with a
 * Request should pass `request.signal` so a disconnected client does not keep
 * a 60s registry spawn running. */
export async function runIsolatedUtilityCommand<T = unknown>(
  command: { type: string; [key: string]: unknown },
  options: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; signal?: AbortSignal; host?: Host } = {},
): Promise<T> {
  const host = options.host ?? currentHost();
  await host.ready();
  const proc = new RpcProcess({
    host,
    cwd: options.cwd ?? host.home ?? homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    env: options.env,
  });
  const signal = options.signal;
  const onAbort = () => { void proc.dispose(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const ready = await proc.waitReady(READY_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    return await proc.sendCommand<T>(command, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    // Await the child's exit (not fire-and-forget): callers like the
    // models-config test remove their throwaway temp dir right after this
    // resolves, and on Windows a still-exiting child holding handles on that
    // dir makes rmSync fail (EBUSY, only suppressed by force: true).
    await proc.dispose();
  }
}
