import { AsyncLocalStorage } from "async_hooks";
import { getFallbackHost, requireHost, type Host } from "./registry";

/**
 * Per-request host selection. Route handlers enter a host context once
 * (lib/hosts/route.ts) and every library function below them resolves the
 * machine through currentHost() instead of threading a parameter through
 * hundreds of call sites.
 */

declare global {
  var __ompHostContext: AsyncLocalStorage<Host> | undefined;
}

const storage: AsyncLocalStorage<Host> = (globalThis.__ompHostContext ??= new AsyncLocalStorage<Host>());

export function withHost<T>(host: Host | string, fn: () => T): T {
  const resolved = typeof host === "string" ? requireHost(host) : host;
  return storage.run(resolved, fn);
}

/** The host of the current request, or null outside any host context. */
export function currentHostOrNull(): Host | null {
  return storage.getStore() ?? null;
}

/** The host of the current request; outside a request the local machine (or
 * the configured default when local is disabled). */
export function currentHost(): Host {
  return storage.getStore() ?? getFallbackHost();
}

export function currentHostId(): string {
  return currentHost().id;
}

/** True when the current request targets the local machine (or no host
 * context is active). */
export function isLocalHostContext(): boolean {
  const host = storage.getStore();
  return !host || host.isLocal;
}
