import { currentHost } from "./hosts/context";

export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; supportsFastMode?: boolean }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  connectedProviders?: { id: string; name: string; disabled: boolean }[];
  modelError?: string;
}

interface ModelsCacheState {
  /** Keyed by `${hostId}\0${cwd}`: the model registry lives on the host. */
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  /** Bumped by a global invalidation. */
  generation: number;
  /** Bumped by a per-host invalidation. */
  hostGenerations: Map<string, number>;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never expose caught provider/configuration details in a fallback response.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
      hostGenerations: new Map(),
    };
  }
  // Older hot-reloaded state may predate the per-host map.
  globalThis.__piModelsCacheState.hostGenerations ??= new Map();
  return globalThis.__piModelsCacheState;
}

function cacheKey(hostId: string, cwd: string): string {
  return `${hostId}\0${cwd}`;
}

function hostGeneration(state: ModelsCacheState, hostId: string): number {
  return state.hostGenerations.get(hostId) ?? 0;
}

/** Drop cached model data. Without a host id every host's cache is cleared
 * (rpc-manager calls it that way after login/set_model events). */
export function invalidateModelsCache(hostId?: string): void {
  const state = getModelsCacheState();
  if (hostId === undefined) {
    state.generation += 1;
    state.entries.clear();
    state.inFlight.clear();
    return;
  }
  state.hostGenerations.set(hostId, hostGeneration(state, hostId) + 1);
  const prefix = `${hostId}\0`;
  for (const key of [...state.entries.keys()]) if (key.startsWith(prefix)) state.entries.delete(key);
  for (const key of [...state.inFlight.keys()]) if (key.startsWith(prefix)) state.inFlight.delete(key);
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>, hostId: string = currentHost().id): Promise<ModelsData> {
  const state = getModelsCacheState();
  const key = cacheKey(hostId, cwd);
  const cached = state.entries.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.data);

  const load = state.inFlight.get(key) ?? startModelsLoad(state, hostId, key, loader);

  if (cached) {
    // Stale-while-revalidate: serve the expired entry immediately while the
    // refresh runs in the background. Staleness here only ever means TTL age —
    // invalidateModelsCache() (login, set_model, models.yml writes) clears
    // entries outright, so mutations never serve through this path.
    load.catch(() => {
      // A failed background refresh keeps serving the stale entry; the next
      // request retries.
    });
    return Promise.resolve(cached.data);
  }
  return load;
}

function startModelsLoad(
  state: ModelsCacheState,
  hostId: string,
  key: string,
  loader: () => Promise<ModelsData>,
): Promise<ModelsData> {
  const generation = state.generation;
  const hostGen = hostGeneration(state, hostId);
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && hostGeneration(state, hostId) === hostGen && state.inFlight.get(key) === loadPromise) {
        // Expired entries are kept (they back stale-while-revalidate serving);
        // the entry cap alone bounds the map.
        state.entries.delete(key);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(key, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(key) === loadPromise) state.inFlight.delete(key);
    });

  state.inFlight.set(key, loadPromise);
  return loadPromise;
}
