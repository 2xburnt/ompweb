import { execFile } from "child_process";
import { promisify } from "util";
import packageJson from "../package.json";
import { getPackageDir, parseGitRemoteUrl, type NpmUpdateStatus } from "./npm-update";

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 5_000;
const MAX_LOG_ENTRIES = 50;
export const MAX_BODY_BYTES = 64 * 1024;

export interface GitHubReleaseNotes {
  version: string;
  body: string;
  htmlUrl: string;
}

/** Only allow github.com release URLs so the dialog never links off-site. */
export function isSafeReleaseUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** "owner/repo" of the repository releases are read from: OMP_WEB_UPDATE_REPO,
 * else package.json's repository URL. */
export function getUpdateRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.OMP_WEB_UPDATE_REPO?.trim();
  const candidates = [fromEnv, parseGitRemoteUrl(typeof packageJson.repository === "object" ? packageJson.repository.url : String(packageJson.repository ?? ""))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(candidate);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

export async function getGitHubReleaseNotes(version: string): Promise<GitHubReleaseNotes | null> {
  const repo = getUpdateRepo();
  if (!repo) return null;
  const tag = `v${version}`;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ompweb", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let release: Record<string, unknown>;
  try {
    release = await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
  if (release.tag_name !== tag || release.draft !== false) return null;
  if (typeof release.body !== "string" || release.body.length === 0) return null;
  if (release.body.length > MAX_BODY_BYTES || Buffer.byteLength(release.body, "utf8") > MAX_BODY_BYTES) return null;
  if (typeof release.html_url !== "string" || !isSafeReleaseUrl(release.html_url)) return null;
  return { version, body: release.body, htmlUrl: release.html_url };
}

/** Render `git log` between two commits as a markdown bullet list. */
export function formatGitLogNotes(log: string, total: number): string {
  const lines = log.split("\n").filter((line) => line.trim()).map((line) => {
    const [hash, subject, author] = line.split("\t");
    return `- \`${hash}\` ${subject ?? ""}${author ? ` (${author})` : ""}`;
  });
  if (total > lines.length) lines.push(`- …and ${total - lines.length} more`);
  return lines.join("\n");
}

/** For git installs: the commits the update would pull, linking to the
 * repository's compare view. */
export async function getGitUpdateNotes(status: NpmUpdateStatus): Promise<GitHubReleaseNotes | null> {
  if (status.installMethod !== "git" || !status.availableVersion || !status.currentCommit || !status.availableCommit) return null;
  if (!status.repoUrl || !isSafeReleaseUrl(status.repoUrl)) return null;
  let log = "";
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", getPackageDir(), "log", "--no-merges", `--max-count=${MAX_LOG_ENTRIES}`, "--format=%h%x09%s%x09%an",
      `${status.currentCommit}..${status.availableCommit}`,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C" } });
    log = stdout;
  } catch {
    return null;
  }
  const body = formatGitLogNotes(log, status.behindBy ?? 0);
  if (!body || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
  return {
    version: status.availableVersion,
    body,
    htmlUrl: `${status.repoUrl}/compare/${status.currentCommit.slice(0, 12)}...${status.availableCommit.slice(0, 12)}`,
  };
}
