process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./file-dirent.ts");
}

test("uses host entry types for regular files and directories", async () => {
  const { resolveDirentIsDirectory } = await loadSubject();

  assert.equal(resolveDirentIsDirectory({ type: "file" }), false);
  assert.equal(resolveDirentIsDirectory({ type: "dir" }), true);
  // Sockets and fifos exist but are not browsable directories.
  assert.equal(resolveDirentIsDirectory({ type: "other" }), false);
});

test("follows symlink target types and drops dangling symlinks", async () => {
  const { resolveDirentIsDirectory } = await loadSubject();

  assert.equal(resolveDirentIsDirectory({ type: "symlink", targetType: "dir" }), true);
  assert.equal(resolveDirentIsDirectory({ type: "symlink", targetType: "file" }), false);
  assert.equal(resolveDirentIsDirectory({ type: "symlink", targetType: "other" }), false);
  assert.equal(resolveDirentIsDirectory({ type: "symlink" }), null);
});

test("agrees with the local host readdir for real symlinks", async (t) => {
  const { resolveDirentIsDirectory } = await loadSubject();
  const { LocalExecutor } = await jiti.import("./hosts/executor.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-dirent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "target"));
  fs.writeFileSync(path.join(root, "plain.txt"), "x");
  try {
    fs.symlinkSync("target", path.join(root, "directory-link"), "dir");
    fs.symlinkSync("missing", path.join(root, "dangling-link"), "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  const entries = await new LocalExecutor().fs.readdir(root);
  const byName = new Map(entries.map((entry) => [entry.name, resolveDirentIsDirectory(entry)]));
  assert.equal(byName.get("target"), true);
  assert.equal(byName.get("plain.txt"), false);
  assert.equal(byName.get("directory-link"), true);
  assert.equal(byName.get("dangling-link"), null);
});
