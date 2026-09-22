import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("./omp-web-release.js");

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

/** A release that only has to look like one. */
function fakeRelease(root, commit, metadata = {}) {
  const dir = join(store.releasePaths(root).releases, commit);
  mkdirSync(join(dir, ".next"), { recursive: true });
  writeFileSync(join(dir, ".next", "BUILD_ID"), commit);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  store.writeReleaseMetadata(dir, { commit, repo: "/somewhere", createdAt: new Date().toISOString(), ...metadata });
  return dir;
}

test("the release root honours OMP_WEB_RELEASE_ROOT then XDG_DATA_HOME", () => {
  assert.equal(store.resolveReleaseRoot({ OMP_WEB_RELEASE_ROOT: "/srv/ompweb" }), "/srv/ompweb");
  assert.equal(store.resolveReleaseRoot({ XDG_DATA_HOME: "/data" }), join("/data", "ompweb"));
  assert.match(store.resolveReleaseRoot({}), /[/\\]\.local[/\\]share[/\\]ompweb$/);
});

test("a release directory reports what it was built from", () => {
  const root = scratch("ompweb-release-meta-");
  const dir = fakeRelease(root, "abc123", { repo: "/repo", remote: "origin", branch: "deploy" });
  const metadata = store.readReleaseMetadata(dir);
  assert.equal(metadata.commit, "abc123");
  assert.equal(metadata.branch, "deploy");
  assert.equal(store.readReleaseMetadata(join(root, "nope")), null);
});

test("activating a release records the one it replaced", () => {
  const root = scratch("ompweb-release-activate-");
  const first = fakeRelease(root, "1111111");
  const second = fakeRelease(root, "2222222");

  const initial = store.activateRelease({ root, releaseDir: first });
  assert.equal(initial.previous, null);
  assert.equal(store.currentReleaseDir(root), first);

  const swapped = store.activateRelease({ root, releaseDir: second });
  assert.equal(swapped.previous, first);
  assert.equal(store.currentReleaseDir(root), second);
  assert.equal(realpathSync(store.releasePaths(root).previous), first);
});

test("rollback is a symlink flip with no build and no git", () => {
  const root = scratch("ompweb-release-rollback-");
  const first = fakeRelease(root, "1111111");
  const second = fakeRelease(root, "2222222");
  store.activateRelease({ root, releaseDir: first });
  store.activateRelease({ root, releaseDir: second });

  store.rollbackRelease({ root });
  assert.equal(store.currentReleaseDir(root), first);
});

test("rollback refuses when there is nothing to go back to", () => {
  const root = scratch("ompweb-release-norollback-");
  assert.throws(() => store.rollbackRelease({ root }), /no previous release/);
});

test("rollback refuses a release that has no build to serve", () => {
  const root = scratch("ompweb-release-unbuilt-");
  const first = fakeRelease(root, "1111111");
  const second = fakeRelease(root, "2222222");
  store.activateRelease({ root, releaseDir: first });
  store.activateRelease({ root, releaseDir: second });
  rmSync(join(first, ".next"), { recursive: true, force: true });
  assert.throws(() => store.rollbackRelease({ root }), /no build to serve/);
});

test("pruning never removes current or previous", async () => {
  const root = scratch("ompweb-release-prune-");
  const made = [];
  for (const commit of ["1111111", "2222222", "3333333", "4444444", "5555555"]) {
    made.push(fakeRelease(root, commit, { createdAt: `2026-01-0${made.length + 1}T00:00:00.000Z` }));
  }
  store.activateRelease({ root, releaseDir: made[0] });
  store.activateRelease({ root, releaseDir: made[1] });

  store.pruneReleases({ root, keep: 3 });
  assert.deepEqual(
    store.listReleases(root).map((release) => release.name).sort(),
    ["1111111", "2222222", "5555555"],
    "keep=3 retains current, previous and the newest spare",
  );

  store.pruneReleases({ root, keep: 1 });
  assert.ok(existsSync(made[0]), "previous survives a keep that would exclude it");
  assert.ok(existsSync(made[1]), "current survives a keep that would exclude it");
  assert.deepEqual(
    store.listReleases(root).map((release) => release.name).sort(),
    ["1111111", "2222222"],
  );
});

