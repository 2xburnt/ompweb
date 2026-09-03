"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { useHosts } from "@/lib/hosts/client";
import { useI18n } from "@/lib/i18n";
import { formatOmpVersion, HostKindIcon, HostStatusDot, MachineMenuList } from "./MachineSwitcher";
import { SidebarPortalMenu } from "./SidebarPortalMenu";

/**
 * Machine identity for a settings panel: `"<name> · omp v18.1.3"`, or just the
 * name while the machine's omp version is unknown (never probed, unreachable).
 */
export function machineScopeText(name: string, versionLabel: string | null | undefined): string {
  const machine = name.trim();
  const version = versionLabel?.trim();
  if (!machine) return version ?? "";
  return version ? `${machine} · ${version}` : machine;
}

const PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  gap: 6,
  maxWidth: "100%",
  padding: "3px 9px",
  border: "1px solid var(--border)",
  borderRadius: 999,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.45,
};

/**
 * Names the machine a panel is bound to, and switches it. Every panel that
 * reads or writes one machine's omp installation carries one, so the machine
 * is both visible and changeable without leaving Settings for the sidebar.
 * Panels whose content is not machine-specific (interface preferences, the
 * Machines tab) must not use it.
 *
 * With a single machine configured there is nothing to switch to, so it stays
 * a plain label rather than a control that does nothing.
 */
export function MachineScopeNote({
  intent = "editing",
  style,
}: {
  /** "editing" for panels that write config, "viewing" for read-only panels. */
  intent?: "editing" | "viewing";
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const { hosts, current, setHostId } = useHosts();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const select = useCallback((id: string) => {
    setOpen(false);
    setHostId(id);
    anchorRef.current?.focus();
  }, [setHostId]);

  if (!current) return null;
  const version = formatOmpVersion(current.ompVersion);
  const machine = machineScopeText(current.name, version ? t("hosts.meta.version", { version }) : null);
  const label = t(intent === "viewing" ? "hosts.scope.viewing" : "hosts.scope.editing", { machine });
  const canSwitch = hosts.filter((host) => host.enabled).length > 1;

  const body = (
    <>
      <HostKindIcon kind={current.kind} size={12} style={{ flexShrink: 0 }} />
      <HostStatusDot host={current} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </>
  );

  if (!canSwitch) {
    return <div role="note" style={{ ...PILL_STYLE, ...style }}>{body}</div>;
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("hosts.scope.switchAriaLabel", { machine: current.name })}
        title={t("hosts.scope.switchTitle")}
        style={{
          ...PILL_STYLE,
          background: open || hovered ? "var(--bg-hover)" : "var(--bg-subtle)",
          cursor: "pointer",
          textAlign: "left",
          transition: "background var(--dur-fast) var(--ease-out-warm)",
          ...style,
        }}
      >
        {body}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
        />
      </button>
      <SidebarPortalMenu anchor={anchorRef} open={open} onClose={close} placement="below" align="start" minWidth={236} zIndex={1050} style={{ maxWidth: 320 }}>
        <MachineMenuList onSelect={select} />
      </SidebarPortalMenu>
    </>
  );
}
