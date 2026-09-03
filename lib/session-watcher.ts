import { watch, type FSWatcher } from "fs";
import { join } from "path";
import { withHost } from "./hosts/context";
import { listHosts, onHostRegistryChange, type Host } from "./hosts/registry";
import { listSessionFileStats } from "./omp/session-files";
import {
  getAgentDir,
  invalidateSessionListCache,
  listAllSessions,
  resolveSessionIdByPath,
} from "./session-reader";

// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches each
// host's session tree and reports which session ids changed, which the
// running-events stream forwards to the client.
//
// The local machine uses fs.watch. A remote host has no inotify channel over
// ssh, so its session tree is polled: one bounded directory walk per interval,
// diffed by (size, mtime) against the previous walk.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;
const RETRY_MS = 5000;
const REMOTE_POLL_MS = 15_000;

interface LocalWatch {
  kind: "local";
  watcher: FSWatcher | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pendingPaths: Set<string>;
  pendingUnknown: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface RemoteWatch {
  kind: "remote";
  timer: ReturnType<typeof setTimeout> | null;
  snapshot: Map<string, { size: number; mtimeMs: number }> | null;
  polling: boolean;
}

type HostWatch = LocalWatch | RemoteWatch;

const listeners = new Set<Listener>();
const watches = new Map<string, { host: Host; watch: HostWatch }>();
let unsubscribeRegistry: (() => void) | null = null;

function emit(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(sessionIds);
    } catch {
      // a failing subscriber must not stop the others
    }
  }
}

function emitAllSessions(): void {
  void listAllSessions()
    .then((sessions) => emit(sessions.map((s) => s.id)))
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

// ----------------------------------------------------------------------------
// Local host: fs.watch
// ----------------------------------------------------------------------------

function flushLocal(host: Host, state: LocalWatch): void {
  state.flushTimer = null;
  const paths = [...state.pendingPaths];
  state.pendingPaths = new Set();
  const hadUnknown = state.pendingUnknown;
  state.pendingUnknown = false;
  if (paths.length === 0 && !hadUnknown) return;

  // A changed file means the cached list's mtimes and message counts are stale.
  invalidateSessionListCache();

  if (hadUnknown) {
    // filename was null — fs.watch coalesced the event or overflowed. We
    // don't know which file changed, so rescan the whole tree.
    emitAllSessions();
    return;
  }

  void Promise.all(paths.map((path) => resolveSessionIdByPath(path, host).catch(() => undefined)))
    .then((ids) => emit([...new Set(ids.filter((id): id is string => Boolean(id)))]))
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

function scheduleLocalRetry(host: Host, state: LocalWatch): void {
  if (state.retryTimer || listeners.size === 0) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    startLocalWatcher(host, state);
  }, RETRY_MS);
}

function startLocalWatcher(host: Host, state: LocalWatch): void {
  if (state.watcher || state.retryTimer) return;
  const sessionsDir = withHost(host, () => join(getAgentDir(), "sessions"));
  try {
    state.watcher = watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) {
        state.pendingUnknown = true;
        if (!state.flushTimer) state.flushTimer = setTimeout(() => flushLocal(host, state), DEBOUNCE_MS);
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      state.pendingPaths.add(join(sessionsDir, name));
      if (!state.flushTimer) state.flushTimer = setTimeout(() => flushLocal(host, state), DEBOUNCE_MS);
    });
    state.watcher.on("error", () => {
      state.watcher?.close();
      state.watcher = null;
      scheduleLocalRetry(host, state);
    });
  } catch {
    // No sessions directory yet, or the platform refused a recursive watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    state.watcher = null;
    scheduleLocalRetry(host, state);
  }
}

function stopLocalWatcher(state: LocalWatch): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  state.pendingPaths = new Set();
  state.pendingUnknown = false;
  state.watcher?.close();
  state.watcher = null;
}

// ----------------------------------------------------------------------------
// Remote host: polling walk
// ----------------------------------------------------------------------------

async function pollRemote(host: Host, state: RemoteWatch): Promise<void> {
  if (state.polling) return;
  state.polling = true;
  try {
    await host.ready();
    const sessionsDir = withHost(host, () => join(getAgentDir(), "sessions"));
    const files = await listSessionFileStats(sessionsDir, host);
    const next = new Map<string, { size: number; mtimeMs: number }>();
    for (const file of files) next.set(file.path, { size: file.size, mtimeMs: file.mtimeMs });
    const previous = state.snapshot;
    state.snapshot = next;
    if (!previous) return;
    const changed: string[] = [];
    let removed = false;
    for (const [path, stat] of next) {
      const before = previous.get(path);
      if (!before || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) changed.push(path);
    }
    for (const path of previous.keys()) {
      if (!next.has(path)) removed = true;
    }
    if (changed.length === 0 && !removed) return;
    invalidateSessionListCache();
    if (removed) {
      emitAllSessions();
      return;
    }
    const ids = await Promise.all(changed.map((path) => resolveSessionIdByPath(path, host).catch(() => undefined)));
    emit([...new Set(ids.filter((id): id is string => Boolean(id)))]);
  } catch {
    // Unreachable host: keep polling; the next successful walk re-baselines.
    state.snapshot = null;
  } finally {
    state.polling = false;
  }
}

function startRemoteWatcher(host: Host, state: RemoteWatch): void {
  if (state.timer) return;
  const tick = () => {
    state.timer = null;
    if (listeners.size === 0) return;
    void pollRemote(host, state).finally(() => {
      if (listeners.size > 0 && watches.get(host.id)?.watch === state) {
        state.timer = setTimeout(tick, REMOTE_POLL_MS);
        state.timer.unref?.();
      }
    });
  };
  state.timer = setTimeout(tick, 0);
  state.timer.unref?.();
}

function stopRemoteWatcher(state: RemoteWatch): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.snapshot = null;
}

// ----------------------------------------------------------------------------
// Registry-driven lifecycle
// ----------------------------------------------------------------------------

function stopWatch(entry: { host: Host; watch: HostWatch }): void {
  if (entry.watch.kind === "local") stopLocalWatcher(entry.watch);
  else stopRemoteWatcher(entry.watch);
}

function ensureWatchers(): void {
  const hosts = listHosts();
  const wanted = new Set(hosts.map((host) => host.id));
  for (const [id, entry] of watches) {
    const host = hosts.find((candidate) => candidate.id === id);
    if (!host || host !== entry.host) {
      stopWatch(entry);
      watches.delete(id);
    }
  }
  for (const host of hosts) {
    if (!wanted.has(host.id) || watches.has(host.id)) continue;
    if (host.isLocal) {
      const state: LocalWatch = { kind: "local", watcher: null, retryTimer: null, pendingPaths: new Set(), pendingUnknown: false, flushTimer: null };
      watches.set(host.id, { host, watch: state });
      startLocalWatcher(host, state);
    } else {
      const state: RemoteWatch = { kind: "remote", timer: null, snapshot: null, polling: false };
      watches.set(host.id, { host, watch: state });
      startRemoteWatcher(host, state);
    }
  }
  if (!unsubscribeRegistry) {
    unsubscribeRegistry = onHostRegistryChange(() => {
      if (listeners.size > 0) ensureWatchers();
    });
  }
}

function stopAll(): void {
  for (const entry of watches.values()) stopWatch(entry);
  watches.clear();
  unsubscribeRegistry?.();
  unsubscribeRegistry = null;
}

export function subscribeSessionFileChanges(listener: Listener): () => void {
  listeners.add(listener);
  ensureWatchers();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopAll();
  };
}
