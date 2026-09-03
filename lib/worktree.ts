import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, posix, resolve } from "path";
import { allowFileRoot } from "./file-access";
import { currentHost } from "./hosts/context";
import { ExecError } from "./hosts/executor";
import type { Host } from "./hosts/registry";
import { normalizeForComparison, samePath, toNativePath } from "./paths";
import { loadProjectRegistry } from "./project-registry";

// ============================================================================
// Project resolution: cwd → { projectRoot, branch }
//
// A worktree's `git rev-parse --git-common-dir` points at the *main* repo's
// .git directory, so its parent is the project root shared by all worktrees.
// Non-git directories resolve to themselves. Results are cached on globalThis
// (hot-reload safe) with a short TTL; add/remove worktree invalidates eagerly.
//
// Every git invocation runs on the host that owns the directory. A remote
// host answers the whole project probe in a single round trip (one shell
// script prints the real cwd and the rev-parse output together).
// ============================================================================

export interface ProjectInfo {
  projectRoot: string;
  /** Current branch of the cwd, null for non-git dirs or detached HEAD */
  branch: string | null;
  /** True when cwd is a linked worktree (not the main checkout) */
  isWorktree: boolean;
  /** True when cwd is the top-level directory of a checkout (main or linked).
   *  False for repo subdirectories and non-git dirs — the worktree switcher
   *  is only meaningful at the top level. */
  isTopLevel: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
}

declare global {
  var __piProjectCache: Map<string, { info: ProjectInfo; expiresAt: number }> | undefined;
}

const PROJECT_CACHE_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

