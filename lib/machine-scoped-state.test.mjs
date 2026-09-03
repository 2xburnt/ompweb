import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { composerModelsStorageKey } = await jiti.import("./composer-prefs.ts");

// State that describes ONE machine's omp installation must never be shared
// between machines. These are the leaks that shipped once already: the
// composer read the default machine's model registry, and drafts for a new
// session were keyed by directory alone.

test("the composer's pinned model set is stored per machine", () => {
  assert.equal(composerModelsStorageKey("hetz"), "omp-composer-models:hetz");
  assert.equal(composerModelsStorageKey("local"), "omp-composer-models:local");
  assert.notEqual(composerModelsStorageKey("hetz"), composerModelsStorageKey("local"));
  // No machine known yet: fall back to the legacy single-machine key rather
  // than inventing one, so a single-machine install keeps its preferences.
  assert.equal(composerModelsStorageKey(null), "omp-composer-models");
  assert.equal(composerModelsStorageKey(undefined), "omp-composer-models");
});

test("the composer reads the model registry from the session's machine, not the default one", async () => {
  const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  // An existing session's machine wins; a new session uses the selected one.
  assert.match(hook, /const modelHostId = session\?\.host \?\? selectedHostId/);
  // The models load must be pinned to that machine...
  assert.match(hook, /await hostFetch\(modelsUrl, [\s\S]{0,80}?, modelHostId\);/);
  // ...and re-run when it changes.
  assert.match(hook, /\}, \[isNew, modelHostId, newSessionCwd, session\?\.cwd\]\)/);
  // A bare fetch here silently served the DEFAULT machine's models.
  assert.doesNotMatch(hook, /[^t]fetch\(modelsUrl/);
});

test("new-session drafts are scoped to the machine as well as the directory", async () => {
  const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  // The same path exists on several machines; the directory alone is not a key.
  assert.match(chatWindow, /draftKey=\{session\?\.id \?\? \(newSessionCwd \? `new:\$\{modelHostId \?\? "\?"\}:\$\{newSessionCwd\}` : undefined\)\}/);
  // No key may be built from the directory alone, including the paging key.
  assert.doesNotMatch(chatWindow, /`new:\$\{newSessionCwd\}`/);
  assert.match(chatWindow, /sessionKeyForPaging = session\?\.id \?\? \(newSessionCwd \? `new:\$\{modelHostId \?\? "\?"\}:\$\{newSessionCwd\}`/);
});

test("server-side per-machine caches key on the host id", async () => {
  const models = await readFile(new URL("./models-cache.ts", import.meta.url), "utf8");
  const usage = await readFile(new URL("./usage-service.ts", import.meta.url), "utf8");
  const fileAccess = await readFile(new URL("./file-access.ts", import.meta.url), "utf8");
  assert.match(models, /function cacheKey\(hostId: string, cwd: string\)/);
  assert.match(usage, /usageCacheKey\(host, filePath\)/);
  // Allowed file roots are per machine: the same path on another machine is
  // a different directory and must not inherit authorization.
  assert.match(fileAccess, /__piAllowedRootsCache: Map<string,/);
});

test("an open file tab is identified by machine AND path", async () => {
  const appShell = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const tabBar = await readFile(new URL("../components/TabBar.tsx", import.meta.url), "utf8");
  // The same path on another machine is a different file: it gets its own tab.
  assert.match(appShell, /const tabId = `file:\$\{tabHostId \?\? "\?"\}:\$\{filePath\}`/);
  assert.doesNotMatch(appShell, /const tabId = `file:\$\{filePath\}`/);
  // Explorer files belong to the browsed machine; linked files to the session's.
  assert.match(appShell, /handleOpenFile\(filePath, fileName, null, hostId\)/);
  assert.match(appShell, /selectedSession\?\.host \?\? hostId/);
  assert.match(tabBar, /hostId\?: string \| null;/);
});

test("the file viewer reads from the tab's machine, not the selected one", async () => {
  const viewer = await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8");
  // Every file request carries the tab's machine.
  assert.match(viewer, /withHostParam\(`\/api\/files\/\$\{encoded\}\?\$\{searchParams\.toString\(\)\}`, hostId \?\? undefined\)/);
  assert.match(viewer, /hostFetch\(`\/api\/git\/diff\?\$\{params\.toString\(\)\}`, undefined, hostId \?\? undefined\)/);
  // An unpinned call would silently read the selected machine's file instead.
  assert.doesNotMatch(viewer, /getFileApiUrl\(filePath, "(read|watch|meta|download|preview)", sourceSessionId\)/);
});

test("composer file and skill lookups follow the conversation's machine", async () => {
  const input = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  for (const route of ["/api/skills", "/api/file-index"]) {
    const needle = "hostFetch(`" + route;
    let index = input.indexOf(needle);
    assert.ok(index !== -1, `no ${route} call found`);
    let seen = 0;
    while (index !== -1) {
      seen += 1;
      // The machine argument follows within the same call expression; an
      // unpinned call would silently query the selected machine instead.
      const call = input.slice(index, index + 220);
      assert.match(call, /modelHostId \?\? undefined/, `${route} call is not pinned: ${call.split("\n")[0]}`);
      index = input.indexOf(needle, index + 1);
    }
    assert.ok(seen > 0);
  }
});

test("a machine switch never queries the new machine with the old machine's directory", async () => {
  const sidebar = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
  // Clearing the directory on switch only schedules a re-render, so the
  // worktree loader in that same commit still holds the previous machine's
  // path. It must recognize the mismatch and skip.
  assert.match(sidebar, /const cwdHostRef = useRef<string \| null>\(null\);/);
  assert.match(sidebar, /cwdHostRef\.current = hostId;/);
  assert.match(sidebar, /if \(cwdHostRef\.current !== hostId\) return;/);
  // The recorded machine goes stale on purpose: keyed on the directory only.
  assert.match(sidebar, /\}, \[selectedCwd\]\);/);
});
