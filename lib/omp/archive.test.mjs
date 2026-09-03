process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listArchivedSessions, parseArchivePrefixBatch, restoreArchivedSession } = await jiti.import("./archive.ts");

function sessionBody(id = "archived-id") {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/workspace/project", timestamp: "2026-08-20T12:00:00.000Z", title: "Archived work" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-08-20T12:00:01.000Z", message: { role: "user", content: "Fix the archived issue" } }),
  ].join("\n") + "\n";
}

test("lists archive metadata and restores the session with artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-browser-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive", "sessions");
    const archiveFile = join(archive, "project", "2026_session.jsonl.gz");
    mkdirSync(join(archive, "project", "2026_session.jsonl"), { recursive: true });
    mkdirSync(join(sessions, "project"), { recursive: true });
    writeFileSync(join(archive, "project", "2026_session.jsonl", "child.jsonl"), "child\n");
    writeFileSync(archiveFile, gzipSync(Buffer.from(sessionBody())));

    const listed = await listArchivedSessions(archive);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, "project/2026_session.jsonl.gz");
    assert.equal(listed[0].firstMessage, "Fix the archived issue");
    assert.equal(listed[0].messageCount, 1);

    const restoredId = await restoreArchivedSession(listed[0].key, sessions, archive);
    assert.equal(restoredId, "archived-id");
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), true);
    assert.equal(readFileSync(join(sessions, "project", "2026_session", "child.jsonl"), "utf8"), "child\n");
    assert.equal(existsSync(archiveFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal archive keys", async () => {
  await assert.rejects(
    () => restoreArchivedSession("../outside.jsonl.gz", "sessions", "archive"),
    /Invalid archive key/,
  );
  await assert.rejects(
    () => restoreArchivedSession("/abs/outside.jsonl.gz", "sessions", "archive"),
    /Invalid archive key/,
  );
});

test("lists only the bounded decompressed prefix of a large archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-large-"));
  try {
    const archive = join(root, "archive", "sessions");
    mkdirSync(join(archive, "project"), { recursive: true });
    // Header + first message land in the first KB; the rest is a long tail
    // that must never be inflated (128 KiB prefix cap).
    const tail = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ type: "message", id: `m${i}`, parentId: null, timestamp: "2026-08-20T12:00:02.000Z", message: { role: "assistant", content: `reply ${i} `.repeat(20) } }),
    ).join("\n");
    writeFileSync(join(archive, "project", "big.jsonl.gz"), gzipSync(Buffer.from(sessionBody("big-id") + tail + "\n")));

    const listed = await listArchivedSessions(archive);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "big-id");
    assert.equal(listed[0].firstMessage, "Fix the archived issue");
    assert.ok(listed[0].messageCount > 1);
    assert.ok(listed[0].messageCount < 4001);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses the remote batch decompression output into per-archive prefixes", () => {
  const sentinel = "--omp-web-archive-0123abcd--";
  const stdout = Buffer.concat([
    Buffer.from("F /home/u/.omp/agent/archive/sessions/p/one.jsonl.gz\n"),
    Buffer.from('{"type":"session","id":"one"}\n{"type":"message"}'),
    Buffer.from(`\n${sentinel}\n`),
    // An archive gzip could not read yields an empty body (still a frame).
    Buffer.from("F /home/u/.omp/agent/archive/sessions/p/broken.jsonl.gz\n"),
    Buffer.from(`\n${sentinel}\n`),
    // A body ending in its own newline keeps that newline (only ours is stripped).
    Buffer.from("F /home/u/.omp/agent/archive/sessions/p/two.jsonl.gz\n"),
    Buffer.from('{"type":"session","id":"two"}\n'),
    Buffer.from(`\n${sentinel}\n`),
    // A frame cut short (script killed mid-file) is dropped, not misattributed.
    Buffer.from("F /home/u/.omp/agent/archive/sessions/p/cut.jsonl.gz\n{\"type\":\"ses"),
  ]);
  const frames = parseArchivePrefixBatch(stdout, sentinel);
  assert.deepEqual([...frames.keys()], [
    "/home/u/.omp/agent/archive/sessions/p/one.jsonl.gz",
    "/home/u/.omp/agent/archive/sessions/p/broken.jsonl.gz",
    "/home/u/.omp/agent/archive/sessions/p/two.jsonl.gz",
  ]);
  assert.equal(frames.get("/home/u/.omp/agent/archive/sessions/p/one.jsonl.gz").toString(), '{"type":"session","id":"one"}\n{"type":"message"}');
  assert.equal(frames.get("/home/u/.omp/agent/archive/sessions/p/broken.jsonl.gz").length, 0);
  assert.equal(frames.get("/home/u/.omp/agent/archive/sessions/p/two.jsonl.gz").toString(), '{"type":"session","id":"two"}\n');
  assert.equal(parseArchivePrefixBatch(Buffer.alloc(0), sentinel).size, 0);
});
