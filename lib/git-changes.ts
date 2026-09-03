import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { hostPath } from "./omp/paths";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

/** Run git on the host that owns `cwd`. */
async function git(host: Host, cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await host.executor.exec(["git", "-C", cwd, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { LC_ALL: "C" },
  });
  return stdout.toString("utf8");
}

async function findRepositoryRoot(host: Host, cwd: string): Promise<string | null> {
  try {
    return (await git(host, cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const pathApi = hostPath();
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(target));
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(hostPath().sep).join("/");
}

async function readStatusEntries(host: Host, repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(host, repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

export async function getGitStatus(cwd: string, host: Host = currentHost()): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(host, cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, files: [] };
  }

  const pathApi = hostPath();
  const entries = await readStatusEntries(host, repositoryRoot);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = pathApi.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(cwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });

  return { isGitRepository: true, repositoryRoot, files };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  host: Host,
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(host, repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string, host: Host = currentHost()): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(host, cwd);
  if (!repositoryRoot || !isWithinPath(repositoryRoot, filePath)) return { supported: false };

  const pathApi = hostPath();
  const resolvedFilePath = pathApi.resolve(filePath);
  let size: number;
  try {
    const stat = await host.fs.lstat(resolvedFilePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { supported: false };
    size = stat.size;
  } catch {
    return { supported: false };
  }
  if (size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const relativePath = toGitPath(pathApi.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(host, repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") return { supported: false };

  // Bounded by the size check above; the cap guards a file that grew since.
  const currentBuffer = await host.fs.readFile(resolvedFilePath, { maxBytes: TEXT_PREVIEW_MAX_BYTES });
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(host, repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
