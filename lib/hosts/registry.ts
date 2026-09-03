import { existsSync, statSync } from "fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "os";
import path from "path";
import { LOCAL_HOST_ID, getHostsFilePath, loadHostsFile, type LoadedHostsFile } from "./config";
import { LocalExecutor, SshExecutor, type HostExecutor } from "./executor";
import type { HostConfig, HostConnectionState, HostSummary } from "./types";

/**
 * Live host registry: one Host per configured machine, kept on globalThis so
 * hot reloads and route bundles share executors (and their ssh master
 * connections). hosts.json is re-read when its mtime changes.
 */

export class HostNotFoundError extends Error {
  readonly code = "host_not_found";
  readonly hostId: string;
  constructor(hostId: string) {
    super(`Unknown host "${hostId}"`);
    this.name = "HostNotFoundError";
    this.hostId = hostId;
  }
}

export class HostUnavailableError extends Error {
  readonly code = "host_unavailable";
  readonly hostId: string;
  constructor(hostId: string, detail: string) {
    super(`Host "${hostId}" is unavailable: ${detail}`);
    this.name = "HostUnavailableError";
    this.hostId = hostId;
  }
}

// After a failed probe, callers get the cached failure for this long instead
// of paying a fresh ssh timeout on every request.
const PROBE_RETRY_MS = 15_000;
const LOCAL_OMP_FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export class Host {
  readonly id: string;
  readonly name: string;
  readonly kind: HostConfig["kind"];
  readonly config: HostConfig;
  readonly executor: HostExecutor;
  status: HostConnectionState;
  lastError: string | null = null;
  home: string | null = null;
  tmp: string | null = null;
  platform: string | null = null;
  /** omp agent directory on the host (null until an ssh host is probed; the
   * local host resolves it through lib/omp/paths.ts). */
  agentDir: string | null = null;
  ompBin: string | null = null;
  ompVersion: string | null = null;
  probedAt = 0;
  private readyPromise: Promise<void> | null = null;
  private lastFailureAt = 0;

  constructor(config: HostConfig) {
    this.id = config.id;
    this.name = config.name;
    this.kind = config.kind;
    this.config = config;
    this.status = config.enabled ? "unknown" : "disabled";
    if (config.kind === "ssh") {
      if (!config.ssh) throw new Error(`ssh host "${config.id}" has no ssh settings`);
      this.executor = new SshExecutor(config.ssh);
    } else {
      this.executor = new LocalExecutor();
      this.home = osHomedir();
      this.tmp = osTmpdir();
      this.platform = process.platform;
    }
  }

  get isLocal(): boolean {
    return this.kind === "local";
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get fs(): HostExecutor["fs"] {
    return this.executor.fs;
  }

  /** Path separator on the host. Remote hosts are POSIX. */
  get pathApi(): typeof path.posix {
    return this.isLocal && process.platform === "win32" ? path.win32 : path.posix;
  }

  /** Ensure the host has been probed; throws HostUnavailableError when it cannot be reached. */
  async ready(): Promise<void> {
    if (!this.enabled) throw new HostUnavailableError(this.id, "host is disabled");
    if (this.status === "connected") return;
    if (this.lastFailureAt && Date.now() - this.lastFailureAt < PROBE_RETRY_MS) {
      throw new HostUnavailableError(this.id, this.lastError ?? "recent connection failure");
    }
    if (!this.readyPromise) {
      this.readyPromise = this.runProbe().finally(() => {
        this.readyPromise = null;
      });
    }
    return this.readyPromise;
  }

  /** Re-run the probe now, ignoring the failure backoff. */
  async refresh(): Promise<void> {
    this.lastFailureAt = 0;
    this.status = this.enabled ? "unknown" : "disabled";
    if (this.executor instanceof SshExecutor) {
      // Drop the cached tool-flavor probe so a reinstalled/replaced machine is
      // re-detected rather than reported with stale facts.
      await this.executor.reprobe().catch(() => {});
    }
    return this.ready();
  }

  private async runProbe(): Promise<void> {
    this.status = "connecting";
    try {
      const probe = await this.executor.probe();
      this.home = probe.home;
      this.tmp = probe.tmp;
      this.platform = probe.platform;
      if (!this.isLocal) {
        this.agentDir = this.config.agentDir
          ? this.config.agentDir.replace(/^~(?=\/|$)/, probe.home)
          : path.posix.join(probe.home, ".omp", "agent");
      }
      await this.probeOmp();
      this.status = "connected";
      this.lastError = null;
      this.probedAt = Date.now();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.status = "error";
      this.lastError = detail;
      this.lastFailureAt = Date.now();
      throw new HostUnavailableError(this.id, detail);
    }
  }

  private async probeOmp(): Promise<void> {
    const configured = this.config.ompBin;
    let bin: string | null = null;
    if (this.isLocal) {
      const override = process.env.OMP_WEB_OMP_BIN || configured;
      if (override) {
        bin = existsSync(override) ? override : null;
      } else {
        bin = await this.executor.which("omp");
        if (!bin) {
          const home = this.home ?? osHomedir();
          for (const dir of [...LOCAL_OMP_FALLBACK_DIRS, path.join(home, ".bun", "bin"), path.join(home, ".local", "bin")]) {
            const candidate = path.join(dir, process.platform === "win32" ? "omp.exe" : "omp");
            if (existsSync(candidate)) {
              bin = candidate;
              break;
            }
          }
        }
      }
    } else {
      bin = await this.executor.which(configured ?? "omp");
    }
    this.ompBin = bin;
    this.ompVersion = null;
    if (!bin) return;
    try {
      const { stdout } = await this.executor.exec([bin, "--version"], { timeoutMs: 20_000 });
      this.ompVersion = stdout.toString("utf8").trim() || null;
    } catch {
      this.ompVersion = null;
    }
  }

  /** Mark the omp probe stale (after `omp update`) so the next ready() re-reads it. */
  invalidateOmp(): void {
    this.ompVersion = null;
    if (this.status === "connected") this.status = "unknown";
  }

  summary(isDefault: boolean): HostSummary {
    const ssh = this.config.ssh;
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      enabled: this.enabled,
      isDefault,
      status: this.status,
      ...(ssh ? { ssh: { host: ssh.host, ...(ssh.user ? { user: ssh.user } : {}), ...(ssh.port ? { port: ssh.port } : {}), ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}) } } : {}),
      ...(this.config.ompBin ? { ompBin: this.config.ompBin } : {}),
      ...(this.config.agentDir ? { agentDir: this.config.agentDir } : {}),
      ...(this.config.defaultCwd ? { defaultCwd: this.config.defaultCwd } : {}),
      home: this.home,
      platform: this.platform,
      ompVersion: this.ompVersion,
      lastError: this.lastError,
      lastSyncAt: this.probedAt || null,
      lastSyncError: null,
    };
  }
}

