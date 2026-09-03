"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HostSummary } from "./types";

/**
 * Client-side host selection. The selected host id is appended to every
 * host-scoped API call (`?host=<id>`); session-scoped calls do not need it
 * because the server derives the host from the session id.
 */

const STORAGE_KEY = "omp-host";

interface HostClientState {
  hostId: string | null;
  hosts: HostSummary[];
  loaded: boolean;
  loading: Promise<HostSummary[]> | null;
  listeners: Set<() => void>;
  snapshot: HostClientSnapshot;
}

export interface HostClientSnapshot {
  hostId: string | null;
  hosts: HostSummary[];
  loaded: boolean;
}

declare global {
  var __ompHostClientState: HostClientState | undefined;
}

function readStoredHostId(): string | null {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const state: HostClientState = (globalThis.__ompHostClientState ??= {
  hostId: null,
  hosts: [],
  loaded: false,
  loading: null,
  listeners: new Set(),
  snapshot: { hostId: null, hosts: [], loaded: false },
});

function publish(): void {
  state.snapshot = { hostId: state.hostId, hosts: state.hosts, loaded: state.loaded };
  for (const listener of state.listeners) listener();
}

function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function getSnapshot(): HostClientSnapshot {
  return state.snapshot;
}

const SERVER_SNAPSHOT: HostClientSnapshot = { hostId: null, hosts: [], loaded: false };

function getServerSnapshot(): HostClientSnapshot {
  return SERVER_SNAPSHOT;
}

/** Selected host id, or null before the host list is known. */
export function getCurrentHostId(): string | null {
  if (state.hostId === null && !state.loaded) {
    const stored = readStoredHostId();
    if (stored) state.hostId = stored;
  }
  return state.hostId;
}

export function setCurrentHostId(hostId: string | null): void {
  if (state.hostId === hostId) return;
  state.hostId = hostId;
  try {
    if (typeof localStorage !== "undefined") {
      if (hostId) localStorage.setItem(STORAGE_KEY, hostId);
      else localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable (private mode etc.)
  }
  publish();
}

function reconcileSelection(hosts: HostSummary[]): void {
  const enabled = hosts.filter((host) => host.enabled);
  const wanted = state.hostId ?? readStoredHostId();
  const selected = enabled.find((host) => host.id === wanted)
    ?? enabled.find((host) => host.isDefault)
    ?? enabled[0]
    ?? null;
  state.hostId = selected ? selected.id : null;
  try {
    if (typeof localStorage !== "undefined" && state.hostId) localStorage.setItem(STORAGE_KEY, state.hostId);
  } catch {
    // ignore
  }
}

export function applyHostList(hosts: HostSummary[]): void {
  state.hosts = hosts;
  state.loaded = true;
  reconcileSelection(hosts);
  publish();
}

/** Fetch the host list (optionally probing connectivity) and reconcile the selection. */
export async function refreshHosts(options: { probe?: boolean } = {}): Promise<HostSummary[]> {
  if (state.loading) return state.loading;
  const request = (async () => {
    try {
      const response = await fetch(`/api/hosts${options.probe ? "?probe=1" : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { hosts?: HostSummary[] };
      const hosts = Array.isArray(body.hosts) ? body.hosts : [];
      applyHostList(hosts);
      return hosts;
    } finally {
      state.loading = null;
    }
  })();
  state.loading = request;
  return request;
}

/** `host=<id>` for the selected (or given) host, or "" when unknown. */
export function hostQuery(hostId: string | null = getCurrentHostId()): string {
  return hostId ? `host=${encodeURIComponent(hostId)}` : "";
}

/** Append the host parameter to an API URL. */
export function withHostParam(url: string, hostId: string | null = getCurrentHostId()): string {
  if (!hostId) return url;
  const [pathPart, hashPart] = url.split("#", 2);
  const separator = pathPart.includes("?") ? "&" : "?";
  const withHost = `${pathPart}${separator}host=${encodeURIComponent(hostId)}`;
  return hashPart !== undefined ? `${withHost}#${hashPart}` : withHost;
}

/** fetch() against a host-scoped API route for the selected (or given) host. */
export function hostFetch(input: string, init?: RequestInit, hostId: string | null = getCurrentHostId()): Promise<Response> {
  return fetch(withHostParam(input, hostId), init);
}

export interface UseHostsResult {
  hosts: HostSummary[];
  hostId: string | null;
  current: HostSummary | null;
  loaded: boolean;
  setHostId: (id: string | null) => void;
  refresh: (options?: { probe?: boolean }) => Promise<HostSummary[]>;
}

/**
 * First load: fetch the list without probing so the UI (sidebar, selection)
 * is usable immediately, then probe in the background so connection states
 * and omp versions fill in. A probe can take seconds per unreachable machine.
 */
export async function primeHosts(): Promise<HostSummary[]> {
  if (state.loaded) return state.hosts;
  if (state.loading) return state.loading;
  const hosts = await refreshHosts({ probe: false });
  void refreshHosts({ probe: true }).catch(() => {});
  return hosts;
}

/** Display name for a host id (falls back to the id itself). */
export function hostNameOf(hosts: readonly HostSummary[], hostId: string | null | undefined): string {
  if (!hostId) return "";
  return hosts.find((host) => host.id === hostId)?.name ?? hostId;
}

/** Subscribe to the host list + selection. Loads the list on first use. */
export function useHosts(): UseHostsResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (!state.loaded && !state.loading) void primeHosts().catch(() => {});
  }, []);
  const setHostId = useCallback((id: string | null) => setCurrentHostId(id), []);
  const refresh = useCallback((options?: { probe?: boolean }) => refreshHosts(options), []);
  const current = snapshot.hosts.find((host) => host.id === snapshot.hostId) ?? null;
  return { hosts: snapshot.hosts, hostId: snapshot.hostId, current, loaded: snapshot.loaded, setHostId, refresh };
}
