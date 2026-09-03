import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, openSync, closeSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeRemoteHost } from "./test-helpers.mjs";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { deleteMcpServer, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, redactMcpServer, validateMcpServer, writeMcpServer } = await jiti.import("./mcp-config.ts");

const posix = process.platform !== "win32";

async function withWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-mcp-config-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writes, renames, and removes a native project MCP server", async () => {
  await withWorkspace(async (cwd) => {
    await writeMcpServer(cwd, "filesystem", { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] });
    let file = await readMcpConfig(cwd);
    assert.match(file.path.replace(/\\/g, "/"), /\.omp\/mcp\.json$/);
    assert.equal(file.config.mcpServers.filesystem.command, "npx");

    await writeMcpServer(cwd, "project-files", { type: "stdio", command: "npx", args: [] }, "filesystem");
    file = await readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers), ["project-files"]);

    await deleteMcpServer(cwd, "project-files");
    assert.deepEqual((await readMcpConfig(cwd)).config.mcpServers, {});
  });
});

test("redacts project MCP credentials and preserves them on edits and renames", async () => {
  await withWorkspace(async (cwd) => {
    await writeMcpServer(cwd, "private", { type: "stdio", command: "node", env: { API_KEY: "secret" }, headers: { Authorization: "Bearer secret" } });
    const stored = (await readMcpConfig(cwd)).config.mcpServers.private;
    assert.deepEqual(redactMcpServer(stored), { type: "stdio", command: "node" });
    await writeMcpServer(cwd, "private", { type: "stdio", command: "node", args: ["server.js"] });
    assert.deepEqual((await readMcpConfig(cwd)).config.mcpServers.private.env, { API_KEY: "secret" });
    assert.deepEqual((await readMcpConfig(cwd)).config.mcpServers.private.headers, { Authorization: "Bearer secret" });
    await writeMcpServer(cwd, "renamed", { type: "stdio", command: "node", args: ["renamed.js"] }, "private");
    const renamed = (await readMcpConfig(cwd)).config.mcpServers;
    assert.equal(renamed.private, undefined);
    assert.deepEqual(renamed.renamed.env, { API_KEY: "secret" });
    assert.deepEqual(renamed.renamed.headers, { Authorization: "Bearer secret" });
  });
});

test("rejects malformed MCP transports before writing", () => {
  assert.throws(() => validateMcpServer("bad server", { command: "npx" }), /Server name/);
  assert.throws(() => validateMcpServer("bad", { type: "http", command: "npx" }), /requires a URL/);
  assert.throws(() => validateMcpServer("bad", { command: "npx", url: "https://example.com/mcp" }), /exactly one/);
  assert.throws(() => validateMcpServer("bad", { type: "sse", url: "file:///tmp/mcp" }), /http or https/);
});

test("reads OMP user MCP servers and disabled entries", async () => {
  await withWorkspace(async (cwd) => {
    const userPath = join(cwd, "user-mcp.json");
    writeFileSync(userPath, JSON.stringify({
      mcpServers: { ida: { command: "python", args: ["server.py"] } },
      disabledServers: ["node_repl"],
    }));

    const config = await readUserMcpConfig(userPath);
    assert.deepEqual(config.servers.map(({ name }) => name), ["ida"]);
    assert.deepEqual(config.disabledServers, ["node_repl"]);
  });
});

test("parses every source and connection state from OMP's MCP list", () => {
  const servers = parseMcpListOutput(`\nConfigured MCP Servers\n\nUser level (~/.omp/agent/mcp.json):\n  ida ● connected [stdio]\n  frida ○ not connected [stdio]\n\nProject level (.omp/mcp.json):\n  docs ◌ connecting [http]\n\nClaude Code (~/.claude.json):\n  ida-reverse-engineering ● connected\n\nDisabled (discovered servers):\n  node_repl ◌ disabled\n`);
  assert.deepEqual(servers, [
    { name: "ida", source: "User level", status: "connected", type: "stdio" },
    { name: "frida", source: "User level", status: "not_connected", type: "stdio" },
    { name: "docs", source: "Project level", status: "connecting", type: "http" },
    { name: "ida-reverse-engineering", source: "Claude Code", status: "connected", type: undefined },
    { name: "node_repl", source: "Disabled", status: "disabled", type: undefined },
  ]);
});

