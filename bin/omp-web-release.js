#!/usr/bin/env node
"use strict";
// Release store: the directories the ompweb service actually runs from.
//
// The service never runs from a git checkout. A release is an export of one
// commit plus its node_modules and .next, living outside any repository:
//
//   <root>/releases/<sha>/   exported tree + node_modules + .next
//   <root>/current  -> releases/<sha>    what ExecStart resolves
//   <root>/previous -> releases/<sha>    one flip back
//
// Nothing here writes to the repository. Commits are read with `git archive`,
// so no worktree is registered, no branch moves, and no checkout is touched —
// the repository belongs to whoever is working in it, and the running service
// belongs to this directory. Dependency-free CommonJS: the update worker runs
// it from a copy in a temp directory, and the deploy CLI runs it in place.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");

const METADATA_FILE = ".ompweb-release.json";
const DEFAULT_KEEP = 3;

function resolveReleaseRoot(env = process.env) {
  if (env.OMP_WEB_RELEASE_ROOT) return path.resolve(env.OMP_WEB_RELEASE_ROOT);
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "ompweb");
}

function releasePaths(root) {
  return {
    root,
    releases: path.join(root, "releases"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
  };
}

/** A release directory identifies itself; nothing else has to remember what a
 * deployed tree was built from. */
function readReleaseMetadata(releaseDir) {
  try {
    const raw = fs.readFileSync(path.join(releaseDir, METADATA_FILE), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.commit !== "string" || typeof data.repo !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

/** Where `current` points, resolved through the symlink. */
function currentReleaseDir(root) {
  const { current } = releasePaths(root);
  try {
    return fs.realpathSync(current);
  } catch {
    return null;
  }
}

function listReleases(root) {
  const { releases } = releasePaths(root);
  let entries;
  try {
    entries = fs.readdirSync(releases, { withFileTypes: true });
  } catch {
    return [];
  }
  const live = currentReleaseDir(root);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(releases, entry.name);
      const metadata = readReleaseMetadata(dir);
      let createdAt = metadata && metadata.createdAt;
      if (!createdAt) {
        try { createdAt = fs.statSync(dir).mtime.toISOString(); } catch { createdAt = null; }
      }
      return { dir, name: entry.name, metadata, createdAt, active: live === dir };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function defaultRun(command, args, options) {
  const result = cp.spawnSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${command} ${args[0] || ""} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}${tail ? `: ${tail}` : ""}`);
  }
  return result;
}

function gitEnvironment(env = process.env) {
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1" };
}

/** Extract one commit into `destination`. Read-only against the repository:
 * no worktree is registered and no ref is written. */
function exportCommit({ repo, commit, destination, run = defaultRun }) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = path.join(path.dirname(destination), `.${path.basename(destination)}.tar`);
  try {
    run("git", ["-C", repo, "archive", "--format=tar", "-o", archive, commit], { env: gitEnvironment() });
    run("tar", ["-xf", archive, "-C", destination], {});
  } finally {
    try { fs.rmSync(archive, { force: true }); } catch { /* the export already failed or succeeded */ }
  }
}

function writeReleaseMetadata(releaseDir, metadata) {
  const file = path.join(releaseDir, METADATA_FILE);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(metadata, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temporary, file);
}

function packageVersion(releaseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** npm ci is the slowest step in a deploy and is usually unnecessary: reuse
 * the live release's node_modules whenever the lockfile is unchanged. */
function dependenciesChanged({ repo, from, to, run = defaultRun }) {
  if (!from) return true;
  const changed = run("git", ["-C", repo, "diff", "--name-only", from, to, "--", "package.json", "package-lock.json"], {
    env: gitEnvironment(),
  });
  return changed.stdout.trim().length > 0;
}

/** node_modules is large, on the same filesystem, and never written to once a
 * release is built, so hard links are safe and cost inodes rather than bytes.
 * Falls back to a real copy where `cp -al` is unavailable. */
function copyDependencies(source, destination, run = defaultRun) {
  if (process.platform !== "win32") {
    try {
      run("cp", ["-al", source, destination], {});
      return true;
    } catch {
      // Fall through to a byte copy.
    }
  }
  try {
    fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a release without touching anything that is serving. Returns the new
 * release directory; it is inert until `activateRelease` links it.
 */
async function buildRelease({
  repo,
  commit,
  root = resolveReleaseRoot(),
  remote = "origin",
  branch = "main",
  run = defaultRun,
  runLong = null,
  log = () => {},
  onStage = () => {},
}) {
  const { releases } = releasePaths(root);
  fs.mkdirSync(releases, { recursive: true });
  const destination = path.join(releases, commit);
  const live = currentReleaseDir(root);
  const liveMetadata = live ? readReleaseMetadata(live) : null;

  onStage("building");
  if (fs.existsSync(destination)) {
    log(`removing a partial release at ${destination}`);
    fs.rmSync(destination, { recursive: true, force: true });
  }
  log(`exporting ${commit} from ${repo}`);
  exportCommit({ repo, commit, destination, run });

  const modules = path.join(destination, "node_modules");
  const reusable = live ? path.join(live, "node_modules") : null;
  const changed = dependenciesChanged({ repo, from: liveMetadata && liveMetadata.commit, to: commit, run });
  let mustInstall = true;
  if (!changed && reusable && fs.existsSync(reusable) && copyDependencies(reusable, modules, run)) {
    log("dependencies unchanged; linked the running release's node_modules");
    mustInstall = false;
  }
  const execute = runLong || (async (command, args, options) => run(command, args, options));
  if (mustInstall) {
    log(changed ? "dependencies changed; installing" : "no node_modules to reuse; installing");
    await execute(npmCommand(), ["ci", "--no-audit", "--no-fund"], {
      cwd: destination, env: gitEnvironment(), timeout: 20 * 60 * 1000,
    });
  }
  log("building");
  await execute(npmCommand(), ["run", "build"], {
    cwd: destination, env: gitEnvironment(), timeout: 20 * 60 * 1000,
  });
  if (!fs.existsSync(path.join(destination, ".next", "BUILD_ID"))) {
    throw new Error("the build finished without producing .next/BUILD_ID");
  }
  writeReleaseMetadata(destination, {
    commit,
    repo,
    remote,
    branch,
    version: packageVersion(destination),
    createdAt: new Date().toISOString(),
    previousCommit: liveMetadata ? liveMetadata.commit : null,
  });
  return destination;
}

function replaceSymlink(linkPath, target) {
  const temporary = `${linkPath}.tmp-${process.pid}`;
  try { fs.rmSync(temporary, { force: true, recursive: true }); } catch { /* nothing to clear */ }
  fs.symlinkSync(target, temporary, "junction");
  fs.renameSync(temporary, linkPath);
}

/** The downtime window is this function plus a service restart: two symlink
 * swaps, each one rename. */
function activateRelease({ root = resolveReleaseRoot(), releaseDir }) {
  const { current, previous } = releasePaths(root);
  const live = currentReleaseDir(root);
  if (live && live !== releaseDir) replaceSymlink(previous, live);
  replaceSymlink(current, releaseDir);
  return { activated: releaseDir, previous: live };
}

/** Roll back to `previous`. No git operation, no build: a symlink flip. */
function rollbackRelease({ root = resolveReleaseRoot() }) {
  const { previous } = releasePaths(root);
  let target;
  try {
    target = fs.realpathSync(previous);
  } catch {
    throw new Error("there is no previous release to roll back to");
  }
  if (!fs.existsSync(path.join(target, ".next", "BUILD_ID"))) {
    throw new Error(`the previous release at ${target} has no build to serve`);
  }
  return activateRelease({ root, releaseDir: target });
}

/**
 * Retain the newest `keep` releases. What `current` and `previous` point at is
 * always retained on top of that — rollback must not depend on how the count
 * happened to fall.
 */
function pruneReleases({ root = resolveReleaseRoot(), keep = DEFAULT_KEEP, log = () => {} }) {
  const { previous } = releasePaths(root);
  let previousDir = null;
  try { previousDir = fs.realpathSync(previous); } catch { /* no previous yet */ }
  const retained = new Set([currentReleaseDir(root), previousDir].filter(Boolean));
  const all = listReleases(root);
  for (const release of all) {
    if (retained.size >= keep) break;
    retained.add(release.dir);
  }
  const removed = [];
  for (const release of all) {
    if (retained.has(release.dir)) continue;
    try {
      fs.rmSync(release.dir, { recursive: true, force: true });
      removed.push(release.dir);
    } catch (error) {
      log(`could not remove ${release.dir}: ${error.message}`);
    }
  }
  return removed;
}

function npmCommand() {
  const sibling = path.join(path.dirname(process.execPath), "npm");
  return fs.existsSync(sibling) ? sibling : "npm";
}

/**
 * The remote and branch a deploy should record and track. An explicit choice
 * wins; otherwise the current release's own tracking is inherited so a plain
 * `ompweb-deploy` keeps following whatever the last deploy followed; only a
 * first-ever deploy falls back to origin/main.
 */
function resolveTracking({ remote, branch, metadata } = {}) {
  return {
    remote: remote || (metadata && metadata.remote) || "origin",
    branch: branch || (metadata && metadata.branch) || "main",
  };
}

/**
 * Retarget which ref a release follows, without a rebuild. Writes the current
 * release's own metadata (the sanctioned alternative to hand-editing it), so
 * the next update check and the next inheriting deploy both see the change.
 */
function setReleaseTracking({ root = resolveReleaseRoot(), releaseDir, remote, branch } = {}) {
  const dir = releaseDir || currentReleaseDir(root);
  if (!dir) throw new Error("no release is active");
  const metadata = readReleaseMetadata(dir);
  if (!metadata) throw new Error(`${dir} is not a release`);
  if (remote === undefined && branch === undefined) throw new Error("nothing to change");
  const next = { ...metadata };
  if (remote !== undefined) next.remote = remote;
  if (branch !== undefined) next.branch = branch;
  writeReleaseMetadata(dir, next);
  return { releaseDir: dir, remote: next.remote, branch: next.branch };
}

/** Resolve what should be deployed: the tip of the tracked ref after a fetch. */
function resolveTarget({ repo, remote = "origin", branch = "main", ref = null, fetch = true, run = defaultRun }) {
  if (fetch) run("git", ["-C", repo, "fetch", "--quiet", remote, branch], { env: gitEnvironment(), timeout: 5 * 60 * 1000 });
  const wanted = ref || `${remote}/${branch}`;
  const commit = run("git", ["-C", repo, "rev-parse", "--verify", `${wanted}^{commit}`], { env: gitEnvironment() }).stdout.trim();
  return { commit, ref: wanted };
}

module.exports = {
  DEFAULT_KEEP,
  METADATA_FILE,
  activateRelease,
  buildRelease,
  currentReleaseDir,
  dependenciesChanged,
  exportCommit,
  gitEnvironment,
  listReleases,
  npmCommand,
  pruneReleases,
  readReleaseMetadata,
  releasePaths,
  resolveReleaseRoot,
  resolveTarget,
  resolveTracking,
  rollbackRelease,
  setReleaseTracking,
  writeReleaseMetadata,
};
