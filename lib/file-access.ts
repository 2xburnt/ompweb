import path from "path";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { isWindowsAbsolutePath } from "./paths";
import { listAllSessions } from "./session-reader";

export { isWindowsAbsolutePath } from "./paths";

// Allowed roots per host — in-memory plus session-derived, globalThis for
// hot-reload. A path is only ever checked against the roots of the host it
// lives on; the same string on another machine is a different directory.
declare global {
  var __piAllowedRootsCache: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
  var __piAdditionalAllowedRoots: Map<string, Set<string>> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return stripLongPathPrefix(filePath.replace(/\\/g, "/"));
}

/** Windows device paths (\\?\C:\... , \\?\UNC\server\share\...) come back from
 *  realpathSync and defeat plain startsWith prefix checks against ordinary
 *  drive/UNC roots, producing false 403s on long paths and junctions. */
function stripLongPathPrefix(filePath: string): string {
  if (filePath.startsWith("//?/UNC/")) return "//" + filePath.slice(8);
  if (filePath.startsWith("//?/")) return filePath.slice(4);
  if (filePath.startsWith("\\\\?\\UNC\\")) return "\\\\" + filePath.slice(8);
  if (filePath.startsWith("\\\\?\\")) return filePath.slice(4);
  return filePath;
}

function getAdditionalAllowedRoots(hostId: string): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) globalThis.__piAdditionalAllowedRoots = new Map();
  let roots = globalThis.__piAdditionalAllowedRoots.get(hostId);
  if (!roots) {
    roots = new Set();
    globalThis.__piAdditionalAllowedRoots.set(hostId, roots);
  }
  return roots;
}

export function allowFileRoot(root: string, host: Host = currentHost()): void {
  if (!root) return;
  const n = normalizeSlashes(root);
  getAdditionalAllowedRoots(host.id).add(n);
  globalThis.__piAllowedRootsCache?.get(host.id)?.roots.add(n);
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

export async function getAllowedFileRoots(host: Host = currentHost()): Promise<Set<string>> {
  const now = Date.now();
  if (!globalThis.__piAllowedRootsCache) globalThis.__piAllowedRootsCache = new Map();
  const cached = globalThis.__piAllowedRootsCache.get(host.id);
  if (cached && cached.expiresAt > now) return cached.roots;
  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.host && s.host !== host.id) continue;
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }
  for (const root of getAdditionalAllowedRoots(host.id)) roots.add(root);
  globalThis.__piAllowedRootsCache.set(host.id, { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
  return roots;
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const n = resolver.resolve(target);
    const nr = resolver.resolve(root);
    const c = useWindowsRules ? n.toLowerCase() : n;
    const cr = useWindowsRules ? nr.toLowerCase() : nr;
    const withSep = cr.endsWith(sep) ? cr : cr + sep;
    if (c === cr || c.startsWith(withSep)) return true;
  }
  return false;
}

export const isFilePathAllowed = isPathWithinRoots;

/** Like isPathWithinRoots but on the real (symlink-resolved) paths on the
 * host, so a link inside an allowed root cannot escape it. */
export async function isExistingPathWithinRoots(target: string, roots: Set<string>, host: Host = currentHost()): Promise<boolean> {
  let realTarget: string;
  try { realTarget = stripLongPathPrefix(await host.fs.realpath(target)); } catch { return false; }
  // Only roots that could contain the target are resolved: each realpath is a
  // round trip on a remote host, and a root whose plain form does not prefix
  // the target cannot prefix its resolved form unless it is itself a symlink
  // — which realpath of the candidate roots below still covers.
  const realRoots = new Set<string>();
  for (const root of roots) {
    try { realRoots.add(stripLongPathPrefix(await host.fs.realpath(root))); } catch { /* stale */ }
  }
  return isPathWithinRoots(realTarget, realRoots);
}

export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>, host: Host = currentHost()): Promise<boolean> {
  return isExistingPathWithinRoots(target, allowedRoots, host);
}
