import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// models-cache keys entries by host id; a single local host is enough here.
process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { invalidateModelsCache, loadModelsWithCache, withModelRuntimeError } = await jiti.import("./models-cache.ts");

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

test("keeps model data separate per host and invalidates one host at a time", async () => {
  invalidateModelsCache();
  let alphaLoads = 0;
  let betaLoads = 0;
  const alpha = await loadModelsWithCache("global", async () => { alphaLoads += 1; return modelsData("alpha"); }, "alpha");
  const beta = await loadModelsWithCache("global", async () => { betaLoads += 1; return modelsData("beta"); }, "beta");
  assert.notDeepEqual(alpha, beta);

  // Same key, other host: served from that host's own entry.
  assert.deepEqual(await loadModelsWithCache("global", async () => { alphaLoads += 1; return modelsData("x"); }, "alpha"), alpha);
  assert.equal(alphaLoads, 1);

  invalidateModelsCache("alpha");
  const alphaFresh = await loadModelsWithCache("global", async () => { alphaLoads += 1; return modelsData("alpha-2"); }, "alpha");
  assert.deepEqual(alphaFresh, modelsData("alpha-2"));
  assert.equal(alphaLoads, 2);
  // Beta's entry survived alpha's invalidation.
  assert.deepEqual(await loadModelsWithCache("global", async () => { betaLoads += 1; return modelsData("y"); }, "beta"), beta);
  assert.equal(betaLoads, 1);
});

test("adds runtime errors without discarding available models", () => {
  const data = modelsData("builtin");
  const result = withModelRuntimeError(data, "Invalid models.json schema");

  assert.deepEqual(result, {
    ...data,
    modelError: "Invalid models.json schema",
  });
});
