import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  getAppUpdateStageIndex,
  getAppUpdateStepIndex,
  getAppUpdateSteps,
  getMonotonicAppUpdateStage,
  getNextAppUpdateStage,
  isStagedAppUpdate,
} = await jiti.import("./AppUpdateDialog.tsx");
const {
  APP_UPDATE_POLL_MS,
  APP_UPDATE_STAGED_POLL_MS,
  APP_UPDATE_STOPPING_POLL_MS,
  APP_UPDATE_TIMEOUT_MS,
  getAppUpdatePhaseForStage,
  getAppUpdatePollMs,
  getAppUpdateStageTimeoutMs,
} = await jiti.import("./AppShell-app-update.ts");

test("only git checkouts build before the restart", () => {
  assert.equal(isStagedAppUpdate("git"), true);
  assert.equal(isStagedAppUpdate("npm"), false);
  assert.equal(isStagedAppUpdate("bun"), false);
  assert.equal(isStagedAppUpdate(undefined), false);
});

test("the step list hides the staged steps for package installs", () => {
  assert.deepEqual(getAppUpdateSteps("git").map((step) => step.stage), [
    "preparing", "building", "ready", "stopping", "installing", "restarting", "finalizing",
  ]);
  assert.deepEqual(getAppUpdateSteps("npm").map((step) => step.stage), [
    "preparing", "stopping", "installing", "restarting", "finalizing",
  ]);
});

test("stage indexes stay absolute so a filtered list still marks progress", () => {
  const steps = getAppUpdateSteps("npm");
  const current = getAppUpdateStepIndex("restarting", "installing");
  assert.equal(current, getAppUpdateStageIndex("installing"));
  const completed = steps
    .filter((step) => getAppUpdateStageIndex(step.stage) < current)
    .map((step) => step.stage);
  assert.deepEqual(completed, ["preparing", "stopping"]);
});

test("stages only ever move forward", () => {
  assert.equal(getMonotonicAppUpdateStage("building", "preparing"), "building");
  assert.equal(getMonotonicAppUpdateStage("building", "ready"), "ready");
  assert.equal(getMonotonicAppUpdateStage(undefined, "stopping"), "stopping");
  assert.equal(getNextAppUpdateStage("building"), "ready");
  assert.equal(getNextAppUpdateStage("finalizing"), undefined);
});

test("the dialog only announces a restart once a stage takes the server down", () => {
  assert.equal(getAppUpdatePhaseForStage("preparing"), "preparing");
  assert.equal(getAppUpdatePhaseForStage("building"), "preparing");
  assert.equal(getAppUpdatePhaseForStage("ready"), "ready");
  assert.equal(getAppUpdatePhaseForStage("stopping"), "restarting");
  assert.equal(getAppUpdatePhaseForStage("finalizing"), "restarting");
});

test("stages that keep serving poll lazily and get longer budgets", () => {
  assert.equal(getAppUpdatePollMs("building"), APP_UPDATE_STAGED_POLL_MS);
  assert.equal(getAppUpdatePollMs("ready"), APP_UPDATE_STAGED_POLL_MS);
  assert.equal(getAppUpdatePollMs("stopping"), APP_UPDATE_STOPPING_POLL_MS);
  assert.equal(getAppUpdatePollMs(undefined), APP_UPDATE_POLL_MS);

  assert.ok(getAppUpdateStageTimeoutMs("building") > APP_UPDATE_TIMEOUT_MS);
  assert.ok(getAppUpdateStageTimeoutMs("ready") > APP_UPDATE_TIMEOUT_MS);
  assert.equal(getAppUpdateStageTimeoutMs("restarting"), APP_UPDATE_TIMEOUT_MS);
  assert.equal(getAppUpdateStageTimeoutMs(undefined), APP_UPDATE_TIMEOUT_MS);
});