test("listReleases marks the active one", () => {
  const root = scratch("ompweb-release-list-");
  fakeRelease(root, "1111111", { createdAt: "2026-01-01T00:00:00.000Z" });
  const second = fakeRelease(root, "2222222", { createdAt: "2026-01-02T00:00:00.000Z" });
  store.activateRelease({ root, releaseDir: second });

  const releases = store.listReleases(root);
  assert.deepEqual(releases.map((release) => release.name), ["2222222", "1111111"]);
  assert.deepEqual(releases.map((release) => release.active), [true, false]);
});

test("exporting a commit writes no worktree and no ref into the repository", () => {
  const repo = scratch("ompweb-release-repo-");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" },
  });
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  mkdirSync(join(repo, "app"));
  writeFileSync(join(repo, "app", "page.tsx"), "export default function Page() { return null; }\n");
  git("add", "-A");
  git("commit", "-m", "fixture");
  const commit = git("rev-parse", "HEAD").trim();

  const destination = join(scratch("ompweb-release-export-"), "out");
  store.exportCommit({ repo, commit, destination });

  assert.equal(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).version, "9.9.9");
  assert.ok(existsSync(join(destination, "app", "page.tsx")));
  assert.ok(!existsSync(join(destination, ".git")), "an export is not a checkout");
  assert.equal(git("worktree", "list").trim().split("\n").length, 1, "no worktree registered");
  assert.equal(git("for-each-ref", "--format=%(refname)", "refs/heads").trim(), "refs/heads/main");
  assert.ok(!existsSync(`${destination}.tar`), "the intermediate archive is cleaned up");
});

test("dependencies are only reinstalled when the lockfile moved", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push(args.join(" "));
    return { stdout: args.includes("package-lock.json") && args.includes("dirty") ? "package-lock.json\n" : "" };
  };
  assert.equal(store.dependenciesChanged({ repo: "/r", from: null, to: "b", run }), true, "a first release always installs");
  assert.equal(store.dependenciesChanged({ repo: "/r", from: "a", to: "b", run }), false);
  assert.equal(store.dependenciesChanged({ repo: "/r", from: "dirty", to: "b", run }), true);
});

test("resolveTracking inherits the current release's branch, then defaults", () => {
  // Explicit choice wins.
  assert.deepEqual(
    store.resolveTracking({ branch: "feature", metadata: { remote: "origin", branch: "main" } }),
    { remote: "origin", branch: "feature" },
  );
  // No choice inherits from the live release — a plain deploy keeps following it.
  assert.deepEqual(
    store.resolveTracking({ metadata: { remote: "upstream", branch: "multi-machine" } }),
    { remote: "upstream", branch: "multi-machine" },
  );
  // First-ever deploy (no release yet) falls back to origin/main.
  assert.deepEqual(store.resolveTracking({}), { remote: "origin", branch: "main" });
  assert.deepEqual(store.resolveTracking({ metadata: null }), { remote: "origin", branch: "main" });
});

test("setReleaseTracking retargets the live release without a rebuild", () => {
  const root = scratch("ompweb-release-retarget-");
  const dir = fakeRelease(root, "abc123", { remote: "origin", branch: "main" });
  store.activateRelease({ root, releaseDir: dir });

  const result = store.setReleaseTracking({ root, branch: "multi-machine" });
  assert.deepEqual(result, { releaseDir: dir, remote: "origin", branch: "multi-machine" });
  // Persisted, and the rest of the metadata (commit, build) is untouched.
  const metadata = store.readReleaseMetadata(dir);
  assert.equal(metadata.branch, "multi-machine");
  assert.equal(metadata.remote, "origin");
  assert.equal(metadata.commit, "abc123");

  // remote alone, and both together.
  assert.equal(store.setReleaseTracking({ root, remote: "upstream" }).remote, "upstream");
  const both = store.setReleaseTracking({ root, remote: "origin", branch: "deploy" });
  assert.deepEqual([both.remote, both.branch], ["origin", "deploy"]);
});

test("setReleaseTracking refuses when there is no release or no change", () => {
  const root = scratch("ompweb-release-retarget-empty-");
  assert.throws(() => store.setReleaseTracking({ root, branch: "x" }), /no release is active/);
  const dir = fakeRelease(root, "abc123");
  store.activateRelease({ root, releaseDir: dir });
  assert.throws(() => store.setReleaseTracking({ root }), /nothing to change/);
});
