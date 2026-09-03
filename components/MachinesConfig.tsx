"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { FolderOpen, Pencil, Plus, Power, RefreshCw, Star, Trash2, Wifi } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError, type ApiErrorPayload } from "@/lib/i18n/api-error";
import { useHosts } from "@/lib/hosts/client";
import type { HostSummary } from "@/lib/hosts/types";
import { Alert, Check, ConfirmDialog, Field, NumInput, TextInput } from "@/components/ui/field";
import { useIsMobile } from "@/hooks/useIsMobile";
import { DirectoryPicker } from "./DirectoryPicker";
import { formatOmpVersion, HostKindIcon, HostStatusDot, hostStatusLabel } from "./MachineSwitcher";

/* ───────────────────────────── form model ───────────────────────────── */

interface HostFormValues {
  name: string;
  sshHost: string;
  user: string;
  port: string;
  identityFile: string;
  ompBin: string;
  agentDir: string;
  defaultCwd: string;
  credentials: "local" | "broker" | "gateway";
  enabled: boolean;
  makeDefault: boolean;
}

type FormErrors = Partial<Record<keyof HostFormValues, string>>;

function emptyForm(): HostFormValues {
  return { name: "", sshHost: "", user: "", port: "", identityFile: "", ompBin: "", agentDir: "", defaultCwd: "", credentials: "local", enabled: true, makeDefault: false };
}

function formFromHost(host: HostSummary): HostFormValues {
  return {
    name: host.name,
    sshHost: host.ssh?.host ?? "",
    user: host.ssh?.user ?? "",
    port: host.ssh?.port ? String(host.ssh.port) : "",
    identityFile: host.ssh?.identityFile ?? "",
    ompBin: host.ompBin ?? "",
    agentDir: host.agentDir ?? "",
    defaultCwd: host.defaultCwd ?? "",
    credentials: host.credentials ?? "local",
    enabled: host.enabled,
    makeDefault: host.isDefault,
  };
}

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : Number.NaN;
}

/** Request body for POST /api/hosts (new machines are always SSH). */
function createBody(values: HostFormValues): Record<string, unknown> {
  const port = parsePort(values.port);
  return {
    name: values.name.trim(),
    kind: "ssh",
    ssh: {
      host: values.sshHost.trim(),
      ...(values.user.trim() ? { user: values.user.trim() } : {}),
      ...(port ? { port } : {}),
      ...(values.identityFile.trim() ? { identityFile: values.identityFile.trim() } : {}),
    },
    ...(values.ompBin.trim() ? { ompBin: values.ompBin.trim() } : {}),
    ...(values.agentDir.trim() ? { agentDir: values.agentDir.trim() } : {}),
    ...(values.defaultCwd.trim() ? { defaultCwd: values.defaultCwd.trim() } : {}),
    credentials: values.credentials,
    enabled: values.enabled,
    makeDefault: values.makeDefault,
  };
}

/** Request body for PATCH /api/hosts/[id]; an empty string clears a field. */
function patchBody(values: HostFormValues, host: HostSummary): Record<string, unknown> {
  const port = parsePort(values.port);
  return {
    name: values.name.trim(),
    ...(host.kind === "ssh" ? {
      ssh: {
        host: values.sshHost.trim(),
        user: values.user.trim(),
        port: port ?? "",
        identityFile: values.identityFile.trim(),
      },
    } : {}),
    ompBin: values.ompBin.trim(),
    agentDir: values.agentDir.trim(),
    defaultCwd: values.defaultCwd.trim(),
    credentials: values.credentials,
    enabled: values.enabled,
  };
}

async function requestJson<T extends object>(input: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & ApiErrorPayload }> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({})) as T & ApiErrorPayload;
  return { ok: response.ok, status: response.status, data };
}

/* ───────────────────────────── styles ───────────────────────────── */

const cardStyle: CSSProperties = {
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
};

