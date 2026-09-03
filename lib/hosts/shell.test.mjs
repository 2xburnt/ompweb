import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shellJoin, shellQuote } = await jiti.import("./shell.ts");

test("shellQuote leaves safe words alone and single-quotes everything else", () => {
  assert.equal(shellQuote("git"), "git");
  assert.equal(shellQuote("/home/twice/.omp/agent"), "/home/twice/.omp/agent");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("$HOME"), "'$HOME'");
  assert.equal(shellJoin(["sh", "-c", "echo $x", "sh", "a'b"]), "sh -c 'echo $x' sh 'a'\\''b'");
});
