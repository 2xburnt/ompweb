import { randomBytes } from "crypto";
import { stripAnsi } from "../ansi";
import { currentHost, withHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { isRecord } from "../type-guards";
import { existingPaths, FileTooLargeError, isExistsError, readTextFile, runHostScript } from "./host-io";
import { resolveOmpBin } from "./omp-cli";
import { getAgentDir, hostHomedir } from "./paths";

const MAX_MCP_CONFIG_BYTES = 512 * 1024;
const MAX_DISCOVERED_MCP_CONFIG_BYTES = 5 * 1024 * 1024;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MCP_FILENAMES: ReadonlyArray<readonly string[]> = [[".omp", "mcp.json"], [".omp", ".mcp.json"], ["mcp.json"], [".mcp.json"]];

export type McpServer = Record<string, unknown>;
export type McpFile = Record<string, unknown> & { mcpServers?: Record<string, McpServer> };
export type McpUserConfig = {
  path: string;
  servers: Array<{ name: string; config: McpServer }>;
  disabledServers: string[];
  error?: string;
};

export type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
export type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

/** Browser-facing project config must never expose environment variables or HTTP headers. */
export function redactMcpServer(server: McpServer): McpServer {
  const safe = { ...server };
  delete safe.env;
  delete safe.headers;
  return safe;
}

function serverEntries(config: McpFile): Array<{ name: string; config: McpServer }> {
  return Object.entries(config.mcpServers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => ({ name, config: server }));
}

function parseMcpUserConfigText(path: string, text: string): McpUserConfig {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("configuration must contain a JSON object");
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) throw new Error("mcpServers must be an object");
    return {
      path,
      servers: serverEntries(parsed as McpFile),
      disabledServers: Array.isArray(parsed.disabledServers)
        ? parsed.disabledServers.filter((name): name is string => typeof name === "string").sort((a, b) => a.localeCompare(b))
        : [],
    };
  } catch (error) {
    return { path, servers: [], disabledServers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function readMcpUserConfig(host: Host, path: string): Promise<McpUserConfig> {
  let text: string | null;
  try {
    text = await readTextFile(host, path, MAX_DISCOVERED_MCP_CONFIG_BYTES);
  } catch (error) {
    const message = error instanceof FileTooLargeError ? "configuration is too large to inspect" : error instanceof Error ? error.message : String(error);
    return { path, servers: [], disabledServers: [], error: message };
  }
  if (text === null) return { path, servers: [], disabledServers: [] };
  return parseMcpUserConfigText(path, text);
}

/** OMP's active user-level server configuration. This is deliberately separate
 * from compatibility providers such as Claude Code, which do not describe the
 * MCP connections owned by OMP. */
export function readUserMcpConfig(path?: string, host: Host = currentHost()): Promise<McpUserConfig> {
  const resolved = path ?? withHost(host, () => host.pathApi.join(getAgentDir(), "mcp.json"));
  return readMcpUserConfig(host, resolved);
}

function sourceName(host: Host, path: string): string {
  const pathApi = host.pathApi;
  const name = pathApi.basename(path) === ".claude.json" ? ".claude" : pathApi.basename(pathApi.dirname(path));
  if (name === ".claude") return "Claude Code";
  if (name === ".codex") return "Codex";
  if (name === ".cursor") return "Cursor";
  if (name === ".vscode") return "VS Code";
  return name.replace(/^\./, "") || "Configured";
}

const ROOT_LEVEL_CANDIDATES = [".claude.json", "mcp.json", ".mcp.json"] as const;
const DOT_DIR_CANDIDATES = ["mcp.json", "config.json", "config.toml"] as const;

/** A discovered provider config: `text` is null when the file was too large. */
type DiscoveredFile = { path: string; text: string | null };

async function discoverMcpConfigFilesLocally(host: Host, roots: readonly string[]): Promise<DiscoveredFile[]> {
  const pathApi = host.pathApi;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const candidates = ROOT_LEVEL_CANDIDATES.map((name) => pathApi.join(root, name));
    try {
      const entries = (await host.fs.readdir(root))
        .filter((entry) => entry.name.startsWith(".") && (entry.isDirectory() || entry.targetType === "dir"))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        for (const name of DOT_DIR_CANDIDATES) candidates.push(pathApi.join(root, entry.name, name));
      }
    } catch {
      // An unavailable workspace simply has no discoverable provider configs.
    }
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
  }
  const files: DiscoveredFile[] = [];
  for (const path of paths) {
    try {
      const text = await readTextFile(host, path, MAX_DISCOVERED_MCP_CONFIG_BYTES);
      if (text !== null) files.push({ path, text });
    } catch (error) {
      if (error instanceof FileTooLargeError) files.push({ path, text: null });
      // Unreadable candidates are skipped like missing ones.
    }
  }
  return files;
}