function realPathOrSelf(filePath: string): string {
  try {
    // Use the OS-native resolver so Windows 8.3 aliases and filesystem casing
    // canonicalize to the same identity Git reports.
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

/** Canonical form of a path on the host: the local machine resolves symlinks
 * and casing synchronously; a remote (POSIX) path is used as-is, since git
 * already prints symlink-free paths there. */
function canonicalPath(host: Host, filePath: string): string {
  return host.isLocal ? realPathOrSelf(filePath) : filePath;
}

function pathApi(host: Host) {
  return host.isLocal ? { join, resolve, dirname, basename } : { join: posix.join, resolve: posix.resolve, dirname: posix.dirname, basename: posix.basename };
}

function getProjectCache(): Map<string, { info: ProjectInfo; expiresAt: number }> {
  if (!globalThis.__piProjectCache) globalThis.__piProjectCache = new Map();
  return globalThis.__piProjectCache;
}

function projectCacheKey(host: Host, cwd: string): string {
  return `${host.id}\0${cwd}`;
}

export function invalidateProjectCache(): void {
  globalThis.__piProjectCache?.clear();
}

async function git(cwd: string, args: string[], host: Host = currentHost()): Promise<string> {
  const { stdout } = await host.executor.exec(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    // Pin the message locale so error-text matching (e.g. the dirty-worktree
    // detection in the DELETE route) works regardless of system language.
    env: { LC_ALL: "C" },
  });
  return stdout.toString("utf8").trim();
}

async function pathExists(host: Host, filePath: string): Promise<boolean> {
  try {
    return await host.fs.exists(filePath);
  } catch {
    return false;
  }
}

/**
 * Proactively sanitize Git worktree metadata on Windows: Git records the
 * absolute path to the worktree's `.git` file in `.git/worktrees/<id>/gitdir`.
 * If recorded with Windows backslashes (`\`), Git's internal C path parsing
 * (`strip_suffix(path, "/.git")`) fails to match the forward-slash `/.git`
 * delimiter, which corrupts Git's worktree root resolution and causes
 * `git worktree remove` to check `<path>/.git/.git` and fail validation.
 * Local-only: remote hosts are POSIX.
 */
export function repairWorktreeGitdirs(repoRoot: string): void {
  try {
    const worktreesDir = join(repoRoot, ".git", "worktrees");
    if (!existsSync(worktreesDir)) return;
    const entries = readdirSync(worktreesDir);
    for (const entry of entries) {
      const gitdirPath = join(worktreesDir, entry, "gitdir");
      if (!existsSync(gitdirPath)) continue;
      try {
        const content = readFileSync(gitdirPath, "utf8");
        const trimmed = content.trim();
        const normalized = trimmed.replace(/\\/g, "/");
        if (normalized !== trimmed) {
          writeFileSync(gitdirPath, normalized + "\n", "utf8");
        }
      } catch {
        // Ignore single-file read/write errors
      }
    }
  } catch {
    // Ignore worktrees directory read errors
  }
}

/**
 * When a worktree directory no longer exists or is no longer a valid git directory
 * (worktree removed, or leftover folders like .next/ remained on Windows),
 * resolve its sessions back under the main repo root instead of letting them dangle.
 */
function inferRemovedWorktreeLocally(cwd: string): ProjectInfo | null {
  // 1. Try `<repoRoot>-worktrees/<dir>`
  const parent = dirname(cwd);
  if (parent.endsWith("-worktrees")) {
    const repoRoot = parent.slice(0, -"-worktrees".length);
    if (repoRoot && existsSync(join(repoRoot, ".git"))) {
      return { projectRoot: realPathOrSelf(repoRoot), branch: basename(cwd), isWorktree: true, isTopLevel: true };
    }
  }

  // 2. Try registered projects from ~/.omp/agent/projects.json
  try {
    const registry = loadProjectRegistry();
    const candidateNormalized = normalizeForComparison(cwd);
    for (const project of registry.projects) {
      const projRoot = project.path;
      if (!existsSync(join(projRoot, ".git"))) continue;
      if (candidateNormalized.startsWith(normalizeForComparison(`${projRoot}-worktrees`))) {
        return { projectRoot: realPathOrSelf(projRoot), branch: basename(cwd), isWorktree: true, isTopLevel: true };
      }
      const worktreesDir = join(projRoot, ".git", "worktrees");
      if (existsSync(worktreesDir)) {
        const entries = readdirSync(worktreesDir);
        for (const entry of entries) {
          const gitdirFile = join(worktreesDir, entry, "gitdir");
          if (!existsSync(gitdirFile)) continue;
          try {
            const line = readFileSync(gitdirFile, "utf8").trim();
            const wtDir = dirname(line);
            if (samePath(wtDir, cwd) || samePath(line, cwd)) {
              return { projectRoot: realPathOrSelf(projRoot), branch: basename(cwd), isWorktree: true, isTopLevel: true };
            }
          } catch {
            // Ignore file read error
          }
        }
      }
    }
  } catch {
    // Ignore registry lookup error
  }

  return null;
}

/** Remote variant: only the `<repoRoot>-worktrees/<dir>` convention is
 * checked (one round trip); registry-based inference stays local. */
async function inferRemovedWorktreeRemotely(host: Host, cwd: string): Promise<ProjectInfo | null> {
  const parent = posix.dirname(cwd);
  if (!parent.endsWith("-worktrees")) return null;
  const repoRoot = parent.slice(0, -"-worktrees".length);
  if (!repoRoot || !(await pathExists(host, posix.join(repoRoot, ".git")))) return null;
  return { projectRoot: repoRoot, branch: posix.basename(cwd), isWorktree: true, isTopLevel: true };
}

function inferRemovedWorktree(host: Host, cwd: string): Promise<ProjectInfo | null> {
  return host.isLocal ? Promise.resolve(inferRemovedWorktreeLocally(cwd)) : inferRemovedWorktreeRemotely(host, cwd);
}

const REV_PARSE_ARGS = [
  "rev-parse", "--path-format=absolute",
  "--git-common-dir", "--git-dir", "--show-toplevel",
  "--abbrev-ref", "HEAD",
];

interface ProjectProbe {
  /** "missing" = cwd does not exist; "plain" = exists without .git; "git" = repo */
  state: "missing" | "plain" | "git";
  realCwd: string;
  revParse: string;
}

async function probeProject(host: Host, cwd: string): Promise<ProjectProbe> {
  if (host.isLocal) {
    if (!existsSync(cwd)) return { state: "missing", realCwd: cwd, revParse: "" };
    if (!existsSync(join(cwd, ".git"))) return { state: "plain", realCwd: realPathOrSelf(cwd), revParse: "" };
    return { state: "git", realCwd: realPathOrSelf(cwd), revParse: await git(cwd, REV_PARSE_ARGS, host) };
  }
  // One round trip: existence, real path and rev-parse together.
  const script = [
    '[ -d "$1" ] || { echo __MISSING__; exit 0; }',
    'cd -- "$1" || { echo __MISSING__; exit 0; }',
    "pwd -P",
    '[ -e .git ] || { echo __PLAIN__; exit 0; }',
    "echo __GIT__",
    `exec git ${REV_PARSE_ARGS.join(" ")}`,
  ].join("\n");
  const { stdout } = await host.executor.exec(["sh", "-c", script, "sh", cwd], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { LC_ALL: "C" },
  });
  const lines = stdout.toString("utf8").split("\n").map((line) => line.trim());
  if (lines[0] === "__MISSING__") return { state: "missing", realCwd: cwd, revParse: "" };
  const realCwd = lines[0] || cwd;
  if (lines[1] === "__PLAIN__") return { state: "plain", realCwd, revParse: "" };
  if (lines[1] !== "__GIT__") throw new Error(`Unexpected project probe output for ${cwd}`);
  return { state: "git", realCwd, revParse: lines.slice(2).join("\n").trim() };
}

