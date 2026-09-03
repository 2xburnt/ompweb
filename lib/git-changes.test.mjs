process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "safe.directory=*", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("reads status and diffs through the host executor", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }
  const { getGitStatus, getGitFileDiff } = await jiti.import("./git-changes.ts");
  const root = mkdtempSync(join(tmpdir(), "omp-web-git-changes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(root, ["init", "-q", repo]);
  git(repo, ["config", "user.email", "omp-web@example.invalid"]);
  git(repo, ["config", "user.name", "omp-web test"]);
  writeFileSync(join(repo, "src", "tracked.ts"), "line one\nline two\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);

  // Non-git directories report cleanly rather than throwing.
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.deepEqual(await getGitStatus(plain), { isGitRepository: false, repositoryRoot: null, files: [] });
  assert.deepEqual(await getGitFileDiff(plain, join(plain, "x.txt")), { supported: false });

  writeFileSync(join(repo, "src", "tracked.ts"), "line one\nline two changed\n");
  writeFileSync(join(repo, "src", "fresh.ts"), "new file\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));

  const status = await getGitStatus(repo);
  assert.equal(status.isGitRepository, true);
  const byPath = new Map(status.files.map((file) => [file.filePath, file.status]));
  assert.equal(byPath.get(join(status.repositoryRoot, "src", "tracked.ts")), "modified");
  assert.equal(byPath.get(join(status.repositoryRoot, "src", "fresh.ts")), "untracked");
  // Scoping to a subdirectory drops files outside it.
  const scoped = await getGitStatus(join(repo, "src"));
  assert.ok(scoped.files.every((file) => file.filePath.includes(`${join("src")}`)));
  assert.ok(!scoped.files.some((file) => file.filePath.endsWith("binary.bin")));

  const modified = await getGitFileDiff(repo, join(repo, "src", "tracked.ts"));
  assert.equal(modified.supported, true);
  assert.equal(modified.status, "modified");
  assert.match(modified.patch, /-line two\n\+line two changed/);

  const untracked = await getGitFileDiff(repo, join(repo, "src", "fresh.ts"));
  assert.equal(untracked.supported, true);
  assert.equal(untracked.status, "untracked");
  assert.match(untracked.patch, /\+\+\+ b\/src\/fresh\.ts/);

  // Binary content and files outside the repository are unsupported.
  assert.deepEqual(await getGitFileDiff(repo, join(repo, "binary.bin")), { supported: false });
  assert.deepEqual(await getGitFileDiff(repo, join(root, "outside.txt")), { supported: false });
});