/** One round trip: every existing candidate file under every root, framed as
 * "H <path>\n" + up to MAX+1 bytes + sentinel. */
async function discoverMcpConfigFilesRemotely(host: Host, roots: readonly string[]): Promise<DiscoveredFile[]> {
  const sentinel = `--omp-web-${randomBytes(12).toString("hex")}--`;
  const script = [
    'S="$1"; MAX="$2"; shift 2',
    'emit() { [ -f "$1" ] || return 0; printf "H %s\\n" "$1"; head -c "$MAX" -- "$1" 2>/dev/null; printf "%s" "$S"; }',
    'for root in "$@"; do',
    '  [ -d "$root" ] || continue',
    `  ${ROOT_LEVEL_CANDIDATES.map((name) => `emit "$root/${name}"`).join("; ")}`,
    '  for d in "$root"/.*/; do',
    '    d="${d%/}"; b="${d##*/}"',
    '    case "$b" in .|..) continue;; esac',
    '    [ -d "$d" ] || continue',
    `    ${DOT_DIR_CANDIDATES.map((name) => `emit "$d/${name}"`).join("; ")}`,
    "  done",
    "done",
    "exit 0",
  ].join("\n");
  const { stdout } = await runHostScript(host, script, [sentinel, String(MAX_DISCOVERED_MCP_CONFIG_BYTES + 1), ...roots], {
    maxBuffer: 64 * 1024 * 1024,
    timeoutMs: 2 * 60_000,
  });
  const sentinelBuffer = Buffer.from(sentinel, "utf8");
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < stdout.length) {
    const lineEnd = stdout.indexOf(0x0a, offset);
    if (lineEnd === -1) break;
    const header = stdout.subarray(offset, lineEnd).toString("utf8");
    offset = lineEnd + 1;
    if (!header.startsWith("H ")) break;
    const bodyEnd = stdout.indexOf(sentinelBuffer, offset);
    if (bodyEnd === -1) break;
    const body = stdout.subarray(offset, bodyEnd);
    offset = bodyEnd + sentinelBuffer.length;
    const path = header.slice(2);
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, text: body.length > MAX_DISCOVERED_MCP_CONFIG_BYTES ? null : body.toString("utf8") });
  }
  return files;
}

