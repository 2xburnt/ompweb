import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isNewerVersion, detectInstallMethod, parseGitRemoteUrl, gitUpdateCommand, isGitCheckout } = jiti("./npm-update.ts");
const { formatGitLogNotes, getUpdateRepo } = jiti("./github-release-notes.ts");

test("recognizes newer npm package versions", () => {
  assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
});

test("only treats a stable build as newer than the matching prerelease", () => {
  assert.equal(isNewerVersion("0.2.0", "0.2.0-beta.1"), true);
  assert.equal(isNewerVersion("0.2.0-beta.2", "0.2.0"), false);
  assert.equal(isNewerVersion("latest", "0.2.0"), false);
});

test("detectInstallMethod routes bun-global installs to bun", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\@kahme247\\ompweb"), "bun");
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\.bin\\omp-web.cmd"), "bun");
  // Mixed separators (Windows-style path on a POSIX host, e.g. CI) must classify identically.
  assert.equal(detectInstallMethod("C:/Users/khaled/node_modules/@kahme247/ompweb"), "bun");
});

test("detectInstallMethod falls back to npm for anything else", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\AppData\\Roaming\\npm\\node_modules\\@kahme247\\ompweb"), "npm");
  assert.equal(detectInstallMethod("C:\\Program Files\\nodejs\\node_modules\\@kahme247\\ompweb"), "npm");
  assert.equal(detectInstallMethod("D:\\OtherProjects\\omp-web"), "npm");
});

test("a git checkout is detected as the git install method", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-git-install-"));
  try {
    assert.equal(isGitCheckout(dir), false);
    assert.equal(detectInstallMethod(dir), "npm");
    mkdirSync(join(dir, ".git"));
    assert.equal(isGitCheckout(dir), true);
    assert.equal(detectInstallMethod(dir), "git");
    assert.equal(gitUpdateCommand(dir, "origin", "main"), `cd ${dir} && git pull --ff-only origin main && npm ci && npm run build`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git remote URLs of every common shape resolve to a browsable https URL", () => {
  assert.equal(parseGitRemoteUrl("https://github.com/2xburnt/ompweb.git"), "https://github.com/2xburnt/ompweb");
  assert.equal(parseGitRemoteUrl("git@github.com:2xburnt/ompweb.git"), "https://github.com/2xburnt/ompweb");
  assert.equal(parseGitRemoteUrl("ssh://git@github.com/2xburnt/ompweb"), "https://github.com/2xburnt/ompweb");
  assert.equal(parseGitRemoteUrl("git+https://github.com/2xburnt/ompweb.git"), "https://github.com/2xburnt/ompweb");
  assert.equal(parseGitRemoteUrl("/srv/git/ompweb.git"), null);
  assert.equal(parseGitRemoteUrl(""), null);
});

test("update notes render the pending commits and the repo comes from package.json", () => {
  const body = formatGitLogNotes("abc1234\tfeat: hosts\tGreg\ndef5678\tfix: ssh\tGreg\n", 5);
  assert.equal(body, "- `abc1234` feat: hosts (Greg)\n- `def5678` fix: ssh (Greg)\n- …and 3 more");
  assert.deepEqual(getUpdateRepo(), { owner: "2xburnt", repo: "ompweb" });
  process.env.OMP_WEB_UPDATE_REPO = "someone/else";
  try {
    assert.deepEqual(getUpdateRepo(), { owner: "someone", repo: "else" });
  } finally {
    delete process.env.OMP_WEB_UPDATE_REPO;
  }
});
