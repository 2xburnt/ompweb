process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./directory-browser.ts");
}

test("lists directories and directory symlinks without returning files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    try {
      await symlink(path.join(root, "project"), path.join(root, "linked-project"));
      // A symlink to a file and a dangling one must both be skipped.
      await symlink(path.join(root, "notes.txt"), path.join(root, "linked-notes"));
      await symlink(path.join(root, "missing"), path.join(root, "dangling"));
    } catch (error) {
      // Windows without Developer Mode/admin rights cannot create symlinks.
      if (error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
    assert.deepEqual(directories.map((entry) => entry.path), [path.join(root, "linked-project"), path.join(root, "project")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const { getBrowseStartDirectory, normalizeDirectory, resolveDirectory, shouldShowWindowsDrivePicker, getWindowsDriveCandidates } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  // Default platform comes from the current host (local here).
  assert.equal(shouldShowWindowsDrivePicker(undefined), process.platform === "win32");
  assert.deepEqual(getWindowsDriveCandidates().at(0), { name: "A:", path: "A:\\" });
  assert.deepEqual(getWindowsDriveCandidates().at(-1), { name: "Z:", path: "Z:\\" });
  assert.equal(normalizeDirectory("~"), homedir());
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `omp-web-missing-${Date.now()}`)));
});

test("resolves symlinked directories to their real path", async (t) => {
  const { resolveDirectory } = await loadSubject();
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-browse-real-"));
  try {
    await mkdir(path.join(root, "real"));
    try {
      await symlink(path.join(root, "real"), path.join(root, "alias"));
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }
    const { realpath } = await import("node:fs/promises");
    assert.equal(await resolveDirectory(path.join(root, "alias")), await realpath(path.join(root, "real")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});
