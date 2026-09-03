import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { fakeRemoteHost } from "./test-helpers.mjs";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { FileTooLargeError, existingPaths, readTextFile, scanTextFiles } = await jiti.import("./host-io.ts");
const { currentHost } = await jiti.import("../hosts/context.ts");

const posix = process.platform !== "win32";

function byPath(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).map(({ root, path: filePath, content, truncated }) => ({ root, path: filePath, content, truncated }));
}

test("scanTextFiles finds markdown agents identically on local and remote hosts", { skip: !posix }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omp-web-host-io-"));
  try {
    const root = path.join(dir, "agents");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "a.md"), "alpha");
    writeFileSync(path.join(root, "B.MD"), "bravo");
    writeFileSync(path.join(root, "my agent (v2).md"), "spaces & parens");
    writeFileSync(path.join(root, ".hidden.md"), "hidden");
    writeFileSync(path.join(root, "notes.txt"), "not markdown");
    writeFileSync(path.join(root, "sub", "deep.md"), "too deep");
    writeFileSync(path.join(root, "big.md"), "x".repeat(50));
    const linkRoot = path.join(dir, "linked");
    symlinkSync(root, linkRoot);
    const missing = path.join(dir, "missing");

    const expected = byPath([
      { root, path: path.join(root, "B.MD"), content: "bravo", truncated: false },
      { root, path: path.join(root, "a.md"), content: "alpha", truncated: false },
      { root, path: path.join(root, "big.md"), content: "x".repeat(20), truncated: true },
      { root, path: path.join(root, "my agent (v2).md"), content: "spaces & parens", truncated: false },
    ]);
    const local = await scanTextFiles(currentHost(), [root, linkRoot, missing], "markdown-files", 20);
    assert.deepEqual(byPath(local.files), expected);
    assert.deepEqual(local.symlinkRoots, [linkRoot]);
    assert.deepEqual(local.unreadableRoots, []);

    const remote = await scanTextFiles(fakeRemoteHost(), [root, linkRoot, missing], "markdown-files", 20);
    assert.deepEqual(byPath(remote.files), expected);
    assert.deepEqual(remote.symlinkRoots, [linkRoot]);
    assert.deepEqual(remote.unreadableRoots, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanTextFiles finds <root>/<entry>/SKILL.md identically on local and remote hosts", { skip: !posix }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omp-web-host-io-"));
  try {
    const root = path.join(dir, "skills");
    mkdirSync(path.join(root, "alpha"), { recursive: true });
    mkdirSync(path.join(root, "with space"), { recursive: true });
    mkdirSync(path.join(root, ".hidden"), { recursive: true });
    mkdirSync(path.join(root, "empty"), { recursive: true });
    writeFileSync(path.join(root, "alpha", "SKILL.md"), "alpha skill");
    writeFileSync(path.join(root, "with space", "SKILL.md"), "spaced skill");
    writeFileSync(path.join(root, ".hidden", "SKILL.md"), "hidden skill");
    writeFileSync(path.join(root, "stray.md"), "not a skill dir");
    const target = path.join(dir, "elsewhere");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "SKILL.md"), "linked skill");
    symlinkSync(target, path.join(root, "linked"));
    // A root that is itself a symlink is followed for skills (omp does too).
    const linkRoot = path.join(dir, "skills-link");
    symlinkSync(root, linkRoot);

    const expectedFor = (base) => [
      { root: base, path: path.join(base, "alpha", "SKILL.md"), content: "alpha skill", truncated: false },
      { root: base, path: path.join(base, "linked", "SKILL.md"), content: "linked skill", truncated: false },
      { root: base, path: path.join(base, "with space", "SKILL.md"), content: "spaced skill", truncated: false },
    ];
    const local = await scanTextFiles(currentHost(), [root, linkRoot], "skill-dirs", 1024);
    assert.deepEqual(byPath(local.files), byPath([...expectedFor(root), ...expectedFor(linkRoot)]));
    const remote = await scanTextFiles(fakeRemoteHost(), [root, linkRoot], "skill-dirs", 1024);
    assert.deepEqual(byPath(remote.files), byPath(local.files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existingPaths batches existence checks with odd file names", { skip: !posix }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omp-web-host-io-"));
  try {
    const present = path.join(dir, "it's here (1).json");
    writeFileSync(present, "{}");
    const dangling = path.join(dir, "dangling");
    symlinkSync(path.join(dir, "nowhere"), dangling);
    const missing = path.join(dir, "missing.json");
    for (const host of [currentHost(), fakeRemoteHost()]) {
      const found = await existingPaths(host, [present, missing, dangling, present]);
      assert.deepEqual([...found].sort(), [dangling, present].sort(), host.id);
    }
    assert.deepEqual([...await existingPaths(fakeRemoteHost(), [])], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTextFile reports missing files as null and refuses oversized ones", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omp-web-host-io-"));
  try {
    const file = path.join(dir, "config.yml");
    writeFileSync(file, "hello: world\n");
    assert.equal(await readTextFile(currentHost(), file, 1024), "hello: world\n");
    assert.equal(await readTextFile(currentHost(), path.join(dir, "nope.yml"), 1024), null);
    await assert.rejects(() => readTextFile(currentHost(), file, 4), (error) => error instanceof FileTooLargeError);
    if (posix) {
      assert.equal(await readTextFile(fakeRemoteHost(), file, 1024), "hello: world\n");
      assert.equal(await readTextFile(fakeRemoteHost(), path.join(dir, "nope.yml"), 1024), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
