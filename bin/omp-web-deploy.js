#!/usr/bin/env node
"use strict";
// `ompweb-deploy` — the only way ompweb is deployed.
//
// The web interface's update button runs the same steps through
// bin/omp-web-update-worker.js; both call into bin/omp-web-release.js, so a
// deploy is one implementation with two triggers and cannot drift.
//
// Nothing here writes to the repository: a commit is exported with
// `git archive` into its own release directory, built there, and a symlink is
// flipped. The service is down only for the flip and its own restart.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("./omp-web-release");

const USAGE = `Usage: ompweb-deploy [options]

  (no options)        build the tracked ref and activate it
  --ref <ref>         deploy this ref or commit instead of the tracked one
  --repo <path>       source repository (required for the first deploy)
  --remote <name>     remote to fetch (default: origin, or the live release's)
  --branch <name>     branch to track (default: the live release's, else main)
  --rollback          activate the previous release; no build, no git
  --list              list releases, newest first
  --status            show what is deployed
  --unit <name>       systemd user unit to restart (default: $OMP_WEB_SERVICE
                      or ompweb.service; "none" to skip the restart)
  --keep <n>          releases to retain when pruning (default: ${store.DEFAULT_KEEP})
  --no-fetch          do not fetch before resolving the ref
  --help
`;

function parseArgs(argv) {
  const options = { keep: store.DEFAULT_KEEP, fetch: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--ref": options.ref = value(); break;
      case "--repo": options.repo = path.resolve(value()); break;
      case "--remote": options.remote = value(); break;
      case "--branch": options.branch = value(); break;
      case "--unit": options.unit = value(); break;
      case "--keep": options.keep = Number(value()); break;
      case "--rollback": options.rollback = true; break;
      case "--list": options.list = true; break;
      case "--status": options.status = true; break;
      case "--no-fetch": options.fetch = false; break;
      case "--help": case "-h": options.help = true; break;
      default: fail(`unknown option ${arg}`);
    }
  }
  if (!Number.isInteger(options.keep) || options.keep < 1) fail("--keep must be a positive integer");
  return options;
}

function fail(message) {
  process.stderr.write(`ompweb-deploy: ${message}\n`);
  process.exit(1);
}
function log(message) {
  process.stdout.write(`${message}\n`);
}

function serviceUnit(options) {
  const unit = options.unit || process.env.OMP_WEB_SERVICE || "ompweb.service";
  return unit === "none" ? null : unit;
}

function systemctl(unit, action) {
  const result = cp.spawnSync("systemctl", ["--user", action, unit], { encoding: "utf8", windowsHide: true, timeout: 180_000 });
  return { ok: result.status === 0, output: (result.stderr || result.stdout || "").trim() };
}

/** Where the deployed tree came from. The first deploy has to be told. */
function resolveSource(root, options) {
  const live = store.currentReleaseDir(root);
  const metadata = live ? store.readReleaseMetadata(live) : null;
  const repo = options.repo || (metadata && metadata.repo) || process.env.OMP_WEB_SOURCE_REPO;
  if (!repo) fail("no source repository known yet; pass --repo <path> for the first deploy");
  if (!fs.existsSync(repo)) fail(`source repository not found: ${repo}`);
  return {
    repo,
    remote: options.remote || (metadata && metadata.remote) || "origin",
    branch: options.branch || (metadata && metadata.branch) || "main",
    metadata,
  };
}

function describe(release) {
  const meta = release.metadata || {};
  const marker = release.active ? "*" : " ";
  const version = meta.version ? `v${meta.version}` : "?";
  return `${marker} ${release.name.slice(0, 12).padEnd(12)}  ${version.padEnd(10)}  ${meta.createdAt || release.createdAt || "?"}`;
}

function restart(options) {
  const unit = serviceUnit(options);
  if (!unit) {
    log("skipping the restart (--unit none); restart the service yourself");
    return;
  }
  log(`restarting ${unit}`);
  const result = systemctl(unit, "restart");
  if (!result.ok) fail(`could not restart ${unit}: ${result.output}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const root = store.resolveReleaseRoot();

  if (options.list || options.status) {
    const releases = store.listReleases(root);
    if (!releases.length) {
      log(`no releases in ${root}`);
      return;
    }
    if (options.status) {
      const live = store.currentReleaseDir(root);
      const metadata = live ? store.readReleaseMetadata(live) : null;
      log(`root     ${root}`);
      log(`current  ${live || "(none)"}`);
      if (metadata) {
        log(`commit   ${metadata.commit}`);
        log(`version  ${metadata.version ? `v${metadata.version}` : "?"}`);
        log(`tracks   ${metadata.remote}/${metadata.branch} in ${metadata.repo}`);
        log(`built    ${metadata.createdAt}`);
      }
      return;
    }
    releases.forEach((release) => log(describe(release)));
    return;
  }

  if (options.rollback) {
    const result = store.rollbackRelease({ root });
    log(`rolled back to ${result.activated}`);
    restart(options);
    return;
  }

  const source = resolveSource(root, options);
  const target = store.resolveTarget({
    repo: source.repo,
    remote: source.remote,
    branch: source.branch,
    ref: options.ref,
    fetch: options.fetch,
  });
  if (source.metadata && source.metadata.commit === target.commit) {
    log(`already deployed: ${target.commit} (${target.ref})`);
    return;
  }
  log(`deploying ${target.commit} (${target.ref})`);
  const releaseDir = await store.buildRelease({
    repo: source.repo,
    commit: target.commit,
    remote: source.remote,
    branch: source.branch,
    root,
    log,
  });
  const result = store.activateRelease({ root, releaseDir });
  log(`activated ${result.activated}`);
  if (result.previous) log(`previous  ${result.previous}`);
  restart(options);
  const removed = store.pruneReleases({ root, keep: options.keep, log });
  removed.forEach((dir) => log(`pruned ${dir}`));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