export async function resolveProject(cwd: string, host: Host = currentHost()): Promise<ProjectInfo> {
  const cache = getProjectCache();
  const key = projectCacheKey(host, cwd);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const paths = pathApi(host);

  let info: ProjectInfo;
  try {
    const probe = await probeProject(host, cwd);
    if (probe.state !== "git") {
      const inferred = await inferRemovedWorktree(host, cwd);
      if (inferred) {
        cache.set(key, { info: inferred, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
        return inferred;
      }
      if (probe.state === "missing") {
        info = { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
        cache.set(key, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
        return info;
      }
      // A directory without .git: git still answers when it sits inside a
      // repo (subdirectory), so fall through to rev-parse.
      probe.revParse = await git(cwd, REV_PARSE_ARGS, host);
    }
    const [commonDirRaw, gitDirRaw, toplevelRaw, ref] = probe.revParse.split("\n").map((l) => l.trim());
    const [commonDir, gitDir, toplevel] = [commonDirRaw, gitDirRaw, toplevelRaw].map((p) => canonicalPath(host, toNativePath(p)));
    // git prints resolved (symlink-free) paths; normalize cwd the same way
    const realCwd = probe.realCwd;
    // For a linked worktree, --git-dir differs from --git-common-dir.
    // Only collapse *worktree toplevels* into the main repo. A session whose
    // cwd is a subdirectory of a repo keeps its own project identity —
    // grouping subdirs under the repo root would change where new sessions
    // are created for existing users.
    const isTopLevel = samePath(toplevel, realCwd);
    const isWorktreeTopLevel = !samePath(gitDir, commonDir) && isTopLevel;
    const topLevelProjectRoot = isWorktreeTopLevel ? paths.dirname(commonDir) : toplevel;
    info = {
      // realCwd is the symlink-free, on-disk-cased form git itself resolved;
      // use it for the non-worktree root too so the project registry and the
      // session-discovered roots produce identical strings (Windows casing).
      projectRoot: isTopLevel ? canonicalPath(host, topLevelProjectRoot) : realCwd,
      branch: ref && ref !== "HEAD" ? ref : null,
      isWorktree: isWorktreeTopLevel,
      isTopLevel,
    };
  } catch {
    const inferred = await inferRemovedWorktree(host, cwd).catch(() => null);
    info = inferred ?? { projectRoot: canonicalPath(host, cwd), branch: null, isWorktree: false, isTopLevel: false };
  }

  cache.set(key, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  return info;
}

// ============================================================================
// Worktree operations
//
// These take any directory inside the repo (a worktree, the main checkout, or
// a subdirectory) and resolve the main repo root themselves via the git
// common dir, so callers can pass session cwds directly.
// ============================================================================

/** Main repo root (parent of the shared .git dir), or throws for non-git dirs */
async function getRepoRoot(cwd: string, host: Host): Promise<string> {
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], host);
  return canonicalPath(host, pathApi(host).dirname(toNativePath(commonDir)));
}

export async function listWorktrees(cwd: string, host: Host = currentHost()): Promise<WorktreeInfo[]> {
  const repoRoot = await getRepoRoot(cwd, host);
  if (host.isLocal) repairWorktreeGitdirs(repoRoot);
  const out = await git(cwd, ["worktree", "list", "--porcelain"], host);
  const paths = pathApi(host);
  const candidates: Array<{ path: string; branch: string | null; prunable: boolean }> = [];
  let current: (Partial<WorktreeInfo> & { prunable?: boolean }) | null = null;

  const flush = () => {
    if (current?.path) {
      // Git may emit forward-slash absolute paths on Windows; normalize before
      // comparing with API/UI paths produced by Node's path helpers.
      candidates.push({ path: paths.resolve(current.path), branch: current.branch ?? null, prunable: current.prunable === true });
    }
    current = null;
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: toNativePath(line.slice("worktree ".length).trim()) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.startsWith("prunable") && current) {
      current.prunable = true;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();

  // Prunable worktrees point at missing/broken gitdirs and cannot be browsed
  // or selected usefully. Also skip vanished paths even if git has not
  // marked them prunable yet.
  const present = await Promise.all(candidates.map((candidate) => candidate.prunable ? Promise.resolve(false) : pathExists(host, candidate.path)));
  const worktrees: WorktreeInfo[] = candidates
    .filter((_, index) => present[index])
    .map((candidate) => ({ path: candidate.path, branch: candidate.branch, isMain: samePath(candidate.path, repoRoot) }));
  worktrees.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.path.localeCompare(b.path)));
  return worktrees;
}

function findWorktreeByPath(worktrees: readonly WorktreeInfo[], candidate: string): WorktreeInfo | undefined {
  return worktrees.find((worktree) => samePath(worktree.path, candidate));
}

export function findCurrentWorktreePath(worktrees: readonly WorktreeInfo[], cwd: string, host: Host = currentHost()): string | null {
  return findWorktreeByPath(worktrees, canonicalPath(host, cwd))?.path ?? null;
}

function sanitizeBranchForDir(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function addWorktree(cwd: string, branch: string, host: Host = currentHost()): Promise<{ path: string; branch: string }> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch name is required");
  // git-ref sanity: a bare positional like `--force` would be read as flags by
  // `git worktree add -b`; whitespace, `..`, and leading/trailing dots are
  // rejected by git's own ref rules (and `@{` is reflog syntax).
  if (trimmed.startsWith("-")) throw new Error(`Invalid branch name: ${branch}`);
  if (/[\s\x00-\x1f\x7f~^:?*[\]\\]/.test(trimmed)) throw new Error(`Invalid branch name: ${branch}`);
  if (trimmed.includes("..") || trimmed.startsWith(".") || trimmed.endsWith(".") || trimmed.endsWith(".lock")) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  const dirName = sanitizeBranchForDir(trimmed);
  if (!dirName) throw new Error(`Invalid branch name: ${branch}`);

  const paths = pathApi(host);
  const repoRoot = await getRepoRoot(cwd, host);
  const baseDir = `${paths.resolve(repoRoot)}-worktrees`;
  const worktreePath = paths.join(baseDir, dirName);
  if (await pathExists(host, worktreePath)) {
    throw new Error(`Directory already exists: ${worktreePath}`);
  }
  if (host.isLocal) mkdirSync(baseDir, { recursive: true });
  else await host.fs.mkdir(baseDir, { recursive: true });

  // Reuse the branch if it already exists, otherwise create it at HEAD.
  let branchExists = false;
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}`], host);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const posixWorktreePath = worktreePath.replace(/\\/g, "/");
  try {
    if (branchExists) {
      await git(repoRoot, ["worktree", "add", "--", posixWorktreePath, trimmed], host);
    } else {
      await git(repoRoot, ["worktree", "add", "-b", trimmed, "--", posixWorktreePath], host);
    }
  } catch (error) {
    throw new Error(extractGitError(error));
  }

  if (host.isLocal) repairWorktreeGitdirs(repoRoot);
  allowFileRoot(worktreePath, host);
  invalidateProjectCache();
  return { path: worktreePath, branch: trimmed };
}

export async function removeWorktree(cwd: string, worktreePath: string, force = false, host: Host = currentHost()): Promise<void> {
  const repoRoot = await getRepoRoot(cwd, host);
  if (host.isLocal) repairWorktreeGitdirs(repoRoot);
  const worktrees = await listWorktrees(cwd, host);
  // Compare on the same canonical form listWorktrees produces (resolve +
  // case-fold on win32): the client body value may use a drive-letter case
  // variant or forward slashes, and an exact string compare would reject a
  // legitimate worktree with a misleading not_a_worktree error.
  const target = findWorktreeByPath(worktrees, worktreePath);
  if (!target) throw new Error(`Not a worktree of this repository: ${worktreePath}`);
  if (target.isMain) throw new Error("Cannot remove the main worktree");

  const posixPath = target.path.replace(/\\/g, "/");
  try {
    await git(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), posixPath], host);
  } catch (error) {
    throw new Error(extractGitError(error));
  }

  if (await pathExists(host, target.path)) {
    try {
      if (host.isLocal) rmSync(target.path, { recursive: true, force: true });
      else await host.fs.rm(target.path, { recursive: true, force: true });
    } catch {
      // Ignore if files are locked
    }
  }

  try {
    await git(repoRoot, ["worktree", "prune"], host);
  } catch {
    // Ignore prune errors
  }

  invalidateProjectCache();
}

function extractGitError(error: unknown): string {
  if (error instanceof ExecError && error.stderr.trim()) return error.stderr.trim();
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
