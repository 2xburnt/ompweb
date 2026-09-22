import { comparableProjectPath } from "@/lib/comparable-path";
import type { HostConnectionState, HostSummary } from "@/lib/hosts/types";
import type { ManagedProject, SessionInfo } from "@/lib/types";

// ============================================================================
// Pure helpers for the machine level of the sidebar. Sessions from every
// machine arrive in one list (`/api/sessions`), each tagged with its host id
// and a projectKey of the form `${hostId}:${identityKey}`; managed projects
// are fetched per machine. The sidebar groups sessions by machine, then by
// project, and keys expansion state by machine + path so the same directory
// on two machines never shares state.
// ============================================================================

/** Colour token for a host connection state (dot + status text). */
export function hostStatusColor(status: HostConnectionState): string {
  switch (status) {
    case "connected": return "var(--status-success)";
    case "connecting": return "var(--status-warning)";
    case "error": return "var(--status-error)";
    default: return "var(--text-dim)";
  }
}

/** Host id a session belongs to, falling back when the server did not tag it
 *  (transient client-built rows, or a server that predates multi-machine). */
export function sessionHostId(session: Pick<SessionInfo, "host">, fallback: string | null): string | null {
  return session.host || fallback;
}

/** The session's project path on its own machine. The server's projectKey is
 *  `${hostId}:${identityKey}`; strip the machine prefix so the path can be
 *  matched against that machine's project list. Untagged keys (legacy or
 *  client-built) are already plain paths. */
export function sessionProjectPath(session: Pick<SessionInfo, "host" | "projectKey" | "projectRoot" | "cwd">): string {
  const key = session.projectKey;
  if (key) {
    if (session.host && key.startsWith(`${session.host}:`)) return key.slice(session.host.length + 1);
    if (!session.host) return key;
  }
  return session.projectRoot ?? session.cwd;
}

/** Storage/lookup key for a project's expansion state: machine + folded path. */
export function projectExpansionKey(hostId: string | null, path: string): string {
  return `${hostId ?? ""}:${comparableProjectPath(path)}`;
}

export interface MachineProjectGroup {
  project: ManagedProject;
  sessions: SessionInfo[];
  /** projectExpansionKey(hostId, project.path) — precomputed for rows. */
  key: string;
}

export interface MachineGroup {
  hostId: string;
  /** Summary when the machine is known to the client; null for a session
   *  whose host is not (yet) in the host list. */
  host: HostSummary | null;
  projects: MachineProjectGroup[];
}

export interface GroupSessionsByMachineInput {
  /** All known hosts (server order). Enabled ones always get a group. */
  hosts: readonly HostSummary[];
  /** Managed projects per machine, already in display order. */
  projectsByHost: Readonly<Record<string, readonly ManagedProject[]>>;
  /** Hidden project paths per machine. A session whose project is hidden is
   *  dropped rather than resurrected as a synthetic bucket. */
  hiddenPathsByHost?: Readonly<Record<string, readonly string[]>>;
  sessions: readonly SessionInfo[];
  /** Host assumed for sessions without a `host` tag. */
  fallbackHostId: string | null;
}

/** Group sessions by machine, then by project. Every enabled machine gets a
 *  group (possibly empty) so it stays visible; machines only known through
 *  their sessions are appended. Sessions whose project is missing from the
 *  machine's list get a synthetic project row (path = projectRoot) instead of
 *  disappearing — the project list for a remote may still be loading. */
