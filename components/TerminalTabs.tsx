"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { useHosts } from "@/lib/hosts/client";
import { useI18n } from "@/lib/i18n";
import { HostKindIcon, HostStatusDot } from "./MachineSwitcher";
import { TerminalPane } from "./TerminalPane";

/**
 * Several shells at once, each on whatever machine it was opened against.
 *
 * A tab owns its session id rather than letting the pane pick one, because two
 * tabs on the same machine have to be two different shells — something the pane
 * cannot work out from the machine alone.
 *
 * Only the active tab is mounted. The server keeps every PTY and its
 * scrollback, so switching back reattaches to the same shell with its screen
 * intact; keeping hidden panes mounted would mean measuring xterm in a
 * zero-sized box and sending nonsense dimensions to the PTY.
 */

const TABS_STORAGE_KEY = "omp-web.terminal.tabs";

export interface TerminalTab {
  /** Stable across reloads, so a persisted tab keeps its identity. */
  key: string;
  hostId: string;
  /** Directory the shell was opened in; the machine's home when null. */
  cwd: string | null;
  /** The shell this tab is attached to, once it has one. */
  sessionId: string | null;
}

interface PersistedState {
  tabs: TerminalTab[];
  activeKey: string | null;
}

function newTabKey(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Persisted tabs, ignoring anything that is not shaped like a tab. */
function readPersisted(): PersistedState {
  if (typeof window === "undefined") return { tabs: [], activeKey: null };
  try {
    const raw = window.localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return { tabs: [], activeKey: null };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { tabs: [], activeKey: null };
    const list = (parsed as { tabs?: unknown }).tabs;
    if (!Array.isArray(list)) return { tabs: [], activeKey: null };
    const tabs: TerminalTab[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.key !== "string" || typeof record.hostId !== "string") continue;
      tabs.push({
        key: record.key,
        hostId: record.hostId,
        cwd: typeof record.cwd === "string" ? record.cwd : null,
        sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      });
    }
    const activeKey = (parsed as { activeKey?: unknown }).activeKey;
    return { tabs, activeKey: typeof activeKey === "string" ? activeKey : null };
  } catch {
    return { tabs: [], activeKey: null };
  }
}

