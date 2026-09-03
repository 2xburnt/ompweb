import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { buildEntriesFromFiles, filterFileEntries, parseResultLimit, type FileIndexEntry } from "@/lib/file-fuzzy";
import { currentHost } from "@/lib/hosts/context";
import type { DirEntry } from "@/lib/hosts/executor";
import type { Host } from "@/lib/hosts/registry";
import { withHostRoute } from "@/lib/hosts/route";
import { shellQuote } from "@/lib/hosts/shell";

// Same skip lists as /api/files — only used for the non-git readdir fallback.
// Git-tracked repos rely on .gitignore instead (matches the TUI's fd behavior).
const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
/** Directories read in parallel per BFS level of the local readdir walk. */
const WALK_CONCURRENCY = 8;
const MAX_QUERY_LENGTH = 500;
const GIT_TIMEOUT_MS = 10_000;
const WALK_TIMEOUT_MS = 30_000;
const LISTING_MAX_BUFFER = 64 * 1024 * 1024;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  /** Same, restricted to files, for callers that never show directories */
  fileEntries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-host, per-cwd cache on globalThis so it survives Next.js hot-reload; the
// @ menu re-requests on every open and searches on every keystroke, so
// listings must not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
  var __piFileIndexPending: Map<string, Promise<FileListing>> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

/** The same directory string on two hosts is two different trees. */
function cacheKey(host: Host, cwd: string): string {
  return `${host.id}\0${cwd}`;
}

/**
 * Build the listing for one cwd, collapsing concurrent callers onto the same
 * scan. Without this, several refreshes in flight would each run `git ls-files`
 * and the slowest one could overwrite a newer cache entry.
 */
function loadListing(host: Host, cwd: string): Promise<FileListing> {
  if (!globalThis.__piFileIndexPending) globalThis.__piFileIndexPending = new Map();
  const pending = globalThis.__piFileIndexPending;
  const key = cacheKey(host, cwd);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const scan = (async () => (await listWithGit(host, cwd)) ?? listWithWalk(host, cwd))()
    .finally(() => { pending.delete(key); });
  pending.set(key, scan);
  return scan;
}

