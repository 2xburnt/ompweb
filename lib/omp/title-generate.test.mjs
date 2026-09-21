import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildTitlePrompt, parseGeneratedTitle } = await jiti.import("./title-generate.ts");

test("takes the answer from the last line of print-mode output", () => {
  // omp --print writes progress chatter before the answer.
  assert.equal(parseGeneratedTitle("Working...\nFix slow session switching"), "Fix slow session switching");
  assert.equal(parseGeneratedTitle('  "Fix the SSE reconnect race"  '), "Fix the SSE reconnect race");
  assert.equal(parseGeneratedTitle("```\nRewrite the worktree resolver\n```"), "Rewrite the worktree resolver");
  assert.equal(parseGeneratedTitle("Title: Port session reader to Node"), "Port session reader to Node");
  assert.equal(parseGeneratedTitle("修复 SSE 重连问题"), "修复 SSE 重连问题");
});

test("rejects output with no usable title", () => {
  assert.equal(parseGeneratedTitle(""), null);
  assert.equal(parseGeneratedTitle("   \n\n  "), null);
  assert.equal(parseGeneratedTitle("---"), null);
});

test("truncates an over-long title by code points", () => {
  const generated = parseGeneratedTitle("x".repeat(200));
  assert.equal(Array.from(generated).length, 81);
  assert.ok(generated.endsWith("…"));
});

test("prompt keeps the opening goal and the latest exchange", () => {
  const messages = [
    { role: "user", text: "make the sidebar group worktrees" },
    ...Array.from({ length: 40 }, (_, index) => ({ role: "assistant", text: `step ${index}` })),
    { role: "user", text: "now fix the flicker" },
  ];
  const prompt = buildTitlePrompt(messages);
  assert.ok(prompt.includes("make the sidebar group worktrees"));
  assert.ok(prompt.includes("now fix the flicker"));
  assert.ok(!prompt.includes("step 5\n"));
});

test("prompt truncates individual messages and skips non-chat roles", () => {
  const prompt = buildTitlePrompt([
    { role: "toolResult", text: "should not appear" },
    { role: "user", text: `paste ${"y".repeat(5000)}` },
  ]);
  assert.ok(!prompt.includes("should not appear"));
  assert.ok(prompt.length < 2000);
});

test("prompt is null when there is nothing to summarize", () => {
  assert.equal(buildTitlePrompt([]), null);
  assert.equal(buildTitlePrompt([{ role: "user", text: "   " }]), null);
});
