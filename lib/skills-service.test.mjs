import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import { fakeRemoteHost } from "./omp/test-helpers.mjs";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
// Some imports use the "@/" path alias, which jiti resolves only when it is
// told the project root.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const {
  discoverSkills,
  getSkillScanRootDirs,
  loadSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} = await jiti.import("./skills-service.ts");
// The toggle route authorizes existing files through the consolidated facade.
const { isExistingFilePathAllowed } = await jiti.import("./file-access.ts");

function skillFile(frontmatter) {
  return `---\nname: demo\ndescription: A demo skill.\n${frontmatter}---\n\n# Demo\n\nBody text.\n`;
}

function flagOf(content) {
  return readDisableModelInvocation(parseSkillFrontmatter(content).frontmatter);
}

test("adds the standard key when no variant is present", () => {
  const out = setDisableModelInvocation(skillFile(""), true);
  assert.match(out, /^---\ndisable-model-invocation: true\nname: demo\n/);
  assert.equal(flagOf(out), true);
});

for (const key of ["disable-model-invocation", "disableModelInvocation", "hide"]) {
  test(`replaces an existing ${key} line instead of duplicating it`, () => {
    const out = setDisableModelInvocation(skillFile(`${key}: false\n`), true);
    assert.equal(out.match(/^(disable-model-invocation|disableModelInvocation|hide)\s*:/gm).length, 1);
    assert.equal(out.includes(`${key}: true`), true);
    // Duplicate keys would make the frontmatter unparseable YAML.
    assert.doesNotThrow(() => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(out)[1]));
    assert.equal(flagOf(out), true);
  });

  test(`clears ${key} when re-enabling model invocation`, () => {
    const out = setDisableModelInvocation(skillFile(`${key}: true\n`), false);
    assert.doesNotMatch(out, /disable-model-invocation|disableModelInvocation|hide/);
    assert.equal(flagOf(out), false);
    assert.match(out, /name: demo/);
  });
}

test("collapses duplicate variants written by earlier versions", () => {
  const corrupt = skillFile("disable-model-invocation: true\nhide: true\n");
  assert.equal(flagOf(setDisableModelInvocation(corrupt, false)), false);
  assert.doesNotMatch(setDisableModelInvocation(corrupt, false), /hide:/);

  const reenabled = setDisableModelInvocation(corrupt, true);
  assert.equal(reenabled.match(/^(disable-model-invocation|disableModelInvocation|hide)\s*:/gm).length, 1);
  assert.equal(flagOf(reenabled), true);
});

test("leaves indented keys of nested mappings alone", () => {
  const content = skillFile("metadata:\n  hide: true\n");
  const out = setDisableModelInvocation(content, true);
  assert.match(out, /metadata:\n {2}hide: true/);
  assert.match(out, /^disable-model-invocation: true$/m);
});

test("prepends frontmatter when the file has none", () => {
  const out = setDisableModelInvocation("# Demo\n\nBody.\n", true);
  assert.equal(out, "---\ndisable-model-invocation: true\n---\n# Demo\n\nBody.\n");
  assert.equal(setDisableModelInvocation("# Demo\n", false), "# Demo\n");
});

test("preserves CRLF line endings", () => {
  const content = "---\r\nname: demo\r\nhide: true\r\n---\r\nBody\r\n";
  const out = setDisableModelInvocation(content, false);
  assert.equal(out, "---\r\nname: demo\r\n---\r\nBody\r\n");
});

test("scan roots cover the compat directories the app installs into", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-skill-roots-"));
  const agentDir = join(dir, ".omp", "agent");
  const claudeDir = join(dir, ".claude");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const roots = await getSkillScanRootDirs();
    for (const expected of [
      join(agentDir, "skills"),
      join(agentDir, "managed-skills"),
      join(claudeDir, "skills"),
      join(homedir(), ".agent", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".codex", "skills"),
    ]) {
      assert.ok(roots.includes(expected), `missing scan root ${expected}`);
    }
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovery honors all three frontmatter spellings", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "omp-web-skill-scan-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, ".omp", "agent");
  process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
  try {
    const fixtures = [
      [join(process.env.PI_CODING_AGENT_DIR, "skills", "kebab"), "kebab", "disable-model-invocation: true\n", true],
      [join(process.env.CLAUDE_CONFIG_DIR, "skills", "camel"), "camel", "disableModelInvocation: true\n", true],
      [join(dir, "project", ".agents", "skills", "hidden"), "hidden", "hide: true\n", true],
      [join(dir, "project", ".codex", "skills", "plain"), "plain", "", false],
    ];
    for (const [skillDir, name, extra] of fixtures) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} fixture.\n${extra}---\n\nBody\n`,
        "utf8",
      );
    }
    const cwd = join(dir, "project");
    mkdirSync(cwd, { recursive: true });

    const { skills } = await discoverSkills(cwd);
    const byName = new Map(skills.map((s) => [s.name, s]));
    const allowedRoots = new Set(await getSkillScanRootDirs(cwd));
    for (const [, name, , expected] of fixtures) {
      assert.equal(byName.get(name)?.disableModelInvocation, expected, `${name} flag`);
      // Every discovered skill must be togglable — this is the exact check the
      // PATCH route runs, and the old hardcoded allowlist failed it here.
      assert.ok(
        await isExistingFilePathAllowed(byName.get(name).filePath, allowedRoots),
        `${name} is discoverable but rejected by the toggle allowlist`,
      );
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers skills on a remote host with the batched scan and lock lookup", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-skill-remote-"));
  try {
    const home = join(dir, "home");
    const agentDir = join(home, ".omp", "agent");
    const repo = join(home, "repo");
    const cwd = join(repo, "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const fixtures = [
      [join(agentDir, "skills", "user-skill"), "user-skill", ".omp", "user"],
      [join(home, ".agents", "skills", "installed"), "installed", ".agents", "user"],
      [join(cwd, ".omp", "skills", "project skill"), "project skill", ".omp", "project"],
      [join(repo, ".claude", "skills", "repo-level"), "repo-level", ".claude", "project"],
      [join(repo, ".github", "skills", "gh"), "gh", ".github", "project"],
    ];
    for (const [skillDir, name] of fixtures) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture.\n---\n\nBody\n`, "utf8");
    }
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents", ".skill-lock.json"), JSON.stringify({
      version: 3,
      skills: { installed: { source: "owner/repo", sourceType: "github", skillPath: "skills/installed/SKILL.md", skillFolderHash: "abc" } },
    }));

    const host = fakeRemoteHost({ home, agentDir });
    const { skills, diagnostics } = await discoverSkills(cwd, host);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.sourceInfo.source, skill.sourceInfo.scope]).sort(),
      fixtures.map(([, name, source, scope]) => [name, source, scope]).sort(),
    );
    assert.equal(skills.find((skill) => skill.name === "project skill").baseDir, join(cwd, ".omp", "skills", "project skill"));

    const annotated = await loadSkillsWithInstallInfo(cwd, host);
    const installed = annotated.skills.find((skill) => skill.name === "installed");
    assert.equal(installed.install?.package, "owner/repo@installed");
    assert.equal(installed.install?.versionHash, "abc");
    assert.equal(annotated.skills.find((skill) => skill.name === "user-skill").install, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