function readTomlMcpServers(text: string, source: string, disabledNames: Set<string>): McpLiveServer[] {
  const sections = [...text.matchAll(/^\s*\[mcp_servers(?:\.([A-Za-z0-9_-]+)|\."([^"]+)")\]\s*$/gm)];
  return sections.flatMap((section, index) => {
    const name = section[1] ?? section[2];
    if (!name || disabledNames.has(name)) return [];
    const body = text.slice((section.index ?? 0) + section[0].length, sections[index + 1]?.index);
    return [{ name, source, status: /^\s*enabled\s*=\s*false\s*$/m.test(body) ? "disabled" as const : "configured" as const, type: /^\s*url\s*=/m.test(body) ? "http" : "stdio" }];
  });
}

/** Read installed provider configs by MCP schema, never by individual server name. */
export async function readDiscoveredMcpServers(cwd?: string, disabled = [] as string[], host: Host = currentHost()): Promise<McpLiveServer[]> {
  const disabledNames = new Set(disabled);
  const roots = [withHost(host, () => hostHomedir())];
  if (cwd && !roots.includes(cwd)) roots.push(cwd);
  const files = host.isLocal
    ? await discoverMcpConfigFilesLocally(host, roots)
    : await discoverMcpConfigFilesRemotely(host, roots);
  const servers: McpLiveServer[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.text === null) continue;
    const source = sourceName(host, file.path);
    if (file.path.endsWith(".toml")) {
      for (const server of readTomlMcpServers(file.text, source, disabledNames)) {
        const key = `${server.source}:${server.name}`;
        if (!seen.has(key)) { seen.add(key); servers.push(server); }
      }
      continue;
    }
    const config = parseMcpUserConfigText(file.path, file.text);
    for (const server of config.servers) {
      if (disabledNames.has(server.name)) continue;
      const key = `${source}:${server.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const type = typeof server.config.type === "string" ? server.config.type : typeof server.config.url === "string" ? "http" : "stdio";
      servers.push({ name: server.name, source, status: server.config.enabled === false ? "disabled" : "configured", type });
    }
  }
  return servers;
}

/** Parse the text emitted by OMP's local `/mcp list` command. */
export function parseMcpListOutput(output: string): McpLiveServer[] {
  const servers: McpLiveServer[] = [];
  let source: string | null = null;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(.+?)\s+\([^)]*\):$/);
    if (heading) {
      source = heading[1];
      continue;
    }
    const server = line.match(/^(.+?)\s+[●◌○]\s+(connected|connecting|not connected|inactive|disabled)(?:\s+\[([^\]]+)\])?$/);
    if (!server || !source) continue;
    const status: Record<string, McpLiveStatus> = {
      connected: "connected",
      connecting: "connecting",
      "not connected": "not_connected",
      inactive: "inactive",
      disabled: "disabled",
    };
    servers.push({ name: server[1].trim(), source, status: status[server[2]], type: server[3] });
  }
  // rpc-ui uses a compact `/mcp list` representation instead of the TUI's
  // colour/status table: `name | transport | enabled | target [source]`.
  // It does not expose a connection state, so retain that distinction rather
  // than falsely treating an enabled configuration as connected.
  if (servers.length > 0) return servers;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const server = line.match(/^(.+?)\s+\|\s+([^|]+?)\s+\|\s+(enabled|disabled)\s+\|\s+.*?(?:\s+\[([^\]]+)\])?$/);
    if (!server) continue;
    const source = server[4] === "user" ? "User level" : server[4] === "project" ? "Project level" : "Configured";
    servers.push({ name: server[1].trim(), source, status: server[3] === "enabled" ? "configured" : "disabled", type: server[2].trim() });
  }
  return servers;
}

/** `omp mcp list` on the host: the CLI view of every configured server. */
export async function runOmpMcpList(cwd: string | undefined, host: Host = currentHost()): Promise<McpLiveServer[]> {
  const bin = resolveOmpBin(host);
  if (!bin) throw new Error(host.isLocal ? "omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN." : `omp binary not found on host "${host.id}"`);
  const result = await host.executor.exec([bin, "mcp", "list"], {
    cwd,
    timeoutMs: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
    allowFailure: true,
  });
  const stdout = result.stdout.toString("utf8");
  if (result.code !== 0) throw new Error(stripAnsi(result.stderr || stdout).trim().slice(-600) || `omp mcp list exited with ${result.code}`);
  return parseMcpListOutput(stdout);
}

function stringRecord(value: unknown, name: string): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error(`${name} must map strings to strings`);
}

const projectRootCache = new Map<string, { root: string; expiresAt: number }>();
const PROJECT_ROOT_TTL_MS = 30_000;

async function projectRoot(host: Host, cwd: string): Promise<string> {
  const key = `${host.id}\0${cwd}`;
  const cached = projectRootCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.root;
  const pathApi = host.pathApi;
  let root: string;
  try {
    const result = await host.executor.exec(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 15_000, allowFailure: true, env: { LC_ALL: "C" } });
    const top = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
    root = top ? pathApi.resolve(top) : pathApi.resolve(cwd);
  } catch {
    root = pathApi.resolve(cwd);
  }
  if (projectRootCache.size > 500) projectRootCache.clear();
  projectRootCache.set(key, { root, expiresAt: Date.now() + PROJECT_ROOT_TTL_MS });
  return root;
}

function assertCwdWithinRoot(host: Host, cwd: string, root: string): void {
  const pathApi = host.pathApi;
  const path = pathApi.relative(root, cwd);
  if (path === ".." || path.startsWith(`..${pathApi.sep}`)) throw new Error("Project root does not contain workspace");
}

export async function resolveMcpConfig(cwd: string, host: Host = currentHost()): Promise<{ root: string; path: string }> {
  const root = await projectRoot(host, cwd);
  assertCwdWithinRoot(host, cwd, root);
  const candidates = MCP_FILENAMES.map((parts) => host.pathApi.join(root, ...parts));
  const present = await existingPaths(host, candidates);
  const existing = candidates.find((candidate) => present.has(candidate));
  return { root, path: existing ?? candidates[0] };
}

export async function readMcpConfig(cwd: string, host: Host = currentHost()): Promise<{ root: string; path: string; config: McpFile; exists: boolean }> {
  const resolved = await resolveMcpConfig(cwd, host);
  let text: string | null;
  try {
    text = await readTextFile(host, resolved.path, MAX_MCP_CONFIG_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) throw new Error("MCP configuration is too large to edit in omp-web");
    throw error;
  }
  if (text === null) return { ...resolved, config: { mcpServers: {} }, exists: false };
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${resolved.path} is not valid JSON`);
  }
  if (!isRecord(config)) throw new Error(`${resolved.path} must contain a JSON object`);
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) throw new Error("mcpServers must be an object");
  return { ...resolved, config: config as McpFile, exists: true };
}

