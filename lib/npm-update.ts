import packageJson from "../package.json";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, normalize, resolve, sep } from "path";
import { promisify } from "util";

/**
 * Update availability for ompweb itself.
 *
 * Three install methods exist:
 * - "git":  ompweb runs from a git checkout (this fork's deployment). Updates
 *           are commits on the tracked remote branch; applying one is
 *           `git pull --ff-only && npm ci && npm run build`. The npm registry
 *           and upstream releases are never consulted.
 * - "npm" / "bun": a global package install; the registry's latest version
 *           is compared with package.json.
 */

const execFileAsync = promisify(execFile);

const NPM_PACKAGE = "@kahme247/ompweb";
const CHECK_TTL_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM = "origin/main";

export type InstallMethod = "git" | "npm" | "bun";

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  installMethod: InstallMethod;
  /** Web URL of the repository (git installs), e.g. https://github.com/2xburnt/ompweb */
  repoUrl?: string | null;
  remote?: string;
  branch?: string;
  currentCommit?: string;
  availableCommit?: string;
  /** Commits on the remote branch that are not in HEAD. */
  behindBy?: number;
  /** Local commits not on the remote branch. */
  aheadBy?: number;
  /** Uncommitted changes in tracked files: a fast-forward pull would refuse. */
  dirty?: boolean;
  /** Set when the remote could not be reached; the comparison uses the last fetched state. */
  checkError?: string;
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}

/** Directory of the ompweb package the server runs from. */
export function getPackageDir(): string {
  return resolve(process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd());
}

/** True when the package directory is a git checkout (a `.git` dir or file). */
export function isGitCheckout(packageDir: string): boolean {
  try {
    return existsSync(join(packageDir, ".git"));
  } catch {
    return false;
  }
}

/** Which package manager owns a given install dir, so updates always run
 * through the manager that manages it (git checkout → git, bun global root →
 * bun, anything else → npm as the fallback). Separators are normalized so the
 * classification is deterministic even when a Windows-style path is passed
 * on a POSIX host (e.g. in CI tests). */
export function detectInstallMethod(packageDir: string): InstallMethod {
  if (isGitCheckout(packageDir)) return "git";
  const toPlatformPath = (value: string): string => normalize(value).replaceAll("\\", sep);
  const normalized = toPlatformPath(packageDir);
  const bunRoots = [
    // bun 1.3.x globals on Windows live in ~/node_modules; POSIX uses the
    // standard ~/.bun/install/global/node_modules.
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "node_modules"),
    join(homedir(), ".bun", "install", "global", "node_modules"),
  ].map(toPlatformPath);
  return bunRoots.some((root) => normalized.startsWith(root + sep)) ? "bun" : "npm";
}

/** Turn a git remote URL (ssh, scp-like or https) into a browsable https URL, or null. */
export function parseGitRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  let host: string;
  let path: string;
  const scpLike = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scpLike) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+https:", "git+ssh:"].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  }
  const cleaned = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !cleaned || cleaned.includes("..")) return null;
  return `https://${host}/${cleaned}`;
}

export function gitUpdateCommand(packageDir: string, remote = "origin", branch = "main"): string {
  return `cd ${packageDir} && git pull --ff-only ${remote} ${branch} && npm ci && npm run build`;
}

async function git(packageDir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", packageDir, ...args], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

/** The tracked upstream of the checked-out branch as { remote, branch }. */
export async function getGitUpstream(packageDir: string): Promise<{ remote: string; branch: string }> {
  let upstream = DEFAULT_UPSTREAM;
  try {
    upstream = (await git(packageDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) || DEFAULT_UPSTREAM;
  } catch {
    upstream = DEFAULT_UPSTREAM;
  }
  const slash = upstream.indexOf("/");
  if (slash <= 0) return { remote: "origin", branch: upstream || "main" };
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) || "main" };
}

