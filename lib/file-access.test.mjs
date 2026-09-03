process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./file-access.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isExistingFilePathAllowed, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(allowed, "public.txt"), "public");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(await isExistingPathWithinRoots(target, roots), false);
  assert.equal(await isExistingFilePathAllowed(target, roots), false);
  assert.equal(await isExistingFilePathAllowed(path.join(allowed, "public.txt"), roots), true);
  // A path that does not exist cannot be resolved, so it is not allowed.
  assert.equal(await isExistingFilePathAllowed(path.join(allowed, "missing.txt"), roots), false);
});

test("allowed roots are scoped per host", async () => {
  const { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } = await loadSubject();
  const { currentHost } = await jiti.import("./hosts/context.ts");
  const local = currentHost();
  const root = `/omp-web-file-access-${process.pid}`;
  const otherHost = { id: `other-${process.pid}` };

  allowFileRoot(root, otherHost);
  assert.equal(isFilePathAllowed(`${root}/file.txt`, await getAllowedFileRoots(otherHost)), true);
  assert.equal(isFilePathAllowed(`${root}/file.txt`, await getAllowedFileRoots(local)), false);

  allowFileRoot(root);
  assert.equal(isFilePathAllowed(`${root}/file.txt`, await getAllowedFileRoots(local)), true);
});