export function validateMcpServer(name: unknown, server: unknown): asserts server is McpServer {
  if (typeof name !== "string" || !SERVER_NAME.test(name)) throw new Error("Server name may contain letters, numbers, dots, dashes, and underscores");
  if (!isRecord(server)) throw new Error("Server configuration must be an object");
  const type = server.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") throw new Error("Server type must be stdio, http, or sse");
  const hasCommand = typeof server.command === "string" && server.command.trim().length > 0;
  const hasUrl = typeof server.url === "string" && server.url.trim().length > 0;
  if (hasCommand === hasUrl) throw new Error("Provide exactly one of command or url");
  if ((type === undefined || type === "stdio") && !hasCommand) throw new Error("A stdio server requires a command");
  if ((type === "http" || type === "sse") && !hasUrl) throw new Error("An HTTP or SSE server requires a URL");
  if (hasUrl) {
    try {
      const url = new URL(server.url as string);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Server URL must be an http or https URL");
    }
  }
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))) throw new Error("args must be an array of strings");
  if (server.env !== undefined) stringRecord(server.env, "env");
  if (server.headers !== undefined) stringRecord(server.headers, "headers");
  if (server.cwd !== undefined && typeof server.cwd !== "string") throw new Error("cwd must be a string");
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (server.timeout !== undefined && (!Number.isInteger(server.timeout) || (server.timeout as number) < 0 || (server.timeout as number) > 600_000)) throw new Error("timeout must be an integer between 0 and 600000");
  if (server.requestIdFormat !== undefined && server.requestIdFormat !== "number" && server.requestIdFormat !== "string") throw new Error("requestIdFormat must be number or string");
}

