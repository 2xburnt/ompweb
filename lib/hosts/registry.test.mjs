import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "omp-web-registry-"));
const hostsFile = join(dir, "hosts.json");
writeFileSync(hostsFile, JSON.stringify({
  version: 1,
  defaultHost: "remote",
  hosts: [
    { id: "local", name: "here", kind: "local", enabled: true },
    { id: "remote", name: "there", kind: "ssh", enabled: true, ssh: { host: "remote.example", user: "u" } },
    { id: "off", name: "off", kind: "ssh", enabled: false, ssh: { host: "off.example" } },
  ],
}));
process.env.OMP_WEB_HOSTS_FILE = hostsFile;
process.env.OMP_WEB_HOME = dir;

const jiti = createJiti(import.meta.url);
const registry = await jiti.import("./registry.ts");
const context = await jiti.import("./context.ts");
const { withHostRoute, hostIdFromRequest } = await jiti.import("./route.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("registry loads hosts.json, exposes defaults and reuses live hosts on reload", () => {
  assert.deepEqual(registry.listHosts().map((host) => host.id), ["local", "remote"]);
  assert.deepEqual(registry.listHosts({ includeDisabled: true }).map((host) => host.id), ["local", "remote", "off"]);
  assert.equal(registry.getDefaultHost().id, "remote");
  assert.equal(registry.getFallbackHost().id, "local", "outside a request the local machine is preferred");
  assert.equal(registry.getHost("off").status, "disabled");
  const before = registry.getHost("remote");
  registry.reloadHostRegistry();
  assert.equal(registry.getHost("remote"), before, "unchanged config keeps the same Host instance");
  assert.throws(() => registry.requireHost("nope"), (error) => error.code === "host_not_found");
  const summary = registry.getHost("remote").summary(true);
  assert.equal(summary.isDefault, true);
  assert.deepEqual(summary.ssh, { host: "remote.example", user: "u" });
  assert.equal(summary.status, "unknown");
});

test("the local host is ready immediately and reports its omp probe", async () => {
  const local = registry.getHost("local");
  await local.ready();
  assert.equal(local.status, "connected");
  assert.equal(typeof local.home, "string");
  assert.equal(local.isLocal, true);
});

test("host context resolves through withHost and falls back to the local host", () => {
  assert.equal(context.currentHostOrNull(), null);
  assert.equal(context.currentHost().id, "local");
  const inside = context.withHost("remote", () => context.currentHostId());
  assert.equal(inside, "remote");
  assert.equal(context.withHost(registry.getHost("remote"), () => context.isLocalHostContext()), false);
});

test("withHostRoute selects the host from the query and rejects unknown or disabled hosts", async () => {
  const handler = withHostRoute(async () => Response.json({ host: context.currentHostId() }));
  const ok = await handler(new Request("http://x/api/things?host=local"));
  assert.deepEqual(await ok.json(), { host: "local" });
  const header = await handler(new Request("http://x/api/things", { headers: { "x-omp-host": "local" } }));
  assert.deepEqual(await header.json(), { host: "local" });
  const unknown = await handler(new Request("http://x/api/things?host=nope"));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const disabled = await handler(new Request("http://x/api/things?host=off"));
  assert.equal(disabled.status, 404);
  assert.equal(hostIdFromRequest(new Request("http://x/api/things?host=%20")), null);
});

test("an unreachable ssh host yields a 503 host_unavailable response", async () => {
  const handler = withHostRoute(async () => Response.json({ ok: true }));
  const remote = registry.getHost("remote");
  // Force a fast failure without touching the network.
  remote.executor.probe = async () => { throw new Error("connection refused (test)"); };
  const response = await handler(new Request("http://x/api/things?host=remote"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "host_unavailable");
  assert.match(body.error, /connection refused/);
  assert.equal(remote.status, "error");
  // The failure is cached briefly so the next request does not pay another probe.
  const again = await handler(new Request("http://x/api/things?host=remote"));
  assert.equal(again.status, 503);
});

test("a changed hosts.json is picked up on reload", () => {
  writeFileSync(hostsFile, JSON.stringify({ version: 1, hosts: [{ id: "local", kind: "local" }] }));
  registry.reloadHostRegistry();
  assert.deepEqual(registry.listHosts({ includeDisabled: true }).map((host) => host.id), ["local"]);
  assert.equal(registry.getDefaultHost().id, "local");
});

test("a machine whose credentials failed to apply is retried, not left broken", async () => {
  // A hub that is briefly unreachable must not leave a machine marked
  // connected but pointed at nothing for as long as the connection lasts.
  const { getHostRegistry, reloadHostRegistry } = await jiti.import("./registry.ts");
  const dir = mkdtempSync(join(tmpdir(), "omp-cred-"));
  const file = join(dir, "hosts.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    defaultHost: "local",
    credentials: { brokerUrl: "http://hub.example:8790", brokerToken: "t" },
    hosts: [
      { id: "local", name: "This machine", kind: "local" },
      { id: "box", name: "Box", kind: "ssh", ssh: { host: "box.example" }, credentials: "broker" },
    ],
  }));
  process.env.OMP_WEB_HOSTS_FILE = file;
  try {
    reloadHostRegistry();
    const host = getHostRegistry().hosts.get("box");
    host.status = "connected";
    host.ompBin = "omp";

    let attempts = 0;
    host.executor.exec = async () => {
      attempts += 1;
      throw new Error("hub unreachable");
    };

    await host.ready();
    assert.equal(attempts > 0, true, "the first attempt runs");
    assert.match(host.credentialError, /hub unreachable/);

    // The failure does not stick: the next call tries again rather than
    // treating "connected" as "configured".
    const afterFirst = attempts;
    await host.ready();
    assert.equal(attempts > afterFirst, true, "a failed policy is retried on the next ready()");

    // Once it succeeds, it stops re-running on every call.
    host.executor.exec = async () => ({ stdout: Buffer.from(""), stderr: "", code: 0, signal: null });
    await host.ready();
    assert.equal(host.credentialError, null);
    const afterSuccess = attempts;
    await host.ready();
    assert.equal(attempts, afterSuccess, "a configured machine is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OMP_WEB_HOSTS_FILE;
  }
});
