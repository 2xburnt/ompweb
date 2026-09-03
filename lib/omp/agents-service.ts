import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { currentHost, withHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { isRecord } from "../type-guards";
import { isMissingFileError, readTextFile, runHostScript, scanTextFiles } from "./host-io";
import { resolveOmpBin } from "./omp-cli";
import { getAgentsBundledCacheDir, getUserAgentsDir, hostHomedir, resolveProjectAgentsDir } from "./paths";

export type AgentSource = "bundled" | "user" | "project";
export type AgentInfo = {
  name: string;
  description: string;
  model?: string[];
  tools?: string[];
  spawns?: string[] | "*";
  thinkingLevel?: string;
  output?: unknown;
  blocking?: boolean;
  prewalk?: boolean | string;
  advisor?: boolean | string;
  source: AgentSource;
  scope: "user" | "project" | "bundled";
  filePath: string;
  valid: boolean;
  enabled: boolean;
  body?: string;
  rawFrontmatter?: Record<string, unknown>;
};

export type AgentDiagnostic = { type: "error" | "warning" | "info"; message: string; path?: string };
export type ParsedAgentFrontmatter = { frontmatter: Record<string, unknown>; body: string };
export type AgentPayload = {
  name?: unknown;
  description: string;
  model?: unknown;
  tools?: unknown;
  thinkingLevel?: unknown;
  spawns?: unknown;
  body?: unknown;
  prewalk?: unknown;
  advisor?: unknown;
  output?: unknown;
  blocking?: unknown;
  enabled?: unknown;
  existingFrontmatter?: unknown;
};

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const MAX_AGENT_BYTES = 512 * 1024;

declare global {
  var __ompBundledAgentsCache: Map<string, { path: string; checkedAt: number }> | undefined;
}

export function parseAgentFrontmatter(content: string): ParsedAgentFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return {
      frontmatter: isRecord(parsed) ? parsed : {},
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

type AgentScanRoot = { dir: string; source: AgentSource; scope: "user" | "project" | "bundled" };

/** Where omp's bundled agents are unpacked for inspection: a temp directory on
 * the host that runs omp (its bundled set depends on the installed version). */
export function getBundledAgentsCacheDir(host: Host = currentHost()): string {
  if (host.isLocal) return getAgentsBundledCacheDir();
  return host.pathApi.join(host.tmp ?? "/tmp", "omp-web-bundled-agents");
}

export async function buildAgentScanRoots(cwd?: string, host: Host = currentHost()): Promise<AgentScanRoot[]> {
  const roots: AgentScanRoot[] = [
    { dir: getBundledAgentsCacheDir(host), source: "bundled", scope: "bundled" },
  ];
  if (cwd) roots.push({ dir: await withHost(host, () => resolveProjectAgentsDir(cwd)), source: "project", scope: "project" });
  roots.push({ dir: withHost(host, () => getUserAgentsDir()), source: "user", scope: "user" });
  return roots;
}

export async function getAgentScanRootDirs(cwd?: string, host: Host = currentHost()): Promise<string[]> {
  return (await buildAgentScanRoots(cwd, host)).map((root) => root.dir);
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  throw new Error(`${field} must be a string array or comma-separated string`);
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>): Omit<AgentInfo, "source" | "scope" | "filePath" | "valid"> {
  const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  const safeArray = (value: unknown, field: string): string[] | undefined => { try { return asStringArray(value, field); } catch { return undefined; } };
  const model = safeArray(frontmatter.model, "model");
  const tools = safeArray(frontmatter.tools, "tools");
  const spawns = frontmatter.spawns === "*" ? "*" : safeArray(frontmatter.spawns, "spawns");
  const thinkingLevel = typeof frontmatter.thinkingLevel === "string" ? frontmatter.thinkingLevel : undefined;
  const boolOrString = (value: unknown): boolean | string | undefined => typeof value === "boolean" || typeof value === "string" ? value : undefined;
  return {
    name: rawName, description, model, tools, spawns, thinkingLevel,
    output: frontmatter.output,
    blocking: typeof frontmatter.blocking === "boolean" ? frontmatter.blocking : undefined,
    prewalk: boolOrString(frontmatter.prewalk),
    advisor: boolOrString(frontmatter.advisor),
    enabled: frontmatter.enabled !== false,
    body: undefined,
    rawFrontmatter: frontmatter,
  };
}

function validateFrontmatter(frontmatter: Record<string, unknown>, filename?: string): string[] {
  const errors: string[] = [];
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (!AGENT_NAME_RE.test(name)) errors.push(`name must match ${AGENT_NAME_RE.source}`);
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) errors.push("description is required");
  for (const field of ["model", "tools"] as const) {
    try { asStringArray(frontmatter[field], field); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (frontmatter.spawns !== undefined && frontmatter.spawns !== "*") {
    try { asStringArray(frontmatter.spawns, "spawns"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (frontmatter.thinkingLevel !== undefined && (typeof frontmatter.thinkingLevel !== "string" || !THINKING_LEVELS.has(frontmatter.thinkingLevel))) errors.push("thinkingLevel is invalid");
  for (const field of ["blocking"] as const) if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean") errors.push(`${field} must be a boolean`);
  for (const field of ["prewalk", "advisor"] as const) if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean" && typeof frontmatter[field] !== "string") errors.push(`${field} must be a boolean or string`);
  if (filename && !name) errors.push(`invalid agent file ${filename}`);
  return errors;
}

function infoFromContent(host: Host, content: string, filePath: string, source: AgentSource, scope: AgentInfo["scope"], fallbackName?: string): AgentInfo {
  const { frontmatter, body } = parseAgentFrontmatter(content);
  const normalized = normalizeFrontmatter(frontmatter);
  const fileName = host.pathApi.basename(filePath);
  const errors = validateFrontmatter(frontmatter, fileName);
  return { ...normalized, name: normalized.name || fallbackName || fileName.replace(/\.md$/i, ""), body, filePath, source, scope, valid: errors.length === 0, rawFrontmatter: frontmatter };
}

/** Read every agent file under every root — one round trip on a remote host. */
async function scanRoots(host: Host, roots: AgentScanRoot[], diagnostics: AgentDiagnostic[]): Promise<AgentInfo[]> {
  const scan = await scanTextFiles(host, roots.map((root) => root.dir), "markdown-files", MAX_AGENT_BYTES);
  for (const dir of scan.symlinkRoots) diagnostics.push({ type: "warning", message: "Skipped symbolic-link agents directory", path: dir });
  for (const dir of scan.unreadableRoots) diagnostics.push({ type: "warning", message: "Failed to read agents directory", path: dir });
  for (const filePath of scan.unreadableFiles) diagnostics.push({ type: "warning", message: "Failed to read agent file", path: filePath });
  const agents: AgentInfo[] = [];
  for (const root of roots) {
    const files = scan.files.filter((file) => file.root === root.dir).sort((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      if (file.truncated) {
        diagnostics.push({ type: "warning", message: "Agent file is too large to inspect", path: file.path });
        continue;
      }
      const fallbackName = host.pathApi.basename(file.path).replace(/\.md$/i, "");
      const info = infoFromContent(host, file.content, file.path, root.source, root.scope, fallbackName);
      if (!info.valid) diagnostics.push({ type: "warning", message: `Invalid agent ${info.name}: ${validateFrontmatter(info.rawFrontmatter ?? {}).join(", ")}`, path: file.path });
      agents.push(info);
    }
  }
  return agents;
}

async function listMarkdownNames(host: Host, dir: string): Promise<string[]> {
  try {
    return (await host.fs.readdir(dir)).filter((entry) => entry.name.toLowerCase().endsWith(".md")).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

/** `omp agents unpack` on the host: writes the bundled agents into targetDir. */
export async function unpackBundled(targetDir: string, force = false, host: Host = currentHost()): Promise<{ targetDir: string; total: number; written: number; skipped: number }> {
  const safeTargetDir = await secureScopeDir(targetDir, host);
  const before = new Set(await listMarkdownNames(host, safeTargetDir));
  const bin = resolveOmpBin(host) ?? "omp";
  await host.executor.exec([bin, "agents", "unpack", "--dir", safeTargetDir, "--json", ...(force ? ["--force"] : [])], {
    timeoutMs: 2 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const after = await listMarkdownNames(host, safeTargetDir);
  const written = after.filter((name) => !before.has(name)).length;
  return { targetDir, total: after.length, written, skipped: Math.max(0, after.length - written) };
}

export async function ensureBundledAgentsCache(host: Host = currentHost()): Promise<string> {
  const cacheDir = getBundledAgentsCacheDir(host);
  const caches = (globalThis.__ompBundledAgentsCache ??= new Map());
  const cached = caches.get(host.id);
  if (cached && cached.path === cacheDir && Date.now() - cached.checkedAt < 60_000) return cacheDir;
  await host.fs.mkdir(cacheDir, { recursive: true });
  const files = await listMarkdownNames(host, cacheDir);
  if (files.length === 0 && (!cached || Date.now() - cached.checkedAt >= 60_000)) {
    try { await unpackBundled(cacheDir, false, host); } catch { /* discovery reports the missing/failed binary */ }
  }
  caches.set(host.id, { path: cacheDir, checkedAt: Date.now() });
  return cacheDir;
}

export async function discoverAgents(cwd?: string, host: Host = currentHost()): Promise<{ agents: AgentInfo[]; diagnostics: AgentDiagnostic[]; bundledPath?: string }> {
  const diagnostics: AgentDiagnostic[] = [];
  const roots = await buildAgentScanRoots(cwd, host);
  const bundledPath = await ensureBundledAgentsCache(host);
  if (!resolveOmpBin(host)) diagnostics.push({ type: "error", message: "omp binary is not installed; bundled agents could not be unpacked" });
  const byName = new Map<string, AgentInfo>();
  for (const agent of await scanRoots(host, roots, diagnostics)) {
    const key = host.platform === "win32" ? agent.name.toLowerCase() : agent.name;
    byName.set(key, agent);
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics, bundledPath };
}

export function validateAgentPayload(input: unknown): asserts input is AgentPayload & { name: string; description: string } {
  if (!isRecord(input)) throw new Error("agent payload must be an object");
  if (typeof input.name !== "string" || !AGENT_NAME_RE.test(input.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error("description is required");
  for (const field of ["model", "tools"] as const) asStringArray(input[field], field);
  if (input.spawns !== undefined && input.spawns !== "*") asStringArray(input.spawns, "spawns");
  if (input.thinkingLevel !== undefined && (typeof input.thinkingLevel !== "string" || !THINKING_LEVELS.has(input.thinkingLevel))) throw new Error("thinkingLevel is invalid");
  if (input.body !== undefined && typeof input.body !== "string") throw new Error("body must be a string");
  if (input.blocking !== undefined && typeof input.blocking !== "boolean") throw new Error("blocking must be a boolean");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (input.existingFrontmatter !== undefined && !isRecord(input.existingFrontmatter)) throw new Error("existingFrontmatter must be an object");
  for (const field of ["prewalk", "advisor"] as const) if (input[field] !== undefined && typeof input[field] !== "boolean" && typeof input[field] !== "string") throw new Error(`${field} must be a boolean or string`);
}

export function serializeAgent(frontmatter: Record<string, unknown>, body: string): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const yaml = stringifyYaml(frontmatter).replace(/\r?\n/g, eol).replace(new RegExp(`${eol}$`), "");
  return `---${eol}${yaml}${eol}---${eol}${body}`;
}

export function getAgentFilePath(scopeDir: string, name: string, host: Host = currentHost()): string {
  if (!AGENT_NAME_RE.test(name)) throw new Error("invalid agent name");
  return host.pathApi.join(scopeDir, `${name}.md`);
}

export async function validateAgentFileReference(scopeDir: string, name: string, host: Host = currentHost()): Promise<void> {
  if (!AGENT_NAME_RE.test(name)) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
  const filePath = getAgentFilePath(scopeDir, name, host);
  if (!(await host.fs.exists(filePath))) throw new Error("agent file not found");
}

/** Refuse scope directories that are (or sit below) a symlink, then make sure
 * the directory exists. Remote hosts do the whole walk in one round trip. */
async function secureScopeDir(scopeDir: string, host: Host): Promise<string> {
  const pathApi = host.pathApi;
  const resolved = pathApi.resolve(scopeDir);
  if (host.isLocal) {
    let current = resolved;
    while (true) {
      try {
        const stat = await host.fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error("agent scope path may not contain a symbolic link");
        if (current === resolved && !stat.isDirectory()) throw new Error("agent scope path is not a directory");
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      const parent = pathApi.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    await host.fs.mkdir(resolved, { recursive: true });
  } else {
    const script = [
      'p="$1"',
      "while :; do",
      '  if [ -L "$p" ]; then echo symlink; exit 0; fi',
      '  if [ "$p" = "$1" ] && [ -e "$p" ] && ! [ -d "$p" ]; then echo notdir; exit 0; fi',
      '  q=$(dirname -- "$p"); [ "$q" = "$p" ] && break; p="$q"',
      "done",
      'mkdir -p -- "$1" || { echo mkdirfail; exit 0; }',
      "echo ok",
    ].join("\n");
    const { stdout } = await runHostScript(host, script, [resolved]);
    const verdict = stdout.toString("utf8").trim();
    if (verdict === "symlink") throw new Error("agent scope path may not contain a symbolic link");
    if (verdict === "notdir") throw new Error("agent scope path is not a directory");
    if (verdict !== "ok") throw new Error(`could not create agent scope directory ${resolved}`);
  }
  const stat = await host.fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("agent scope directory is not a regular directory");
  return resolved;
}

export async function writeAgent(scopeDir: string, name: string, payload: AgentPayload, previousName?: string, host: Host = currentHost()): Promise<{ path: string }> {
  if (!AGENT_NAME_RE.test(name)) throw new Error("invalid agent name");
  validateAgentPayload({ ...payload, name });
  const dir = await secureScopeDir(scopeDir, host);
  if (previousName !== undefined) await validateAgentFileReference(dir, previousName, host);
  const pathApi = host.pathApi;
  const fileName = `${name}.md`;
  const filePath = pathApi.join(dir, fileName);
  const previousPath = previousName ? getAgentFilePath(dir, previousName, host) : undefined;
  const entries = new Map((await host.fs.readdir(dir)).map((entry) => [entry.name, entry]));
  const exact = entries.get(fileName);
  if (exact?.isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
  // On a case-insensitive filesystem (macOS APFS default, Windows) the new
  // name can resolve to an existing entry that is listed under different
  // casing. A case-only rename must treat that entry as the file being
  // replaced, while distinct entries (hardlinks, real collisions) stay
  // collisions.
  const targetExists = exact !== undefined || (await host.fs.exists(filePath));
  const sameName = previousName !== undefined && (host.platform === "win32" ? previousName.toLowerCase() === name.toLowerCase() : previousName === name);
  const caseAlias = previousName !== undefined && !sameName && previousName.toLowerCase() === name.toLowerCase() && targetExists && exact === undefined;
  const replacesPreviousPath = previousName !== undefined && (sameName || caseAlias);
  if (targetExists && !replacesPreviousPath) throw new Error("agent file already exists");
  const preserved: Record<string, unknown> = isRecord(payload.existingFrontmatter) ? { ...payload.existingFrontmatter } : {};
  if (previousPath) {
    if (entries.get(`${previousName}.md`)?.isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
    try {
      const previousContent = await readTextFile(host, previousPath, MAX_AGENT_BYTES);
      if (previousContent !== null) Object.assign(preserved, parseAgentFrontmatter(previousContent).frontmatter);
    } catch {
      // The new form remains writable even if an old file cannot be parsed.
    }
  }
  // These are the fields represented by the compact editor and therefore
  // intentionally replaced when omitted or changed. Other OMP frontmatter
  // (prewalk/advisor/output/blocking and unknown extensions) is preserved.
  for (const field of ["name", "description", "model", "tools", "thinkingLevel", "spawns"] as const) delete preserved[field];
  const frontmatter: Record<string, unknown> = { ...preserved, name, description: payload.description.trim() };
  for (const field of ["model", "tools", "thinkingLevel", "spawns", "prewalk", "advisor", "output", "blocking", "enabled"] as const) {
    const value = payload[field];
    if (value !== undefined && value !== "") frontmatter[field] = field === "model" || field === "tools" ? asStringArray(value, field) : value;
  }
  const body = typeof payload.body === "string" ? payload.body : "";
  const serialized = serializeAgent(frontmatter, body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AGENT_BYTES) throw new Error("agent file is too large");
  // Renaming over a case-variant keeps the OLD directory entry's casing on a
  // case-insensitive filesystem, and Windows may refuse to replace an open
  // file: move the old entry aside first so the new name's casing lands on
  // disk and the update stays atomic from the caller's view.
  let displacedPath: string | undefined;
  if ((host.platform === "win32" || caseAlias) && replacesPreviousPath && targetExists) {
    displacedPath = `${filePath}.${process.pid}.${Date.now()}.old`;
    await host.fs.rename(filePath, displacedPath);
  }
  try {
    // host.fs.writeFile is atomic (temp file + rename in the target directory).
    await host.fs.writeFile(filePath, serialized);
  } catch (error) {
    if (displacedPath) await host.fs.rename(displacedPath, filePath).catch(() => {});
    throw error;
  }
  if (displacedPath) await host.fs.rm(displacedPath, { force: true }).catch(() => {});
  if (previousPath && !replacesPreviousPath) await host.fs.rm(previousPath, { force: true }).catch(() => {});
  return { path: filePath };
}

export async function deleteAgent(scopeDir: string, name: string, host: Host = currentHost()): Promise<{ path: string }> {
  const dir = await secureScopeDir(scopeDir, host);
  await validateAgentFileReference(dir, name, host);
  const filePath = getAgentFilePath(dir, name, host);
  let stat;
  try {
    stat = await host.fs.lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) throw new Error("agent file not found");
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("agent file may not be a symbolic link");
  await host.fs.rm(filePath);
  return { path: filePath };
}

export async function resolveAgentsScope(cwd: string | undefined, scope: "user" | "project", host: Host = currentHost()): Promise<string> {
  return withHost(host, () => scope === "user" ? getUserAgentsDir() : resolveProjectAgentsDir(cwd || hostHomedir()));
}

export async function readAgentFile(filePath: string, host: Host = currentHost()): Promise<AgentInfo | null> {
  try {
    const content = await readTextFile(host, filePath, MAX_AGENT_BYTES);
    if (content === null) return null;
    const pathApi = host.pathApi;
    const isWithin = (root: string) => {
      const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(filePath));
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
    };
    const bundled = isWithin(getBundledAgentsCacheDir(host));
    const user = isWithin(withHost(host, () => getUserAgentsDir()));
    const source: AgentSource = bundled ? "bundled" : user ? "user" : "project";
    return infoFromContent(host, content, filePath, source, source);
  } catch { return null; }
}
