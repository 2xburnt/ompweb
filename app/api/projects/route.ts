import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { comparableProjectPath } from "@/lib/comparable-path";
import { allowFileRoot } from "@/lib/file-access";
import { currentHost } from "@/lib/hosts/context";
import type { Host } from "@/lib/hosts/registry";
import { withHostRoute } from "@/lib/hosts/route";
import { hostProjectKey } from "@/lib/paths";
import {
  hideProject,
  mergeProjects,
  normalizeProjectCwd,
  ProjectPathError,
  readProjectRegistry,
  saveProjectRegistryOnHost,
  upsertProject,
  updateProjectsPresentation,
  validateProjectPath,
} from "@/lib/project-registry";
import { listAllSessions } from "@/lib/session-reader";
import { resolveProject } from "@/lib/worktree";
import type { ManagedProject } from "@/lib/types";

// Every handler here is scoped to one host (`?host=<id>` / x-omp-host, default
// host otherwise): the registry lives in that host's omp agent dir, session
// discovery only considers that host's sessions, and every returned project
// carries the host-scoped `projectKey` the session list uses.

type HostProject = ManagedProject & { projectKey: string; host: string };

function withProjectKey(host: Host, project: ManagedProject): HostProject {
  return { ...project, projectKey: hostProjectKey(host.id, project.path), host: host.id };
}

// GET /api/projects[?host=<id>]  →  { projects: HostProject[], host }
// Registered (non-hidden) projects plus session-discovered projects of the
// selected host, excluding hidden entries. Session-discovered paths get no
// addedAt; the client orders the merged list by most-recently-added
// (registration order), then by path — deliberately not by session activity,
// which would reorder rows on refresh.
export const GET = withHostRoute(async () => {
  try {
    const host = currentHost();
    const [registry, sessions] = await Promise.all([readProjectRegistry(host), listAllSessions()]);
    const discovered = sessions
      .filter((s) => s.host === host.id)
      .map((s) => s.projectRoot ?? s.cwd)
      .filter((path): path is string => Boolean(path));
    const projects = mergeProjects(registry, discovered);
    // Keep the in-memory browse allowlist warm for registered projects that
    // have no sessions (the in-memory list does not survive restarts, and an
    // empty managed project derives no root from sessions).
    for (const project of projects) allowFileRoot(project.path, host);
    return NextResponse.json({ projects: projects.map((project) => withProjectKey(host, project)), host: host.id });
  } catch (error) {
    return apiErrorResponse(error);
  }
});

// POST /api/projects[?host=<id>]  body: { cwd }  →  { project: HostProject }
// Validates the directory on the host, resolves Git worktrees to their main
// projectRoot, registers and authorizes it, and unhides it if it was
// previously hidden.
export const POST = withHostRoute(async (req: Request) => {
  try {
    const host = currentHost();
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const normalized = await validateProjectPath(cwd, host);
    const { projectRoot } = await resolveProject(normalized, host);

    const registry = await readProjectRegistry(host);
    const next = upsertProject(registry, projectRoot);
    await saveProjectRegistryOnHost(next, host);
    allowFileRoot(projectRoot, host);

    const entry = next.projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(projectRoot))!;
    return NextResponse.json({ project: withProjectKey(host, { path: entry.path, addedAt: entry.addedAt }) });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
});

// PATCH /api/projects[?host=<id>]
// Single shape: { cwd, alias?, sortOrder? }   Batch shape: { updates: [{ cwd, alias?, sortOrder? }, ...] }
// Applied atomically in one registry load/save so a drag reorder (one request,
// many entries) can never interleave with another writer and lose updates.
// Renaming or ordering a project is an explicit act of managing it: paths that
// were only session-discovered get registered and their root authorized in the
// same cycle instead of silently no-oping.
const MAX_PRESENTATION_UPDATES = 500;

