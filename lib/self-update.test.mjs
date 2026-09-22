import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { detectSupervisor, parseServiceUnitFromCgroup } = await jiti.import("./self-update.ts");

const USER_SERVICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ompweb.service\n";

test("reads the unit name out of a cgroup v2 hierarchy", () => {
  assert.equal(parseServiceUnitFromCgroup(USER_SERVICE_CGROUP), "ompweb.service");
  assert.equal(
    parseServiceUnitFromCgroup("0::/system.slice/ompweb.service/some-child\n"),
    "ompweb.service",
  );
});

test("never mistakes the user manager or a scope for the service", () => {
  assert.equal(parseServiceUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service\n"), null);
  assert.equal(parseServiceUnitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseServiceUnitFromCgroup(""), null);
  assert.equal(parseServiceUnitFromCgroup("0::/\n"), null);
});

test("OMP_WEB_SERVICE wins over the cgroup", () => {
  const detected = detectSupervisor(
    { OMP_WEB_SERVICE: "custom.service", INVOCATION_ID: "x" },
    () => USER_SERVICE_CGROUP,
  );
  assert.deepEqual(detected, { supervisor: "systemd", serviceUnit: "custom.service" });
});

test("derives the unit when the generated unit file does not name itself", () => {
  const detected = detectSupervisor({ INVOCATION_ID: "x" }, () => USER_SERVICE_CGROUP);
  assert.deepEqual(detected, { supervisor: "systemd", serviceUnit: "ompweb.service" });
});

test("reports why self-update is unsupported when the unit cannot be identified", () => {
  const detected = detectSupervisor({ INVOCATION_ID: "x" }, () => "");
  assert.equal(detected.supervisor, "systemd");
  assert.equal(detected.serviceUnit, null);
  assert.match(detected.reason, /OMP_WEB_SERVICE/);
});

test("outside systemd there is no supervisor to restart through", () => {
  assert.deepEqual(detectSupervisor({}, () => USER_SERVICE_CGROUP), {
    supervisor: "none",
    serviceUnit: null,
  });
});