interface RegistryState {
  hosts: Map<string, Host>;
  defaultId: string;
  filePath: string;
  fileMtimeMs: number;
  fileExists: boolean;
  checkedAt: number;
}

declare global {
  var __ompHostRegistry: RegistryState | undefined;
  var __ompHostRegistryListeners: Set<() => void> | undefined;
}

const FILE_CHECK_INTERVAL_MS = 2_000;

function listeners(): Set<() => void> {
  if (!globalThis.__ompHostRegistryListeners) globalThis.__ompHostRegistryListeners = new Set();
  return globalThis.__ompHostRegistryListeners;
}

function buildState(loaded: LoadedHostsFile, previous?: RegistryState): RegistryState {
  const hosts = new Map<string, Host>();
  for (const config of loaded.file.hosts) {
    const existing = previous?.hosts.get(config.id);
    // Reuse the live Host (and its ssh master) when the config is unchanged.
    if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) {
      hosts.set(config.id, existing);
    } else {
      hosts.set(config.id, new Host(config));
    }
  }
  return {
    hosts,
    defaultId: loaded.file.defaultHost ?? loaded.file.hosts[0].id,
    filePath: loaded.path,
    fileMtimeMs: loaded.mtimeMs,
    fileExists: loaded.exists,
    checkedAt: Date.now(),
  };
}

