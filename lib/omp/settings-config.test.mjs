import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// A single local host: settings-config resolves paths through the host registry.
process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { getCachedNativeSettings, readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

async function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uses config.yaml when the canonical config.yml is absent", async () => {
  await withAgentDir(async (dir) => {
    const fallback = join(dir, "config.yaml");
    writeFileSync(fallback, "compaction:\n  strategy: context-full\n", "utf8");
    assert.equal((await readNativeSettings()).path, fallback);
    assert.equal((await readNativeSettings()).settings.compaction.strategy, "context-full");

    await writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(existsSync(join(dir, "config.yml")), false);
    assert.match(readFileSync(fallback, "utf8"), /hideThinkingBlock: true/);
  });
});

test("rejects malformed native settings and accepts OMP compaction strategies", async () => {
  await withAgentDir(async () => {
    await assert.rejects(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    await assert.rejects(() => writeNativeSettings({ compaction: { strategy: "prune" } }), /Invalid compaction strategy/);
    await writeNativeSettings({ compaction: { strategy: "shake", autoContinue: true } });
    assert.equal((await readNativeSettings()).settings.compaction.strategy, "shake");
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", async () => {
  await withAgentDir(async () => {
    await assert.rejects(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    await writeNativeSettings({ externalThinking: true });
    assert.equal((await readNativeSettings()).settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    await writeNativeSettings({ hideThinkingBlock: true });
    assert.equal((await readNativeSettings()).settings.externalThinking, true);
    assert.equal((await readNativeSettings()).settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", async () => {
  await withAgentDir(async () => {
    await writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = (await readNativeSettings()).settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    await assert.rejects(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", async () => {
  await withAgentDir(async () => {
    await writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = (await readNativeSettings()).settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    await assert.rejects(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    await assert.rejects(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});

test("the synchronous settings cache reflects the last read/write for the host", async () => {
  await withAgentDir(async () => {
    // A write updates the cache immediately, so rpc-manager's synchronous
    // auto-approve check sees the new policy without waiting for a re-read.
    await writeNativeSettings({ tools: { approval: { extension: "allow" } } });
    assert.equal(getCachedNativeSettings().settings.tools?.approval?.extension, "allow");
    await writeNativeSettings({ tools: { approval: { extension: "prompt" } } });
    assert.equal(getCachedNativeSettings().settings.tools?.approval?.extension, "prompt");
  });
});