/** Compare HEAD with the tracked remote branch (after a fetch). */
export async function checkGitUpdate(packageDir: string, options: { fetch?: boolean } = {}): Promise<NpmUpdateStatus> {
  const { remote, branch } = await getGitUpstream(packageDir);
  const remoteRef = `${remote}/${branch}`;
  const updateCommand = gitUpdateCommand(packageDir, remote, branch);
  let checkError: string | undefined;
  if (options.fetch !== false) {
    try {
      await git(packageDir, ["fetch", "--quiet", remote, branch], GIT_TIMEOUT_MS);
    } catch (error) {
      checkError = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : String(error);
    }
  }
  const head = await git(packageDir, ["rev-parse", "HEAD"]);
  let remoteHead: string;
  try {
    remoteHead = await git(packageDir, ["rev-parse", remoteRef]);
  } catch {
    // Never fetched: nothing to compare against.
    return {
      currentVersion: `${packageJson.version}+${head.slice(0, 7)}`,
      availableVersion: null,
      updateAvailable: false,
      updateCommand,
      installMethod: "git",
      remote,
      branch,
      currentCommit: head,
      behindBy: 0,
      aheadBy: 0,
      checkError: checkError ?? `${remoteRef} has not been fetched yet`,
    };
  }
  const [behindRaw, aheadRaw, statusRaw, remoteUrl] = await Promise.all([
    git(packageDir, ["rev-list", "--count", `HEAD..${remoteRef}`]),
    git(packageDir, ["rev-list", "--count", `${remoteRef}..HEAD`]),
    git(packageDir, ["status", "--porcelain", "--untracked-files=no"]),
    git(packageDir, ["remote", "get-url", remote]).catch(() => ""),
  ]);
  let remoteVersion = packageJson.version;
  try {
    const remotePackage = JSON.parse(await git(packageDir, ["show", `${remoteRef}:package.json`])) as { version?: unknown };
    if (typeof remotePackage.version === "string") remoteVersion = remotePackage.version;
  } catch {
    // Keep the local version label.
  }
  const behindBy = Number.parseInt(behindRaw, 10) || 0;
  const aheadBy = Number.parseInt(aheadRaw, 10) || 0;
  return {
    currentVersion: `${packageJson.version}+${head.slice(0, 7)}`,
    availableVersion: behindBy > 0 ? `${remoteVersion}+${remoteHead.slice(0, 7)}` : null,
    updateAvailable: behindBy > 0,
    updateCommand,
    installMethod: "git",
    repoUrl: parseGitRemoteUrl(remoteUrl),
    remote,
    branch,
    currentCommit: head,
    availableCommit: remoteHead,
    behindBy,
    aheadBy,
    dirty: statusRaw.length > 0,
    ...(checkError ? { checkError } : {}),
  };
}

export async function checkNpmUpdate(force = false): Promise<NpmUpdateStatus> {
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  const currentVersion = packageJson.version;
  const packageDir = getPackageDir();
  const method = detectInstallMethod(packageDir);

  if (method === "git") {
    try {
      const status = await checkGitUpdate(packageDir);
      cached = { checkedAt: Date.now(), status };
      return status;
    } catch (error) {
      return {
        currentVersion,
        availableVersion: null,
        updateAvailable: false,
        updateCommand: gitUpdateCommand(packageDir),
        installMethod: "git",
        checkError: error instanceof Error ? error.message.slice(0, 200) : String(error),
      };
    }
  }

  const updateCommand = method === "bun" ? `bun add -g ${NPM_PACKAGE}` : `npm install -g ${NPM_PACKAGE}`;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = response.ok ? await response.json() as { version?: unknown } : null;
    const availableVersion = typeof data?.version === "string" ? data.version : null;
    const status: NpmUpdateStatus = {
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(availableVersion && isNewerVersion(availableVersion, currentVersion)),
      updateCommand,
      installMethod: method,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, updateCommand, installMethod: method };
  }
}