test("parses rpc-ui's compact MCP list without claiming configured servers are connected", () => {
  assert.deepEqual(parseMcpListOutput("ida | stdio | enabled | python [user]\nfrida | stdio | disabled | frida serve [project]"), [
    { name: "ida", source: "User level", status: "configured", type: "stdio" },
    { name: "frida", source: "Project level", status: "disabled", type: "stdio" },
  ]);
});

test("serializes concurrent mutations through the config lock (no lost updates)", async () => {
  await withWorkspace(async (cwd) => {
    // Simulate two writers racing: each read-modify-write must re-read inside
    // the lock, so the second mutation preserves the first's server.
    await writeMcpServer(cwd, "alpha", { type: "stdio", command: "python", args: ["a.py"] });
    await writeMcpServer(cwd, "beta", { type: "stdio", command: "python", args: ["b.py"] });
    const file = await readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers).sort(), ["alpha", "beta"]);
    // Lock files must not leak after successful writes.
    assert.equal(existsSync(`${file.path}.lock`), false);
    assert.equal(existsSync(`${file.path}.tmp-${process.pid}-`), false);
  });
});

test("breaks a stale config lock from a crashed writer", async () => {
  await withWorkspace(async (cwd) => {
    const { path } = await readMcpConfig(cwd);
    const lockPath = `${path}.lock`;
    // A lock file left behind by a crashed process, aged past the stale window.
    mkdirSync(join(dirname(lockPath)), { recursive: true });
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    await writeMcpServer(cwd, "recovered", { type: "stdio", command: "python", args: ["r.py"] });
    const file = await readMcpConfig(cwd);
    assert.equal(file.config.mcpServers.recovered.command, "python");
    assert.equal(existsSync(lockPath), false);
  });
});

test("discovers provider configs on a remote host in one round trip", { skip: !posix }, async () => {
  await withWorkspace(async (dir) => {
    const home = join(dir, "home");
    const cwd = join(dir, "project");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(cwd, ".vscode"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "ida-re": { command: "ida" } } }));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cursor: { url: "https://example.com/mcp" }, skipped: { command: "x" } } }));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.codex-docs]\nurl = "https://example.com"\n\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n');
    writeFileSync(join(cwd, ".vscode", "mcp.json"), JSON.stringify({ mcpServers: { "vs code": { command: "code", enabled: false } } }));
    writeFileSync(join(cwd, "mcp.json"), "not json at all");

    const host = fakeRemoteHost({ home, agentDir: join(home, ".omp", "agent") });
    const servers = await readDiscoveredMcpServers(cwd, ["skipped"], host);
    assert.deepEqual(servers.sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`)), [
      { name: "ida-re", source: "Claude Code", status: "configured", type: "stdio" },
      { name: "codex-docs", source: "Codex", status: "configured", type: "http" },
      { name: "off", source: "Codex", status: "disabled", type: "stdio" },
      { name: "cursor", source: "Cursor", status: "configured", type: "http" },
      { name: "vs code", source: "VS Code", status: "disabled", type: "stdio" },
    ]);
  });
});

test("edits a project MCP config through the remote host path", { skip: !posix }, async () => {
  await withWorkspace(async (cwd) => {
    const host = fakeRemoteHost();
    await writeMcpServer(cwd, "remote-fs", { type: "stdio", command: "npx", args: ["-y", "server"] }, undefined, host);
    const file = await readMcpConfig(cwd, host);
    assert.match(file.path, /\.omp\/mcp\.json$/);
    assert.deepEqual(Object.keys(file.config.mcpServers), ["remote-fs"]);
    await deleteMcpServer(cwd, "remote-fs", host);
    assert.deepEqual((await readMcpConfig(cwd, host)).config.mcpServers, {});
    assert.equal(existsSync(`${file.path}.lock`), false);
  });
});
