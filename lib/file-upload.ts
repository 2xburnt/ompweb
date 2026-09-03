import path from "path";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

/** Only the local machine can be a case-insensitive Windows filesystem;
 * remote hosts are POSIX. */
function isWindowsHost(host: Host): boolean {
  return host.isLocal && process.platform === "win32";
}

export function validateUploadFileNames(fileNames: string[], host: Host = currentHost()): string | null {
  if (fileNames.length === 0) return "No files selected";

  const caseInsensitive = isWindowsHost(host);
  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    // On Windows `A.txt` and `a.txt` address the same filesystem object —
    // key the dedupe case-insensitively or an overwrite batch would unlink
    // and replace that object twice, discarding the first payload.
    const seenKey = caseInsensitive ? fileName.toLocaleLowerCase() : fileName;
    if (seen.has(seenKey)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(seenKey);
  }

  return null;
}

/** lstat-level kind of an upload target: absent, a regular file, or something
 * that must never be replaced by an upload (directory, symlink, device). */
type TargetKind = "missing" | "file" | "other";

async function inspectLocally(host: Host, directory: string, fileNames: string[]): Promise<TargetKind[]> {
  return Promise.all(fileNames.map(async (fileName) => {
    const destination = host.pathApi.join(directory, fileName);
    try {
      const stat = await host.fs.lstat(destination);
      return stat.isFile() && !stat.isSymbolicLink() ? "file" : "other";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  }));
}

/** One round trip for every name: the script prints one kind per line in
 * argument order (works with GNU and BSD sh/test). */
async function inspectRemotely(host: Host, directory: string, fileNames: string[]): Promise<TargetKind[]> {
  const script = [
    'd="$1"; shift',
    '[ -d "$d" ] || { echo "Not a directory: $d" >&2; exit 20; }',
    'for f in "$@"; do',
    '  p="$d/$f"',
    '  if [ -L "$p" ]; then echo other',
    '  elif [ -f "$p" ]; then echo file',
    '  elif [ -e "$p" ]; then echo other',
    '  else echo missing; fi',
    "done",
  ].join("\n");
  const { stdout } = await host.executor.exec(["sh", "-c", script, "sh", directory, ...fileNames], { timeoutMs: 30_000 });
  const kinds = stdout.toString("utf8").split("\n").filter(Boolean);
  if (kinds.length !== fileNames.length) throw new Error("Upload target inspection returned an unexpected result");
  return kinds.map((kind) => (kind === "file" || kind === "other" ? kind : "missing"));
}

/** Which of `fileNames` already exist in `directory` on the host, and which
 * of those cannot be replaced by a plain file write. */
export async function inspectUploadTargets(
  directory: string,
  fileNames: string[],
  host: Host = currentHost(),
): Promise<UploadTargetInspection> {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];
  if (fileNames.length === 0) return { conflicts, nonReplaceable };

  const kinds = host.isLocal
    ? await inspectLocally(host, directory, fileNames)
    : await inspectRemotely(host, directory, fileNames);

  fileNames.forEach((fileName, index) => {
    const kind = kinds[index];
    if (kind === "missing") return;
    conflicts.push(fileName);
    if (kind === "other") nonReplaceable.push(fileName);
  });

  return { conflicts, nonReplaceable };
}
