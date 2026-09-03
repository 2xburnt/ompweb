"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Plug, RotateCcw, X } from "lucide-react";
import { hostFetch, hostNameOf, useHosts } from "@/lib/hosts/client";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/hooks/useTheme";
import { formatApiError } from "@/lib/i18n/api-error";

/**
 * A shell on the selected machine, rendered with xterm.js.
 *
 * Output arrives over SSE and input goes back over POST. The server keeps the
 * PTY and a scrollback buffer, so remounting this component (tab change,
 * dropped stream, page reload) restores the screen instead of starting a new
 * shell.
 *
 * xterm and its addon are imported lazily: they touch `window` at module scope
 * and must never be pulled into the server bundle.
 */

const FALLBACK_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * The app's monospace stack as a concrete font list.
 *
 * `--font-mono` is defined in terms of other custom properties, and xterm needs
 * a literal family list rather than a `var()` reference. Reading it back from a
 * probe element lets the browser do the substitution, including the hashed
 * next/font family name.
 */
function resolveMonoFontStack(): string {
  if (typeof window === "undefined") return FALLBACK_MONO_STACK;
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = "var(--font-mono)";
  document.body.appendChild(probe);
  const resolved = window.getComputedStyle(probe).fontFamily;
  probe.remove();
  // A stack that still mentions var() never resolved; do not hand that to xterm.
  return resolved && !resolved.includes("var(") ? `${resolved}, ${FALLBACK_MONO_STACK}` : FALLBACK_MONO_STACK;
}

interface TerminalHandle {
  write: (data: string) => void;
  focus: () => void;
  fit: () => { cols: number; rows: number } | null;
  dispose: () => void;
}

type Status = "starting" | "connected" | "exited" | "error";

