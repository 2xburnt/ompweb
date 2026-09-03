import path from "path";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { expandHostHome, hostHomedir, hostPath } from "./omp/paths";

export interface BrowsableDirectory {
  name: string;
  path: string;
  /** Only present when files were requested; directories omit it. */
  isFile?: boolean;
}

/** Platform of the host a request targets: remote hosts are always POSIX, so
 * Windows-only behavior (drive picker) applies to the local machine alone. */
function hostPlatform(host: Host = currentHost()): NodeJS.Platform {
  return host.isLocal ? process.platform : "linux";
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  return platform === "win32" && !directory;
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

/** Local Windows only: probe every drive letter through the host fs. */
export async function listWindowsDrives(host: Host = currentHost()): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await host.fs.stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));
  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || hostHomedir();
}

/** Expand "~" against the host's home and resolve to an absolute host path. */
export function normalizeDirectory(directory: string): string {
  return hostPath().resolve(expandHostHome(directory));
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : directory.startsWith("/") ? path.posix : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

/** Canonical (symlink-resolved) form of a directory on the host; rejects when
 * it does not exist. */
export async function resolveDirectory(directory: string, host: Host = currentHost()): Promise<string> {
  return host.fs.realpath(normalizeDirectory(directory));
}

/** Readable subdirectories of `directory` on the host, one readdir round
 * trip. Symlinks count when they point at a directory; dangling, unreadable
 * or file-targeted links are skipped. */
export async function listDirectories(
  directory: string,
  host: Host = currentHost(),
  options: { includeFiles?: boolean } = {},
): Promise<BrowsableDirectory[]> {
  const entries = await host.fs.readdir(directory);
  const pathApi = host.pathApi;
  const isDir = (entry: { type: string; targetType?: string }) =>
    entry.type === "dir" || (entry.type === "symlink" && entry.targetType === "dir");
  const isFile = (entry: { type: string; targetType?: string }) =>
    entry.type === "file" || (entry.type === "symlink" && entry.targetType === "file");

  return entries
    .filter((entry) => isDir(entry) || (options.includeFiles === true && isFile(entry)))
    .map((entry) => ({
      name: entry.name,
      path: pathApi.join(directory, entry.name),
      ...(isDir(entry) ? {} : { isFile: true }),
    }))
    // Directories first so the tree is navigable before the files below it.
    .sort((left, right) => {
      const leftIsFile = left.isFile === true;
      const rightIsFile = right.isFile === true;
      if (leftIsFile !== rightIsFile) return leftIsFile ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
}
