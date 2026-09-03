import type { SkillInfo, SkillInstallInfo, SkillInstallScope } from "./api-types";
import { currentHost, withHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { existingPaths } from "./omp/host-io";
import { hostHomedir } from "./omp/paths";

interface SkillLockEntry {
  source?: unknown;
  sourceType?: unknown;
  skillPath?: unknown;
  ref?: unknown;
  skillFolderHash?: unknown;
  computedHash?: unknown;
}

interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

interface GlobalLockPathOptions {
  homeDir?: string;
  xdgStateHome?: string;
}

interface AnnotateSkillOptions {
  cwd: string;
  agentDir: string;
  globalLockPath?: string;
  projectLockPath?: string;
}

// Lock files list installed skills; a larger file is not a lock file.
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

export function getGlobalSkillsLockPath(options: GlobalLockPathOptions = {}, host: Host = currentHost()): string {
  const pathApi = host.pathApi;
  const homeDir = options.homeDir ?? withHost(host, () => hostHomedir());
  // Callers that inject a home directory (tests or alternate installations)
  // must not accidentally inherit the host process's XDG state directory —
  // and that environment only describes the local machine anyway.
  const xdgStateHome = options.xdgStateHome
    ?? (options.homeDir === undefined && host.isLocal ? process.env.XDG_STATE_HOME : undefined);
  return xdgStateHome
    ? pathApi.join(xdgStateHome, "skills", ".skill-lock.json")
    : pathApi.join(homeDir, ".agents", ".skill-lock.json");
}

function parseSkillLock(text: Buffer | undefined): Record<string, SkillLockEntry> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text.toString("utf8")) as SkillLockFile;
    return parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {};
  } catch {
    return {};
  }
}

function isWithin(host: Host, path: string, root: string): boolean {
  const pathApi = host.pathApi;
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

function findLockEntry(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
): SkillLockEntry | undefined {
  if (entries[skillName]) return entries[skillName];
  const normalizedName = skillName.toLowerCase();
  const key = Object.keys(entries).find((name) => name.toLowerCase() === normalizedName);
  return key ? entries[key] : undefined;
}

function normalizeSource(source: string, sourceType?: string): string {
  if (sourceType !== "github") return source.replace(/\/$/, "");
  return source
    .replace(/^git\+/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function buildSkillsShUrl(source: string, skillName: string): string | undefined {
  if (!source || source.includes("://") || source.startsWith("git@")) return undefined;
  const sourcePath = source
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  if (!sourcePath) return undefined;
  return `https://skills.sh/${sourcePath}/${encodeURIComponent(skillName)}`;
}

function getInstallInfo(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
  scope: SkillInstallScope,
): SkillInstallInfo | undefined {
  const entry = findLockEntry(entries, skillName);
  if (!entry || typeof entry.source !== "string" || !entry.source.trim()) return undefined;

  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : undefined;
  const source = normalizeSource(entry.source.trim(), sourceType);
  if (!source) return undefined;
  const skillPath = typeof entry.skillPath === "string" ? entry.skillPath : undefined;
  const ref = typeof entry.ref === "string" ? entry.ref : undefined;
  const rawVersionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const versionHash = typeof rawVersionHash === "string" && rawVersionHash
    ? rawVersionHash
    : undefined;
  const isGitHubSource =
    sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(source);
  const hasComparableVersion = scope === "global" || !ref;

  return {
    package: `${source}@${skillName}`,
    scope,
    source,
    sourceType,
    skillsShUrl: sourceType === "local" ? undefined : buildSkillsShUrl(source, skillName),
    ...(skillPath && { skillPath }),
    ...(ref && { ref }),
    ...(versionHash && { versionHash }),
    canCheckForUpdates: Boolean(
      isGitHubSource && skillPath && versionHash && hasComparableVersion,
    ),
  };
}

/** Attach skills.sh lock-file provenance to discovered skills. Both lock files
 * are read in one round trip and the skill files' existence in another. */
export async function annotateSkillsWithInstallInfo(
  skills: SkillInfo[],
  options: AnnotateSkillOptions,
  host: Host = currentHost(),
): Promise<SkillInfo[]> {
  const pathApi = host.pathApi;
  const { cwd, agentDir } = options;
  const globalLockPath = options.globalLockPath ?? getGlobalSkillsLockPath({}, host);
  const projectLockPath = options.projectLockPath ?? pathApi.join(cwd, "skills-lock.json");
  const locks = await host.fs.readSlices([globalLockPath, projectLockPath], MAX_LOCK_BYTES, 0);
  const globalEntries = parseSkillLock(locks.get(globalLockPath)?.prefix);
  const projectEntries = parseSkillLock(locks.get(projectLockPath)?.prefix);
  const present = await existingPaths(host, skills.map((skill) => skill.filePath));
  // skills.sh installs with --agent universal land in .agents/skills; omp's
  // own dirs remain valid install roots for manually placed skills.
  const home = withHost(host, () => hostHomedir());
  const globalSkillsRoots = [pathApi.join(agentDir, "skills"), pathApi.join(home, ".agents", "skills")];
  const projectSkillsRoots = [pathApi.join(cwd, ".omp", "skills"), pathApi.join(cwd, ".agents", "skills")];

  return skills.map((skill) => {
    if (!present.has(skill.filePath)) return skill;

    const install = globalSkillsRoots.some((root) => isWithin(host, skill.filePath, root))
      ? getInstallInfo(globalEntries, skill.name, "global")
      : projectSkillsRoots.some((root) => isWithin(host, skill.filePath, root))
        ? getInstallInfo(projectEntries, skill.name, "project")
        : undefined;

    return install ? { ...skill, install } : skill;
  });
}
