#!/usr/bin/env node
"use strict";
// Dependency-free CommonJS - copied outside pkgDir to survive Windows file-lock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

// "building" and "ready" precede the downtime window: a git checkout produces
// the new build while the current server keeps serving, and (unless the commit
// asked for --apply-mode auto) waits for the browser to confirm the restart.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STAGES = ["preparing", "building", "ready", "stopping", "installing", "restarting", "finalizing"];

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const attemptId = arg("--attempt");
const root = arg("--root");
const packageDir = arg("--package-dir");
const manager = arg("--manager");
const managerPath = arg("--manager-path");
const target = arg("--target");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const from = arg("--from");
const launcherPid = Number(arg("--launcher-pid"));
const serverPid = Number(arg("--server-pid"));
const kind = arg("--kind") || "app";
// "systemd": the server is a systemd user service (unit in --service-unit) and
// this worker runs in its own transient unit; stop/start go through systemctl.
const supervisor = arg("--supervisor") === "systemd" ? "systemd" : "none";
const serviceUnit = arg("--service-unit") || "";
const gitRemote = arg("--remote") || "origin";
const gitBranch = arg("--branch") || "main";
const applyMode = arg("--apply-mode") === "auto" ? "auto" : "ask";
let descriptor;
let managerPrefix;
try {
  descriptor = JSON.parse(arg("--descriptor") || "null");
  managerPrefix = JSON.parse(arg("--manager-prefix") || "[]");
} catch {
  descriptor = null;
  managerPrefix = [];
}

// How long a finished build waits for the browser to confirm the restart. The
// server keeps serving the whole time, so expiry costs nothing but the build.
const APPLY_WAIT_MS = Number(process.env.OMP_WEB_UPDATE_APPLY_WAIT_MS) > 0
  ? Number(process.env.OMP_WEB_UPDATE_APPLY_WAIT_MS)
  : 30 * 60 * 1000;
const LEASE_MS = 30 * 60 * 1000;
// The staging worktree is removed after every update, so nothing of ours is
// left registered in the repository. Set to "1" to keep it instead: its
// .next/cache survives and makes the next build incremental, at the cost of a
// build tree (and a `git worktree list` entry) that outlives the update.
const KEEP_BUILD_TREE = process.env.OMP_WEB_UPDATE_KEEP_BUILD_TREE === "1";