async function listWithGit(host: Host, cwd: string): Promise<FileListing | null> {
  try {
    const gitOptions = {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: LISTING_MAX_BUFFER,
      env: { LC_ALL: "C" },
    };
    // --cached lists index entries, including files already removed from the
    // working tree. Those would show up as results that 404 the moment anyone
    // opens them, so subtract what git reports as deleted. That query is
    // auxiliary: a stale-but-complete listing beats throwing away the git
    // listing over it, which would fall back to the depth-capped readdir walk.
    const [listed, deleted] = await Promise.all([
      host.executor.exec(["git", "-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], gitOptions),
      host.executor.exec(["git", "-C", cwd, "ls-files", "--deleted", "-z"], gitOptions).catch(() => null),
    ]);
    const missing = new Set((deleted?.stdout.toString("utf8") ?? "").split("\0").filter(Boolean));
    const all = listed.stdout.toString("utf8").split("\0").filter((file) => file && !missing.has(file));
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Local host: breadth-first readdir walk through the host fs, depth-capped.
 * Each BFS level is read with bounded parallelism; order within a level is
 * preserved so shallow files still win when the cap truncates the listing. */
async function listWithReaddirWalk(host: Host, cwd: string): Promise<FileListing> {
  const files: string[] = [];
  const pathApi = host.pathApi;
  let level: Array<{ abs: string; rel: string }> = [{ abs: cwd, rel: "" }];
  for (let depth = 0; level.length > 0; depth++) {
    const next: Array<{ abs: string; rel: string }> = [];
    for (let offset = 0; offset < level.length; offset += WALK_CONCURRENCY) {
      const chunk = level.slice(offset, offset + WALK_CONCURRENCY);
      const listings = await Promise.all(chunk.map((dir) => host.fs.readdir(dir.abs).catch((): DirEntry[] => [])));
      for (let index = 0; index < chunk.length; index++) {
        const { abs, rel } = chunk[index];
        for (const entry of listings[index]) {
          if (isIgnoredName(entry.name)) continue;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          // Symlinks are skipped either way, exactly like Dirent.isDirectory()/isFile().
          if (entry.type === "dir") {
            if (depth + 1 <= MAX_WALK_DEPTH) next.push({ abs: pathApi.join(abs, entry.name), rel: childRel });
          } else if (entry.type === "file") {
            if (files.length >= WALK_HARD_CAP) {
              return { files, hardTruncated: true };
            }
            files.push(childRel);
          }
        }
      }
    }
    level = next;
  }
  return { files, hardTruncated: false };
}

/** Remote host: the same walk as one `find` round trip. Ignored names are
 * pruned host-side (they never cross the wire), symlinks are skipped like the
 * readdir walk (-type f does not follow), and the depth cap matches: the
 * readdir walk descends into directories up to MAX_WALK_DEPTH deep and lists
 * their files, i.e. paths up to MAX_WALK_DEPTH + 1 segments. Output is sorted
 * by depth to keep the BFS "shallow files win" property under the cap. */
async function listWithFindWalk(host: Host, cwd: string): Promise<FileListing> {
  const prune = [...IGNORED_NAMES].map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  const suffixFilter = IGNORED_SUFFIXES.map((suffix) => `! -name ${shellQuote(`*${suffix}`)}`).join(" ");
  const script = [
    'cd -- "$1" || exit 1',
    `exec find . -mindepth 1 -maxdepth ${MAX_WALK_DEPTH + 1} \\( ${prune} \\) -prune -o -type f ${suffixFilter} -print0`,
  ].join("\n");
  let stdout: Buffer;
  try {
    ({ stdout } = await host.executor.exec(["sh", "-c", script, "sh", cwd], {
      timeoutMs: WALK_TIMEOUT_MS,
      maxBuffer: LISTING_MAX_BUFFER,
      env: { LC_ALL: "C" },
    }));
  } catch {
    // Unreadable root, or a tree so large the output bound was hit: report
    // an incomplete listing rather than failing the request.
    return { files: [], hardTruncated: true };
  }
  const files = stdout.toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => (file.startsWith("./") ? file.slice(2) : file));
  const depthOf = (file: string): number => file.split("/").length;
  files.sort((a, b) => depthOf(a) - depthOf(b));
  if (files.length > WALK_HARD_CAP) {
    return { files: files.slice(0, WALK_HARD_CAP), hardTruncated: true };
  }
  return { files, hardTruncated: false };
}

function listWithWalk(host: Host, cwd: string): Promise<FileListing> {
  return host.isLocal ? listWithReaddirWalk(host, cwd) : listWithFindWalk(host, cwd);
}

// GET /api/file-index?cwd=/abs/path[&q=query][&limit=n][&kind=file][&refresh=1][&host=<id>]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd). limit defaults to the `@`
// menu size and is clamped to MAX_RESULT_LIMIT; kind=file drops directories
// before ranking and reports a `truncated` flag; refresh=1 rebuilds the listing
// instead of using the TTL cache, for the explorer's refresh button.
// Guarded by the same allow-list as /api/files, on the selected host.
export const GET = withHostRoute(async (req: NextRequest) => {
  try {
    const host = currentHost();
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const allowedRoots = await getAllowedFileRoots(host);
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let isDirectory: boolean;
    try {
      isDirectory = (await host.fs.stat(cwd)).isDirectory();
    } catch {
      return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!isDirectory) {
      return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!(await isExistingFilePathAllowed(cwd, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const key = cacheKey(host, cwd);
    const now = Date.now();
    // An explicit refresh in the UI must not be answered from the TTL window,
    // or a file the agent just wrote stays invisible. loadListing collapses
    // concurrent rebuilds onto one scan, which is the whole bound: an age gate
    // on top of it can only suppress the refresh the user actually asked for.
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
    let cached = cache.get(key);
    if (!cached || cached.expiresAt <= now || forceRefresh) {
      const listing = await loadListing(host, cwd);
      for (const [entryKey, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(entryKey);
      }
      // Replacing an existing key does not grow the cache, so it must not wipe
      // the listings of unrelated projects.
      if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      // Timed after the scan, not from `now`: a large repo can take longer to
      // list than the whole TTL, which would store an already-expired entry.
      cached = { listing, expiresAt: Date.now() + CACHE_TTL_MS };
      cache.set(key, cached);
    }

    if (query) {
      const limit = parseResultLimit(req.nextUrl.searchParams.get("limit"));
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      // Directories score a ranking bonus, so a caller that only renders files
      // must drop them before the limit is applied: "api" in this repo matches
      // 67 directories, which would otherwise consume half the budget and
      // silently push matching files out of the response.
      if (req.nextUrl.searchParams.get("kind") === "file") {
        cached.fileEntries ??= cached.entries.filter((entry) => !entry.isDir);
        // Ask for one past the limit: the extra row never ships, it only tells
        // the panel that the list it shows is incomplete. A listing that hit the
        // hard cap is incomplete the same way, and is worth reporting even
        // though fewer than `limit` rows matched what survived.
        const ranked = filterFileEntries(cached.fileEntries, query, limit + 1);
        const truncated = ranked.length > limit || cached.listing.hardTruncated;
        return NextResponse.json({
          matches: truncated ? ranked.slice(0, limit) : ranked,
          truncated,
        });
      }
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query, limit) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
