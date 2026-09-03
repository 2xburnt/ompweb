"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Monitor, Server, Settings2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useHosts } from "@/lib/hosts/client";
import type { HostSummary } from "@/lib/hosts/types";
import { SidebarPortalMenu } from "./SidebarPortalMenu";
import { hostStatusColor } from "./machine-groups";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Localized connection-state label for a host. */
export function hostStatusLabel(t: Translate, host: Pick<HostSummary, "status" | "enabled">): string {
  if (!host.enabled || host.status === "disabled") return t("hosts.status.disabled");
  switch (host.status) {
    case "connected": return t("hosts.status.connected");
    case "connecting": return t("hosts.status.connecting");
    case "error": return t("hosts.status.error");
    default: return t("hosts.status.unknown");
  }
}

/** omp reports "omp/17.1.3"; show just the number. */
export function formatOmpVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.replace(/^omp\//, "").trim();
  return trimmed ? `v${trimmed}` : null;
}

/** Icon for a host kind — the serving machine vs. a remote reached over SSH. */
export function HostKindIcon({ kind, size = 13, style }: { kind: HostSummary["kind"]; size?: number; style?: CSSProperties }) {
  const Icon = kind === "local" ? Monitor : Server;
  return <Icon size={size} strokeWidth={1.9} aria-hidden="true" style={style} />;
}

/** Status dot: green connected, amber connecting, red error (tooltip carries
 *  the last error), muted for disabled / not yet probed. */
export function HostStatusDot({ host, size = 7 }: { host: Pick<HostSummary, "status" | "enabled" | "lastError">; size?: number }) {
  const { t } = useI18n();
  const label = hostStatusLabel(t, host);
  const detail = host.status === "error" && host.lastError ? `${label}: ${host.lastError}` : label;
  const color = host.enabled ? hostStatusColor(host.status) : hostStatusColor("disabled");
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: host.enabled && host.status === "connected" ? `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)` : "none",
        flexShrink: 0,
      }}
    />
  );
}

interface MachineSwitcherProps {
  /** Opens Settings → Machines. */
  onManageMachines?: () => void;
}

/** Compact machine switcher for the sidebar header: current machine name,
 *  status dot and omp version; the menu lists every enabled machine plus a
 *  "Manage machines…" entry. Keyboard: Enter/Space opens, arrows move,
 *  Escape closes (handled by SidebarPortalMenu). */
export function MachineSwitcher({ onManageMachines }: MachineSwitcherProps) {
  const { t } = useI18n();
  const { hosts, hostId, current, loaded, setHostId } = useHosts();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const enabledHosts = hosts.filter((host) => host.enabled);
  const close = useCallback(() => setOpen(false), []);

  const select = useCallback((id: string) => {
    setOpen(false);
    if (id !== hostId) setHostId(id);
    anchorRef.current?.focus();
  }, [hostId, setHostId]);

  const version = formatOmpVersion(current?.ompVersion);
  const name = current?.name ?? (loaded ? t("hosts.switcher.none") : t("hosts.switcher.loading"));
  const title = current
    ? (current.status === "error" && current.lastError
      ? `${t("hosts.switcher.title", { name: current.name })} — ${current.lastError}`
      : t("hosts.switcher.title", { name: current.name }))
    : name;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="sidebar-machine-switcher"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("hosts.switcher.ariaLabel", { name })}
        title={title}
        style={{
          width: "100%",
          height: 28,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: open || hovered ? "var(--bg-hover)" : "var(--bg-subtle)",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
          transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
        }}
      >
        <HostKindIcon kind={current?.kind ?? "local"} size={13} style={{ color: current ? "var(--text-muted)" : "var(--text-dim)", flexShrink: 0 }} />
        {current && <HostStatusDot host={current} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600, letterSpacing: "-0.01em", color: current ? "var(--text)" : "var(--text-dim)" }}>
          {name}
        </span>
        {version && (
          <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{version}</span>
        )}
        <ChevronDown size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} />
      </button>
      <SidebarPortalMenu anchor={anchorRef} open={open} onClose={close} placement="below" align="start" minWidth={236} style={{ maxWidth: 320 }}>
        <div role="presentation" style={{ padding: "4px 9px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
          {t("hosts.switcher.label")}
        </div>
        {enabledHosts.length === 0 && (
          <div style={{ padding: "6px 9px", fontSize: 11, color: "var(--text-dim)" }}>{t("hosts.switcher.none")}</div>
        )}
        {enabledHosts.map((host) => {
          const selected = host.id === hostId;
          const hostVersion = formatOmpVersion(host.ompVersion);
          const detail = host.status === "error" && host.lastError ? host.lastError : hostVersion ?? hostStatusLabel(t, host);
          return (
            <button
              key={host.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className="sidebar-menu-item"
              onClick={() => select(host.id)}
              title={host.status === "error" && host.lastError ? host.lastError : host.ssh ? `${host.ssh.user ? `${host.ssh.user}@` : ""}${host.ssh.host}${host.ssh.port ? `:${host.ssh.port}` : ""}` : undefined}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11.5 }}
            >
              <HostKindIcon kind={host.kind} size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <HostStatusDot host={host} />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: selected ? 600 : 500 }}>{host.name}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, fontFamily: hostVersion && host.status !== "error" ? "var(--font-mono)" : "inherit", color: host.status === "error" ? "var(--status-error)" : "var(--text-dim)" }}>
                  {detail}
                </span>
              </span>
              {selected && <Check size={12} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />}
            </button>
          );
        })}
        {onManageMachines && (
          <>
            <div role="separator" aria-orientation="horizontal" style={{ height: 1, margin: "4px 4px", background: "var(--border)" }} />
            <button
              type="button"
              role="menuitem"
              className="sidebar-menu-item"
              onClick={() => { setOpen(false); onManageMachines(); }}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11.5 }}
            >
              <Settings2 size={13} strokeWidth={1.9} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>{t("hosts.switcher.manage")}</span>
            </button>
          </>
        )}
      </SidebarPortalMenu>
    </>
  );
}
