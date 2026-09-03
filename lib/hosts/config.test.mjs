import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  HostConfigError,
  loadHostsFile,
  normalizeHostConfig,
  parseHostsFile,
  pickDefaultHostId,
  removeHostConfig,
  saveHostsFile,
  slugifyHostId,
  upsertHostConfig,
} = await jiti.import("./config.ts");

test("a missing hosts file means a single local host", () => {
  const loaded = loadHostsFile(join(tmpdir(), "omp-web-hosts-does-not-exist", "hosts.json"));
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.file.hosts.map((host) => host.id), ["local"]);
  assert.equal(loaded.file.defaultHost, "local");
});

test("parseHostsFile validates ids, kinds and ssh settings", () => {
  assert.throws(() => parseHostsFile("{"), (error) => error instanceof HostConfigError && error.code === "invalid_json");
  assert.throws(() => parseHostsFile(JSON.stringify({ hosts: [{ id: "Bad Id", kind: "ssh" }] })), (error) => error.code === "invalid_id");
  assert.throws(() => parseHostsFile(JSON.stringify({ hosts: [{ id: "a", kind: "ssh" }] })), (error) => error.code === "ssh_required");
  assert.throws(() => parseHostsFile(JSON.stringify({ hosts: [{ id: "a", kind: "ssh", ssh: { host: "-oProxyCommand=x" } }] })), (error) => error.code === "invalid_field");
  assert.throws(() => parseHostsFile(JSON.stringify({ hosts: [{ id: "a", kind: "ssh", ssh: { host: "h", port: 70000 } }] })), (error) => error.code === "invalid_field");
  assert.throws(() => parseHostsFile(JSON.stringify({ hosts: [{ id: "a", kind: "local" }, { id: "a", kind: "local" }] })), (error) => error.code === "duplicate_id");
});

test("parseHostsFile normalizes optional fields and picks a remote default", () => {
  const file = parseHostsFile(JSON.stringify({
    hosts: [
      { id: "local", kind: "local", name: "  " },
      { id: "hetz", kind: "ssh", ssh: { host: "hetz", user: "twice", port: "22", identityFile: "" }, ompBin: " /usr/local/bin/omp ", agentDir: "", enabled: undefined },
    ],
  }));
  assert.equal(file.defaultHost, "hetz");
  const hetz = file.hosts.find((host) => host.id === "hetz");
  assert.deepEqual(hetz.ssh, { host: "hetz", user: "twice", port: 22 });
  assert.equal(hetz.ompBin, "/usr/local/bin/omp");
  assert.equal("agentDir" in hetz, false);
  assert.equal(hetz.enabled, true);
  assert.equal(file.hosts[0].name, "local");
});

test("an unknown defaultHost falls back to the first enabled remote, then local", () => {
  const file = parseHostsFile(JSON.stringify({ defaultHost: "gone", hosts: [{ id: "local", kind: "local" }, { id: "r", kind: "ssh", enabled: false, ssh: { host: "r" } }] }));
  assert.equal(file.defaultHost, "local");
  assert.equal(pickDefaultHostId([{ id: "l", kind: "local", enabled: true }, { id: "r", kind: "ssh", enabled: true }]), "r");
});

test("slugifyHostId derives safe ids", () => {
  assert.equal(slugifyHostId("Hetzner Box #1"), "hetzner-box-1");
  assert.equal(slugifyHostId("twice@hetz.example.com"), "twice-hetz-example-com");
  assert.equal(slugifyHostId("---"), "");
});

test("upsert/remove keep the default host consistent and saveHostsFile round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-hosts-"));
  try {
    const filePath = join(dir, "hosts.json");
    let file = parseHostsFile(JSON.stringify({ hosts: [{ id: "local", kind: "local" }] }));
    file = upsertHostConfig(file, normalizeHostConfig({ id: "hetz", kind: "ssh", ssh: { host: "hetz" } }));
    file = { ...file, defaultHost: "hetz" };
    saveHostsFile(file, filePath);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(raw.defaultHost, "hetz");
    assert.deepEqual(raw.hosts.map((host) => host.id), ["local", "hetz"]);

    const removed = removeHostConfig(loadHostsFile(filePath).file, "hetz");
    assert.equal(removed.defaultHost, "local");
    assert.deepEqual(removed.hosts.map((host) => host.id), ["local"]);

    writeFileSync(filePath, "not json");
    assert.throws(() => loadHostsFile(filePath), (error) => error.code === "invalid_json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