export const PATCH = withHostRoute(async (req: Request) => {
  try {
    const host = currentHost();
    const body = await req.json() as {
      cwd?: unknown;
      alias?: unknown;
      sortOrder?: unknown;
      updates?: unknown;
    };
    const rawUpdates: unknown[] = Array.isArray(body.updates)
      ? body.updates
      : body.cwd !== undefined || body.alias !== undefined || body.sortOrder !== undefined
        ? [{ cwd: body.cwd, alias: body.alias, sortOrder: body.sortOrder }]
        : [];
    if (rawUpdates.length === 0) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    if (rawUpdates.length > MAX_PRESENTATION_UPDATES) {
      return NextResponse.json({ error: "Too many updates", code: "too_many_updates" }, { status: 400 });
    }

    // Pre-load registry so we can distinguish "already managed but now
    // deleted" (allow reorder/alias) from "session-discovered ghost" (must not
    // auto-register a deleted path). validateProjectPath is still required for
    // the latter.
    const earlyRegistry = await readProjectRegistry(host);
    // Cheap probe without stat: resolve ~ and relative, then compare. Mirrors
    // validateProjectPath's normalizeProjectCwd + canonicalProjectPath
    // fallback. The local machine resolves symlinks (one batch of parallel
    // syscalls); a remote path is used as-is — its registry entries were
    // written from git-resolved roots, so no per-path round trip is needed.
    const probes = await Promise.all(rawUpdates.map(async (item) => {
      const entry = item as { cwd?: unknown };
      const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
      if (!cwd) return null;
      const probe = normalizeProjectCwd(cwd);
      if (!host.isLocal) return probe;
      try {
        return await host.fs.realpath(probe);
      } catch {
        return probe; // deleted dirs fall back to the resolved form
      }
    }));
    const isAlreadyManaged = (index: number): string | null => {
      const probe = probes[index];
      if (!probe) return null;
      const key = comparableProjectPath(probe);
      const match = earlyRegistry.projects.find((p) => comparableProjectPath(p.path) === key);
      return match ? match.path : null;
    };

    const parsed: Array<{ path: string; alias?: string | null; sortOrder?: number | null }> = [];
    const skipped: Array<{ cwd: string; code: string; error: string }> = [];
    for (const [index, item] of rawUpdates.entries()) {
      const entry = item as { cwd?: unknown; alias?: unknown; sortOrder?: unknown };
      const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
      if (!cwd) return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
      const alias = entry.alias === null ? null : typeof entry.alias === "string" ? entry.alias : undefined;
      const sortOrder = entry.sortOrder === null ? null : typeof entry.sortOrder === "number" && Number.isFinite(entry.sortOrder) ? entry.sortOrder : undefined;
      if (entry.alias !== undefined && alias === undefined) return NextResponse.json({ error: "Alias must be a string", code: "invalid_alias" }, { status: 400 });
      if (entry.sortOrder !== undefined && sortOrder === undefined) return NextResponse.json({ error: "Sort order must be a number", code: "invalid_sort_order" }, { status: 400 });
      // Same existence/directory checks as POST: an auto-registering endpoint
      // must never persist ghost entries for deleted paths, plain files, or
      // unexpanded "~"/relative paths. For bulk reorder (multiple entries),
      // a single ghost (e.g. a session-discovered directory that was deleted
      // on disk) must not abort the entire batch — skip it instead.
      // Already-managed projects bypass the check so a user's explicitly added
      // workspace stays reorderable/renamable even after its directory is removed.
      const managedPath = isAlreadyManaged(index);
      if (managedPath) {
        parsed.push({ path: managedPath, alias, sortOrder });
        continue;
      }
      let normalized: string;
      try {
        normalized = await validateProjectPath(cwd, host);
      } catch (error) {
        if (error instanceof ProjectPathError) {
          if (rawUpdates.length > 1) {
            skipped.push({ cwd, code: error.code, error: error.message });
            continue;
          }
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
      let projectRoot: string;
      try {
        ({ projectRoot } = await resolveProject(normalized, host));
      } catch (error) {
        if (rawUpdates.length > 1) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({ cwd, code: "resolve_failed", error: message });
          continue;
        }
        throw error;
      }
      parsed.push({ path: projectRoot, alias, sortOrder });
    }
    // Bulk path: every entry was a ghost — propagate the first failure so the
    // client gets a meaningful 400 instead of a misleading 200 with no changes.
    if (parsed.length === 0 && skipped.length > 0) {
      const first = skipped[0]!;
      return NextResponse.json({ error: first.error, code: first.code }, { status: 400 });
    }

    // Duplicate targets within one batch merge per-field (later defined
    // fields win) instead of the whole later update replacing the earlier.
    const merged = new Map<string, { path: string; alias?: string | null; sortOrder?: number | null }>();
    for (const update of parsed) {
      const key = comparableProjectPath(update.path);
      const previous = merged.get(key);
      merged.set(key, previous ? {
        path: previous.path,
        alias: update.alias !== undefined ? update.alias : previous.alias,
        sortOrder: update.sortOrder !== undefined ? update.sortOrder : previous.sortOrder,
      } : update);
    }

    let registry = await readProjectRegistry(host);
    const newRoots: string[] = [];
    for (const update of merged.values()) {
      const key = comparableProjectPath(update.path);
      if (!registry.projects.some((p) => comparableProjectPath(p.path) === key)) {
        registry = upsertProject(registry, update.path);
        newRoots.push(update.path);
      }
    }
    // Hidden entries are invisible management-wise: user actions target rows
    // on screen, so their stored display data stays untouched.
    const updates = [...merged.values()].filter((update) => {
      const entry = registry.projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(update.path));
      return !entry?.hidden;
    });
    const next = updateProjectsPresentation(registry, updates);
    await saveProjectRegistryOnHost(next, host);
    // Only after a successful save: a failed write must not leave an orphaned
    // in-memory browse authorization behind.
    for (const root of newRoots) allowFileRoot(root, host);

    const updatedKeys = new Set(updates.map((update) => comparableProjectPath(update.path)));
    const projects = next.projects
      .filter((entry) => updatedKeys.has(comparableProjectPath(entry.path)))
      .map((entry) => ({ ...withProjectKey(host, { path: entry.path, addedAt: entry.addedAt, alias: entry.alias, sortOrder: entry.sortOrder }), hidden: entry.hidden }));
    return NextResponse.json({ projects, host: host.id });
  } catch (error) { return apiErrorResponse(error); }
});

// DELETE /api/projects[?host=<id>]  body: { cwd }  →  { success: true }
// Hides the project from the sidebar without touching its directory or
// sessions. Re-adding the directory (POST) restores it.
export const DELETE = withHostRoute(async (req: Request) => {
  try {
    const host = currentHost();
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }
    // Canonicalize worktree paths so hiding a worktree hides its whole project.
    const { projectRoot } = await resolveProject(cwd, host);
    const registry = await readProjectRegistry(host);
    await saveProjectRegistryOnHost(hideProject(registry, projectRoot), host);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