function leaseFile() { return path.join(root, "lease.json"); }
function statusFile() { return path.join(root, "status.json"); }
function markerFile(m) { return path.join(root, attemptId + "." + m); }
function abortFile() { return markerFile("abort.json"); }
function applyFile() { return markerFile("apply.json"); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
function updateStatus(patch) {
  const cur = readJson(statusFile()) || {};
  const next = { ...cur, ...patch };
  // atomic write via tmp+rename
  const dir = path.dirname(statusFile());
  const tmp = path.join(dir, ".status." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, statusFile());
}
/** The server drops a lease it believes expired, which would let a second
 * update start while this one is still building. Long steps renew it. */
function renewLease() {
  const lease = readJson(leaseFile());
  if (!lease || lease.attemptId !== attemptId) return;
  const expiresAt = Date.now() + LEASE_MS;
  if (typeof lease.expiresAt === "number" && lease.expiresAt - expiresAt > -60_000) return;
  try { atomicWrite(leaseFile(), { ...lease, expiresAt }); } catch {}
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function logFile() { return path.join(root, attemptId + ".install.log"); }
function appendLog(text) {
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${text}\n`, { mode: 0o600 }); } catch {}
}
function aborted() {
  try { return fs.existsSync(abortFile()); } catch { return false; }
}
class CancelledError extends Error {
  constructor() {
    super("The update was cancelled before the server was stopped");
    this.cancelled = true;
  }
}
function throwIfCancelled() {
  if (aborted()) throw new CancelledError();
}
function portOpen(port, host) {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net");
    const socket = net.connect({ port, host: host === "0.0.0.0" || !host ? "127.0.0.1" : host });
    const done = (open) => { try { socket.destroy(); } catch {} resolve(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}
async function waitForPort(open, timeoutMs) {
  const port = descriptor && descriptor.port;
  if (!port) { await sleep(2000); return true; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portOpen(port, descriptor.hostname)) === open) return true;
    await sleep(1000);
  }
  return false;
}
function run(cmd, args, options) {
  appendLog(`$ ${[cmd, ...args].join(" ")}`);
  const result = cp.spawnSync(cmd, args, { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.stdout) appendLog(result.stdout.trim().slice(-4000));
  if (result.stderr) appendLog(result.stderr.trim().slice(-4000));
  if (result.error) throw new Error(`${cmd} ${args[0] || ""} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}${tail ? `: ${tail}` : ""}`);
  }
  return result;
}
/** Long steps (install, build) run asynchronously so a cancel from the web
 * interface stops them instead of being noticed minutes later. */
function runLong(cmd, args, options) {
  return new Promise((resolve, reject) => {
    appendLog(`$ ${[cmd, ...args].join(" ")}`);
    const child = cp.spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    let err = "";
    const keep = (buffer, chunk) => (buffer + chunk).slice(-8000);
    child.stdout?.on("data", (chunk) => { out = keep(out, String(chunk)); });
    child.stderr?.on("data", (chunk) => { err = keep(err, String(chunk)); });
    let cancelled = false;
    const timer = setInterval(() => {
      renewLease();
      if (!aborted()) return;
      cancelled = true;
      clearInterval(timer);
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
    }, 1000);
    child.on("error", (error) => {
      clearInterval(timer);
      reject(new Error(`${cmd} ${args[0] || ""} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (out.trim()) appendLog(out.trim().slice(-4000));
      if (err.trim()) appendLog(err.trim().slice(-4000));
      if (cancelled) return reject(new CancelledError());
      if (code !== 0) {
        const tail = (err || out).trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        return reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}${tail ? `: ${tail}` : ""}`));
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}
function isLaunchdActive() {
  try {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist");
    return fs.existsSync(plist);
  } catch { return false; }
}
function isTrayActive() {
  try {
    const svc = path.join(os.homedir(), ".omp", "agent", "web-service.json");
    if (!fs.existsSync(svc)) return false;
    const data = readJson(svc);
    return Boolean(data && data.pid);
  } catch { return false; }
}

async function stopOriginalProcesses() {
  updateStatus({ stage: "stopping" });
  if (supervisor === "systemd") {
    appendLog(`stopping ${serviceUnit} via systemctl --user`);
    run("systemctl", ["--user", "stop", serviceUnit], { timeout: 120000 });
    await waitForPort(false, 60000);
    return { launchd: false, tray: false, systemd: true };
  }
  // Detect services
  const launchd = isLaunchdActive();
  const tray = isTrayActive();
  if (launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootout", `gui/${uid}/com.kahme247.ompweb`], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(500);
  }
  if (tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawnSync(process.execPath, [trayBin, "--stop"], { timeout: 15000, windowsHide: true });
      }
    } catch {}
    await sleep(500);
  }
  // Plain next: try to kill launcher/server pids with SIGTERM 5s -> SIGKILL
  if (!launchd && !tray) {
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await sleep(5000);
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    // waitForPort 90s simplified: sleep 1s (real impl would poll port)
    await sleep(1000);
  }
  return { launchd, tray };
}

// --- git checkouts: build first, restart second -----------------------------
//
// The checkout the server runs from is never modified until the new build is
// finished and released. The build happens in a sibling worktree detached at
// the target commit, so a failed or cancelled update leaves both the checkout
// and the running build exactly as they were.

function gitEnv() {
  return { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1" };
}
function git(args, cwd) {
  return run("git", args, { cwd: cwd || packageDir, timeout: 5 * 60 * 1000, env: gitEnv() }).stdout.trim();
}
function gitOk(args, cwd) {
  const result = cp.spawnSync("git", args, { cwd: cwd || packageDir, timeout: 60_000, encoding: "utf8", windowsHide: true, env: gitEnv() });
  return result.status === 0;
}
function npmBin() {
  const sibling = path.join(path.dirname(process.execPath), "npm");
  return fs.existsSync(sibling) ? sibling : "npm";
}
function sameDevice(a, b) {
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return false; }
}
/** Where the new build is produced. The cache directory keeps it out of the
 * checkout's parent (a git repository home holds task checkouts, not build
 * trees), but only while it is on the same filesystem — the swap relies on
 * rename() being atomic, which never crosses devices. */
function buildTreePath() {
  const resolved = path.resolve(packageDir);
  const name = `build-${path.basename(resolved)}`;
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheHome, "ompweb");
  try {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    if (sameDevice(cacheRoot, resolved)) return path.join(cacheRoot, name);
    appendLog(`${cacheRoot} is on another filesystem; building next to the checkout instead`);
  } catch (error) {
    appendLog(`${cacheRoot} is unusable (${error.message}); building next to the checkout instead`);
  }
  return path.join(path.dirname(resolved), `.ompweb-${name}`);
}
function removeBuildTree(stagingDir) {
  if (!stagingDir) return;
  try { gitOk(["worktree", "remove", "--force", stagingDir]); } catch {}
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  try { gitOk(["worktree", "prune"]); } catch {}
}
/** Point the staging worktree at `commit`, reusing an existing one so its
 * .next/cache (and node_modules) keep the next build incremental. */
function prepareBuildTree(commit) {
  const stagingDir = buildTreePath();
  const reusable = fs.existsSync(path.join(stagingDir, ".git"))
    && gitOk(["-C", stagingDir, "rev-parse", "--is-inside-work-tree"]);
  if (reusable) {
    // A leftover tree from an interrupted update may be dirty; it is ours.
    gitOk(["-C", stagingDir, "reset", "--hard", "--quiet"]);
    try {
      git(["checkout", "--detach", "--quiet", commit], stagingDir);
      return stagingDir;
    } catch (error) {
      appendLog(`reusing the staging worktree failed (${error.message}); recreating it`);
    }
  }
  removeBuildTree(stagingDir);
  git(["worktree", "add", "--detach", "--quiet", stagingDir, commit]);
  return stagingDir;
}
/** node_modules is shared with the live checkout unless the update changes a
 * dependency, in which case the staging tree installs its own copy and the two
 * are swapped during the restart. */
async function prepareBuildDependencies(stagingDir, headCommit, targetCommit) {
  const changed = git(["diff", "--name-only", headCommit, targetCommit, "--", "package.json", "package-lock.json"]);
  const modules = path.join(stagingDir, "node_modules");
  const live = path.join(packageDir, "node_modules");
  let linked = false;
  try { linked = fs.lstatSync(modules).isSymbolicLink(); } catch {}
  if (!changed) {
    if (!linked) {
      try { fs.rmSync(modules, { recursive: true, force: true }); } catch {}
      fs.symlinkSync(live, modules, "junction");
    }
    return false;
  }
  if (linked) fs.rmSync(modules);
  await runLong(npmBin(), ["ci", "--no-audit", "--no-fund"], { cwd: stagingDir, timeout: 20 * 60 * 1000, env: gitEnv() });
  return true;
}
async function stageGitBuild() {
  updateStatus({ stage: "building", installMethod: "git" });
  const remoteRef = `${gitRemote}/${gitBranch}`;
  await runLong("git", ["fetch", "--quiet", gitRemote, gitBranch], { cwd: packageDir, timeout: 5 * 60 * 1000, env: gitEnv() });
  throwIfCancelled();
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("the checkout has uncommitted changes; commit or stash them before updating");
  }
  const headCommit = git(["rev-parse", "HEAD"]);
  const targetCommit = git(["rev-parse", remoteRef]);
  if (headCommit === targetCommit) throw new Error(`the checkout is already at ${remoteRef}`);
  // Verified before anything is built so the fast-forward cannot be the step
  // that fails once the server is already down.
  if (!gitOk(["-C", packageDir, "merge-base", "--is-ancestor", headCommit, targetCommit])) {
    throw new Error(`${remoteRef} is not a fast-forward of the checked-out commit`);
  }
  const stagingDir = prepareBuildTree(targetCommit);
  const staged = { stagingDir, headCommit, targetCommit, ownDependencies: false };
  staged.ownDependencies = await prepareBuildDependencies(stagingDir, headCommit, targetCommit);
  throwIfCancelled();
  await runLong(npmBin(), ["run", "build"], { cwd: stagingDir, timeout: 20 * 60 * 1000, env: gitEnv() });
  if (!fs.existsSync(path.join(stagingDir, ".next", "BUILD_ID"))) {
    throw new Error("the build finished without producing .next/BUILD_ID");
  }
  updateStatus({ stagedCommit: targetCommit });
  return staged;
}
/** Wait for the browser to release the staged build. Returns false when the
 * attempt was cancelled or nobody confirmed in time — the server is untouched
 * either way. */
async function waitForApplyConfirmation() {
  const applyDeadline = Date.now() + APPLY_WAIT_MS;
  updateStatus({ stage: "ready", applyDeadline });
  while (Date.now() < applyDeadline) {
    if (aborted()) return false;
    if (fs.existsSync(applyFile())) return true;
    renewLease();
    await sleep(500);
  }
  appendLog("no confirmation arrived before the staged build expired");
  return false;
}
/** Re-checked immediately before the server is stopped: the build may have
 * taken minutes, and a commit or a stray edit in the checkout since then would
 * otherwise turn the fast-forward into the step that fails with the service
 * already down. */
function verifyStagedBuildStillApplies(staged) {
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("the checkout was modified while the update was building; nothing was changed");
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head === staged.targetCommit) throw new Error("the checkout already moved to the target commit");
  if (!gitOk(["-C", packageDir, "merge-base", "--is-ancestor", head, staged.targetCommit])) {
    throw new Error("the checkout moved while the update was building and can no longer fast-forward");
  }
  if (!fs.existsSync(path.join(staged.stagingDir, ".next", "BUILD_ID"))) {
    throw new Error("the staged build disappeared before it could be applied");
  }
}
function swapDirectory(stagingPath, livePath, backupPath) {
  let movedLive = false;
  if (fs.existsSync(livePath)) {
    fs.renameSync(livePath, backupPath);
    movedLive = true;
  }
  try {
    fs.renameSync(stagingPath, livePath);
  } catch (error) {
    if (movedLive) {
      try { fs.renameSync(backupPath, livePath); } catch {}
    }
    throw error;
  }
  return movedLive ? backupPath : null;
}
/** The downtime window: a fast-forward plus two renames. */
function applyStagedBuild(staged) {
  updateStatus({ stage: "installing" });
  const { stagingDir, targetCommit, ownDependencies } = staged;
  git(["merge", "--ff-only", targetCommit]);
  const suffix = attemptId.slice(0, 8);
  const discard = [];
  // The build cache is the reason the next update is fast; it stays behind in
  // the staging tree instead of moving into the live directory.
  const stagedNext = path.join(stagingDir, ".next");
  const keptCache = path.join(stagingDir, ".ompweb-build-cache");
  let cacheKept = false;
  if (KEEP_BUILD_TREE && fs.existsSync(path.join(stagedNext, "cache"))) {
    try {
      fs.rmSync(keptCache, { recursive: true, force: true });
      fs.renameSync(path.join(stagedNext, "cache"), keptCache);
      cacheKept = true;
    } catch (error) {
      appendLog(`keeping the build cache failed: ${error.message}`);
    }
  }
  const replaced = swapDirectory(stagedNext, path.join(packageDir, ".next"), path.join(packageDir, `.next.old-${suffix}`));
  if (replaced) discard.push(replaced);
  if (ownDependencies) {
    const liveModules = path.join(packageDir, "node_modules");
    const backup = path.join(packageDir, `node_modules.old-${suffix}`);
    try {
      const previous = swapDirectory(path.join(stagingDir, "node_modules"), liveModules, backup);
      if (previous) discard.push(previous);
      fs.symlinkSync(liveModules, path.join(stagingDir, "node_modules"), "junction");
    } catch (error) {
      // .next is already the new build; a stale node_modules would only differ
      // by the dependencies this update added, so surface it rather than
      // rolling back a half-applied swap.
      appendLog(`swapping node_modules failed: ${error.message}`);
      throw new Error(`the new dependencies could not be moved into place: ${error.message}`);
    }
  }
  if (cacheKept) {
    try {
      fs.mkdirSync(stagedNext, { recursive: true });
      fs.renameSync(keptCache, path.join(stagedNext, "cache"));
    } catch (error) {
      appendLog(`restoring the build cache failed: ${error.message}`);
    }
  }
  return discard;
}

async function runManagerGate() {
  updateStatus({ stage: "installing" });
  if (kind === "omp") {
    // Run omp update
    const bin = process.env.OMP_WEB_OMP_BIN || "omp";
    // Try resolve via packageDir/../?
    await new Promise((resolve) => {
      const child = cp.spawn(bin, ["update"], { timeout: 5 * 60 * 1000, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 5 * 60 * 1000 + 1000);
    });
    return;
  }
  // App update via npm/bun. A global install replaces the directory the server
  // runs from, so unlike the git path it cannot be staged in advance.
  const cmd = manager === "bun" ? (managerPath || "bun") : (managerPath || "npm");
  const args = manager === "bun" ? ["add", "-g", `@kahme247/ompweb@${target}`] : ["install", "-g", `@kahme247/ompweb@${target}`];
  if (Array.isArray(managerPrefix) && managerPrefix.length) args.unshift(...managerPrefix);
  let retries = 0;
  let lastResult;
  while (retries <= 1) {
    const result = cp.spawnSync(cmd, args, { timeout: 5 * 60 * 1000, windowsHide: true, env: process.env, shell: process.platform === "win32" });
    lastResult = result;
    const stderr = result.stderr ? result.stderr.toString() : "";
    const spawnError = result.error ? String(result.error.code || result.error.message || "") : "";
    const isBusy = (result.error && ["EBUSY", "EPERM"].includes(result.error.code || "")) || /EBUSY|EPERM/.test(stderr) || /EBUSY|EPERM/.test(spawnError);
    if (isBusy && retries === 0) {
      retries++;
      await sleep(2000);
      continue;
    }
    break;
  }
  if (lastResult && lastResult.status !== 0) {
    const stderr = lastResult.stderr ? lastResult.stderr.toString().trim().slice(0, 500) : "";
    const spawnErr = lastResult.error ? String(lastResult.error.message || lastResult.error.code || "").slice(0, 200) : "";
    const detail = stderr || spawnErr;
    throw new Error(`package install failed (exit ${lastResult.status})${detail ? `: ${detail}` : ""}`);
  }
}

async function restartServices(info) {
  updateStatus({ stage: "restarting" });
  if (info.systemd) {
    appendLog(`starting ${serviceUnit} via systemctl --user`);
    run("systemctl", ["--user", "start", serviceUnit], { timeout: 120000 });
    const up = await waitForPort(true, 180000);
    if (!up) throw new Error(`${serviceUnit} did not start listening within 3 minutes`);
    return;
  }
  if (info.launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist")], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(1000);
    return;
  }
  if (info.tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawn(process.execPath, [trayBin, "--start"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      }
    } catch {}
    await sleep(1000);
    return;
  }
  // Plain next: ask launcher to restart via armed marker handshake
  try {
    const restartRequest = path.join(root, attemptId + ".restart-request.json");
    const restartAck = path.join(root, attemptId + ".restart-ack.json");
    atomicWrite(restartRequest, { attemptId, port: descriptor && descriptor.port, hostname: descriptor && descriptor.hostname, requestedAt: new Date().toISOString() });
    // Wait up to 30s for ack
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(restartAck)) break;
      await sleep(1000);
    }
  } catch {}
}

/** Directories replaced by the swap, deleted after the server is back up. */
function discardReplaced(paths) {
  for (const target of paths) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (error) { appendLog(`could not remove ${target}: ${error.message}`); }
  }
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId || "") || !root || !packageDir || !target) {
    process.exit(1);
  }
  // Check abort
  if (fs.existsSync(abortFile())) {
    updateStatus({ state: "cancelled", error: (readJson(abortFile()) || {}).reason || "aborted", finishedAt: new Date().toISOString(), cleanupReady: true });
    process.exit(0);
  }
  // Check go marker exists (commit signal)
  if (!fs.existsSync(markerFile("go"))) {
    // wait briefly for go
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(markerFile("go"))) break;
      await sleep(200);
    }
  }
  // Record the real worker pid: under systemd-run the pid the server saw was
  // the short-lived systemd-run client, not this process.
  updateStatus({ state: "running", stage: "preparing", startedAt: new Date().toISOString(), workerPid: process.pid });
  await sleep(1000); // PREPARING_MIN 1s

  let svcInfo = { launchd: false, tray: false, systemd: false };
  let staged = null;
  try {
    if (kind !== "omp" && manager === "git") {
      staged = await stageGitBuild();
      if (applyMode !== "auto" && !await waitForApplyConfirmation()) throw new CancelledError();
      throwIfCancelled();
      verifyStagedBuildStillApplies(staged);
    }
    if (kind !== "omp") svcInfo = await stopOriginalProcesses();
    let replaced = [];
    if (staged) {
      replaced = applyStagedBuild(staged);
    } else {
      await runManagerGate();
    }
    try {
      const pkgPath = path.join(packageDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        if (pkg && pkg.version !== target) {
          // version mismatch not fatal but record
        }
      }
    } catch {}
    if (kind !== "omp") await restartServices(svcInfo);
    discardReplaced(replaced);
    if (staged && !KEEP_BUILD_TREE) removeBuildTree(staged.stagingDir);
    await sleep(500);
    updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
    // write complete marker
    try { atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() }); } catch {}
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(`${e && e.cancelled ? "CANCELLED" : "FAILED"}: ${msg}`);
    if (staged && !KEEP_BUILD_TREE) removeBuildTree(staged.stagingDir);
    updateStatus({
      state: e && e.cancelled ? "cancelled" : "failed",
      error: msg.slice(0, 240),
      finishedAt: new Date().toISOString(),
      cleanupReady: true,
    });
    // Under systemd the service was stopped before the failed step; bring the
    // previous build back so a failed update never leaves the UI down.
    if (svcInfo.systemd) {
      try { run("systemctl", ["--user", "start", serviceUnit], { timeout: 120000 }); } catch {}
    }
  }
}

main().catch((e) => {
  try { updateStatus({ state: "failed", error: String(e).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }); } catch {}
  process.exit(1);
});