function buttonStyle(options: { primary?: boolean; danger?: boolean; busy?: boolean; disabled?: boolean } = {}): CSSProperties {
  const { primary, danger, busy, disabled } = options;
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 10px",
    border: `1px solid ${primary ? "var(--accent-strong)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    background: primary ? "var(--accent-strong)" : "transparent",
    color: primary ? "var(--on-accent)" : danger ? "var(--status-error)" : "var(--text)",
    cursor: busy ? "wait" : disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    fontSize: 12,
    fontWeight: primary ? 600 : 500,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
  };
}

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "1px 6px",
  borderRadius: 10,
  background: "var(--bg-subtle)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.02em",
  whiteSpace: "nowrap",
};

/* ───────────────────────────── form ───────────────────────────── */

/**
 * A path field with an optional browser.
 *
 * Typing stays the primary interaction, since a path can name something that
 * does not exist yet, or a machine that cannot be reached. The browser is an
 * affordance on top, and is only offered for a machine that is saved and
 * reachable: there is nothing to list otherwise.
 */
function PathField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  mode,
  hostId,
  browsable,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  mode: "file" | "directory";
  hostId: string | null;
  browsable: boolean;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TextInput id={id} value={value} onChange={onChange} placeholder={placeholder} mono disabled={disabled} autoComplete="off" spellCheck={false} />
      </div>
      {browsable && (
        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={disabled}
          title={mode === "file" ? t("directoryPicker.chooseFile") : t("directoryPicker.chooseDirectory")}
          aria-label={mode === "file" ? t("directoryPicker.chooseFile") : t("directoryPicker.chooseDirectory")}
          style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", cursor: disabled ? "default" : "pointer", fontSize: 11.5 }}
        >
          <FolderOpen size={13} strokeWidth={1.9} aria-hidden="true" />
          {t("directoryPicker.browse")}
        </button>
      )}
      {picking && (
        <DirectoryPicker
          mode={mode}
          hostId={hostId}
          startPath={value.trim() || null}
          onCancel={() => setPicking(false)}
          onSelect={(path) => { onChange(path); setPicking(false); }}
        />
      )}
    </div>
  );
}

function HostForm({
  host,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  /** Existing machine when editing; null when adding. */
  host: HostSummary | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: HostFormValues) => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [values, setValues] = useState<HostFormValues>(() => (host ? formFromHost(host) : emptyForm()));
  const [errors, setErrors] = useState<FormErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const isSsh = host === null || host.kind === "ssh";
  // Browsing needs a machine the server already knows and can reach; a machine
  // being added has neither, so those fields stay type-only until it is saved.
  const canBrowse = host !== null && host.enabled && host.status === "connected";

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const set = <K extends keyof HostFormValues>(key: K, value: HostFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (!values.name.trim()) next.name = t("hosts.form.nameRequired");
    if (isSsh && !values.sshHost.trim()) next.sshHost = t("hosts.form.sshHostRequired");
    if (isSsh && Number.isNaN(parsePort(values.port))) next.port = t("hosts.form.portInvalid");
    return next;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit(values);
  };

  const columns = isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))";

  return (
    <form onSubmit={handleSubmit} aria-label={host ? t("hosts.settings.editTitle", { name: host.name }) : t("hosts.settings.addTitle")} style={{ ...cardStyle, gap: 12, borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))" }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {host ? t("hosts.settings.editTitle", { name: host.name }) : t("hosts.settings.addTitle")}
      </div>
      {error && <Alert variant="error" description={error} />}
      <div style={{ display: "grid", gridTemplateColumns: columns, gap: 10 }}>
        <Field label={t("hosts.form.name")} required error={errors.name}>
          <TextInput id="host-form-name" value={values.name} onChange={(v) => set("name", v)} placeholder={t("hosts.form.namePlaceholder")} error={errors.name} disabled={busy} autoComplete="off" />
        </Field>
        {isSsh && (
          <Field label={t("hosts.form.sshHost")} required hint={t("hosts.form.sshHostHint")} error={errors.sshHost}>
            <TextInput id="host-form-ssh-host" value={values.sshHost} onChange={(v) => set("sshHost", v)} placeholder="build-box or 10.0.0.5" mono error={errors.sshHost} disabled={busy} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        {isSsh && (
          <Field label={t("hosts.form.user")} hint={t("hosts.form.userHint")}>
            <TextInput id="host-form-user" value={values.user} onChange={(v) => set("user", v)} mono disabled={busy} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        {isSsh && (
          <Field label={t("hosts.form.port")} hint={t("hosts.form.portHint")} error={errors.port}>
            <NumInput id="host-form-port" value={values.port} onChange={(v) => set("port", v)} placeholder="22" error={errors.port} disabled={busy} />
          </Field>
        )}
        {isSsh && (
          <Field label={t("hosts.form.identityFile")} hint={t("hosts.form.identityFileHint")}>
            <PathField id="host-form-identity" value={values.identityFile} onChange={(v) => set("identityFile", v)} placeholder="~/.ssh/id_ed25519" disabled={busy} mode="file" hostId={host?.id ?? null} browsable={canBrowse} />
          </Field>
        )}
        <Field label={t("hosts.form.ompBin")} hint={t("hosts.form.ompBinHint")}>
          <PathField id="host-form-omp-bin" value={values.ompBin} onChange={(v) => set("ompBin", v)} placeholder="omp" disabled={busy} mode="file" hostId={host?.id ?? null} browsable={canBrowse} />
        </Field>
        <Field label={t("hosts.form.agentDir")} hint={t("hosts.form.agentDirHint")}>
          <PathField id="host-form-agent-dir" value={values.agentDir} onChange={(v) => set("agentDir", v)} placeholder="~/.omp/agent" disabled={busy} mode="directory" hostId={host?.id ?? null} browsable={canBrowse} />
        </Field>
        <Field label={t("hosts.form.credentials")} hint={t(`hosts.form.credentialsHint.${values.credentials}`)}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["local", "broker", "gateway"] as const).map((policy) => {
              const active = values.credentials === policy;
              return (
                <button
                  key={policy}
                  type="button"
                  onClick={() => set("credentials", policy)}
                  disabled={busy}
                  aria-pressed={active}
                  style={{ padding: "5px 11px", border: `1px solid ${active ? "var(--accent-strong)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 12, fontWeight: active ? 600 : 400 }}
                >
                  {t(`hosts.form.credentialsOption.${policy}`)}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={t("hosts.form.defaultCwd")} hint={t("hosts.form.defaultCwdHint")}>
          <PathField id="host-form-default-cwd" value={values.defaultCwd} onChange={(v) => set("defaultCwd", v)} placeholder="~/projects" disabled={busy} mode="directory" hostId={host?.id ?? null} browsable={canBrowse} />
        </Field>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
        <Check label={t("hosts.form.enabled")} checked={values.enabled} onChange={(v) => set("enabled", v)} disabled={busy} />
        {host === null && (
          <Check label={t("hosts.form.makeDefault")} checked={values.makeDefault} onChange={(v) => set("makeDefault", v)} disabled={busy} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onCancel} disabled={busy} style={buttonStyle({ disabled: busy })}>{t("hosts.settings.cancel")}</button>
        <button type="submit" disabled={busy} style={buttonStyle({ primary: true, busy })}>
          {busy ? t("hosts.settings.saving") : host ? t("hosts.settings.save") : t("hosts.settings.add")}
        </button>
      </div>
    </form>
  );
}

/* ───────────────────────────── host card ───────────────────────────── */

function sshTarget(host: HostSummary): string | null {
  if (!host.ssh) return null;
  const user = host.ssh.user ? `${host.ssh.user}@` : "";
  const port = host.ssh.port ? `:${host.ssh.port}` : "";
  return `${user}${host.ssh.host}${port}`;
}

function HostCard({
  host,
  busyAction,
  testResult,
  onTest,
  onSetDefault,
  onToggleEnabled,
  onEdit,
  onRemove,
  canRemove,
}: {
  host: HostSummary;
  busyAction: string | null;
  testResult: { ok: boolean; message: string } | null;
  onTest: () => void;
  onSetDefault: () => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { t } = useI18n();
  const busy = busyAction !== null;
  const version = formatOmpVersion(host.ompVersion);
  const target = sshTarget(host);
  const statusText = hostStatusLabel(t, host);
  const meta: ReactNode[] = [];
  if (version) meta.push(<span key="version" style={{ fontFamily: "var(--font-mono)" }}>{t("hosts.meta.version", { version })}</span>);
  if (host.platform) meta.push(<span key="platform">{host.platform}</span>);
  if (host.home) meta.push(<span key="home" style={{ fontFamily: "var(--font-mono)" }}>{host.home}</span>);

  return (
    <section aria-label={host.name} style={{ ...cardStyle, opacity: host.enabled ? 1 : 0.75 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0, flex: 1 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text-muted)", flexShrink: 0 }}>
            <HostKindIcon kind={host.kind} size={15} />
          </span>
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{host.name}</span>
              <span style={chipStyle}>{host.kind === "local" ? t("hosts.kind.local") : t("hosts.kind.ssh")}</span>
              {host.isDefault && <span style={{ ...chipStyle, color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))" }}>{t("hosts.default")}</span>}
              {!host.enabled && <span style={chipStyle}>{t("hosts.status.disabled")}</span>}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{host.id}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", flexWrap: "wrap" }}>
              <HostStatusDot host={host} />
              <span style={{ color: host.enabled && host.status === "error" ? "var(--status-error)" : "var(--text-muted)" }}>{statusText}</span>
              {meta.map((node, index) => (
                <span key={index} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>·</span>
                  {node}
                </span>
              ))}
            </div>
            {target && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                {target}{host.ssh?.identityFile ? ` · ${host.ssh.identityFile}` : ""}
              </div>
            )}
            {(host.ompBin || host.agentDir || host.defaultCwd) && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                {[host.ompBin, host.agentDir, host.defaultCwd].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
          <button type="button" onClick={onTest} disabled={busy || !host.enabled} aria-label={t("hosts.settings.testAria", { name: host.name })} style={buttonStyle({ busy: busyAction === "test", disabled: busy || !host.enabled })}>
            <Wifi size={13} aria-hidden="true" /> {busyAction === "test" ? t("hosts.settings.testing") : t("hosts.settings.test")}
          </button>
          <button type="button" onClick={onSetDefault} disabled={busy || host.isDefault || !host.enabled} aria-label={t("hosts.settings.setDefaultAria", { name: host.name })} style={buttonStyle({ busy: busyAction === "default", disabled: busy || host.isDefault || !host.enabled })}>
            <Star size={13} aria-hidden="true" /> {host.isDefault ? t("hosts.settings.isDefault") : t("hosts.settings.setDefault")}
          </button>
          <button type="button" onClick={onToggleEnabled} disabled={busy} aria-label={host.enabled ? t("hosts.settings.disableAria", { name: host.name }) : t("hosts.settings.enableAria", { name: host.name })} style={buttonStyle({ busy: busyAction === "toggle", disabled: busy })}>
            <Power size={13} aria-hidden="true" /> {host.enabled ? t("hosts.settings.disable") : t("hosts.settings.enable")}
          </button>
          <button type="button" onClick={onEdit} disabled={busy} aria-label={t("hosts.settings.editAria", { name: host.name })} style={buttonStyle({ disabled: busy })}>
            <Pencil size={13} aria-hidden="true" /> {t("hosts.settings.edit")}
          </button>
          <button type="button" onClick={onRemove} disabled={busy || !canRemove} aria-label={t("hosts.settings.removeAria", { name: host.name })} title={canRemove ? undefined : t("hosts.settings.lastHost")} style={buttonStyle({ danger: true, disabled: busy || !canRemove })}>
            <Trash2 size={13} aria-hidden="true" /> {t("hosts.settings.remove")}
          </button>
        </div>
      </div>
      {host.enabled && host.status === "error" && host.lastError && (
        <Alert variant="error" description={t("hosts.meta.lastError", { error: host.lastError })} />
      )}
      {host.lastSyncError && (
        <Alert variant="warning" description={t("hosts.meta.lastSyncError", { error: host.lastSyncError })} />
      )}
      {testResult && (
        <Alert variant={testResult.ok ? "success" : "error"} description={testResult.message} />
      )}
    </section>
  );
}

/* ───────────────────────────── panel ───────────────────────────── */

type FormMode = { type: "idle" } | { type: "add" } | { type: "edit"; id: string };

export function MachinesConfig() {
  const { t } = useI18n();
  const { hosts, loaded, refresh } = useHosts();
  const [mode, setMode] = useState<FormMode>({ type: "idle" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyById, setBusyById] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<HostSummary | null>(null);
  const [removing, setRemoving] = useState(false);

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      await refresh({ probe: true });
      setListError(null);
    } catch (error) {
      setListError(t("hosts.settings.loadFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setProbing(false);
    }
  }, [refresh, t]);

  // Statuses are probed when the tab opens so the list reflects reality, not
  // the last cached state.
  const probedRef = useRef(false);
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    void probe();
  }, [probe]);

  const setBusy = useCallback((id: string, action: string | null) => {
    setBusyById((prev) => {
      if (action === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: action };
    });
  }, []);

  const editingHost = useMemo(() => (mode.type === "edit" ? hosts.find((host) => host.id === mode.id) ?? null : null), [mode, hosts]);

  const closeForm = useCallback(() => {
    setMode({ type: "idle" });
    setFormError(null);
  }, []);

  const submitForm = useCallback(async (values: HostFormValues) => {
    setFormBusy(true);
    setFormError(null);
    try {
      const result = mode.type === "edit" && editingHost
        ? await requestJson<{ host?: HostSummary | null }>(`/api/hosts/${encodeURIComponent(editingHost.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody(values, editingHost)),
        })
        : await requestJson<{ host?: HostSummary | null }>("/api/hosts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody(values)),
        });
      if (!result.ok || result.data.error) {
        setFormError(formatApiError(result.data.error || result.data.code ? result.data : `HTTP ${result.status}`));
        return;
      }
      closeForm();
      await probe();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setFormBusy(false);
    }
  }, [mode, editingHost, closeForm, probe]);

  const testConnection = useCallback(async (host: HostSummary) => {
    setBusy(host.id, "test");
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[host.id];
      return next;
    });
    try {
      const result = await requestJson<{ ok?: boolean; error?: string; host?: HostSummary }>(`/api/hosts/${encodeURIComponent(host.id)}/test`, { method: "POST" });
      const ok = result.ok && result.data.ok === true;
      const version = formatOmpVersion(result.data.host?.ompVersion ?? null);
      const message = ok
        ? t("hosts.settings.testOk", { version: version ?? t("hosts.meta.versionUnknown") })
        : t("hosts.settings.testFailed", { error: result.data.error || result.data.code ? formatApiError(result.data) : `HTTP ${result.status}` });
      setTestResults((prev) => ({ ...prev, [host.id]: { ok, message } }));
      await refresh({ probe: false }).catch(() => {});
    } catch (error) {
      setTestResults((prev) => ({ ...prev, [host.id]: { ok: false, message: t("hosts.settings.testFailed", { error: error instanceof Error ? error.message : String(error) }) } }));
    } finally {
      setBusy(host.id, null);
    }
  }, [setBusy, refresh, t]);

  const setDefault = useCallback(async (host: HostSummary) => {
    setBusy(host.id, "default");
    try {
      const result = await requestJson<{ hosts?: HostSummary[] }>("/api/hosts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultHost: host.id }),
      });
      if (!result.ok || result.data.error) throw new Error(formatApiError(result.data.error || result.data.code ? result.data : `HTTP ${result.status}`));
      await refresh({ probe: false });
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(host.id, null);
    }
  }, [setBusy, refresh]);

  const toggleEnabled = useCallback(async (host: HostSummary) => {
    setBusy(host.id, "toggle");
    try {
      const result = await requestJson<{ host?: HostSummary | null }>(`/api/hosts/${encodeURIComponent(host.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !host.enabled }),
      });
      if (!result.ok || result.data.error) throw new Error(formatApiError(result.data.error || result.data.code ? result.data : `HTTP ${result.status}`));
      await probe();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(host.id, null);
    }
  }, [setBusy, probe]);

  const removeHost = useCallback(async () => {
    const host = confirmRemove;
    if (!host) return;
    setRemoving(true);
    try {
      const result = await requestJson<{ success?: boolean; hosts?: HostSummary[] }>(`/api/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
      if (!result.ok || result.data.error || result.data.success === false) {
        throw new Error(formatApiError(result.data.error || result.data.code ? result.data : `HTTP ${result.status}`));
      }
      setConfirmRemove(null);
      if (mode.type === "edit" && mode.id === host.id) closeForm();
      await probe();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
      setConfirmRemove(null);
    } finally {
      setRemoving(false);
    }
  }, [confirmRemove, mode, closeForm, probe]);

  const canRemove = hosts.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("hosts.settings.title")}</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("hosts.settings.description")}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button type="button" onClick={() => void probe()} disabled={probing} aria-label={t("hosts.settings.refreshAria")} style={buttonStyle({ busy: probing })}>
            <RefreshCw size={13} aria-hidden="true" className={probing ? "icon-spin" : undefined} /> {t("hosts.settings.refresh")}
          </button>
          <button type="button" onClick={() => { setMode({ type: "add" }); setFormError(null); }} disabled={mode.type === "add"} style={buttonStyle({ primary: true, disabled: mode.type === "add" })}>
            <Plus size={13} aria-hidden="true" /> {t("hosts.settings.add")}
          </button>
        </div>
      </div>

      {listError && <Alert variant="error" description={listError} onDismiss={() => setListError(null)} />}

      {mode.type === "add" && (
        <HostForm host={null} busy={formBusy} error={formError} onCancel={closeForm} onSubmit={(values) => void submitForm(values)} />
      )}

      {!loaded && hosts.length === 0 ? (
        <div role="status" style={{ padding: "14px 4px", fontSize: 12, color: "var(--text-dim)" }}>{t("hosts.switcher.loading")}</div>
      ) : hosts.length === 0 ? (
        <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--text-muted)" }}>{t("hosts.settings.empty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {hosts.map((host) => (
            mode.type === "edit" && mode.id === host.id && editingHost ? (
              <HostForm key={`${host.id}-edit`} host={editingHost} busy={formBusy} error={formError} onCancel={closeForm} onSubmit={(values) => void submitForm(values)} />
            ) : (
              <HostCard
                key={host.id}
                host={host}
                busyAction={busyById[host.id] ?? null}
                testResult={testResults[host.id] ?? null}
                onTest={() => void testConnection(host)}
                onSetDefault={() => void setDefault(host)}
                onToggleEnabled={() => void toggleEnabled(host)}
                onEdit={() => { setMode({ type: "edit", id: host.id }); setFormError(null); }}
                onRemove={() => setConfirmRemove(host)}
                canRemove={canRemove}
              />
            )
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open && !removing) setConfirmRemove(null); }}
        title={confirmRemove ? t("hosts.settings.removeConfirmTitle", { name: confirmRemove.name }) : ""}
        description={t("hosts.settings.removeConfirmDesc")}
        confirmLabel={t("hosts.settings.remove")}
        cancelLabel={t("hosts.settings.cancel")}
        danger
        busy={removing}
        onConfirm={() => void removeHost()}
      />
    </div>
  );
}