function fileChanged(state: RegistryState): boolean {
  const filePath = getHostsFilePath();
  if (filePath !== state.filePath) return true;
  try {
    const stat = statSync(filePath);
    return !state.fileExists || stat.mtimeMs !== state.fileMtimeMs;
  } catch {
    return state.fileExists;
  }
}

export function getHostRegistry(): RegistryState {
  const state = globalThis.__ompHostRegistry;
  if (state) {
    if (Date.now() - state.checkedAt < FILE_CHECK_INTERVAL_MS) return state;
    state.checkedAt = Date.now();
    if (!fileChanged(state)) return state;
    return reloadHostRegistry();
  }
  return reloadHostRegistry();
}

/** Re-read hosts.json now. A malformed file keeps the previous registry (or a
 * lone local host) and logs the problem instead of taking the server down. */
export function reloadHostRegistry(): RegistryState {
  const previous = globalThis.__ompHostRegistry;
  let loaded: LoadedHostsFile;
  try {
    loaded = loadHostsFile();
  } catch (error) {
    console.error(`[omp-web] hosts.json could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    if (previous) {
      previous.checkedAt = Date.now();
      return previous;
    }
    loaded = { file: { version: 1, defaultHost: LOCAL_HOST_ID, hosts: [{ id: LOCAL_HOST_ID, name: "This machine", kind: "local", enabled: true }] }, path: getHostsFilePath(), mtimeMs: 0, exists: false };
  }
  const next = buildState(loaded, previous);
  globalThis.__ompHostRegistry = next;
  const changed = !previous
    || previous.defaultId !== next.defaultId
    || previous.hosts.size !== next.hosts.size
    || [...next.hosts.entries()].some(([id, host]) => previous.hosts.get(id) !== host);
  if (changed) {
    for (const listener of listeners()) {
      try {
        listener();
      } catch {
        // One subscriber's failure must not stop the others.
      }
    }
  }
  return next;
}

export function onHostRegistryChange(listener: () => void): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function listHosts(options: { includeDisabled?: boolean } = {}): Host[] {
  const hosts = [...getHostRegistry().hosts.values()];
  return options.includeDisabled ? hosts : hosts.filter((host) => host.enabled);
}

export function getHost(id: string): Host | undefined {
  return getHostRegistry().hosts.get(id);
}

export function requireHost(id: string): Host {
  const host = getHost(id);
  if (!host) throw new HostNotFoundError(id);
  return host;
}

export function getDefaultHostId(): string {
  return getHostRegistry().defaultId;
}

export function getDefaultHost(): Host {
  const state = getHostRegistry();
  const preferred = state.hosts.get(state.defaultId);
  if (preferred?.enabled) return preferred;
  const firstEnabled = [...state.hosts.values()].find((host) => host.enabled);
  if (firstEnabled) return firstEnabled;
  // Nothing enabled: still hand back something so read-only paths degrade
  // to "no sessions" rather than crashing.
  return preferred ?? [...state.hosts.values()][0];
}

export function getLocalHost(): Host | undefined {
  return [...getHostRegistry().hosts.values()].find((host) => host.isLocal);
}

/** Host used by code that runs outside any request context (startup warm-up,
 * timers). Prefers the local machine when it is enabled so hermetic tests and
 * legacy single-machine setups behave exactly as before. */
export function getFallbackHost(): Host {
  const local = getLocalHost();
  return local?.enabled ? local : getDefaultHost();
}

export function hostSummaries(options: { includeDisabled?: boolean } = { includeDisabled: true }): HostSummary[] {
  const state = getHostRegistry();
  return [...state.hosts.values()]
    .filter((host) => options.includeDisabled || host.enabled)
    .map((host) => host.summary(host.id === state.defaultId));
}
