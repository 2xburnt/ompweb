"use client";

import type { CSSProperties } from "react";
import { useHosts } from "@/lib/hosts/client";
import { useI18n } from "@/lib/i18n";
import { formatOmpVersion, HostKindIcon, HostStatusDot } from "./MachineSwitcher";

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

/**
 * Small muted row naming the machine a panel is bound to. Every panel that
 * reads or writes one machine's omp installation carries one, so switching
 * machines is visible in the panel itself and not only in the sidebar
 * switcher. Panels whose content is not machine-specific (interface
 * preferences, the Machines tab) must not use it.
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
  const { current } = useHosts();
  if (!current) return null;
  const version = formatOmpVersion(current.ompVersion);
  const machine = machineScopeText(current.name, version ? t("hosts.meta.version", { version }) : null);
  return (
    <div
      role="note"
      style={{
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
        ...style,
      }}
    >
      <HostKindIcon kind={current.kind} size={12} style={{ flexShrink: 0 }} />
      <HostStatusDot host={current} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t(intent === "viewing" ? "hosts.scope.viewing" : "hosts.scope.editing", { machine })}
      </span>
    </div>
  );
}