export function groupSessionsByMachine(input: GroupSessionsByMachineInput): MachineGroup[] {
  const { hosts, projectsByHost, hiddenPathsByHost, sessions, fallbackHostId } = input;
  const groups = new Map<string, MachineGroup>();
  const bucketByKey = new Map<string, MachineProjectGroup>();
  const hostById = new Map(hosts.map((host) => [host.id, host] as const));
  // Hidden project paths folded to their expansion keys, keyed by host, so a
  // session under a removed project is skipped instead of spawning a phantom
  // bucket that shares a display name with a still-visible project.
  const hiddenKeysByHost = new Map<string, Set<string>>();
  for (const [host, paths] of Object.entries(hiddenPathsByHost ?? {})) {
    hiddenKeysByHost.set(host, new Set(paths.map((path) => projectExpansionKey(host, path))));
  }

  const ensureGroup = (hostId: string): MachineGroup => {
    let group = groups.get(hostId);
    if (group) return group;
    group = { hostId, host: hostById.get(hostId) ?? null, projects: [] };
    for (const project of projectsByHost[hostId] ?? []) {
      const key = projectExpansionKey(hostId, project.path);
      if (bucketByKey.has(key)) continue;
      const bucket: MachineProjectGroup = { project, sessions: [], key };
      group.projects.push(bucket);
      bucketByKey.set(key, bucket);
    }
    groups.set(hostId, group);
    return group;
  };

  for (const host of hosts) {
    if (host.enabled) ensureGroup(host.id);
  }

  const synthetic = new Map<string, MachineProjectGroup[]>();
  for (const session of sessions) {
    const hostId = sessionHostId(session, fallbackHostId);
    if (!hostId) continue;
    const group = ensureGroup(hostId);
    const path = sessionProjectPath(session);
    if (!path) continue;
    const key = projectExpansionKey(hostId, path);
    // A hidden project keeps no bucket, so its leftover sessions would fall
    // through to the synthetic branch below and reappear. Drop them: the
    // project was explicitly removed from the sidebar. A session that matches
    // an existing (visible) bucket is unaffected.
    if (!bucketByKey.has(key) && hiddenKeysByHost.get(hostId)?.has(key)) continue;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = { project: { path: session.projectRoot ?? session.cwd ?? path }, sessions: [], key };
      bucketByKey.set(key, bucket);
      const list = synthetic.get(group.hostId) ?? [];
      list.push(bucket);
      synthetic.set(group.hostId, list);
    }
    bucket.sessions.push(session);
  }

  for (const [hostId, buckets] of synthetic) {
    const group = groups.get(hostId);
    if (!group) continue;
    buckets.sort((a, b) => a.project.path.localeCompare(b.project.path));
    group.projects.push(...buckets);
  }

  return [...groups.values()];
}

/** Running/unread counts per project expansion key. */
export function projectActivityByKey(
  groups: readonly MachineGroup[],
  runningIds: ReadonlySet<string>,
  unreadIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const result = new Map<string, { running: number; unread: number }>();
  for (const group of groups) {
    for (const bucket of group.projects) {
      let running = 0;
      let unread = 0;
      for (const session of bucket.sessions) {
        if (runningIds.has(session.id)) running += 1;
        if (unreadIds.has(session.id)) unread += 1;
      }
      if (running > 0 || unread > 0) result.set(bucket.key, { running, unread });
    }
  }
  return result;
}
export interface SidebarActivity {
  running: number;
  unread: number;
}

/** Aggregate project activity to each machine. Machines without activity are omitted. */
export function machineActivityByHost(
  groups: readonly MachineGroup[],
  projectActivity: ReadonlyMap<string, SidebarActivity>,
): Map<string, SidebarActivity> {
  const result = new Map<string, SidebarActivity>();
  for (const group of groups) {
    let running = 0;
    let unread = 0;
    for (const bucket of group.projects) {
      const activity = projectActivity.get(bucket.key);
      running += activity?.running ?? 0;
      unread += activity?.unread ?? 0;
    }
    if (running > 0 || unread > 0) result.set(group.hostId, { running, unread });
  }
  return result;
}

/** Parent rows represent activity only while their child rows are hidden. */
export function collapsedActivity(
  isExpanded: boolean,
  activity: SidebarActivity | undefined,
): SidebarActivity | undefined {
  return isExpanded ? undefined : activity;
}
