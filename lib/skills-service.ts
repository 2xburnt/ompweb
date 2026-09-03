import { parse as parseYaml } from "yaml";
import type { SkillInfo } from "./api-types";
import { currentHost, withHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { runHostScript, scanTextFiles } from "./omp/host-io";
import { getAgentDir, hostHomedir } from "./omp/paths";
import { annotateSkillsWithInstallInfo } from "./skill-lock";

/**
 * Pure-Node skill discovery mirroring omp's providers
 * (oh-my-pi/packages/coding-agent/src/discovery/{builtin,claude,agents,codex,github}.ts).
 * omp-web cannot import the Bun-only SDK, so the scan rules are replicated:
 * each provider contributes <root>/<name>/SKILL.md skills, higher-priority
 * providers win name collisions, and `enabled: false` frontmatter hides a
 * skill entirely. Everything is read through the host boundary: a remote
 * host's skill tree is scanned in a single round trip and never copied.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

interface SkillScanRoot {
  dir: string;
  /** Provider label surfaced as sourceInfo.source (".omp", ".claude", ...). */
  source: string;
  scope: "user" | "project";
  /** omp skips skills without a description for these providers. */
  requireDescription?: boolean;
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

// SKILL.md files are prose; anything past this is not a skill definition.
const MAX_SKILL_BYTES = 1024 * 1024;

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** Ancestor directories from cwd up to the git repo root (or $HOME / fs root),
 * closest first — matches omp's project-level walk-up discovery. */
async function getAncestorDirs(host: Host, cwd: string, home: string): Promise<string[]> {
  const pathApi = host.pathApi;
  const start = pathApi.resolve(cwd);
  if (!host.isLocal) {
    // One round trip for the whole walk; NUL-separated so odd names survive.
    const script = [
      'cur="$1"; home="$2"',
      "while :; do",
      '  printf "%s\\0" "$cur"',
      '  [ -e "$cur/.git" ] && break',
      '  [ "$cur" = "$home" ] && break',
      '  parent=$(dirname -- "$cur"); [ "$parent" = "$cur" ] && break; cur="$parent"',
      "done",
      "exit 0",
    ].join("\n");
    const { stdout } = await runHostScript(host, script, [start, home]);
    const dirs = stdout.toString("utf8").split("\0").filter(Boolean);
    return dirs.length > 0 ? dirs : [start];
  }
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.push(current);
    if (await host.fs.exists(pathApi.join(current, ".git"))) break;
    if (current === home) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** Scan roots in omp's provider priority order (highest first): .omp (100),
 * .claude (80), .agent/.agents + .codex + .github (70), managed skills (5). */
async function buildScanRoots(host: Host, cwd: string): Promise<SkillScanRoot[]> {
  const pathApi = host.pathApi;
  const home = withHost(host, () => hostHomedir());
  const agentDir = withHost(host, () => getAgentDir());
  const ancestors = await getAncestorDirs(host, cwd, home);
  const projectAncestors = ancestors.filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // builtin (.omp): project walk-up first (closest first), then user dir.
  for (const dir of projectAncestors) {
    roots.push({ dir: pathApi.join(dir, ".omp", "skills"), source: ".omp", scope: "project", requireDescription: true });
  }
  roots.push({ dir: pathApi.join(agentDir, "skills"), source: ".omp", scope: "user", requireDescription: true });

  // claude compat: user ~/.claude/skills + project .claude/skills walk-up.
  // CLAUDE_CONFIG_DIR is this process's environment, so it only describes the
  // local machine.
  const claudeHome = (host.isLocal && process.env.CLAUDE_CONFIG_DIR) || pathApi.join(home, ".claude");
  roots.push({ dir: pathApi.join(claudeHome, "skills"), source: ".claude", scope: "user" });
  for (const dir of projectAncestors) {
    roots.push({ dir: pathApi.join(dir, ".claude", "skills"), source: ".claude", scope: "project" });
  }

  // agent dirs compat (.agent/.agents): project walk-up + user home.
  for (const dir of projectAncestors) {
    roots.push({ dir: pathApi.join(dir, ".agent", "skills"), source: ".agents", scope: "project" });
    roots.push({ dir: pathApi.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }
  roots.push({ dir: pathApi.join(home, ".agent", "skills"), source: ".agents", scope: "user" });
  roots.push({ dir: pathApi.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  // codex compat: user ~/.codex/skills + project .codex/skills.
  roots.push({ dir: pathApi.join(home, ".codex", "skills"), source: ".codex", scope: "user" });
  roots.push({ dir: pathApi.join(cwd, ".codex", "skills"), source: ".codex", scope: "project" });

  // github compat: <repoRoot>/.github/skills.
  const repoRoot = ancestors[ancestors.length - 1];
  roots.push({ dir: pathApi.join(repoRoot, ".github", "skills"), source: ".github", scope: "project", requireDescription: true });

  // managed auto-learn skills (lowest priority).
  roots.push({ dir: pathApi.join(agentDir, "managed-skills"), source: "managed", scope: "user", requireDescription: true });

  return roots;
}

/** Directories the discovery walk reads, for callers that must authorize a
 * skill path (single source of truth with buildScanRoots — a narrower list
 * would reject skills the app itself discovered and installed). Without a cwd
 * only the cwd-independent user-scope roots are returned. */
export async function getSkillScanRootDirs(cwd?: string, host: Host = currentHost()): Promise<string[]> {
  const roots = await buildScanRoots(host, cwd ?? withHost(host, () => hostHomedir()));
  return roots.map((root) => root.dir);
}

const DISABLE_INVOCATION_KEYS = ["disable-model-invocation", "disableModelInvocation", "hide"] as const;
/** Agent Skills standard spelling — used when no variant is present yet. */
const CANONICAL_DISABLE_KEY = DISABLE_INVOCATION_KEYS[0];

/** True when any of the three spellings omp honors is set
 * (frontmatter.hide === true || frontmatter.disableModelInvocation === true,
 * with `disable-model-invocation` normalized into the latter). */
export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return DISABLE_INVOCATION_KEYS.some((key) => isTruthyFlag(frontmatter[key]));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^(?:${DISABLE_INVOCATION_KEYS.join("|")})[ \\t]*:.*$`);

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present (in whichever of the three spellings) instead of
 * prepending a second copy, which would make the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${CANONICAL_DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    if (hits.length === 0) {
      next = [`${CANONICAL_DISABLE_KEY}: true`, ...lines];
    } else {
      // Keep the spelling the file already uses; drop any duplicate variants so
      // a stale `hide: true` cannot re-enable hiding on the next toggle.
      const keep = hits[0];
      const keyName = /^([\w-]+)/.exec(lines[keep])?.[1] ?? CANONICAL_DISABLE_KEY;
      next = lines
        .map((line, index) => (index === keep ? `${keyName}: true` : line))
        .filter((_, index) => index === keep || !hits.includes(index));
    }
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

/** Discover skills for a cwd the way omp does. Name collisions resolve to the
 * highest-priority provider (scan-root order); result is sorted by name. */
export async function discoverSkills(cwd: string, host: Host = currentHost()): Promise<SkillsWithDiagnostics> {
  const diagnostics: SkillDiagnostic[] = [];
  const roots = await buildScanRoots(host, cwd);
  const scan = await scanTextFiles(host, roots.map((root) => root.dir), "skill-dirs", MAX_SKILL_BYTES);
  for (const dir of scan.unreadableRoots) diagnostics.push({ type: "warning", message: "Failed to read skills directory", path: dir });
  for (const filePath of scan.unreadableFiles) diagnostics.push({ type: "warning", message: "Failed to read skill file", path: filePath });
  const pathApi = host.pathApi;
  const byName = new Map<string, SkillInfo>();
  for (const root of roots) {
    for (const file of scan.files) {
      if (file.root !== root.dir) continue;
      if (file.truncated) {
        diagnostics.push({ type: "warning", message: "Skill file is too large to inspect", path: file.path });
        continue;
      }
      const { frontmatter } = parseSkillFrontmatter(file.content);
      if (frontmatter.enabled === false) continue;
      const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
      if (root.requireDescription && !description) continue;
      const baseDir = pathApi.dirname(file.path);
      const entryName = pathApi.basename(baseDir);
      const rawName = frontmatter.name;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : entryName;
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        description,
        filePath: file.path,
        baseDir,
        disableModelInvocation: readDisableModelInvocation(frontmatter),
        sourceInfo: { source: root.source, scope: root.scope },
      });
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp !== 0 ? cmp : a.filePath.localeCompare(b.filePath);
  });
  return { skills, diagnostics };
}

export async function loadSkillsWithInstallInfo(cwd: string, host: Host = currentHost()) {
  const { skills, diagnostics } = await discoverSkills(cwd, host);
  return {
    skills: await annotateSkillsWithInstallInfo(skills, { cwd, agentDir: withHost(host, () => getAgentDir()) }, host),
    diagnostics,
  };
}