export function TerminalPane({
  hostId,
  cwd,
  sessionId,
  onSessionChange,
  onClose,
  onExit,
  tabs,
}: {
  /** Machine to open the shell on. Changing it replaces the session. */
  hostId: string | null;
  /** Directory to start in; the machine's home when omitted. */
  cwd?: string | null;
  /**
   * Shell to reattach to, read once when the pane mounts. Null opens a new one.
   * The owner of the tab holds this, not the pane: two tabs on the same machine
   * must be two shells, which is not something the pane can work out for itself.
   */
  sessionId?: string | null;
  /** Reports the shell this pane settled on, so the tab can reattach to it later. */
  onSessionChange?: (sessionId: string | null) => void;
  onClose: () => void;
  /** The shell ended on its own (exit, or the machine went away). */
  onExit?: () => void;
  /**
   * Tab strip for the header. The pane is short, so its chrome is a single
   * row: tabs on the left, this session's status and controls on the right.
   */
  tabs?: ReactNode;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const { hosts } = useHosts();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // True once this pane has attached to a stream, so a reconnect can be told
  // apart from the user opening the terminal.
  const attachedRef = useRef(false);
  // The working directory only matters when a shell is created; a later change
  // must not tear down a running one, so it is read from a ref.
  const cwdRef = useRef(cwd);
  // Read once: the parent re-renders as tabs come and go, and re-running the
  // session effect on every one of those would churn shells.
  const requestedSessionRef = useRef(sessionId ?? null);
  const onSessionChangeRef = useRef(onSessionChange);
  const onExitRef = useRef(onExit);
  const [status, setStatus] = useState<Status>("starting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [restartKey, setRestartKey] = useState(0);

  const machineName = hostId ? hostNameOf(hosts, hostId) : null;

  useEffect(() => {
    cwdRef.current = cwd;
    onSessionChangeRef.current = onSessionChange;
    onExitRef.current = onExit;
  }, [cwd, onSessionChange, onExit]);

  const sendInput = useCallback((data: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "input", data }),
      keepalive: true,
    }).catch(() => {
      // A dropped keystroke is not worth tearing the pane down; the stream's
      // own error handling reports a session that has really gone away.
    });
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const id = sessionIdRef.current;
    if (!id) return;
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "resize", cols, rows }),
    }).catch(() => {});
  }, []);

  // One effect owns the whole session lifecycle: terminal, PTY and stream are
  // created together and torn down together, so a machine switch or a restart
  // can never leave a stream attached to a disposed terminal.
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    let source: EventSource | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let disposeTerm: (() => void) | null = null;

    setStatus("starting");
    setError(null);
    setExitCode(null);
    attachedRef.current = false;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !containerRef.current) return;

      // xterm measures glyph width itself and writes the family into a canvas
      // font string, where `var(--font-mono)` is not a valid value: it fell
      // back to a default whose metrics did not match, which is what made the
      // text look stretched. Resolve the stack through a probe element so the
      // terminal is handed a concrete font list.
      const term = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        fontFamily: resolveMonoFontStack(),
        fontSize: 13,
        scrollback: 5000,
        theme: isDark
          ? { background: "#00000000", foreground: "#d6d3cd", cursor: "#e06c4b", selectionBackground: "#3a3632" }
          : { background: "#00000000", foreground: "#2b2723", cursor: "#c2410c", selectionBackground: "#e7e2d9" },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);

      const fit = () => {
        try {
          fitAddon.fit();
          return { cols: term.cols, rows: term.rows };
        } catch {
          return null;
        }
      };
      fit();
      termRef.current = {
        write: (data) => term.write(data),
        focus: () => term.focus(),
        fit,
        dispose: () => term.dispose(),
      };
      disposeTerm = () => {
        termRef.current = null;
        term.dispose();
      };

      // Reattach to this tab's own shell rather than opening another one: a
      // remount (tab switch, dropped stream, reload) must resume the session
      // the user was looking at, not leave an orphan behind and greet them
      // with a fresh prompt.
      let sessionId: string | null = null;
      try {
        const wanted = requestedSessionRef.current;
        if (wanted) {
          const existing = await fetch(`/api/terminal/${encodeURIComponent(wanted)}`, { cache: "no-store" });
          if (existing.ok) {
            const body = await existing.json().catch(() => ({}));
            // A shell that has already exited is not worth reattaching to.
            if (!(body.terminal as { exit?: unknown } | undefined)?.exit) sessionId = wanted;
          }
        }
        if (!sessionId) {
          // Sized to the pane so the first paint is already correct.
          const response = await hostFetch("/api/terminal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: cwdRef.current ?? undefined, cols: term.cols, rows: term.rows }),
          }, hostId);
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(formatApiError(body) || `HTTP ${response.status}`);
          sessionId = (body.terminal as { id: string }).id;
        }
      } catch (failure) {
        if (!cancelled) {
          setStatus("error");
          setError(failure instanceof Error ? failure.message : String(failure));
        }
        return;
      }
      if (cancelled || !sessionId) return;
      const created = { id: sessionId };
      sessionIdRef.current = created.id;
      requestedSessionRef.current = created.id;
      onSessionChangeRef.current?.(created.id);

      term.onData(sendInput);
      term.onResize(({ cols, rows }) => sendResize(cols, rows));

      resizeObserver = new ResizeObserver(() => {
        const size = fit();
        if (size) sendResize(size.cols, size.rows);
      });
      resizeObserver.observe(containerRef.current);

      source = new EventSource(`/api/terminal/${encodeURIComponent(created.id)}/events`);
      source.onmessage = (event) => {
        let frame: { type?: string; data?: string; backlog?: string; code?: number };
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === "ready") {
          setStatus("connected");
          // EventSource reconnects on its own, and every reconnect replays the
          // session's scrollback. Appending it a second time redrew the prompt
          // and stealing focus yanked the caret out of the composer, several
          // times a minute. Re-sync by clearing first, and only take focus on
          // the first attach, when the user actually opened the pane.
          const firstAttach = !attachedRef.current;
          attachedRef.current = true;
          if (!firstAttach) term.reset();
          if (frame.backlog) term.write(atob(frame.backlog));
          const size = fit();
          if (size) sendResize(size.cols, size.rows);
          if (firstAttach) term.focus();
          return;
        }
        if (frame.type === "output" && typeof frame.data === "string") {
          // Byte-exact: a PTY emits arbitrary bytes, so the payload is base64.
          const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
          term.write(bytes);
          return;
        }
        if (frame.type === "exit") {
          setStatus("exited");
          setExitCode(typeof frame.code === "number" ? frame.code : null);
          source?.close();
          onExitRef.current?.();
        }
      };
      source.onerror = () => {
        // EventSource retries on its own; only a closed stream is terminal.
        if (source?.readyState === EventSource.CLOSED && !cancelled) setStatus("error");
      };
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      source?.close();
      disposeTerm?.();
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      // The shell itself stays alive on the server so reopening the pane
      // resumes it; only an explicit close (below) kills it.
      void id;
    };
  }, [hostId, restartKey, isDark, sendInput, sendResize]);

  // Hides the pane; the shell keeps running. Closing a tab is what ends a
  // shell, so putting the terminal away does not throw away what is in it.
  const hidePane = useCallback(() => {
    onClose();
  }, [onClose]);

  const restart = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) {
      void fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
      sessionIdRef.current = null;
    }
    // Forget the dead shell so the next run opens a new one instead of trying
    // to reattach to something that has just been deleted.
    requestedSessionRef.current = null;
    onSessionChangeRef.current?.(null);
    setRestartKey((key) => key + 1);
  }, []);

  const statusLabel = status === "connected"
    ? machineName ?? ""
    : status === "starting"
      ? t("terminal.starting")
      : status === "exited"
        ? t("terminal.exited", { code: String(exitCode ?? 0) })
        : t("terminal.disconnected");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          height: 28,
          padding: "0 8px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        {tabs ?? (
          <>
            <Plug size={12} strokeWidth={1.9} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>
              {t("terminal.title")}
            </span>
          </>
        )}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: status === "error" ? "var(--status-error)" : "var(--text-dim)" }}>
          {/* With a tab strip the machine name is already on the tab, so an
              idle session needs no further label. */}
          {tabs && status === "connected" ? "" : statusLabel}
        </span>
        <span style={{ flex: 1 }} />
        {(status === "exited" || status === "error") && (
          <button
            type="button"
            onClick={restart}
            title={t("terminal.restart")}
            aria-label={t("terminal.restart")}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
          >
            <RotateCcw size={11} strokeWidth={2} aria-hidden="true" /> {t("terminal.restart")}
          </button>
        )}
        <button
          type="button"
          onClick={hidePane}
          title={t("terminal.close")}
          aria-label={t("terminal.close")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, border: "none", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <div role="alert" style={{ flexShrink: 0, padding: "6px 10px", borderBottom: "1px solid var(--border)", color: "var(--status-error)", fontSize: 11.5, lineHeight: 1.45 }}>
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        style={{ flex: 1, minHeight: 0, padding: "4px 6px", overflow: "hidden", background: "var(--bg)" }}
      />
    </div>
  );
}
