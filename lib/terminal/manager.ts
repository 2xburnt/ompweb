import { spawn as ptySpawn, type IPty } from "node-pty";
import { randomUUID } from "crypto";
import { currentHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";

/**
 * Interactive terminal sessions, one PTY per session.
 *
 * The PTY is always allocated on the hub. For the local machine it wraps the
 * user's shell directly; for a remote machine it wraps `ssh -tt`, which
 * allocates a second terminal on the far side. That indirection is what makes
 * a remote terminal behave like a local one: the ssh client sees a real
 * controlling terminal, so window-size changes reach the remote program and
 * full-screen tools reflow when the pane is dragged.
 *
 * Output is fanned out to any number of subscribers and also kept in a bounded
 * scrollback buffer, so a browser that reconnects (tab switch, SSE drop, page
 * reload) gets the screen back instead of an empty pane.
 */

export interface TerminalSessionInfo {
  id: string;
  hostId: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** Set once the shell has exited; the session is kept briefly so the UI can show why. */
  exit?: { code: number; signal?: number };
}

type OutputListener = (chunk: string) => void;
type ExitListener = (exit: { code: number; signal?: number }) => void;

interface TerminalSession extends TerminalSessionInfo {
  pty: IPty;
  /** Recent output, trimmed to SCROLLBACK_BYTES. Replayed to new subscribers. */
  scrollback: string[];
  scrollbackBytes: number;
  outputListeners: Set<OutputListener>;
  exitListeners: Set<ExitListener>;
  idleTimer: NodeJS.Timeout | null;
}

// Enough to redraw a full-screen program plus some history, small enough that
// a forgotten session cannot grow without bound.
const SCROLLBACK_BYTES = 256 * 1024;
// A session with no browser attached is closed after this long. Terminals are
// interactive by nature: nobody is served by a shell nobody can see.
const IDLE_CLOSE_MS = 30 * 60 * 1000;
// How long a finished session lingers so the UI can render the exit notice.
const EXIT_LINGER_MS = 30 * 1000;
const MAX_SESSIONS = 24;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

declare global {
  var __ompTerminals: Map<string, TerminalSession> | undefined;
}

function getSessions(): Map<string, TerminalSession> {
  if (!globalThis.__ompTerminals) {
    globalThis.__ompTerminals = new Map();
    // Mirror the RPC registry: never leave shells behind when the server stops.
    const cleanup = () => {
      for (const session of globalThis.__ompTerminals?.values() ?? []) {
        try {
          session.pty.kill();
        } catch {
          // Already gone.
        }
      }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompTerminals;
}

function clampDimension(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(500, Math.max(2, Math.trunc(parsed)));
}

function toInfo(session: TerminalSession): TerminalSessionInfo {
  return {
    id: session.id,
    hostId: session.hostId,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    ...(session.exit ? { exit: session.exit } : {}),
  };
}

function resetIdleTimer(session: TerminalSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.outputListeners.size > 0) {
    session.idleTimer = null;
    return;
  }
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    closeTerminal(session.id);
  }, IDLE_CLOSE_MS);
  session.idleTimer.unref?.();
}

/**
 * The shell to run on a host. `$SHELL` is resolved on the machine that will run
 * it, not on the hub, so a remote login shell is the remote user's own.
 */
function shellCommand(host: Host): string[] {
  if (host.isLocal && process.platform === "win32") {
    return [process.env.COMSPEC || "cmd.exe"];
  }
  // -l so the shell reads its login files: without it a remote shell often has
  // no PATH to the tools the user expects (omp, node, cargo).
  return ["sh", "-lc", 'exec "${SHELL:-/bin/bash}" -l'];
}

