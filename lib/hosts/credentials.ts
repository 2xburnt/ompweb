import { withHost } from "./context";
import type { Host } from "./registry";
import type { CredentialEndpoints, CredentialPolicy } from "./types";

/**
 * Applying a machine's credential policy.
 *
 * Every policy is expressed in omp's own configuration on that machine, so a
 * machine behaves the same whether it was reached through ompweb or by
 * someone sshing in and running omp by hand.
 *
 * - "local":   clear any broker pointing we previously wrote and leave the
 *              machine's own credentials alone.
 * - "broker":  set auth.broker.url / auth.broker.token so omp fetches
 *              credentials from the hub's vault.
 * - "gateway": write a models.yml provider pointing at the hub's gateway. The
 *              machine holds only the gateway token, which can make model
 *              calls but cannot extract credentials.
 *
 * The token in each case is written with `secretEnv`, so it is streamed over
 * stdin and never appears in a command line other users on that machine can
 * read.
 */

/** Provider name ompweb owns in a machine's models.yml. Anything else there is left alone. */
export const GATEWAY_PROVIDER_NAME = "ompweb-gateway";

const OMP_CONFIG_TIMEOUT_MS = 30_000;
// The gateway's model list is fetched from the hub, not the machine, so a
// machine never needs to reach it just to be configured.
const GATEWAY_MODELS_TIMEOUT_MS = 20_000;

export class CredentialPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CredentialPolicyError";
    this.code = code;
  }
}

/** Run `omp config <action> <key> [value]` on a host, keeping values off the command line. */
async function ompConfig(host: Host, args: string[], secret?: { name: string; value: string }): Promise<void> {
  const bin = host.ompBin ?? "omp";
  // `$SECRET` is expanded by the remote shell from a value read on stdin, so
  // the literal never becomes part of any argv.
  const argv = secret ? [bin, ...args, `$${secret.name}`] : [bin, ...args];
  await host.executor.exec(argv, {
    timeoutMs: OMP_CONFIG_TIMEOUT_MS,
    ...(secret ? { secretEnv: { [secret.name]: secret.value } } : {}),
  });
}

