import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { HostConfig, HostKind, HostsFile, SshHostConfig } from "./types";

/**
 * Persistent host configuration: ~/.omp-web/hosts.json (override the app
 * home with OMP_WEB_HOME, or the file itself with OMP_WEB_HOSTS_FILE).
 *
 * Missing file = single local host, which is the pre-multi-machine behavior.
 */

export const LOCAL_HOST_ID = "local";
const HOST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_NAME_LENGTH = 80;

export class HostConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostConfigError";
    this.code = code;
  }
}

export function getOmpWebHome(): string {
  const override = process.env.OMP_WEB_HOME;
  return override ? resolve(override) : join(homedir(), ".omp-web");
}

export function getHostsFilePath(): string {
  const override = process.env.OMP_WEB_HOSTS_FILE;
  return override ? resolve(override) : join(getOmpWebHome(), "hosts.json");
}

export function defaultLocalHostConfig(): HostConfig {
  return { id: LOCAL_HOST_ID, name: "This machine", kind: "local", enabled: true };
}

export function defaultHostsFile(): HostsFile {
  return { version: 1, defaultHost: LOCAL_HOST_ID, hosts: [defaultLocalHostConfig()] };
}

export function isValidHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID_RE.test(value);
}

/** Derive a host id from a display name or ssh target ("Hetzner box" -> "hetzner-box"). */
export function slugifyHostId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return HOST_ID_RE.test(slug) ? slug : "";
}

function optionalString(value: unknown, field: string, maxLength = 4096): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HostConfigError("invalid_field", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new HostConfigError("invalid_field", `${field} is too long`);
  if (/[\0\r\n]/.test(trimmed)) throw new HostConfigError("invalid_field", `${field} contains control characters`);
  return trimmed;
}

function normalizeSsh(value: unknown): SshHostConfig {
  if (!value || typeof value !== "object") throw new HostConfigError("ssh_required", "ssh settings are required for an ssh host");
  const raw = value as Record<string, unknown>;
  const host = optionalString(raw.host, "ssh.host", 253);
  if (!host) throw new HostConfigError("ssh_host_required", "ssh.host is required");
  // Leading "-" would let a host string inject ssh options.
  if (host.startsWith("-")) throw new HostConfigError("invalid_field", "ssh.host cannot start with '-'");
  const user = optionalString(raw.user, "ssh.user", 64);
  if (user && (user.startsWith("-") || /\s/.test(user))) throw new HostConfigError("invalid_field", "ssh.user is invalid");
  let port: number | undefined;
  if (raw.port !== undefined && raw.port !== null && raw.port !== "") {
    const parsed = typeof raw.port === "number" ? raw.port : Number.parseInt(String(raw.port), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new HostConfigError("invalid_field", "ssh.port must be 1-65535");
    port = parsed;
  }
  const identityFile = optionalString(raw.identityFile, "ssh.identityFile");
  if (identityFile?.startsWith("-")) throw new HostConfigError("invalid_field", "ssh.identityFile cannot start with '-'");
  return { host, ...(user ? { user } : {}), ...(port ? { port } : {}), ...(identityFile ? { identityFile } : {}) };
}

/** Validate and normalize one host entry. Throws HostConfigError. */
export function normalizeHostConfig(input: unknown): HostConfig {
  if (!input || typeof input !== "object") throw new HostConfigError("invalid_host", "host must be an object");
  const raw = input as Record<string, unknown>;
  if (!isValidHostId(raw.id)) {
    throw new HostConfigError("invalid_id", "host id must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  const kind = raw.kind === "ssh" || raw.kind === "local" ? (raw.kind as HostKind) : undefined;
  if (!kind) throw new HostConfigError("invalid_kind", "host kind must be \"local\" or \"ssh\"");
  const name = optionalString(raw.name, "name", MAX_NAME_LENGTH) ?? raw.id;
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  const ompBin = optionalString(raw.ompBin, "ompBin");
  if (ompBin?.startsWith("-")) throw new HostConfigError("invalid_field", "ompBin cannot start with '-'");
  const agentDir = optionalString(raw.agentDir, "agentDir");
  const defaultCwd = optionalString(raw.defaultCwd, "defaultCwd");
  const config: HostConfig = { id: raw.id, name, kind, enabled };
  if (kind === "ssh") config.ssh = normalizeSsh(raw.ssh);
  if (ompBin) config.ompBin = ompBin;
  if (agentDir) config.agentDir = agentDir;
  if (defaultCwd) config.defaultCwd = defaultCwd;
  return config;
}

export function parseHostsFile(raw: string): HostsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HostConfigError("invalid_json", `hosts.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new HostConfigError("invalid_file", "hosts.json must be an object");
  const file = parsed as Record<string, unknown>;
  const hostsRaw = Array.isArray(file.hosts) ? file.hosts : [];
  const hosts: HostConfig[] = [];
  const seen = new Set<string>();
  for (const entry of hostsRaw) {
    const host = normalizeHostConfig(entry);
    if (seen.has(host.id)) throw new HostConfigError("duplicate_id", `duplicate host id "${host.id}"`);
    seen.add(host.id);
    hosts.push(host);
  }
  if (hosts.length === 0) hosts.push(defaultLocalHostConfig());
  let defaultHost = isValidHostId(file.defaultHost) ? file.defaultHost : undefined;
  if (!defaultHost || !hosts.some((h) => h.id === defaultHost)) {
    defaultHost = pickDefaultHostId(hosts);
  }
  return { version: 1, defaultHost, hosts };
}

/** The first enabled host; prefers "local" only when nothing else is enabled. */
export function pickDefaultHostId(hosts: readonly HostConfig[]): string {
  const enabled = hosts.filter((h) => h.enabled);
  const firstRemote = enabled.find((h) => h.kind === "ssh");
  return (firstRemote ?? enabled[0] ?? hosts[0]).id;
}

export interface LoadedHostsFile {
  file: HostsFile;
  path: string;
  /** mtimeMs of the file, 0 when it does not exist. */
  mtimeMs: number;
  exists: boolean;
}

export function loadHostsFile(filePath = getHostsFilePath()): LoadedHostsFile {
  if (!existsSync(filePath)) {
    return { file: defaultHostsFile(), path: filePath, mtimeMs: 0, exists: false };
  }
  const raw = readFileSync(filePath, "utf8");
  const file = parseHostsFile(raw);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // Racing deletion: treat as absent on the next reload.
  }
  return { file, path: filePath, mtimeMs, exists: true };
}

export function saveHostsFile(file: HostsFile, filePath = getHostsFilePath()): void {
  // Re-validate through the parser so a programming error can never persist
  // a file the next boot refuses to load.
  const normalized = parseHostsFile(JSON.stringify(file));
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, filePath);
}

/** Immutable update helpers used by the hosts API. */
export function upsertHostConfig(file: HostsFile, host: HostConfig): HostsFile {
  const hosts = file.hosts.some((h) => h.id === host.id)
    ? file.hosts.map((h) => (h.id === host.id ? host : h))
    : [...file.hosts, host];
  return { ...file, hosts };
}

export function removeHostConfig(file: HostsFile, id: string): HostsFile {
  const hosts = file.hosts.filter((h) => h.id !== id);
  const defaultHost = file.defaultHost === id ? pickDefaultHostId(hosts.length ? hosts : [defaultLocalHostConfig()]) : file.defaultHost;
  return { ...file, defaultHost, hosts };
}
