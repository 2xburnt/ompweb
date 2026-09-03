import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { resolveOmpBin } from "./omp/omp-cli";
import { asNumber, isRecord } from "./type-guards";
import type {
  ProviderUsageReport,
  ProviderUsageSnapshot,
  ProviderUsageWindowId,
} from "./provider-usage-types";

const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 5 * 60_000;

type UsageQuery = { provider?: string; modelId?: string };

type CachedUsage = { expiresAt: number; output: string };

// Per host: usage is reported by the omp install (and credentials) on that machine.
const usageCache = new Map<string, CachedUsage>();
const usageInFlight = new Map<string, Promise<string>>();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d") {
    return windowId === "30d" ? "monthly" : windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

function accountLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  return nonEmptyString(metadata?.email) ?? nonEmptyString(metadata?.accountId);
}

type UsageLimit = { id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> };

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  limits: Map<ProviderUsageWindowId, UsageLimit>;
};

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  reportIndex: number,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}`;
    const priority = modelId ? (normalizedTier ? 0 : 1) : normalizedTier ? 2 : 3;
    let group = groups.get(groupKey);
    if (!group) {
      group = { priority, modelId, tier, limits: new Map() };
      groups.set(groupKey, group);
    }
    const candidate = { id: windowId, fraction, window };
    const current = group.limits.get(windowId);
    if (!current || fraction > current.fraction) group.limits.set(windowId, candidate);
  }

  const selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    const selected = selectedGroups.reduce((best, group) => group.priority < best.priority ? group : best);
    selectedGroups.splice(0, selectedGroups.length, selected);
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  const label = accountLabel(metadata);
  const plan = nonEmptyString(metadata?.planType);
  if (selectedGroups.length === 0) {
    return [{
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      noLimits: true,
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
    };
    for (const candidate of group.limits.values()) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

export function parseProviderUsageOutput(output: string, query: UsageQuery = {}, now = Date.now()): ProviderUsageSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  const rawReports = Array.isArray(payload.reports) ? payload.reports : [];
  const reports = rawReports.flatMap((report, index) => isRecord(report) ? normalizeReport(report, query, now, index) : []);
  const generatedAt = asNumber(payload.generatedAt) ?? null;
  return { generatedAt, reports };
}

async function fetchProviderUsage(host: Host): Promise<string> {
  const bin = resolveOmpBin(host);
  if (!bin) {
    throw new Error(host.isLocal
      ? "omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."
      : `omp binary not found on host "${host.id}"`);
  }
  const { stdout } = await host.executor.exec([bin, "usage", "--json", "--redact"], {
    timeoutMs: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  return stdout.toString("utf8");
}

function getUsageOutput(host: Host): Promise<string> {
  const cached = usageCache.get(host.id);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.output);
  const inFlight = usageInFlight.get(host.id);
  if (inFlight) return inFlight;
  const load = fetchProviderUsage(host)
    .then((output) => {
      usageCache.set(host.id, { output, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
      return output;
    })
    .finally(() => {
      if (usageInFlight.get(host.id) === load) usageInFlight.delete(host.id);
    });
  usageInFlight.set(host.id, load);
  return load;
}

export async function getProviderUsage(query: UsageQuery = {}, host: Host = currentHost()): Promise<ProviderUsageSnapshot> {
  return parseProviderUsageOutput(await getUsageOutput(host), query);
}

/** Drop the cached `omp usage` output (one host, or every host). */
export function clearProviderUsageCache(hostId?: string): void {
  if (hostId === undefined) {
    usageCache.clear();
    usageInFlight.clear();
    return;
  }
  usageCache.delete(hostId);
  usageInFlight.delete(hostId);
}
