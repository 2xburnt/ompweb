import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  groupSessionsByMachine,
  hostStatusColor,
  projectActivityByKey,
  projectExpansionKey,
  sessionProjectPath,
} = await jiti.import("./machine-groups.ts");

function host(id, overrides = {}) {
  return {
    id,
    name: id.toUpperCase(),
    kind: id === "local" ? "local" : "ssh",
    enabled: true,
    isDefault: id === "local",
    status: "connected",
    home: null,
    platform: null,
    ompVersion: null,
    lastError: null,
    lastSyncAt: null,
    lastSyncError: null,
    ...overrides,
  };
}

function session(id, hostId, cwd, extra = {}) {
  return {
    id,
    host: hostId,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    projectRoot: cwd,
    projectKey: `${hostId}:${cwd}`,
    ...extra,
  };
}

test("sessionProjectPath strips the machine prefix from projectKey", () => {
  assert.equal(sessionProjectPath({ host: "box", projectKey: "box:/srv/app", projectRoot: "/srv/app/x", cwd: "/srv/app/x" }), "/srv/app");
  // Windows identity keys contain a second colon; only the host prefix goes.
  assert.equal(sessionProjectPath({ host: "win", projectKey: "win:c:/work/app", projectRoot: "C:\\work\\app", cwd: "C:\\work\\app" }), "c:/work/app");
  // Untagged (legacy) keys are already plain paths.
  assert.equal(sessionProjectPath({ projectKey: "/home/me/app", projectRoot: "/home/me/app", cwd: "/home/me/app/sub" }), "/home/me/app");
  // Client-built rows fall back to projectRoot, then cwd.
  assert.equal(sessionProjectPath({ host: "box", projectKey: "/x", projectRoot: "/x", cwd: "/x/y" }), "/x");
  assert.equal(sessionProjectPath({ host: "box", cwd: "/only/cwd" }), "/only/cwd");
});

test("groups sessions by machine then project, keeping every enabled machine", () => {
  const hosts = [host("local"), host("box"), host("off", { enabled: false })];
  const groups = groupSessionsByMachine({
    hosts,
    projectsByHost: {
      local: [{ path: "/home/me/app" }, { path: "/home/me/empty" }],
      box: [{ path: "/home/me/app" }],
    },
    sessions: [
      session("s1", "local", "/home/me/app"),
      session("s2", "box", "/home/me/app"),
      session("s3", "box", "/srv/other"),
    ],
    fallbackHostId: "local",
  });

  assert.deepEqual(groups.map((g) => g.hostId), ["local", "box"]);
  const local = groups[0];
  assert.deepEqual(local.projects.map((p) => [p.project.path, p.sessions.map((s) => s.id)]), [
    ["/home/me/app", ["s1"]],
    ["/home/me/empty", []],
  ]);
  const box = groups[1];
  // The same path on another machine is a different bucket, and a session
  // whose project is missing from the list gets a synthetic row.
  assert.deepEqual(box.projects.map((p) => [p.project.path, p.sessions.map((s) => s.id)]), [
    ["/home/me/app", ["s2"]],
    ["/srv/other", ["s3"]],
  ]);
  assert.equal(box.projects[0].key, projectExpansionKey("box", "/home/me/app"));
  assert.equal(local.host?.name, "LOCAL");
});

test("untagged sessions fall back to the given machine and unknown machines are appended", () => {
  const groups = groupSessionsByMachine({
    hosts: [host("local")],
    projectsByHost: { local: [{ path: "/p" }] },
    sessions: [
      session("legacy", undefined, "/p", { projectKey: "/p" }),
      session("ghost", "gone", "/q"),
    ],
    fallbackHostId: "local",
  });
  assert.deepEqual(groups.map((g) => [g.hostId, g.host === null]), [["local", false], ["gone", true]]);
  assert.deepEqual(groups[0].projects[0].sessions.map((s) => s.id), ["legacy"]);
  assert.deepEqual(groups[1].projects[0].sessions.map((s) => s.id), ["ghost"]);
});

test("projectActivityByKey counts running and unread sessions per bucket", () => {
  const groups = groupSessionsByMachine({
    hosts: [host("local")],
    projectsByHost: { local: [{ path: "/p" }] },
    sessions: [session("a", "local", "/p"), session("b", "local", "/p"), session("c", "local", "/q")],
    fallbackHostId: "local",
  });
  const activity = projectActivityByKey(groups, new Set(["a"]), new Set(["b", "c"]));
  assert.deepEqual(activity.get(projectExpansionKey("local", "/p")), { running: 1, unread: 1 });
  assert.deepEqual(activity.get(projectExpansionKey("local", "/q")), { running: 0, unread: 1 });
});

test("hostStatusColor maps states to design tokens", () => {
  assert.equal(hostStatusColor("connected"), "var(--status-success)");
  assert.equal(hostStatusColor("connecting"), "var(--status-warning)");
  assert.equal(hostStatusColor("error"), "var(--status-error)");
  assert.equal(hostStatusColor("disabled"), "var(--text-dim)");
  assert.equal(hostStatusColor("unknown"), "var(--text-dim)");
});