export class TerminalError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface CreateTerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Open a shell on the current host. */
export async function createTerminal(options: CreateTerminalOptions = {}, host: Host = currentHost()): Promise<TerminalSessionInfo> {
  const sessions = getSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw new TerminalError("too_many_terminals", `At most ${MAX_SESSIONS} terminals can be open at once`, 429);
  }
  await host.ready();

  const cols = clampDimension(options.cols, DEFAULT_COLS);
  const rows = clampDimension(options.rows, DEFAULT_ROWS);
  const cwd = options.cwd?.trim() || host.home || undefined;

  // The working directory belongs to the target machine, so only the local
  // host's PTY can be given it directly; for a remote host it is applied by
  // the command the executor builds.
  const { file, args } = host.executor.ptyCommand(shellCommand(host), cwd ? { cwd } : {});

  let pty: IPty;
  try {
    pty = ptySpawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: host.isLocal ? cwd : undefined,
      env: sanitizeProjectCommandEnvironment({
        ...process.env,
        TERM: "xterm-256color",
        // Tools that ask "am I in a terminal that can render colour?".
        COLORTERM: "truecolor",
      }) as Record<string, string>,
    });
  } catch (error) {
    throw new TerminalError("spawn_failed", `Could not open a terminal on "${host.id}": ${error instanceof Error ? error.message : String(error)}`, 500);
  }

  const session: TerminalSession = {
    id: randomUUID(),
    hostId: host.id,
    cwd: cwd ?? "",
    cols,
    rows,
    createdAt: Date.now(),
    pty,
    scrollback: [],
    scrollbackBytes: 0,
    outputListeners: new Set(),
    exitListeners: new Set(),
    idleTimer: null,
  };

  pty.onData((chunk) => {
    session.scrollback.push(chunk);
    session.scrollbackBytes += chunk.length;
    while (session.scrollbackBytes > SCROLLBACK_BYTES && session.scrollback.length > 1) {
      session.scrollbackBytes -= session.scrollback.shift()!.length;
    }
    for (const listener of session.outputListeners) {
      try {
        listener(chunk);
      } catch {
        // One dead subscriber must not stop the others.
      }
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    session.exit = { code: exitCode, ...(signal ? { signal } : {}) };
    for (const listener of session.exitListeners) {
      try {
        listener(session.exit);
      } catch {
        // As above.
      }
    }
    // Keep it around briefly so a browser can render the exit, then drop it.
    const timer = setTimeout(() => sessions.delete(session.id), EXIT_LINGER_MS);
    timer.unref?.();
  });

  sessions.set(session.id, session);
  resetIdleTimer(session);
  return toInfo(session);
}

function requireSession(id: string): TerminalSession {
  const session = getSessions().get(id);
  if (!session) throw new TerminalError("terminal_not_found", "Terminal session not found", 404);
  return session;
}

/** Sessions on one host (or every host when omitted). */
export function listTerminals(hostId?: string): TerminalSessionInfo[] {
  return [...getSessions().values()]
    .filter((session) => !hostId || session.hostId === hostId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toInfo);
}

export function getTerminal(id: string): TerminalSessionInfo | null {
  const session = getSessions().get(id);
  return session ? toInfo(session) : null;
}

export function writeTerminal(id: string, data: string): void {
  const session = requireSession(id);
  if (session.exit) throw new TerminalError("terminal_exited", "This terminal has exited", 409);
  session.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): TerminalSessionInfo {
  const session = requireSession(id);
  const nextCols = clampDimension(cols, session.cols);
  const nextRows = clampDimension(rows, session.rows);
  if (!session.exit && (nextCols !== session.cols || nextRows !== session.rows)) {
    session.cols = nextCols;
    session.rows = nextRows;
    try {
      session.pty.resize(nextCols, nextRows);
    } catch {
      // A shell that exited between the check and here; harmless.
    }
  }
  return toInfo(session);
}

export function closeTerminal(id: string): boolean {
  const sessions = getSessions();
  const session = sessions.get(id);
  if (!session) return false;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    session.pty.kill();
  } catch {
    // Already dead.
  }
  sessions.delete(id);
  return true;
}

/** Close every terminal on a host (it was removed, disabled, or updated). */
export function closeTerminalsForHost(hostId: string): number {
  const ids = [...getSessions().values()].filter((session) => session.hostId === hostId).map((session) => session.id);
  for (const id of ids) closeTerminal(id);
  return ids.length;
}

export interface TerminalSubscription {
  /** Output produced before this subscriber attached, so the screen is restored. */
  backlog: string;
  unsubscribe: () => void;
}

export function subscribeTerminal(
  id: string,
  onOutput: OutputListener,
  onExit?: ExitListener,
): TerminalSubscription {
  const session = requireSession(id);
  session.outputListeners.add(onOutput);
  if (onExit) session.exitListeners.add(onExit);
  resetIdleTimer(session);
  return {
    backlog: session.scrollback.join(""),
    unsubscribe: () => {
      session.outputListeners.delete(onOutput);
      if (onExit) session.exitListeners.delete(onExit);
      resetIdleTimer(session);
    },
  };
}