async function readOmpConfig(host: Host, key: string): Promise<string | null> {
  const bin = host.ompBin ?? "omp";
  try {
    const { stdout } = await host.executor.exec([bin, "config", "get", key], { timeoutMs: OMP_CONFIG_TIMEOUT_MS, allowFailure: true });
    const value = stdout.toString("utf8").trim();
    return !value || value === "(not set)" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Models the gateway offers, in the shape models.yml wants.
 *
 * Fetched from the gateway rather than hardcoded, so the list a machine sees
 * matches what the gateway can actually serve and refreshes whenever the
 * policy is reapplied.
 */
export interface GatewayModel {
  id: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export function parseGatewayModels(payload: unknown): GatewayModel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: GatewayModel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    const contextWindow = typeof record.context_length === "number" ? record.context_length
      : typeof record.context_len === "number" ? record.context_len
      : undefined;
    const maxTokens = typeof record.max_output_tokens === "number" ? record.max_output_tokens
      : typeof record.max_tokens === "number" ? record.max_tokens
      : undefined;
    models.push({
      id: record.id,
      // The gateway reports each model's upstream API; omp needs one per model
      // because a single gateway fronts providers that do not share a shape.
      ...(typeof record.api === "string" && record.api ? { api: record.api } : {}),
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      ...(maxTokens && maxTokens > 0 ? { maxTokens } : {}),
    });
  }
  return models;
}

async function fetchGatewayModels(endpoints: CredentialEndpoints): Promise<GatewayModel[]> {
  const url = `${endpoints.gatewayUrl}/v1/models`;
  const response = await fetch(url, {
    headers: endpoints.gatewayToken ? { Authorization: `Bearer ${endpoints.gatewayToken}` } : {},
    signal: AbortSignal.timeout(GATEWAY_MODELS_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new CredentialPolicyError("gateway_unreachable", `The gateway at ${endpoints.gatewayUrl} answered ${response.status}`);
  }
  const models = parseGatewayModels(await response.json());
  if (models.length === 0) {
    throw new CredentialPolicyError("gateway_no_models", "The gateway offered no models");
  }
  return models;
}

/**
 * The models.yml a machine on the gateway policy should have.
 *
 * Only ompweb's own provider entry is replaced; any provider the user defined
 * on that machine is preserved, because their models.yml is not ours to own.
 */
export function withGatewayProvider(
  existing: Record<string, unknown>,
  endpoints: CredentialEndpoints,
  models: GatewayModel[],
): Record<string, unknown> {
  const providers = { ...(existing.providers as Record<string, unknown> | undefined ?? {}) };
  providers[GATEWAY_PROVIDER_NAME] = {
    baseUrl: `${endpoints.gatewayUrl}/v1`,
    apiKey: endpoints.gatewayToken ?? "",
    models: models.map((model) => ({
      id: model.id,
      ...(model.api ? { api: model.api } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
    })),
  };
  return { ...existing, providers };
}

/** Remove ompweb's gateway provider, leaving everything else in place. */
export function withoutGatewayProvider(existing: Record<string, unknown>): Record<string, unknown> {
  const providers = existing.providers as Record<string, unknown> | undefined;
  if (!providers || !(GATEWAY_PROVIDER_NAME in providers)) return existing;
  const next = { ...providers };
  delete next[GATEWAY_PROVIDER_NAME];
  return { ...existing, providers: next };
}

async function applyLocal(host: Host): Promise<void> {
  // Only clear a pointer we could have written. A machine that was never on
  // the broker has nothing to undo.
  if (await readOmpConfig(host, "auth.broker.url")) {
    await ompConfig(host, ["config", "reset", "auth.broker.url"]);
    await ompConfig(host, ["config", "reset", "auth.broker.token"]);
  }
  await clearGatewayProvider(host);
}

async function applyBroker(host: Host, endpoints: CredentialEndpoints): Promise<void> {
  if (!endpoints.brokerUrl) {
    throw new CredentialPolicyError("broker_not_configured", "No broker URL is configured for this hub");
  }
  await ompConfig(host, ["config", "set", "auth.broker.url", endpoints.brokerUrl]);
  if (endpoints.brokerToken) {
    await ompConfig(host, ["config", "set", "auth.broker.token"], { name: "OMPWEB_BROKER_TOKEN", value: endpoints.brokerToken });
  }
  await clearGatewayProvider(host);
}

async function applyGateway(host: Host, endpoints: CredentialEndpoints): Promise<void> {
  if (!endpoints.gatewayUrl) {
    throw new CredentialPolicyError("gateway_not_configured", "No gateway URL is configured for this hub");
  }
  // A gateway machine must not also hold a broker pointer: that would hand it
  // the credentials the gateway exists to withhold.
  if (await readOmpConfig(host, "auth.broker.url")) {
    await ompConfig(host, ["config", "reset", "auth.broker.url"]);
    await ompConfig(host, ["config", "reset", "auth.broker.token"]);
  }
  const models = await fetchGatewayModels(endpoints);
  const { readModelsConfigFile, writeModelsConfig } = await import("../omp/models-config");
  await withHost(host, async () => {
    const current = await readModelsConfigFile();
    const next = withGatewayProvider(current.config as unknown as Record<string, unknown>, endpoints, models);
    await writeModelsConfig(next as never);
  });
}

/**
 * Drop our gateway provider when a machine moves off that policy.
 *
 * Best-effort on purpose: this is cleanup of something that usually is not
 * there, and a machine whose models.yml cannot be read is still perfectly able
 * to use the broker or its own credentials. Failing the whole policy over it
 * would turn a tidy-up into an outage.
 */
async function clearGatewayProvider(host: Host): Promise<void> {
  try {
    const { readModelsConfigFile, writeModelsConfig } = await import("../omp/models-config");
    await withHost(host, async () => {
      const current = await readModelsConfigFile();
      const config = current.config as unknown as Record<string, unknown>;
      const next = withoutGatewayProvider(config);
      if (next !== config) await writeModelsConfig(next as never);
    });
  } catch {
    // Nothing to clean up, or the file is unreadable; neither blocks the policy.
  }
}

/**
 * Bring a machine's omp configuration in line with its credential policy.
 *
 * Called after a successful probe, so a machine is configured the moment it
 * becomes reachable and stays that way if the policy changes later.
 */
export async function applyCredentialPolicy(host: Host, policy: CredentialPolicy, endpoints: CredentialEndpoints | undefined): Promise<void> {
  if (!host.ompBin) {
    throw new CredentialPolicyError("omp_missing", "omp is not installed on this machine");
  }
  switch (policy) {
    case "broker":
      return applyBroker(host, endpoints ?? {});
    case "gateway":
      return applyGateway(host, endpoints ?? {});
    default:
      return applyLocal(host);
  }
}
