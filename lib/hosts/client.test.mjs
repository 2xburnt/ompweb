import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { worthAsking } = await jiti.import("./client.ts");

test("machines that answered are asked", () => {
  assert.equal(worthAsking({ status: "connected", lastError: null }), true);
  // Still connected, but carrying the error from an earlier blip: it is
  // answering now, which is the only thing that matters.
  assert.equal(worthAsking({ status: "connected", lastError: "an old failure" }), true);
});

test("machines not yet tried are asked", () => {
  // Skipping an unprobed machine would leave its projects missing with nothing
  // to explain why, so being unknown is not grounds for skipping.
  assert.equal(worthAsking({ status: "unknown", lastError: null }), true);
  assert.equal(worthAsking({ status: "connecting", lastError: null }), true);
});

test("machines known to be down are not asked", () => {
  assert.equal(worthAsking({ status: "error", lastError: "Permission denied (publickey)" }), false);
  assert.equal(worthAsking({ status: "error", lastError: null }), false);
  assert.equal(worthAsking({ status: "disabled", lastError: null }), true);
});

test("a machine that hangs is skipped while it is retrying", () => {
  // The case that made this necessary: a machine that hangs rather than
  // refusing reports "connecting" for its entire 30s probe. Going by status
  // alone, every page load in that window fires a request that can only end in
  // a timeout — and enough of those saturate the browser's connection pool.
  assert.equal(
    worthAsking({ status: "connecting", lastError: "sh exited with 255: twice@ubi: Permission denied (publickey)." }),
    false,
  );
});