export function TerminalTabs({
  hostId,
  cwd,
  onClose,
}: {
  /** The workspace's machine, used for the first tab and for new tabs by default. */
  hostId: string | null;
  /** The workspace's directory. Only applied to tabs on the workspace's machine. */
  cwd?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { hosts } = useHosts();
  // Persisted tabs are shown at once rather than after the listing below. That
  // listing queues behind the page's other requests — including machines that
  // take their full timeout to fail — and waiting on it left the pane reading
  // "no terminals open" for several seconds every time the page loaded.
  const [initial] = useState(readPersisted);
  const [tabs, setTabs] = useState<TerminalTab[]>(initial.tabs);
  const [activeKey, setActiveKey] = useState<string | null>(initial.activeKey);
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  // Where to draw the menu. The terminal pane clips its overflow, so the menu
  // is drawn into the document body instead and has to be told where to go.
  const [menuAt, setMenuAt] = useState<{ left: number; bottom: number } | null>(null);

  // Lets the close handler read the current tabs without the effects that keep
  // it up to date having to re-create it.
  const tabsRef = useRef<TerminalTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Chooses an active tab only when the current one has gone away, so a late
  // restore cannot yank the user off the tab they are typing in.
  const setActiveKeyIfUnset = useCallback((next: TerminalTab[], preferred: string | null) => {
    setActiveKey((active) => {
      if (active && next.some((tab) => tab.key === active)) return active;
      if (preferred && next.some((tab) => tab.key === preferred)) return preferred;
      return next[0]?.key ?? null;
    });
  }, []);

  const usableHosts = useMemo(() => hosts.filter((host) => host.enabled), [hosts]);

  // Reconcile with the server: forget shells it no longer has, and adopt any it
  // does that no tab claims — a reload in another browser tab, or a session
  // opened before tabs existed, should not leave a shell running invisibly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let live: Array<{ id: string; hostId: string; cwd?: string; exit?: unknown }> = [];
      try {
        const response = await fetch("/api/terminal?all=1", { cache: "no-store" });
        if (response.ok) {
          const body = await response.json().catch(() => ({}));
          const list = (body as { terminals?: unknown }).terminals;
          if (Array.isArray(list)) live = list.filter((entry) => entry && !entry.exit);
        }
      } catch {
        // The listing is an optimisation; without it tabs simply open fresh shells.
      }
      if (cancelled) return;

      const liveIds = new Set(live.map((session) => session.id));
      // Only shells this listing could have known about are pruned. A tab that
      // started its own while the listing was in flight is absent from it
      // through no fault of its own, and forgetting that shell would leave it
      // running with nothing pointing at it.
      const knowable = new Set(initial.tabs.map((tab) => tab.sessionId).filter(Boolean));
      const restoredTabs = tabsRef.current.map((tab) => (
        // A session the server no longer has is not worth reattaching to; the
        // tab stays and opens a new shell when it is next shown.
        tab.sessionId && knowable.has(tab.sessionId) && !liveIds.has(tab.sessionId)
          ? { ...tab, sessionId: null }
          : tab
      ));

      const next = [...restoredTabs];
      // Adopt shells nothing is pointing at, so none is left running invisibly.
      // A machine that already has a tab is skipped: that tab may simply not
      // have reported its session yet, and a second tab for the same shell
      // would be worse than waiting.
      const spokenFor = new Set(next.map((tab) => tab.hostId));
      for (const session of live) {
        if (spokenFor.has(session.hostId)) continue;
        spokenFor.add(session.hostId);
        next.push({ key: newTabKey(), hostId: session.hostId, cwd: session.cwd ?? null, sessionId: session.id });
      }
      if (next.length === 0 && hostId) {
        next.push({ key: newTabKey(), hostId, cwd: cwd ?? null, sessionId: null });
      }
      setTabs(next);
      setActiveKeyIfUnset(next, initial.activeKey);
    })();
    return () => {
      cancelled = true;
    };
    // Restoration runs once: later changes to the workspace's machine open a
    // tab on demand rather than rewriting the ones the user already has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeKey } satisfies PersistedState));
    } catch {
      // A full or blocked localStorage costs the user their tab list on reload,
      // which is not worth breaking the terminal over.
    }
  }, [tabs, activeKey]);

  // A workspace with no tabs at all still needs one when the pane is opened.
  useEffect(() => {
    if (tabs.length > 0 || !hostId) return;
    const tab: TerminalTab = { key: newTabKey(), hostId, cwd: cwd ?? null, sessionId: null };
    setTabs([tab]);
    setActiveKey(tab.key);
  }, [tabs.length, hostId, cwd]);

  // Position the menu against the button it hangs off, and keep it there while
  // the pane is resized or the page scrolls.
  useLayoutEffect(() => {
    if (!picking) {
      setMenuAt(null);
      return;
    }
    const place = () => {
      const rect = addButtonRef.current?.getBoundingClientRect();
      if (rect) setMenuAt({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [picking]);

  useEffect(() => {
    if (!picking) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !menuRef.current?.contains(target)) setPicking(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picking]);

  const openTab = useCallback((targetHostId: string) => {
    // The workspace's directory only makes sense on the workspace's machine;
    // a tab elsewhere starts in that machine's home.
    const startCwd = targetHostId === hostId ? cwd ?? null : null;
    const tab: TerminalTab = { key: newTabKey(), hostId: targetHostId, cwd: startCwd, sessionId: null };
    // Built outside the updater: React may re-run an updater, and one that also
    // set the active tab dropped the new tab while leaving its shell running.
    setTabs((current) => [...current, tab]);
    setActiveKey(tab.key);
    setPicking(false);
  }, [cwd, hostId]);

  const closeTab = useCallback((key: string) => {
    // Closing a tab ends its shell: a tab is the only handle on that session,
    // so keeping it alive would strand it.
    const target = tabsRef.current.find((tab) => tab.key === key);
    if (target?.sessionId) {
      void fetch(`/api/terminal/${encodeURIComponent(target.sessionId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    }
    const index = tabsRef.current.findIndex((tab) => tab.key === key);
    const next = tabsRef.current.filter((tab) => tab.key !== key);
    setTabs(next);
    setActiveKey((active) => (active === key ? next[Math.min(index, next.length - 1)]?.key ?? null : active));
  }, []);

  const setTabSession = useCallback((key: string, sessionId: string | null) => {
    setTabs((current) => {
      const tab = current.find((entry) => entry.key === key);
      // Re-rendering every tab because a pane re-reported the id it already had
      // would remount the active pane and churn its shell.
      if (!tab || tab.sessionId === sessionId) return current;
      return current.map((entry) => (entry.key === key ? { ...entry, sessionId } : entry));
    });
  }, []);

  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null;

  /** Machine name, plus an ordinal when the machine has more than one tab. */
  const labelFor = useCallback((tab: TerminalTab): string => {
    const host = hosts.find((entry) => entry.id === tab.hostId);
    const name = host?.name ?? tab.hostId;
    const sameHost = tabs.filter((entry) => entry.hostId === tab.hostId);
    if (sameHost.length < 2) return name;
    return `${name} ${sameHost.findIndex((entry) => entry.key === tab.key) + 1}`;
  }, [hosts, tabs]);

  const tabStrip = (
    <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, flex: 1, overflowX: "auto", scrollbarWidth: "none" }}>
      {tabs.map((tab) => {
        const host = hosts.find((entry) => entry.id === tab.hostId);
        const isActive = tab.key === active?.key;
        return (
          <div
            key={tab.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
              maxWidth: 190,
              padding: "0 4px 0 7px",
              height: 22,
              borderRadius: "var(--radius-control)",
              background: isActive ? "var(--bg-selected)" : "transparent",
              color: isActive ? "var(--text)" : "var(--text-muted)",
            }}
          >
            <button
              type="button"
              onClick={() => setActiveKey(tab.key)}
              aria-current={isActive ? "true" : undefined}
              title={tab.cwd ?? labelFor(tab)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                padding: 0,
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {host
                ? <HostStatusDot host={host} size={6} />
                : <HostKindIcon kind="ssh" size={11} />}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {labelFor(tab)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => closeTab(tab.key)}
              title={t("terminal.closeTab")}
              aria-label={t("terminal.closeTab", { name: labelFor(tab) })}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 15,
                height: 15,
                flexShrink: 0,
                padding: 0,
                border: "none",
                borderRadius: 3,
                background: "transparent",
                color: "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              <X size={10} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        );
      })}

      <div ref={pickerRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setPicking((open) => !open)}
          title={t("terminal.newTab")}
          aria-label={t("terminal.newTab")}
          aria-expanded={picking}
          aria-haspopup="menu"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            padding: 0,
            border: "none",
            borderRadius: "var(--radius-control)",
            background: picking ? "var(--bg-selected)" : "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <Plus size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
        {picking && menuAt && createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: "fixed",
              bottom: menuAt.bottom,
              left: menuAt.left,
              zIndex: 400,
              minWidth: 180,
              maxHeight: 260,
              overflowY: "auto",
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-panel)",
              background: "var(--bg-panel)",
              boxShadow: "var(--shadow-panel, 0 8px 24px rgba(0,0,0,0.18))",
            }}
          >
            {usableHosts.map((host) => (
              <button
                key={host.id}
                type="button"
                role="menuitem"
                onClick={() => openTab(host.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "5px 8px",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  background: "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: 12,
                  textAlign: "left",
                }}
                onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
              >
                <HostStatusDot host={host} size={6} />
                <HostKindIcon kind={host.kind} size={12} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {host.name}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
      </div>
    </div>
  );

  if (!active) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 28, padding: "0 8px", borderBottom: "1px solid var(--border)" }}>
          {tabStrip}
          <button
            type="button"
            onClick={onClose}
            title={t("terminal.close")}
            aria-label={t("terminal.close")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
          {t("terminal.noTabs")}
        </div>
      </div>
    );
  }

  return (
    <TerminalPane
      // Remounting per tab is deliberate: it is what tears down the previous
      // tab's stream and attaches to this one's.
      key={active.key}
      hostId={active.hostId}
      cwd={active.cwd}
      sessionId={active.sessionId}
      onSessionChange={(sessionId) => setTabSession(active.key, sessionId)}
      onClose={onClose}
      tabs={tabStrip}
    />
  );
}
