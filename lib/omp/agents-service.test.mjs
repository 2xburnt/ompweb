import assert from "node:assert/strict";
import { link, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeRemoteHost } from "./test-helpers.mjs";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { deleteAgent, parseAgentFrontmatter, readAgentFile, writeAgent } = await jiti.import("./agents-service.ts");

const payload = { description: "A test agent", body: "Do the task." };

test("renaming an agent is case-sensitive on POSIX filesystems", async () => {
  // secureScopeDir rejects symlinked scope paths; macOS tmpdir is a
  // /var -> /private/var symlink, so resolve it first.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    await writeAgent(dir, "Scout", payload);
    await writeAgent(dir, "scout", payload, "Scout");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renaming onto a distinct hardlink of the same file is a collision, not a case alias", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    const { path: scoutPath } = await writeAgent(dir, "Scout", payload);
    // A hardlink shares the inode but is a separate directory entry — the
    // rename target genuinely exists and must be rejected.
    await link(scoutPath, join(dir, "Existing.md"));
    await assert.rejects(() => writeAgent(dir, "Existing", payload, "Scout"), /agent file already exists/);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["Existing.md", "Scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses agent frontmatter with an optional UTF-8 BOM", () => {
  const parsed = parseAgentFrontmatter("\uFEFF---\nname: scout\ndescription: Test\n---\nPrompt");
  assert.equal(parsed.frontmatter.name, "scout");
  assert.equal(parsed.body, "Prompt");
});

test("writes, renames, reads and deletes agents through the remote host path", { skip: process.platform === "win32" }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  const host = fakeRemoteHost();
  try {
    const { path: written } = await writeAgent(join(dir, "nested"), "Scout", { ...payload, model: "gpt-5, claude" }, undefined, host);
    assert.equal(written, join(dir, "nested", "Scout.md"));
    const info = await readAgentFile(written, host);
    assert.equal(info.name, "Scout");
    assert.deepEqual(info.model, ["gpt-5", "claude"]);
    assert.equal(info.body, "Do the task.");

    await writeAgent(join(dir, "nested"), "scout", payload, "Scout", host);
    const names = (await readdir(join(dir, "nested"))).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["scout.md"]);

    await assert.rejects(() => writeAgent(join(dir, "nested"), "scout", payload, undefined, host), /agent file already exists/);
    await deleteAgent(join(dir, "nested"), "scout", host);
    assert.deepEqual((await readdir(join(dir, "nested"))).filter((name) => name.endsWith(".md")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a symlinked scope directory on the remote host path", { skip: process.platform === "win32" }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    await symlink(join(dir, "real"), join(dir, "link"));
    await assert.rejects(() => writeAgent(join(dir, "link", "agents"), "x", payload, undefined, fakeRemoteHost()), /symbolic link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