// Cross-process mutex for MCP config read-modify-write cycles. The dev server
// (30178) and the installed production app (30177) can edit the same project's
// mcp.json at the same time; without a lock the later rename would silently
// overwrite the earlier mutation (add vs delete lost update). A lock
// *directory* is created with a plain (non-recursive) mkdir, which is atomic
// on every platform and needs nothing beyond HostFs on a remote host; the
// holder removes it on completion. Stale locks (writer crashed) are broken
// after a grace period.
const MCP_LOCK_TIMEOUT_MS = 3_000;
const MCP_LOCK_STALE_MS = 10_000;
const MCP_LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMcpConfigLock<T>(host: Host, configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + MCP_LOCK_TIMEOUT_MS;
  // The config file may not exist yet (first write) — the lock needs its
  // parent dir to exist before exclusive-create can succeed.
  await host.fs.mkdir(host.pathApi.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await host.fs.mkdir(lockPath);
    } catch (error) {
      if (!isExistsError(error)) throw error;
      // Held by another process — break it if stale, otherwise wait and retry.
      try {
        if (Date.now() - (await host.fs.lstat(lockPath)).mtimeMs > MCP_LOCK_STALE_MS) {
          await host.fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between mkdir and lstat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${lockPath} (another process holds the MCP config lock)`);
      }
      await sleep(MCP_LOCK_RETRY_MS);
      continue;
    }
    try {
      return await fn();
    } finally {
      await host.fs.rm(lockPath, { recursive: true, force: true }).catch(() => {
        // Already removed (e.g. by cleanup) — the critical section is done.
      });
    }
  }
}

async function writeMcpFile(host: Host, path: string, config: McpFile): Promise<void> {
  await host.fs.mkdir(host.pathApi.dirname(path), { recursive: true });
  // Atomic on the host (temp file + rename).
  await host.fs.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeMcpServer(cwd: string, name: string, server: McpServer, previousName?: string, host: Host = currentHost()): Promise<{ path: string }> {
  validateMcpServer(name, server);
  if (previousName !== undefined && !SERVER_NAME.test(previousName)) throw new Error("Invalid previous server name");
  const current = await readMcpConfig(cwd, host);
  return withMcpConfigLock(host, current.path, async () => {
    // Re-read INSIDE the lock so a concurrent writer's mutation is not lost.
    const locked = await readMcpConfig(cwd, host);
    const servers = { ...(locked.config.mcpServers ?? {}) };
    // Capture the old entry before deleting it: a rename must retain credentials
    // that the browser intentionally redacts from its payload.
    const previous = servers[previousName ?? name];
    if (previousName && previousName !== name) delete servers[previousName];
    // The browser never receives existing credentials. Preserve them when an
    // edited server omits those fields, rather than deleting them on save.
    servers[name] = {
      ...server,
      ...(previous?.env !== undefined && server.env === undefined ? { env: previous.env } : {}),
      ...(previous?.headers !== undefined && server.headers === undefined ? { headers: previous.headers } : {}),
    };
    await writeMcpFile(host, locked.path, { ...locked.config, mcpServers: servers });
    return { path: locked.path };
  });
}

export async function deleteMcpServer(cwd: string, name: string, host: Host = currentHost()): Promise<{ path: string }> {
  if (!SERVER_NAME.test(name)) throw new Error("Invalid server name");
  const current = await readMcpConfig(cwd, host);
  return withMcpConfigLock(host, current.path, async () => {
    const locked = await readMcpConfig(cwd, host);
    const servers = { ...(locked.config.mcpServers ?? {}) };
    if (!(name in servers)) throw new Error("MCP server was not found");
    delete servers[name];
    await writeMcpFile(host, locked.path, { ...locked.config, mcpServers: servers });
    return { path: locked.path };
  });
}
