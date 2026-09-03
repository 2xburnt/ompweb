import type { DirEntry } from "./hosts/executor";

/** The subset of a host directory entry the explorer listing needs. */
export type DirEntryLike = Pick<DirEntry, "type" | "targetType">;

/**
 * Whether a host directory entry should be shown as a directory.
 *
 * Host readdir entries already carry the lstat type and, for symlinks, the
 * type of the link target — no extra stat round trip is needed. Dangling
 * symlinks (no target type) yield null so callers can drop them, matching
 * the old "stat failed" behavior.
 */
export function resolveDirentIsDirectory(entry: DirEntryLike): boolean | null {
  if (entry.type === "dir") return true;
  if (entry.type === "file") return false;
  if (entry.type === "symlink") {
    if (!entry.targetType) return null;
    return entry.targetType === "dir";
  }
  // Sockets, fifos, devices: they exist but are not browsable directories.
  return false;
}
