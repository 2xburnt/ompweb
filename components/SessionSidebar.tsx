"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SidebarPortalMenu } from "./SidebarPortalMenu";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { sortManagedProjects } from "@/lib/project-ordering";
import { comparableProjectPath } from "@/lib/comparable-path";
import { Archive, Check, ChevronDown, ChevronRight, FileUp, Folder, GitBranch, MoreHorizontal, Plus, RefreshCw, Search, Server, Settings2, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { hostFetch, useHosts, worthAsking } from "@/lib/hosts/client";
import { MachineSwitcher } from "./MachineSwitcher";
import { groupSessionsByMachine, projectActivityByKey, projectExpansionKey, sessionHostId, sessionProjectPath, type MachineGroup } from "./machine-groups";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  /** Effective cwd changed. `hostId` is the machine the cwd lives on. */
  onCwdChange?: (cwd: string | null, projectRoot?: string | null, hostId?: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  explorerRefreshing?: boolean;
  onExplorerRefreshDone?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available — shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** Opens Settings → Machines (from the machine switcher). */
  onManageMachines?: () => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

/** Normalize a repository/project path for use as a Git-state map key. The
 *  same physical repo may be reached via different path spellings (forward /
 *  back slashes, drive-letter casing); folding them makes distinct spellings
 *  resolve to one shared Git context, while genuinely different repos stay
 *  separate. */
function normalizeProjectKey(value: string): string {
  // Clip trailing separators and unify separators. Fold case when the path is
  // Windows-style (drive-letter rooted or backslash-y) so Drive:\ vs C:\ and
  // path casing variants map to the same repository, while preserving
  // case-sensitivity for POSIX paths (client has no process.platform).
  const isWindowsPath = /^[a-zA-Z]:/.test(value) || value.includes("\\");
  const normalized = value.replace(/[\/]+$/, "").replace(/\\/g, "/");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

// Bounded retry window for restoring a brand-new session from its URL before
// omp flushes the JSONL (typically appears within a second or two of the
// first prompt, so 8 × 1s covers it without hanging a dead link forever).
const INITIAL_RESTORE_RETRY_MS = 1000;
const INITIAL_RESTORE_MAX_ATTEMPTS = 8;

const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

const EXPANDED_PROJECTS_STORAGE_KEY = "omp-web:expanded-projects";

/** Shared empty set for the no-stored-expansion default (never mutated). */
const EMPTY_PROJECT_SET: ReadonlySet<string> = new Set();

/** Persisted expanded-project paths. Returns null when nothing was stored —
 *  the sidebar then defaults to expanding only the active project. */
function loadExpandedProjects(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((path): path is string => typeof path === "string" && path.length > 0).map((path) => comparableProjectPath(path)));
    }
    return null;
  } catch {
    return null;
  }
}

function saveExpandedProjects(paths: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */

/** Persisted collapsed machine ids (machines default to expanded). */


/** Git-state cache key: the same repository path on two machines is two repos. */
function worktreeStateKey(hostId: string | null, root: string): string {
  return `${hostId ?? ""}:${normalizeProjectKey(root)}`;
}

const EMPTY_PROJECTS: ManagedProject[] = [];

function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** Final folder name of a project path, portable across / and \ separators. */
function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

function formatRelativeTime(value: string, _locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

const SIDEBAR_BUTTON_TRANSITION = "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)";

/** Quiet square icon button used across the sidebar chrome (header, section
 *  headers, footer). Stays visually subdued; the accent appears on hover and
 *  when active (e.g. an applied filter). */
function SidebarIconButton({
  label,
  title,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0, lineHeight: 0,
        background: active || hovered ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: "var(--radius-control)",
        color: active ? "var(--accent)" : hovered ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: SIDEBAR_BUTTON_TRANSITION,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean, reducedMotion: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running || reducedMotion) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running, reducedMotion]);

  return display;
}

function OmpWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const target = showVersion ? `v${process.env.NEXT_PUBLIC_OMP_WEB_VERSION ?? "0.0.0"}` : "omp web";
  const display = useScramble(target, scrambling, reducedMotion);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
    if (reducedMotion) return;
    setScrambling(true);
    scrambleTimerRef.current = setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, [reducedMotion]);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
  }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
        lineHeight: 1,
      }}
      title={showVersion ? "Show ompweb name" : "Show ompweb version"}
    >
      {!scrambling && !showVersion ? (
        <>
          <span style={{ color: "var(--accent)" }}>omp</span>
          <span style={{ color: "var(--text)" }}>web</span>
        </>
      ) : (
        <span style={{ color: showVersion ? "var(--accent)" : "var(--text)" }}>{display}</span>
      )}
    </button>
  );
}
export const SessionSidebar = memo(function SessionSidebar({ selectedSessionId, optimisticSession, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, explorerRefreshing, onExplorerRefreshDone, onAtMention, onAtMentions, onOpenSettings, onOpenArchive, updateAvailable, onManageMachines }: Props) {
  const { t } = useI18n();
  // Machines: the selected machine scopes projects, worktrees, the explorer
  // and New Session; sessions from every machine are listed together.
  const { hosts, hostId, loaded: hostsLoaded, setHostId, refresh: refreshHostList } = useHosts();
  const enabledHosts = useMemo(() => hosts.filter((host) => host.enabled), [hosts]);
  // Machines worth asking: the ones that answered, plus any not yet tried.
  // Asking a machine that is down costs a full connect timeout per request and
  // reports nothing the probe has not already put on screen.
  const reachableHosts = useMemo(() => enabledHosts.filter(worthAsking), [enabledHosts]);
  const reachableHostKey = reachableHosts.map((host) => host.id).join("\n");
  const multiHost = enabledHosts.length > 1;
  const defaultHostId = hosts.find((host) => host.isDefault)?.id ?? null;
  /** Machine assumed for sessions the server did not tag with a host. */
  const fallbackHostId = defaultHostId ?? hostId;
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  // Home directory per machine — paths are shortened with the owner's home.
  const [homeByHost, setHomeByHost] = useState<Record<string, string>>({});
  const homeDir = hostId ? homeByHost[hostId] ?? "" : "";
  // Managed + session-discovered projects per machine (server-merged, hidden
  // excluded). `projects` is the selected machine's list.
  const [projectsByHost, setProjectsByHost] = useState<Record<string, ManagedProject[]>>({});
  const projects = hostId ? projectsByHost[hostId] ?? EMPTY_PROJECTS : EMPTY_PROJECTS;
  const [draggedProject, setDraggedProject] = useState<{ host: string; path: string } | null>(null);
  const [projectsErrorByHost, setProjectsErrorByHost] = useState<Record<string, string>>({});
  const selectedHostSummary = hostId ? hosts.find((host) => host.id === hostId) ?? null : null;
  // A machine that was never asked has no fetch error to report, so the
  // connection failure the probe already found stands in for one.
  const projectsError = hostId
    ? projectsErrorByHost[hostId]
      ?? (selectedHostSummary?.status === "error"
        ? t("projects.loadFailed", { detail: selectedHostSummary.lastError ?? t("hosts.status.error") })
        : null)
    : null;
  // Collapsed machine groups, persisted like project expansion.
  // Machine the selected cwd belongs to. A machine switch from the header
  // resets the selection; selecting a session/project on another machine
  // updates this first so the switch effect leaves the selection alone.
  const activeHostRef = useRef<string | null>(null);

  // Add-project picker state.
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => loadExpandedProjects());
  // Project currently being removed (hide) — serializes remove requests.
  const [removeProjectPath, setRemoveProjectPath] = useState<string | null>(null);
  // Worktree/branch/Git state is scoped per repository. It is cached in a
  // map keyed by the normalized repository root so switching workspaces never
  // leaks one project's branch/worktree data into another's UI (each project
  // keeps its own loaded Git state; a late async response for a previous repo
  // only updates that repo's entry, never the active one).
  const [worktreeStateByProject, setWorktreeStateByProject] = useState<Record<string, WorktreeState>>({});
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtToggleRef = useRef<HTMLButtonElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [runningSessionCwds, setRunningSessionCwds] = useState<Record<string, string>>({});
  const knownRunningCwdsRef = useRef<Map<string, string>>(new Map());
  // Machine of each running session (SSE + /api/sessions tag them).
  const [runningSessionHosts, setRunningSessionHosts] = useState<Record<string, string>>({});
  const knownRunningHostsRef = useRef<Map<string, string>>(new Map());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  const loadSessions = useCallback(async (showLoading = false) => {
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    try {
      if (showLoading) setLoading(true);
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const res = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("ETag");
      if (etag) sessionsEtagRef.current = etag;
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; cwd: string; host?: string }> };
      setAllSessions(data.sessions);
      if (data.runningSessions) {
        for (const rs of data.runningSessions) {
          if (rs.id && rs.cwd) knownRunningCwdsRef.current.set(rs.id, rs.cwd);
          if (rs.id && rs.host) knownRunningHostsRef.current.set(rs.id, rs.host);
        }
      }
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        if (data.runningSessions) {
          const nextCwds: Record<string, string> = {};
          const nextHosts: Record<string, string> = {};
          for (const rs of data.runningSessions) {
            if (rs.id && rs.cwd) nextCwds[rs.id] = rs.cwd;
            if (rs.id && rs.host) nextHosts[rs.id] = rs.host;
          }
          setRunningSessionCwds(nextCwds);
          setRunningSessionHosts(nextHosts);
        }
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(t("sessionSidebar.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      initialLoadedRef.current = true;
      if (showLoading) setLoading(false);
    }
  }, [t]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projectsLoadSeqRef = useRef(0);
  /** Load the managed project list of every enabled machine (each machine
   *  keeps its own registry). Waits for the machine list so results can be
   *  keyed by machine id. */
  const loadProjects = useCallback(async () => {
    const ids = reachableHostKey ? reachableHostKey.split("\n") : [];
    if (ids.length === 0) return;
    const seq = ++projectsLoadSeqRef.current;
    await Promise.all(ids.map(async (id) => {
      try {
        const res = await hostFetch("/api/projects", undefined, id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { projects?: ManagedProject[] };
        // A newer request superseded this one — drop the stale response.
        if (seq !== projectsLoadSeqRef.current) return;
        setProjectsByHost((prev) => ({ ...prev, [id]: data.projects ?? [] }));
        setProjectsErrorByHost((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        projectsLoadedHostsRef.current.add(id);
      } catch (e) {
        if (seq !== projectsLoadSeqRef.current) return;
        setProjectsErrorByHost((prev) => ({ ...prev, [id]: t("projects.loadFailed", { detail: e instanceof Error ? e.message : String(e) }) }));
      }
    }));
  }, [reachableHostKey, t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  // Refreshing re-probes the machines too. The fetches above skip machines
  // whose last probe failed, so nothing else would notice one coming back:
  // it would stay missing from the sidebar until the page was reloaded.
  // Re-probing is one request that fans out on the server, rather than the
  // per-machine requests this replaced.
  const probedForRefreshRef = useRef(refreshKey);
  useEffect(() => {
    // Skipped on mount, where the machine list has just been probed anyway.
    if (probedForRefreshRef.current === refreshKey) return;
    probedForRefreshRef.current = refreshKey;
    void refreshHostList({ probe: true }).catch(() => {});
  }, [refreshKey, refreshHostList]);

  // Forget everything belonging to a machine that is no longer configured.
  // Removing a machine in Settings does not reach into these per-machine maps,
  // so its projects, sessions and Git state stayed on screen as rows that
  // could not be opened or cleaned up, and the file explorer kept asking a
  // machine the server no longer knows ("Unknown host"). Keyed on the set of
  // live machines, so it also covers a machine being disabled.
  const liveHostKey = useMemo(
    () => enabledHosts.map((host) => host.id).sort().join("\u0000"),
    [enabledHosts],
  );
  useEffect(() => {
    if (!hostsLoaded) return;
    const live = new Set(liveHostKey ? liveHostKey.split("\u0000") : []);
    const pruneByHost = <T,>(previous: Record<string, T>): Record<string, T> => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([id]) => live.has(id)));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    };
    setProjectsByHost(pruneByHost);
    setHomeByHost(pruneByHost);
    setProjectsErrorByHost(pruneByHost);
    // These are keyed "<hostId>:<path>", so match on the machine prefix.
    const pruneByHostPrefix = <T,>(previous: Record<string, T>): Record<string, T> => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([key]) => live.has(key.slice(0, key.indexOf(":")))));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    };
    setWorktreeStateByProject(pruneByHostPrefix);
    setExpandedProjects((previous) => {
      if (!previous) return previous;
      const kept = new Set([...previous].filter((key) => live.has(key.slice(0, key.indexOf(":")))));
      return kept.size === previous.size ? previous : kept;
    });
    // A selection on a removed machine would keep the explorer and worktree
    // loader pointed at a machine that no longer exists.
    if (activeHostRef.current && !live.has(activeHostRef.current)) {
      activeHostRef.current = hostId;
      setSelectedCwd(null);
    }
    void loadSessions();
  }, [hostsLoaded, liveHostKey, hostId, loadSessions]);



  useEffect(() => {
    const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist expansion state; null means nothing was stored yet.
  useEffect(() => {
    if (expandedProjects === null) return;
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  // Debounce refresh bursts (agent_start + session_info_update + file-appear signal can fire within 250ms)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      void loadSessions(false);
    }, 300);
  }, [loadSessions]);
  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Live running status and session-list invalidations arrive via SSE; the
    // sidebar never has to poll while an agent is working.
    const source = new EventSource("/api/agent/running/events");

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; cwd: string; host?: string }>;
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          if (data.runningSessions) {
            const nextCwds: Record<string, string> = {};
            const nextHosts: Record<string, string> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) {
                knownRunningCwdsRef.current.set(rs.id, rs.cwd);
                nextCwds[rs.id] = rs.cwd;
              }
              if (rs.id && rs.host) {
                knownRunningHostsRef.current.set(rs.id, rs.host);
                nextHosts[rs.id] = rs.host;
              }
            }
            setRunningSessionCwds(nextCwds);
            setRunningSessionHosts(nextHosts);
          }
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      } catch {
        // ignore malformed frames
      }
    };

    source.onerror = () => {
      // EventSource auto-reconnects; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      sseAuthoritativeRef.current = false;
    };
    // On error EventSource auto-reconnects; keep the last known state meanwhile.
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      source.close();
    };
  }, [loadSessions, scheduleRefresh]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // A brand-new session's JSONL does not exist until the first assistant
    // turn makes progress — but its running badge must show immediately
    // via the optimistic row. Once any session completes (or a new session
    // appears on disk), reload so it replaces the optimistic placeholder
    // without waiting for another refresh trigger.
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  // Home directory of every enabled machine: seeded from the probe result,
  // fetched from /api/home for machines the probe has not reached yet.
  const homeRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const host of reachableHosts) {
      if (homeByHost[host.id]) continue;
      if (host.home) {
        const home = host.home;
        setHomeByHost((prev) => (prev[host.id] === home ? prev : { ...prev, [host.id]: home }));
        continue;
      }
      if (homeRequestedRef.current.has(host.id)) continue;
      homeRequestedRef.current.add(host.id);
      hostFetch("/api/home", undefined, host.id).then((r) => r.json()).then((d: { home?: string }) => {
        if (d.home) setHomeByHost((prev) => ({ ...prev, [host.id]: d.home! }));
      }).catch(() => {
        homeRequestedRef.current.delete(host.id);
      });
    }
  }, [reachableHosts, homeByHost]);

  const restoredRef = useRef(false);
  /** Machines whose /api/projects fetch has succeeded at least once; guards
   *  the expansion prune against running on an empty (still-loading) list. */
  const projectsLoadedHostsRef = useRef<Set<string>>(new Set());

  /** Resolve the project root for a cwd from the freshest data available.
   *  The worktree/branch cache is keyed per repository, so this lookup is
   *  scoped: a worktree belongs to the repository whose cached GitState lists
   *  it — never to a different repository's state. */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    // Only the selected machine's Git state: the same path elsewhere is
    // another repository.
    const prefix = `${hostId ?? ""}:`;
    for (const [key, state] of Object.entries(worktreeStateByProject)) {
      if (!key.startsWith(prefix)) continue;
      if (state.worktrees.some((w) => normalizeProjectKey(w.path) === normalizeProjectKey(cwd))) {
        return state.projectRoot;
      }
    }
    // Fall back to the project registry, then to session cwd→root matches, so
    // a session whose projectKey was normalized server-side still resolves to
    // the registry's case-preserved path — the caller gets a canonical value.
    const registered = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cwd));
    if (registered) return registered.path;
    const foldedCwd = comparableProjectPath(cwd);
    const match = allSessions.find((s) => sessionHostId(s, fallbackHostId) === hostId && comparableProjectPath(s.cwd) === foldedCwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeStateByProject, allSessions, projects, hostId, fallbackHostId]);

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  // Keys are `${machine}:${comparableProjectPath(path)}` so case-variant
  // spellings of the same Windows path map to one entry (the server lowercases
  // projectKey on win32, while project.path preserves registry casing) and the
  // same directory on two machines keeps separate state.
  const expandProject = useCallback((path: string, host: string | null = hostId) => {
    const key = projectExpansionKey(host, path);
    setExpandedProjects((prev) => {
      if (prev?.has(key)) return prev;
      const next = new Set(prev ?? []);
      next.add(key);
      return next;
    });
  }, [hostId]);

  const collapseProject = useCallback((path: string, host: string | null = hostId) => {
    const key = projectExpansionKey(host, path);
    setExpandedProjects((prev) => {
      if (!prev?.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [hostId]);

  const toggleProjectExpanded = useCallback((path: string, host: string | null = hostId) => {
    const key = projectExpansionKey(host, path);
    setExpandedProjects((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [hostId]);

  /** Make `host` the selected machine because the user picked something on
   *  it (project, session). Marks it active first so the machine-switch
   *  effect does not clear the selection being made. */
  const adoptHost = useCallback((host: string | null) => {
    if (!host || host === hostId) return;
    activeHostRef.current = host;
    setHostId(host);
  }, [hostId, setHostId]);

  /** Activate a project (effective cwd = its root) and expand it, without
   *  opening a session. Projects of another machine switch the machine. */
  const activateProject = useCallback((path: string, host: string | null = hostId) => {
    provisionalSelectionRef.current = false;
    adoptHost(host);
    setSelectedCwd(path);
    expandProject(path, host);
  }, [expandProject, adoptHost, hostId]);

  // A machine switch from the header (not from picking a project/session on
  // that machine) leaves the selected directory on the previous machine: drop
  // it so the top project of the new machine is auto-selected below.
  useEffect(() => {
    if (!hostId) return;
    if (activeHostRef.current === null || activeHostRef.current === hostId) {
      activeHostRef.current = hostId;
      return;
    }
    activeHostRef.current = hostId;
    provisionalSelectionRef.current = false;
    setSelectedCwd(null);
  }, [hostId]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd), hostId);
  }, [selectedCwd, onCwdChange, projectRootFor, hostId]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. Sessions
  // picked outside the sidebar (URL restore, command palette) also expand
  // their containing project.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
      const project = projectRootFor(selectedCwdProp);
      if (project) expandProject(project);
    }
  }, [selectedCwdProp, projectRootFor, expandProject]);

  // Load worktrees/branch data for the repository containing the current
  // effective cwd. Results are cached in worktreeStateByProject keyed by the
  // normalized repository root, so each workspace keeps its own Git context:
  //  • switching to another repo leaves this repo's cached state intact, and
  //  • a late response for the previously-selected repo writes only that
  //    repo's entry (never the active repo's, so it can't overwrite the UI).
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  // The machine the current `selectedCwd` was chosen on. A machine switch
  // changes `hostId` while `selectedCwd` still points at the previous
  // machine's directory for one commit (the reset above only schedules a
  // re-render), so this ref stays on the old machine and the loader below
  // skips that commit. Without it the new machine is asked about a path it
  // has no business seeing, which comes back as access-denied.
  const cwdHostRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    cwdHostRef.current = hostId;
    // Intentionally keyed on the directory only: when the MACHINE changes the
    // recorded machine must go stale, which is what the loader detects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCwd]);

  useLayoutEffect(() => {
    if (!selectedCwd || !hostId) return;
    if (cwdHostRef.current !== hostId) return;
    let cancelled = false;
    const requestedCwd = selectedCwd;
    const requestedHost = hostId;
    hostFetch(`/api/worktrees?cwd=${encodeURIComponent(requestedCwd)}`, undefined, requestedHost)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          // This cwd is not a Git repo (or the lookup failed) — the selected
          // workspace should show no branch/worktrees. Other repos' cached
          // state is left intact: a non-Git workspace never inherits another
          // repo's branch, and we never discard previously-visited repos' Git
          // state.
          return;
        }
        const projectRoot = d.projectRoot;
        const entry: WorktreeState = {
          forCwd: requestedCwd,
          projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          worktrees: d.worktrees ?? [],
        };
        setWorktreeStateByProject((prev) => {
          const key = worktreeStateKey(requestedHost, projectRoot);
          const existing = prev[key];
          if (existing && worktreeStateKey(requestedHost, existing.projectRoot) !== key) {
            const next = { ...prev };
            delete next[worktreeStateKey(requestedHost, existing.projectRoot)];
            next[key] = entry;
            return next;
          }
          return { ...prev, [key]: entry };
        });
      })
      .catch(() => { /* leave any cached state; refetch on demand */ });
    return () => { cancelled = true; };
  }, [selectedCwd, hostId, wtRefreshKey, refreshKey]);

  // Keep a just-created session and its project visible while omp is still
  // flushing the JSONL file. The server list remains authoritative once it
  // contains the same id.
  // IMPORTANT: derive synchronously — the previous projectRootFor(cwd) needs
  // the async /api/worktrees git lookup, so the optimistic row would park in
  // cwd-bucket then jump to repo bucket. Use registered-project match first.
  const optimisticProjectRoot = (() => {
    if (!optimisticSession) return null;
    if (optimisticSession.projectRoot) return optimisticSession.projectRoot;
    if (optimisticSession.projectKey) return optimisticSession.projectKey;
    const cw = optimisticSession.cwd ?? "";
    if (!cw) return null;
    const reg = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cw));
    if (reg) return reg.path;
    return cw;
  })();
  // Stable placeholder timestamps: Date.now() inside the memo would churn every refresh and bust downstream memos.
  const placeholderTsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (optimisticSession?.id && optimisticSession.cwd) {
      knownRunningCwdsRef.current.set(optimisticSession.id, optimisticSession.cwd);
      setRunningSessionCwds((prev) => (prev[optimisticSession.id] === optimisticSession.cwd ? prev : { ...prev, [optimisticSession.id]: optimisticSession.cwd }));
    }
  }, [optimisticSession]);
  const visibleSessions = useMemo(() => {
    let base = allSessions;
    if (optimisticSession && !base.some((session) => session.id === optimisticSession.id)) {
      const stableRoot = optimisticProjectRoot ?? optimisticSession.cwd;
      const stableKey = stableRoot ? comparableProjectPath(stableRoot) : undefined;
      // A just-created session lives on the machine it was started on.
      const host = optimisticSession.host ?? hostId ?? undefined;
      base = [...base, { ...optimisticSession, ...(host ? { host } : {}), projectRoot: stableRoot ?? optimisticSession.cwd, ...(stableKey ? { projectKey: stableKey } : {}) }];
    }
    // A running session's JSONL may not exist yet (first turn still
    // streaming). Keep it in the list so navigating away never hides it
    // until the file lands and the next refresh replaces the placeholder.
    const known = new Set(base.map((s) => s.id));
    const placeholders: SessionInfo[] = [];
    for (const id of runningSessionIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const sessionHost = (isOptimistic ? optimisticSession.host : null)
        ?? runningSessionHosts[id]
        ?? knownRunningHostsRef.current.get(id)
        ?? hostId
        ?? undefined;
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phRoot = resolvedRoot ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        ...(sessionHost ? { host: sessionHost } : {}),
        path: "",
        cwd: sessionCwd,
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
      });
    }
    // Prune timestamps and known cwds for ids that are now materialized or no longer running
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!runningSessionIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    if (knownRunningCwdsRef.current.size > runningSessionIds.size + (optimisticSession ? 1 : 0)) {
      const activeIds = new Set(runningSessionIds);
      if (optimisticSession) activeIds.add(optimisticSession.id);
      for (const key of [...knownRunningCwdsRef.current.keys()]) {
        if (!activeIds.has(key) && known.has(key)) knownRunningCwdsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, runningSessionCwds, runningSessionHosts, projectRootFor, selectedCwd, hostId]);
  const visibleProjects = useMemo(() => {
    let base = projects;
    const hasOpt = optimisticProjectRoot ? base.some((p) => comparableProjectPath(p.path) === comparableProjectPath(optimisticProjectRoot)) : false;
    if (optimisticProjectRoot && !hasOpt) {
      base = [...base, { path: optimisticProjectRoot }];
    }
    // Running placeholders may belong to a project not yet in the managed list
    // (new session's cwd wasn't registered as a project). Keep that workspace
    // visible so the placeholder row has a bucket to render in.
    const knownFolded = new Set(base.map((p) => comparableProjectPath(p.path)));
    for (const id of runningSessionIds) {
      if (allSessions.some((s) => s.id === id)) continue;
      const isOptimistic = optimisticSession?.id === id;
      // Placeholders of another machine get their bucket in that machine's
      // group (groupSessionsByMachine synthesizes it) — not a row here.
      const placeholderHost = (isOptimistic ? optimisticSession.host : null)
        ?? runningSessionHosts[id]
        ?? knownRunningHostsRef.current.get(id)
        ?? hostId;
      if (placeholderHost !== hostId) continue;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phPath = resolvedRoot ?? "";
      if (phPath && !knownFolded.has(comparableProjectPath(phPath))) {
        base = [...base, { path: phPath }];
        knownFolded.add(comparableProjectPath(phPath));
      }
    }
    return base;
  }, [optimisticProjectRoot, projects, runningSessionIds, runningSessionCwds, runningSessionHosts, allSessions, optimisticSession, projectRootFor, selectedCwd, hostId]);

  // ---- Derived project list ---------------------------------------------------
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);
  // While a fresh optimistic/placeholder is pending (JSONL not yet on disk),
  // freeze ordering so the new project row does not flicker optimistic ->
  // confirmed position. New projects are allowed to append at the end.
  const hasPendingNewSession = Boolean(optimisticSession || [...runningSessionIds].some((id) => !allSessions.some((ss) => ss.id === id)));
  const sortedProjectsBase = useMemo(() => sortManagedProjects(visibleProjects), [visibleProjects]);
  const sortedProjectsRef = useRef<ManagedProject[] | null>(null);
  const sortedProjects = useMemo(() => {
    if (hasPendingNewSession && sortedProjectsRef.current) {
      const prev = sortedProjectsRef.current;
      const prevKeys = new Set(prev.map((p) => comparableProjectPath(p.path)));
      const next = [...prev];
      for (const p of sortedProjectsBase) if (!prevKeys.has(comparableProjectPath(p.path))) next.push(p);
      return next;
    }
    sortedProjectsRef.current = sortedProjectsBase;
    return sortedProjectsBase;
  }, [sortedProjectsBase, hasPendingNewSession]);
  // Every machine's project list in display order; the selected machine uses
  // the order-frozen list above so a pending new session does not reshuffle.
  const sortedProjectsByHost = useMemo(() => {
    const result: Record<string, ManagedProject[]> = {};
    for (const host of enabledHosts) {
      result[host.id] = host.id === hostId ? sortedProjects : sortManagedProjects(projectsByHost[host.id] ?? EMPTY_PROJECTS);
    }
    if (hostId && !result[hostId]) result[hostId] = sortedProjects;
    return result;
  }, [enabledHosts, hostId, sortedProjects, projectsByHost]);
  const machineGroups = useMemo(
    () => groupSessionsByMachine({ hosts, projectsByHost: sortedProjectsByHost, sessions: visibleSessions, fallbackHostId }),
    [hosts, sortedProjectsByHost, visibleSessions, fallbackHostId],
  );
  const hasAnyProject = machineGroups.some((group) => group.projects.length > 0);
  const projectActivity = useMemo(
    () => projectActivityByKey(machineGroups, runningSessionIds, unreadSessionIds),
    [machineGroups, runningSessionIds, unreadSessionIds],
  );

  // Client-side filtering (Workspaces header: search + "running only").
  // While a filter is active, workspaces with no matching sessions are hidden
  // so the list reads as a genuine result set; at rest every workspace stays.
  // Deferred search: typing stays responsive (input updates immediately) while the heavy
  // visibleMachineEntries filter runs at lower priority. Combines with the 200ms ETag loadSessions
  // debounce already in place — keystrokes never block the main thread on large session lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filtersActive = searchOpen || runningOnly || deferredSearchQuery.trim().length > 0;
  type ProjectEntry = { project: ManagedProject; sessions: SessionInfo[]; key: string };
  type MachineEntry = MachineGroup & { entries: ProjectEntry[] };
  const visibleMachineEntries = useMemo<MachineEntry[]>(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    const result: MachineEntry[] = [];
    for (const group of machineGroups) {
      const entries: ProjectEntry[] = [];
      for (const bucket of group.projects) {
        const { project } = bucket;
        let list = bucket.sessions;
        if (runningOnly) list = list.filter((s) => runningSessionIds.has(s.id));
        if (q) {
          list = list.filter((s) => (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q));
        }
        // Label/alias-only matches surface as empty workspaces; without this
        // clause a custom workspace name would be unfindable by search.
        if (list.length === 0 && (runningOnly || (q && !projectLabel(project.path).toLowerCase().includes(q) && !(project.alias ?? "").toLowerCase().includes(q)))) continue;
        entries.push({ project, sessions: list, key: bucket.key });
      }
      // While a filter is active, machines without matches drop out too.
      if (entries.length === 0 && filtersActive) continue;
      result.push({ ...group, entries });
    }
    return result;
  }, [machineGroups, runningOnly, deferredSearchQuery, runningSessionIds, filtersActive]);
  const hasVisibleProject = visibleMachineEntries.some((group) => group.entries.length > 0);

  const treesByProject = useMemo(() => {
    const m = new Map<string, ReturnType<typeof buildSessionTree>>();
    for (const group of visibleMachineEntries) {
      for (const { key, sessions } of group.entries) m.set(key, buildSessionTree(sessions));
    }
    return m;
  }, [visibleMachineEntries]);

  // Drop persisted expansion keys whose project no longer exists (removed or
  // vanished), so the storage stays bounded to real projects. Only prunes
  // machines whose project fetch has succeeded — an empty list mid-load must
  // never wipe storage — plus keys of machines that are no longer configured.
  useEffect(() => {
    if (expandedProjects === null || !hostsLoaded) return;
    const known = new Set<string>();
    for (const group of machineGroups) for (const bucket of group.projects) known.add(bucket.key);
    const configured = new Set(hosts.map((host) => host.id));
    const stale = [...expandedProjects].filter((key) => {
      if (known.has(key)) return false;
      const sep = key.indexOf(":");
      const host = sep >= 0 ? key.slice(0, sep) : "";
      return projectsLoadedHostsRef.current.has(host) || !configured.has(host);
    });
    if (stale.length === 0) return;
    setExpandedProjects((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      stale.forEach((key) => next.delete(key));
      return next;
    });
  }, [expandedProjects, machineGroups, hosts, hostsLoaded]);

  // True while the auto-selected project was chosen before projects loaded
  // (ordering incomplete); cleared by any manual activation.
  const provisionalSelectionRef = useRef(false);

  // A just-started session's JSONL is not flushed until its first turn makes
  // progress, so a URL reopened in that window has no list entry yet. Retry
  // the list a few times before declaring the restore failed.
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (restoreRetryTimerRef.current) {
      clearTimeout(restoreRetryTimerRef.current);
      restoreRetryTimerRef.current = null;
    }
  }, []);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (skipInitialProjectSelection) return;

    // If restoring a session, set cwd to match that session
    if (initialSessionId && !restoredRef.current) {
      // An empty list only blocks while the first load is still in flight —
      // a settled-but-empty or failed load means the target will never appear
      // (shared ?session= link, deleted session), so fall through to the
      // retry/exhaustion path below instead of returning forever.
      if (allSessions.length === 0 && !initialLoadedRef.current) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        const targetHost = sessionHostId(target, fallbackHostId);
        adoptHost(targetHost);
        setSelectedCwd(target.cwd);
        expandProject(sessionProjectPath(target), targetHost);
        onSelectSession(target, true);
        return;
      }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) {
          clearTimeout(restoreRetryTimerRef.current);
          restoreRetryTimerRef.current = null;
        }
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void loadSessions(false);
        }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoreRetryRef.current = 0;
      restoredRef.current = true;
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    // No restore target: activate the top project (most recently added) so New
    // Session and Explorer have a context. When projects have not loaded yet
    // the ordering is provisional — re-pick once they arrive, unless the user
    // already activated a project by hand.
    if (selectedCwd !== null && !provisionalSelectionRef.current) return;
    const top = sortedProjects[0];
    if (!top) return;
    setSelectedCwd(top.path);
    expandProject(top.path);
    provisionalSelectionRef.current = allSessions.length === 0;
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, sortedProjects, expandProject, loadSessions, adoptHost, fallbackHostId]);

  // Default expansion: when the user has never stored an expansion choice,
  // expand only the active project.
  const defaultExpandedRef = useRef(false);
  useEffect(() => {
    if (defaultExpandedRef.current) return;
    const project = selectedProject;
    if (!project) return;
    defaultExpandedRef.current = true;
    if (expandedProjects === null) expandProject(project);
  }, [selectedProject, expandedProjects, expandProject]);

  // A workspace is a machine and a folder, both chosen in the picker, so the
  // machine no longer has to be selected before adding one.
  const commitAddProject = useCallback(async (candidate?: string, candidateHost?: string | null) => {
    const path = (candidate ?? "").trim();
    if (!path || addProjectBusy) return;
    const targetHost = candidateHost ?? hostId;

    setAddProjectBusy(true);
    setAddProjectError(null);
    try {
      const res = await hostFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      }, targetHost);
      const data = await res.json().catch(() => ({})) as { project?: ManagedProject; error?: string; code?: string };
      if (!res.ok || data.error || !data.project) {
        setAddProjectError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      await loadProjects();
      // Activate + expand the newly added project and close the picker. The
      // machine comes with it, so adding a workspace elsewhere moves there.
      adoptHost(targetHost);
      setSelectedCwd(data.project.path);
      expandProject(data.project.path, targetHost);
      setAddProjectOpen(false);
    } catch (e) {
      setAddProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddProjectBusy(false);
    }
  }, [addProjectBusy, loadProjects, expandProject, adoptHost, hostId]);

  const handleUpdateProjectPresentation = useCallback(async (projectPath: string, updates: { alias?: string | null; sortOrder?: number | null }, host: string | null = hostId) => {
    try {
      const response = await hostFetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectPath, ...updates }) }, host);
      if (!response.ok) throw new Error(t("projects.updateFailed"));
      await loadProjects();
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }, [loadProjects, t, hostId]);

  /** Persist one whole-list order as a single atomic batched PATCH. */
  const persistProjectOrder = useCallback(async (next: ManagedProject[], host: string | null) => {
    try {
      // One batched request: the server applies every entry in a single
      // atomic registry save, so per-project writes can't interleave and lose
      // updates. Discovered projects included here are registered server-side.
      const response = await hostFetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: next.map((project, index) => ({ cwd: project.path, sortOrder: index })) }),
      }, host);
      if (!response.ok) throw new Error(t("projects.reorderFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [loadProjects, t]);

  /** Reordering happens within one machine's list. */
  const handleProjectDrop = useCallback(async (targetPath: string, host: string) => {
    const source = draggedProject;
    setDraggedProject(null);
    if (!source || source.host !== host || source.path === targetPath) return;
    const next = [...(sortedProjectsByHost[host] ?? EMPTY_PROJECTS)];
    const from = next.findIndex((project) => project.path === source.path);
    const to = next.findIndex((project) => project.path === targetPath);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    await persistProjectOrder(next, host);
  }, [draggedProject, sortedProjectsByHost, persistProjectOrder]);

  /** Keyboard-accessible reorder: move one project up/down the list. */
  const handleMoveProject = useCallback(async (projectPath: string, delta: -1 | 1, host: string) => {
    const next = [...(sortedProjectsByHost[host] ?? EMPTY_PROJECTS)];
    const index = next.findIndex((project) => project.path === projectPath);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    await persistProjectOrder(next, host);
  }, [sortedProjectsByHost, persistProjectOrder]);

  const handleRemoveProject = useCallback(async (projectPath: string, host: string | null = hostId) => {
    if (removeProjectPath) return;
    setRemoveProjectPath(projectPath);
    try {
      const res = await hostFetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPath }),
      }, host);
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      // Hiding the active project leaves nothing selected; activate the next
      // most-relevant project so New Session and Explorer stay usable.
      // Compare case-folded — the selected cwd can spell the project path
      // with different casing than this row (Windows/NTFS).
      if (host === hostId && selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(projectPath)) {
        const next = sortedProjects.find((p) => p.path !== projectPath);
        setSelectedCwd(next ? next.path : null);
      }
      collapseProject(projectPath, host);
      await loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveProjectPath(null);
    }
  }, [removeProjectPath, selectedProject, sortedProjects, collapseProject, loadProjects, hostId]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    // Operate against the active repo's own cached Git state — never a
    // globally stored path, so the branch is created in the correct repo.
    const activeState = selectedProject ? worktreeStateByProject[worktreeStateKey(hostId, selectedProject)] : undefined;
    if (!branch || wtBusy || !activeState) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await hostFetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      const newWorktreePath: string = data.path;
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree against THIS repo's cached
      // entry so projectRootFor() resolves it to the main repo before the
      // refetch lands (keeps AppShell from treating the new cwd as a different
      // project). Other repos' cached state is untouched.
      setWorktreeStateByProject((prev) => {
        const key = worktreeStateKey(hostId, root);
        const existing = prev[key];
        if (!existing) return prev;
        const newWt: WorktreeEntry = { path: newWorktreePath, branch, isMain: false };
        return { ...prev, [key]: { ...existing, forCwd: newWorktreePath, worktrees: [...existing.worktrees, newWt] } };
      });
      setSelectedCwd(newWorktreePath);
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, selectedProject, worktreeStateByProject, loadProjects, loadSessions, hostId]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    // Remove only from the active repo's own cached Git state.
    const activeState = selectedProject ? worktreeStateByProject[worktreeStateKey(hostId, selectedProject)] : undefined;
    if (!activeState || wtBusy) return;
    const root = activeState.projectRoot;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await hostFetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      setWtConfirmRemove(null);
      // Optimistically remove the deleted worktree from the active project's state
      setWorktreeStateByProject((prev) => {
        const key = worktreeStateKey(hostId, root);
        const existing = prev[key];
        if (!existing) return prev;
        const nextWorktrees = existing.worktrees.filter((w) => comparableProjectPath(w.path) !== comparableProjectPath(path));
        return {
          ...prev,
          [key]: {
            ...existing,
            forCwd: selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path) ? root : existing.forCwd,
            worktrees: nextWorktrees,
          },
        };
      });
      if (selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path)) {
        setSelectedCwd(root);
      }
      setWtRefreshKey((k) => k + 1);
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [selectedProject, worktreeStateByProject, wtBusy, selectedCwd, loadProjects, loadSessions, hostId]);

  // Reset the worktree dropdown's transient state (used by the portaled
  // dropdown's outside-press/Escape close, the branch toggle, and worktree
  // selection).
  const closeWorktreeDropdown = useCallback(() => {
    setWtDropdownOpen(false);
    setWtNewOpen(false);
    setWtNewBranch("");
    setWtError(null);
    setWtConfirmRemove(null);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees. Selecting a session also
  // activates and expands its containing project.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    provisionalSelectionRef.current = false;
    const host = sessionHostId(s, fallbackHostId);
    adoptHost(host);
    if (s.cwd) setSelectedCwd(s.cwd);
    expandProject(sessionProjectPath(s), host);
    onSelectSession(s);
  }, [onSelectSession, expandProject, adoptHost, fallbackHostId]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportSession = useCallback(async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await hostFetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(t("sessionSidebar.imported"));
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [importing, loadSessions, loadProjects, t]);

  // Sessions of every worktree in the selected project are shown together.
  // Keys are comparableProjectPath forms (see expandProject) — comparable to
  // the folded registry paths rows are checked against.
  const expandedProjectKeys = expandedProjects ?? EMPTY_PROJECT_SET;
  const currentHostName = hosts.find((host) => host.id === hostId)?.name ?? null;

  // The active repo's own cached Git state, selected by repository root — never
  // a single sidebar-wide variable, so it is always the state belonging to the
  // repo the user currently has active.
  const activeGitState = selectedProject
    ? worktreeStateByProject[worktreeStateKey(hostId, selectedProject)]
    : undefined;

  /** Inline branch label ("omp-web · main") from a project's OWN cached Git
   *  state. Returns null when the project has no Git state or is not a git
   *  repo, so a non-Git / not-yet-loaded project never shows another repo's
   *  branch. */
  const worktreeBranchForProject = useCallback((projectPath: string): string | null => {
    const state = worktreeStateByProject[worktreeStateKey(hostId, projectPath)];
    if (!state || !state.isGit || !state.isTopLevel) return null;
    const current = state.worktrees.find((w) => normalizeProjectKey(w.path) === normalizeProjectKey(selectedCwd ?? ""))
      ?? state.worktrees.find((w) => w.isMain);
    if (!current) return null;
    return current.branch ?? displayCwd(current.path, homeDir);
  }, [worktreeStateByProject, selectedCwd, homeDir, hostId]);

  const showWorktreeSwitcher = Boolean(
    activeGitState?.isGit
    && activeGitState.isTopLevel
    && selectedCwd
    && selectedProject !== null
    // Case-folded: the active project may be spelled differently than the
    // server-resolved git root (Windows/NTFS), yet still be the same repo.
    && comparableProjectPath(selectedProject) === comparableProjectPath(activeGitState.projectRoot),
  );
  const toggleWorktrees = useCallback(() => {
    // Fold through closeWorktreeDropdown so closing never leaves the previous
    // worktree's confirm/new-branch transient state behind.
    if (wtDropdownOpen) closeWorktreeDropdown();
    else setWtDropdownOpen(true);
  }, [wtDropdownOpen, closeWorktreeDropdown]);

  // Stable callbacks for the session list so memoized children don't re-render
  // on every parent state change.
  const handleSessionDeleted = useCallback((id: string) => {
    const deleted = allSessions.find((session) => session.id === id);
    if (deleted) clearLastOpenSession(workspaceKeyOf(deleted));
    onSessionDeleted?.(id);
    loadSessions();
  }, [allSessions, onSessionDeleted, loadSessions]);

  useEffect(() => {
    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) setLastOpenSession(workspaceKeyOf(selected), selected.id);
  }, [allSessions, selectedSessionId]);

  // row. Non-Git projects intentionally render no Git affordance at all. The
  // switcher shows the ACTIVE repo's own worktrees/branches only.
  const activeProjectSwitcher = showWorktreeSwitcher && activeGitState ? (
    <ProjectWorktreeSwitcher
      worktreeState={activeGitState}
      selectedCwd={selectedCwd}
      homeDir={homeDir}
      wtDropdownOpen={wtDropdownOpen}
      wtNewOpen={wtNewOpen}
      setWtNewOpen={setWtNewOpen}
      wtNewBranch={wtNewBranch}
      setWtNewBranch={setWtNewBranch}
      wtError={wtError}
      setWtError={setWtError}
      wtBusy={wtBusy}
      wtConfirmRemove={wtConfirmRemove}
      setWtConfirmRemove={setWtConfirmRemove}
      onSelectWorktree={(path) => {
        setSelectedCwd(path);
        closeWorktreeDropdown();
      }}
      onCreateWorktree={handleCreateWorktree}
      onRemoveWorktree={(path, force) => void handleRemoveWorktree(path, force)}
      anchorRef={wtToggleRef}
      newInputRef={wtNewInputRef}
      onClose={closeWorktreeDropdown}
    />
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {addProjectOpen && (
        <DirectoryPicker
          busy={addProjectBusy}
          error={addProjectError}
          onCancel={() => {
            setAddProjectOpen(false);
            setAddProjectError(null);
          }}
          allowHostChange
          onSelect={(path, pickedHost) => void commitAddProject(path, pickedHost)}
        />
      )}
      {/* Header: branding + quiet utilities + New Session */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <OmpWebTitle />
          <div style={{ display: "flex", gap: 2 }}>
            {onOpenArchive && (
              <Tooltip content={t("sessionSidebar.archiveBrowserTitle")} side="bottom">
                <SidebarIconButton
                  label={t("sessionSidebar.archiveBrowser")}
                  onClick={onOpenArchive}
                >
                  <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
                </SidebarIconButton>
              </Tooltip>
            )}
            <Tooltip content={t("sessionSidebar.importTitle")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.import")}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
              >
                <FileUp size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            <Tooltip content={t("sessionSidebar.refresh")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.refresh")}
                active={sessionRefreshDone}
                onClick={() => {
                  loadSessions(false);
                  void loadProjects();
                }}
              >
                {sessionRefreshDone ? (
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                )}
              </SidebarIconButton>
            </Tooltip>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".jsonl,.json,application/json,application/jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            void handleImportSession(file);
          }}
        />
        <MachineSwitcher onManageMachines={onManageMachines} />
        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          className="sidebar-new-session"
          title={selectedCwd
            ? (multiHost && currentHostName
              ? t("hosts.sidebar.newSessionOn", { cwd: selectedCwd, machine: currentHostName })
              : t("sessionSidebar.newSessionIn", { cwd: selectedCwd }))
            : t("sessionSidebar.selectProjectFirst")}
          style={{
            width: "100%",
            height: 38,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            color: selectedCwd ? "var(--text)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            opacity: selectedCwd ? 1 : 0.65,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 30%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus size={15} strokeWidth={2.2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
          <span>{t("sessionSidebar.new")}</span>
        </button>
      </div>

      {/* Workspaces section header: label + search / filter / add */}
      <div style={{ flexShrink: 0, padding: "4px 10px 2px", display: "flex", alignItems: "center", gap: 2 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("projects.heading")}
        </span>
        <SidebarIconButton
          label={t("sessionSidebar.search")}
          title={t("sessionSidebar.searchTitle")}
          active={searchOpen}
          onClick={() => {
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
            else setSearchQuery("");
          }}
        >
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("sessionSidebar.filterRunning")}
          title={t("sessionSidebar.filterRunningTitle")}
          active={runningOnly}
          onClick={() => setRunningOnly((v) => !v)}
        >
          <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("projects.add")}
          title={t("projects.addTitle")}
          onClick={() => {
            setAddProjectOpen(true);
            setAddProjectError(null);
          }}
        >
          <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
      </div>
      {searchOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder={t("sessionSidebar.searchPlaceholder")}
            aria-label={t("sessionSidebar.search")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: "0 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        </div>
      )}

      {/* Workspaces */}
        <div
          style={{
            flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto",
            transition: "flex var(--dur-med) var(--ease-out-warm)",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: 80,
          }}
        >
          {loading && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12 }}>
              {t("sessionSidebar.loading")}
            </div>
          )}
          {projectsError && (
            <div style={{ padding: "10px 4px", color: "var(--accent)", fontSize: 12 }}>{projectsError}</div>
          )}
          {error && (
            <div style={{ padding: "10px 4px", color: "var(--accent)", fontSize: 12 }}>{error}</div>
          )}
          {!loading && !projectsError && !error && hostsLoaded && !hasAnyProject && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              {t("projects.noProjects")}
            </div>
          )}
          {!loading && !projectsError && !error && hasAnyProject && !hasVisibleProject && (
            <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>
              {t("sessionSidebar.noMatches")}
            </div>
          )}

          {visibleMachineEntries.map((group) => {
            // Workspaces are one flat list across machines. Each row carries a
            // machine label instead of sitting under a machine heading: the
            // heading repeated itself on every row below it, and the machine
            // switcher above already says which machine is active.
            const isCurrentMachine = group.hostId === hostId;
            const machineName = group.host?.name ?? group.hostId;
            const groupHome = homeByHost[group.hostId] ?? "";
            return (
              <div key={group.hostId} className="sidebar-machine" data-current={isCurrentMachine ? "true" : "false"}>
                {group.entries.map(({ project, sessions, key }) => {
                  const tree = treesByProject.get(key) ?? buildSessionTree(sessions);
                  // Sessions group under a project through the case-folded
                  // comparable form (see groupSessionsByMachine), so the active
                  // highlight must use the same comparison: a session whose
                  // cwd/projectRoot spells the project folder with different
                  // casing (Windows/NTFS) lands in this row — the row must
                  // light up for it too. Only the selected machine has an
                  // active project.
                  const isActive = isCurrentMachine && selectedProject !== null && comparableProjectPath(selectedProject) === comparableProjectPath(project.path);
                  // Each project's own branch comes from its own cached Git
                  // state — a project never inherits another repo's branch.
                  // Only the active repo's row owns the single switcher anchor
                  // so the dropdown opens against the correct row.
                  const projectBranch = isCurrentMachine ? worktreeBranchForProject(project.path) : null;
                  return (
                    <ProjectRow
                      key={key}
                      project={project}
                      isActive={isActive}
                      activity={projectActivity.get(key)}
                      tree={tree}
                      isExpanded={expandedProjectKeys.has(key)}
                      hiddenCount={filtersActive ? 0 : Math.max(0, tree.length - MAX_PROJECT_SESSIONS)}
                      selectedSessionId={selectedSessionId}
                      runningSessionIds={runningSessionIds}
                      unreadSessionIds={unreadSessionIds}
                      relativeTimeNow={relativeTimeNow}
                      onActivate={(path) => activateProject(path, group.hostId)}
                      onToggleExpand={(path) => toggleProjectExpanded(path, group.hostId)}
                      onRemoveProject={(path) => void handleRemoveProject(path, group.hostId)}
                      onUpdatePresentation={(path, updates) => void handleUpdateProjectPresentation(path, updates, group.hostId)}
                      onDragPathChange={(path) => setDraggedProject(path ? { host: group.hostId, path } : null)}
                      onDropProject={(path) => void handleProjectDrop(path, group.hostId)}
                      onMoveProject={(path, delta) => void handleMoveProject(path, delta, group.hostId)}
                      isDragTarget={draggedProject !== null && draggedProject.host === group.hostId && draggedProject.path !== project.path}
                      removeBusy={removeProjectPath === project.path}
                      onSelectSession={handleSelectSessionFromList}
                      onRenamed={loadSessions}
                      onSessionDeleted={handleSessionDeleted}
                      activeWorktreeSwitcher={isActive ? activeProjectSwitcher : null}
                      worktreeBranch={projectBranch}
                      worktreeToggleRef={isActive && projectBranch ? wtToggleRef : undefined}
                      worktreeOpen={isActive ? wtDropdownOpen : false}
                      onToggleWorktrees={isActive ? toggleWorktrees : undefined}
                      homeDir={groupHome}
                      machineLabel={multiHost ? machineName : null}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
            transition: "flex var(--dur-med) var(--ease-out-warm)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <ChevronRight
                size={12}
                strokeWidth={1.8}
                style={{
                  transform: explorerOpen ? "rotate(90deg)" : "none",
                  transition: "transform var(--dur-med) var(--ease-out-warm)",
                  flexShrink: 0,
                }}
                aria-hidden="true"
              />
              {t("sessionSidebar.explorer")}
            </button>
            <div
              inert={!explorerOpen ? true : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                opacity: explorerOpen ? 1 : 0,
                pointerEvents: explorerOpen ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm)",
              }}
            >
              <Tooltip content={t("fileExplorer.searchFiles")} side="top">
                <button
                  onClick={() => setFileSearchOpen((open) => !open)}
                  title={t("fileExplorer.searchFiles")}
                  aria-label={t("fileExplorer.searchFiles")}
                  aria-pressed={fileSearchOpen}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    background: fileSearchOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    color: fileSearchOpen ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    borderRadius: "var(--radius-control)",
                    flexShrink: 0,
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (fileSearchOpen) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <Search size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip content={t("sessionSidebar.uploadFilesTitle")} side="top">
                <button
                  onClick={() => fileExplorerRef.current?.openUploadPicker()}
                  disabled={explorerUploadBusy}
                  title={t("sessionSidebar.uploadFilesTitle")}
                  aria-label={t("sessionSidebar.uploadFiles")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, padding: 0,
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    cursor: explorerUploadBusy ? "default" : "pointer",
                    borderRadius: "var(--radius-control)",
                    flexShrink: 0,
                    opacity: explorerUploadBusy ? 0.6 : 1,
                    transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (explorerUploadBusy) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <Upload size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
            <Tooltip content={t("sessionSidebar.refreshExplorer")} side="top">
              <button
                aria-label={t("sessionSidebar.refreshExplorer")}
                onClick={() => {
                  if (onExplorerRefresh) onExplorerRefresh();
                  else setExplorerKey((k) => k + 1);
                }}
                title={t("sessionSidebar.refreshExplorer")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, padding: 0, marginRight: 6,
                  background: "none",
                  border: "none",
                  color: explorerRefreshing ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  borderRadius: "var(--radius-control)",
                  flexShrink: 0,
                  transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (explorerRefreshing) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
              >
                {explorerRefreshing ? (
                  <RefreshCw size={13} strokeWidth={2} aria-hidden="true" className="icon-spin" />
                ) : (
                  <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </div>
          <div
            className={"accordion-flow " + (explorerOpen ? "is-open" : "")}
            inert={!explorerOpen ? true : undefined}
            style={{
              flex: explorerOpen ? "1 1 auto" : "0 0 0px",
              minHeight: 0,
            }}
          >
            <div className="accordion-flow-inner" style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                onRefreshDone={onExplorerRefreshDone}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          </div>
        </div>
      )}

      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          onClick={onOpenSettings}
          title={t("chatInput.settings")}
          aria-label={t("chatInput.settings")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            {updateAvailable && (
              <span
                aria-label={t("skillsConfig.updateAvailable")}
                role="status"
                style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", border: "1px solid var(--bg-panel)" }}
              />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500 }}>
            {t("chatInput.settings")}
          </span>
          <ChevronRight size={13} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});

const MAX_PROJECT_SESSIONS = 5;


interface ProjectRowProps {
  project: ManagedProject;
  isActive: boolean;
  isExpanded: boolean;
  activity: { running: number; unread: number } | undefined;
  tree: SessionTreeNode[];
  /** Sessions beyond the cap (0 when a filter is active — show all matches). */
  hiddenCount: number;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  relativeTimeNow: number;
  onActivate: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onUpdatePresentation: (path: string, updates: { alias?: string | null; sortOrder?: number | null }) => void;
  onDragPathChange: (path: string | null) => void;
  onDropProject: (path: string) => void;
  onMoveProject: (path: string, delta: -1 | 1) => void;
  isDragTarget: boolean;
  removeBusy: boolean;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  activeWorktreeSwitcher?: ReactNode;
  /** Active worktree/branch label shown inline beside the workspace name. */
  worktreeBranch?: string | null;
  worktreeToggleRef?: RefObject<HTMLButtonElement | null>;
  worktreeOpen?: boolean;
  onToggleWorktrees?: () => void;
  homeDir: string;
  /** Machine name badge, shown only when more than one machine is enabled. */
  machineLabel?: string | null;
}

/** One project in the sidebar: a card row matching the session items' visual
 *  language, with the active project's worktree selector directly below and
 *  the project's session tree (capped at MAX_PROJECT_SESSIONS roots, with a
 *  show-more toggle) nested under it when expanded. */
function ProjectRow({
  project,
  isActive,
  isExpanded,
  activity,
  tree,
  hiddenCount,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  relativeTimeNow,
  onActivate,
  onToggleExpand,
  onRemoveProject,
  onUpdatePresentation,
  onDragPathChange,
  onDropProject,
  onMoveProject,
  isDragTarget,
  removeBusy,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  activeWorktreeSwitcher,
  worktreeBranch,
  worktreeToggleRef,
  worktreeOpen,
  onToggleWorktrees,
  machineLabel,
}: ProjectRowProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasValue, setAliasValue] = useState("");
  const aliasInputRef = useRef<HTMLInputElement>(null);
  const aliasCancelRef = useRef(false);

  const startAliasEdit = useCallback(() => {
    setAliasValue(project.alias ?? "");
    setAliasEditing(true);
    setTimeout(() => aliasInputRef.current?.select(), 0);
  }, [project.alias]);

  const commitAliasEdit = useCallback(() => {
    if (aliasCancelRef.current) {
      aliasCancelRef.current = false;
      setAliasEditing(false);
      return;
    }
    const alias = aliasValue.trim();
    setAliasEditing(false);
    if (alias === (project.alias ?? "")) return;
    void onUpdatePresentation(project.path, { alias });
  }, [aliasValue, project.alias, project.path, onUpdatePresentation]);
  const label = project.alias ?? projectLabel(project.path);
  const hasActivity = Boolean(activity && (activity.running > 0 || activity.unread > 0));
  const visibleRoots = hiddenCount > 0 && !showAllSessions
    ? tree.slice(0, MAX_PROJECT_SESSIONS)
    : tree;
  const showActions = hovered || focusWithin || actionMenuOpen;

  return (
    <section className="sidebar-project" data-active={isActive ? "true" : "false"} style={{ marginBottom: 12 }}>
      <div
        className="sidebar-project-header"
        draggable={!aliasEditing}
        onDragStart={(event) => { event.dataTransfer.setData("text/plain", project.path); event.dataTransfer.effectAllowed = "move"; onDragPathChange(project.path); }}
        onDragOver={(event) => { if (isDragTarget) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { event.preventDefault(); onDropProject(project.path); }}
        onDragEnd={() => onDragPathChange(null)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && actionMenuOpen) {
            event.stopPropagation();
            setActionMenuOpen(false);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 30,
          margin: 0,
          padding: "0 6px 0 0",
          borderRadius: "var(--radius-control)",
          background: hovered ? "var(--bg-hover)" : "transparent",
          transition: SIDEBAR_BUTTON_TRANSITION,
          ...(isDragTarget ? { outline: "1px solid var(--accent)", outlineOffset: -1 } : {}),
        }}
      >
        {aliasEditing ? (
          <div
            className="sidebar-project-identity"
            onClick={(event) => event.stopPropagation()}
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 4px 0 10px",
            }}
          >
            <Folder
              size={15}
              strokeWidth={1.8}
              style={{ flexShrink: 0, color: "var(--text-muted)" }}
              aria-hidden="true"
            />
            <input
              ref={aliasInputRef}
              autoFocus
              aria-label={t("projects.aliasPrompt")}
              value={aliasValue}
              onChange={(event) => setAliasValue(event.target.value)}
              onBlur={commitAliasEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitAliasEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  aliasCancelRef.current = true;
                  setAliasEditing(false);
                }
              }}
              style={{ flex: 1, minWidth: 0, height: 22, padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600 }}
            />
          </div>
        ) : (
          <button
            className="sidebar-project-identity"
            onClick={() => onActivate(project.path)}
            aria-current={isActive ? "true" : undefined}
            title={project.path}
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 4px 0 10px",
              background: "none", border: "none",
              color: hovered ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <Folder
              size={15}
              strokeWidth={1.8}
              style={{ flexShrink: 0, color: isActive ? "var(--accent)" : hovered ? "var(--text-muted)" : "var(--text-dim)", transition: "color var(--dur-fast) var(--ease-out-warm)" }}
              aria-hidden="true"
            />
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                lineHeight: 1.25,
              }}
            >
              {label}
            </span>
          </button>
        )}
        {machineLabel && (
          <span
            className="sidebar-project-machine"
            title={t("hosts.sidebar.badge", { name: machineLabel })}
            aria-label={t("hosts.sidebar.badge", { name: machineLabel })}
            style={{ flexShrink: 1, minWidth: 0, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 5px", height: 16, lineHeight: "16px", borderRadius: 8, background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 9.5, fontWeight: 600 }}
          >
            {machineLabel}
          </span>
        )}
        {worktreeBranch && worktreeToggleRef && (
          <button
            type="button"
            ref={worktreeToggleRef}
            onClick={onToggleWorktrees}
            aria-expanded={worktreeOpen}
            aria-haspopup="menu"
            title={t("sessionSidebar.switchWorktreeTo", { path: worktreeBranch })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
              minWidth: 0,
              maxWidth: 104,
              height: 24,
              padding: "0 6px",
              border: "none",
              borderRadius: "var(--radius-control)",
              background: worktreeOpen ? "var(--bg-selected)" : "none",
              color: worktreeOpen ? "var(--accent)" : hovered ? "var(--text-muted)" : "var(--text-dim)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              lineHeight: 1,
              transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
            }}
          >
            <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>·</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worktreeBranch}</span>
          </button>
        )}
        <div style={{ flex: 1 }} />
        {hasActivity && (
          <span
            aria-label={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0 })}
            title={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0 })}
            className="sidebar-project-activity"
            data-running={(activity?.running ?? 0) > 0 ? "true" : "false"}
            role="status"
            aria-live="polite"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 11, height: 11, margin: "0 2px 0 0", flexShrink: 0, lineHeight: 0 }}
          >
            <span
              aria-hidden="true"
              className="sidebar-project-activity-dot"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent)",
              }}
            />
          </span>
        )}
        <div
          style={{
            flexShrink: 0,
            visibility: showActions ? "visible" : "hidden",
          }}
        >
          <button
            type="button"
            ref={actionButtonRef}
            className="sidebar-project-action"
            onClick={() => setActionMenuOpen((open) => !open)}
            disabled={removeBusy}
            aria-label={t("commandPalette.actions")}
            title={t("commandPalette.actions")}
            aria-expanded={actionMenuOpen}
            aria-haspopup="menu"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: "var(--text-dim)", cursor: removeBusy ? "default" : "pointer", opacity: removeBusy ? 0.5 : 1, lineHeight: 0, transition: SIDEBAR_BUTTON_TRANSITION }}
          >
            <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <SidebarPortalMenu
            anchor={actionButtonRef}
            open={actionMenuOpen}
            onClose={() => setActionMenuOpen(false)}
            placement="below"
            minWidth={136}
          >
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { startAliasEdit(); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {project.alias ? t("projects.editAlias") : t("projects.nameAlias")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, -1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveUp")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, 1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveDown")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" disabled={removeBusy} onClick={() => { setActionMenuOpen(false); void onRemoveProject(project.path); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: removeBusy ? "default" : "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.remove", { name: label })}
            </button>
          </SidebarPortalMenu>
        </div>
        <button
          className="sidebar-project-toggle"
          onClick={() => onToggleExpand(project.path)}
          aria-label={isExpanded ? t("projects.collapseProject", { name: label }) : t("projects.expandProject", { name: label })}
          aria-expanded={isExpanded}
          title={isExpanded ? t("projects.collapseProjectTitle", { path: project.path }) : t("projects.expandProjectTitle", { path: project.path })}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 26, padding: 0, flexShrink: 0,
            background: "none", border: "none",
            color: "var(--text-dim)", cursor: "pointer", lineHeight: 0,
            borderRadius: "var(--radius-control)",
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <ChevronRight
            size={13}
            strokeWidth={1.8}
            style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
            aria-hidden="true"
          />
        </button>
      </div>

      {isActive && activeWorktreeSwitcher}

      {isExpanded && (
        <div className="sidebar-project-sessions" style={{ margin: "2px 0 0" }}>
          {visibleRoots.length === 0 ? (
            <div style={{ padding: "6px 12px 8px 34px", color: "var(--text-dim)", fontSize: 11 }}>
              {t("projects.emptyProject")}
            </div>
          ) : (
            <>
              {visibleRoots.map((node) => (
                <SessionTreeItem
                  key={node.session.id}
                  node={node}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  relativeTimeNow={relativeTimeNow}
                  onSelectSession={onSelectSession}
                  onRenamed={onRenamed}
                  onSessionDeleted={onSessionDeleted}
                  depth={0}
                  machineLabel={machineLabel}
                />
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllSessions((v) => !v)}
                  aria-expanded={showAllSessions}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    width: "100%",
                    margin: "2px 0 0",
                    padding: "5px 8px 5px 34px",
                    background: "none",
                    border: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: "var(--radius-control)",
                    transition: SIDEBAR_BUTTON_TRANSITION,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <ChevronDown size={11} strokeWidth={1.8} style={{ flexShrink: 0, transform: showAllSessions ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} aria-hidden="true" />
                  {showAllSessions
                    ? t("projects.showLess")
                    : t("projects.showMoreSessions", { count: hiddenCount })}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface ProjectWorktreeSwitcherProps {
  worktreeState: WorktreeState;
  selectedCwd: string | null;
  homeDir: string;
  wtDropdownOpen: boolean;
  wtNewOpen: boolean;
  setWtNewOpen: Dispatch<SetStateAction<boolean>>;
  wtNewBranch: string;
  setWtNewBranch: Dispatch<SetStateAction<string>>;
  wtError: string | null;
  setWtError: Dispatch<SetStateAction<string | null>>;
  wtBusy: boolean;
  wtConfirmRemove: string | null;
  setWtConfirmRemove: Dispatch<SetStateAction<string | null>>;
  onSelectWorktree: (path: string) => void;
  onCreateWorktree: () => void;
  onRemoveWorktree: (path: string, force: boolean) => void;
  /** Anchor button — the inline branch label in the workspace row. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  newInputRef: RefObject<HTMLInputElement | null>;
  /** Closes the dropdown and resets its transient state. */
  onClose: () => void;
}

/** Worktree dropdown for the active project; opening it exposes all checkouts.
 *  Rendered through the portal menu so it floats above every sidebar row. */
function ProjectWorktreeSwitcher({
  worktreeState,
  selectedCwd,
  homeDir,
  wtDropdownOpen,
  wtNewOpen,
  setWtNewOpen,
  wtNewBranch,
  setWtNewBranch,
  wtError,
  setWtError,
  wtBusy,
  wtConfirmRemove,
  setWtConfirmRemove,
  onSelectWorktree,
  onCreateWorktree,
  onRemoveWorktree,
  anchorRef,
  newInputRef,
  onClose,
}: ProjectWorktreeSwitcherProps) {
  const { t } = useI18n();

  return (
    <SidebarPortalMenu
      anchor={anchorRef}
      open={wtDropdownOpen}
      onClose={onClose}
      placement="below"
      align="start"
      minWidth={240}
      style={{ overflow: "hidden" }}
    >
          <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
            {worktreeState.worktrees.map((wt) => {
              const foldedCwd = selectedCwd === null ? null : comparableProjectPath(selectedCwd);
              const isCurrent = (foldedCwd !== null && comparableProjectPath(wt.path) === foldedCwd)
                || (wt.isMain && !worktreeState.worktrees.some((w) => comparableProjectPath(w.path) === foldedCwd));
              if (wtConfirmRemove === wt.path) {
                return (
                  <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t("sessionSidebar.uncommittedForceRemove")}
                    </span>
                    <button
                      onClick={() => onRemoveWorktree(wt.path, true)}
                      disabled={wtBusy}
                      style={{ padding: "3px 9px", background: "var(--accent-strong)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                    >
                      {t("sessionSidebar.force")}
                    </button>
                    <button
                      onClick={() => setWtConfirmRemove(null)}
                      style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                    >
                      {t("sessionSidebar.cancel")}
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={wt.path}
                  className="wt-row"
                  style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                >
                  <button
                    onClick={() => onSelectWorktree(wt.path)}
                    aria-pressed={isCurrent}
                    title={wt.path}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      color: isCurrent ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {isCurrent ? (
                      <Check size={10} strokeWidth={2} style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
                    ) : (
                      <span style={{ width: 10, flexShrink: 0 }} />
                    )}
                    <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                    {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionSidebar.mainBadge")}</span>}
                  </button>
                  {!wt.isMain && (
                    <button
                      onClick={() => onRemoveWorktree(wt.path, false)}
                      disabled={wtBusy}
                      title={t("sessionSidebar.removeWorktreeTitle", { path: wt.path })}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 34, height: 28, padding: 0, marginRight: 4,
                        background: "none", border: "none",
                        color: "var(--text-dim)", cursor: "pointer",
                        borderRadius: "var(--radius-control)", flexShrink: 0,
                        transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                    >
                      <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!wtNewOpen ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setWtNewOpen(true);
                setWtError(null);
                setTimeout(() => newInputRef.current?.focus(), 0);
              }}
              title={t("sessionSidebar.newWorktreeTitle")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "8px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
              }}
            >
              <Plus size={12} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden="true" />
              <span>{t("sessionSidebar.newWorktree")}</span>
            </button>
          ) : (
            <div style={{ padding: "6px 8px" }}>
              <input
                ref={newInputRef}
                value={wtNewBranch}
                onChange={(e) => {
                  setWtNewBranch(e.target.value);
                  setWtError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCreateWorktree();
                  }
                  if (e.key === "Escape") {
                    setWtNewOpen(false);
                    setWtNewBranch("");
                    setWtError(null);
                  }
                }}
                placeholder={t("sessionSidebar.branchNamePlaceholder")}
                style={{
                  width: "100%",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "5px 8px",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-control)",
                  outline: "none",
                  background: "var(--bg)",
                  color: "var(--text)",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                <button
                  onClick={onCreateWorktree}
                  disabled={wtBusy || !wtNewBranch.trim()}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    background: "var(--accent-strong)",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--on-accent)",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                    opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                  }}
                >
                  {wtBusy ? t("sessionSidebar.creating") : t("sessionSidebar.create")}
                </button>
                <button
                  onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {t("sessionSidebar.cancel")}
                </button>
              </div>
            </div>
          )}
          {wtError && (
            <div style={{
              padding: "5px 10px 8px",
              color: "var(--accent)",
              fontSize: 11,
              lineHeight: 1.35,
              overflowWrap: "anywhere",
            }}>
              {wtError}
            </div>
          )}
    </SidebarPortalMenu>
  );
}

const SessionTreeItem = memo(function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  relativeTimeNow,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  machineLabel,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  relativeTimeNow: number;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  machineLabel?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  const sessionId = node.session.id;

  // Pre-compute the booleans so SessionItem only sees primitives — its memo
  // check then never re-renders unless this row's flags actually changed.
  const isSelected = sessionId === selectedSessionId;
  const isRunning = runningSessionIds.has(sessionId);
  const isUnread = unreadSessionIds.has(sessionId);

  // Stable callbacks: depend only on primitives / stable parent callbacks so
  // SessionItem's React.memo stays effective across re-renders.
  const handleClick = useCallback(() => {
    onSelectSession(node.session);
  }, [onSelectSession, node.session]);
  const handleDeleted = useCallback((id: string) => {
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);
  const handleToggleCollapse = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 14 + 22,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={isSelected}
          isRunning={isRunning}
          isUnread={isUnread}
          relativeTimeNow={relativeTimeNow}
          onClick={handleClick}
          onRenamed={onRenamed}
          onDeleted={handleDeleted}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          machineLabel={machineLabel}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              relativeTimeNow={relativeTimeNow}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              machineLabel={machineLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Deep-changed inputs warrant a re-render; otherwise skip.
  if (prev.node !== next.node) return false;
  if (prev.selectedSessionId !== next.selectedSessionId) {
    // Only re-render if THIS node's selection state flipped.
    const id = prev.node.session.id;
    if ((id === prev.selectedSessionId) !== (id === next.selectedSessionId)) return false;
  }
  if (prev.runningSessionIds !== next.runningSessionIds) {
    const id = prev.node.session.id;
    if (prev.runningSessionIds.has(id) !== next.runningSessionIds.has(id)) return false;
  }
  if (prev.unreadSessionIds !== next.unreadSessionIds) {
    const id = prev.node.session.id;
    if (prev.unreadSessionIds.has(id) !== next.unreadSessionIds.has(id)) return false;
  }
  if (prev.relativeTimeNow !== next.relativeTimeNow) return false;
  if (prev.machineLabel !== next.machineLabel) return false;
  if (prev.onSelectSession !== next.onSelectSession
    || prev.onRenamed !== next.onRenamed
    || prev.onSessionDeleted !== next.onSessionDeleted) return false;
  return true;
});
function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.agentRunning")}
      aria-label={t("sessionSidebar.agentRunningAria")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <span
        aria-hidden="true"
        className="sidebar-running-spinner"
        data-reduced-motion={reducedMotion ? "true" : "false"}
        style={{ width: size - 2, height: size - 2 }}
      />
    </span>
  );
}

function UnreadSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.newActivity")}
      aria-label={t("sessionSidebar.newSessionActivity")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        {!reducedMotion && (
          <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
            <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </span>
  );
}

const SessionItem = memo(function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  relativeTimeNow,
  onToggleCollapse,
  machineLabel,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  relativeTimeNow: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Machine name for the tiny badge (multi-machine setups only). */
  machineLabel?: string | null;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameCancelRef = useRef(false);
 const [confirmArchive, setConfirmArchive] = useState(false);
 const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const relativeTime = formatRelativeTime(session.modified, locale, relativeTimeNow);
 const confirming = confirmArchive || confirmDelete;
 const showActions = hovered || focusWithin || actionMenuOpen;
  const rowBackground = confirming
    ? "color-mix(in srgb, var(--accent) 6%, transparent)"
    : isSelected
      ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)"
      : hovered ? "var(--bg-hover)" : "transparent";

  const startRename = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("Session rename failed");
      onRenamed?.();
    } catch {
      // The next refresh remains authoritative if the rename fails.
    }
  }, [renameValue, session.id, session.name, onRenamed]);

 const handleArchive = useCallback(async () => {
 setConfirmArchive(false);
 setDeleting(true);
 try {
 const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
 if (!response.ok) throw new Error("Session archive failed");
 onDeleted?.(session.id);
 } catch {
 setDeleting(false);
 toast.error(t("sessionSidebar.archiveFailed"));
 }
 }, [session.id, onDeleted, t]);

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Session deletion failed");
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
      toast.error(t("sessionSidebar.deleteFailed"));
    }
  }, [session.id, onDeleted, t]);

 const closeConfirmation = useCallback(() => {
 setConfirmArchive(false);
 setConfirmDelete(false);
 setActionMenuOpen(false);
 requestAnimationFrame(() => contentButtonRef.current?.focus());
 }, []);

  return (
    <div
 onClick={confirmArchive || confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      onKeyDown={(event) => {
        if ((confirmArchive || confirmDelete || actionMenuOpen) && event.key === "Escape") {
          event.stopPropagation();
          closeConfirmation();
        }
      }}
      style={{
        height: confirming ? 34 : 30,
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        margin: "1px 0",
        padding: `0 8px 0 ${30 + depth * 14}px`,
        position: "relative",
        overflow: "hidden",
        background: rowBackground,
        opacity: deleting ? 0.5 : 1,
        cursor: confirming || renaming ? "default" : "pointer",
        transition: "background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {(isSelected || confirming) && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 20 + depth * 14,
            top: 0,
            bottom: 0,
            width: 2,
            borderRadius: 1,
            background: "var(--accent)",
            pointerEvents: "none",
          }}
        />
      )}
      {confirming ? (
        <>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
            {confirmArchive
              ? t("sessionSidebar.archiveConfirm", { title: title.length > 22 ? `${title.slice(0, 22)}…` : title })
              : t("sessionSidebar.deleteConfirm", { title: title.length > 22 ? `${title.slice(0, 22)}…` : title })}
          </span>
          <button onClick={(event) => { event.stopPropagation(); if (confirmArchive) void handleArchive(); else void handleDelete(); }} style={{ height: 28, padding: "0 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            {confirmArchive ? t("sessionSidebar.archive") : t("sessionSidebar.delete")}
          </button>
          <button onClick={(event) => { event.stopPropagation(); closeConfirmation(); }} autoFocus style={{ height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
            {t("sessionSidebar.cancel")}
          </button>
        </>
      ) : renaming ? (
        <input ref={inputRef} autoFocus aria-label={t("sessionSidebar.rename")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") { event.preventDefault(); renameCancelRef.current = true; setRenaming(false); } }} style={{ flex: 1, height: 25, padding: "3px 7px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }} />
      ) : (
        <>
          {depth > 0 && <GitBranch size={11} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />}
          <button ref={contentButtonRef} type="button" className="session-item-button" aria-current={isSelected ? "true" : undefined} onKeyDown={(event) => { if (event.key === "Delete") { event.preventDefault(); setConfirmDelete(true); } }} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            <span title={title} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12.5, fontWeight: isSelected ? 600 : 500, lineHeight: 1.35, letterSpacing: "-0.005em" }}>
              {title}
            </span>
          </button>
          {session.worktreeBranch && <span title={t("sessionSidebar.worktreeTitle", { path: session.cwd })} style={{ display: "flex", alignItems: "center", gap: 3, maxWidth: 56, minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 10, flexShrink: 1 }}><GitBranch size={10} strokeWidth={2.4} aria-hidden="true" /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span></span>}
          {hasChildren && <button className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); onToggleCollapse?.(); }} title={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-label={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-expanded={!collapsed} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, flexShrink: 0, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}><ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "flex-end", width: 64, height: 24, flexShrink: 0 }}>
              <div aria-hidden={showActions && !isRunning} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, width: "100%", whiteSpace: "nowrap", opacity: showActions && !isRunning ? 0 : 1, pointerEvents: showActions && !isRunning ? "none" : "auto", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                {machineLabel && (
                  <span role="img" aria-label={t("hosts.sidebar.badge", { name: machineLabel })} title={t("hosts.sidebar.badge", { name: machineLabel })} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, color: "var(--text-dim)", opacity: 0.8 }}>
                    <Server size={10} strokeWidth={2} aria-hidden="true" />
                  </span>
                )}
                {isRunning && <RunningSessionIndicator size={12} />}
                {!isRunning && isUnread && <UnreadSessionIndicator size={11} />}
                {relativeTime && <span title={new Date(session.modified).toLocaleString(locale)} style={{ minWidth: 42, whiteSpace: "nowrap", textAlign: "right", color: isSelected ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{relativeTime}</span>}
              </div>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, opacity: showActions ? 1 : 0, pointerEvents: showActions ? "auto" : "none", transition: "opacity var(--dur-fast) var(--ease-out-warm)" }}>
                {isRunning && <span style={{ display: "flex", alignItems: "center", marginRight: 2 }}><RunningSessionIndicator size={12} /></span>}
                <button type="button" ref={menuButtonRef} className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); setActionMenuOpen((open) => !open); }} title={t("projects.actions")} aria-label={t("projects.actions")} aria-expanded={actionMenuOpen} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, lineHeight: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: actionMenuOpen ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
                  <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <SidebarPortalMenu anchor={menuButtonRef} open={actionMenuOpen} onClose={() => setActionMenuOpen(false)} placement="below" minWidth={128}>
 <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleArchive(); }} disabled={hasChildren} title={hasChildren ? t("sessionSidebar.archiveLeafOnly") : t("sessionSidebar.archive")} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: hasChildren ? "var(--text-dim)" : "var(--text-muted)", cursor: hasChildren ? "not-allowed" : "pointer", textAlign: "left", fontSize: 11, opacity: hasChildren ? 0.55 : 1 }}>{t("sessionSidebar.archive")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { startRename(event); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.rename")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleDelete(); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.delete")}</button>
                </SidebarPortalMenu>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
