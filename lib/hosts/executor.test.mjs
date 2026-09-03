import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const { ExecError, HostFsError, LocalExecutor, SshExecutor, SshFs } = await jiti.import("./executor.ts");

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-executor-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("LocalExecutor filesystem operations behave like bounded host reads", async () => {
  await withTempDir(async (dir) => {
    const local = new LocalExecutor();
    const fs = local.fs;
    const file = join(dir, "a.jsonl");
    const body = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, text: "x".repeat(200) })).join("\n") + "\n";
    await fs.writeFile(file, body, { mode: 0o600 });
    assert.equal((await fs.readFile(file)).toString(), body);
    assert.equal((await fs.readHead(file, 5)).toString(), body.slice(0, 5));
    assert.equal((await fs.readFile(file, { maxBytes: 7 })).toString(), body.slice(0, 7));

    const slices = await fs.readSlices([file, join(dir, "missing")], 100, 300);
    const slice = slices.get(file);
    assert.equal(slices.has(join(dir, "missing")), false);
    assert.equal(slice.size, Buffer.byteLength(body));
    assert.equal(slice.prefix.toString(), body.slice(0, 100));
    assert.equal(slice.suffix.toString(), body.slice(-300));

    let lines = 0;
    await fs.forEachLine(file, () => { lines++; });
    assert.equal(lines, 50);

    await fs.writeAt(file, 0, Buffer.from("ZZ"));
    assert.equal((await fs.readHead(file, 2)).toString(), "ZZ");
    await fs.prependFile(file, Buffer.from("PRE\n"));
    assert.equal((await fs.readHead(file, 4)).toString(), "PRE\n");

    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    writeFileSync(join(dir, "sub", "b.jsonl"), "1\n");
    writeFileSync(join(dir, "sub", "deep", "c.jsonl"), "2\n");
    writeFileSync(join(dir, "sub", "deep", "d.txt"), "3\n");
    symlinkSync(join(dir, "sub"), join(dir, "link-to-sub"));
    symlinkSync(join(dir, "nope"), join(dir, "dangling"));

    const depthTwo = await fs.walkFiles(dir, { minDepth: 2, maxDepth: 2, suffix: ".jsonl" });
    assert.deepEqual(depthTwo.map((entry) => entry.path).sort(), [join(dir, "sub", "b.jsonl")]);
    const depthThree = await fs.walkFiles(dir, { minDepth: 1, maxDepth: 3, suffix: ".jsonl" });
    assert.deepEqual(depthThree.map((entry) => entry.path).sort(), [file, join(dir, "sub", "b.jsonl"), join(dir, "sub", "deep", "c.jsonl")]);

    const entries = await fs.readdir(dir);
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName["sub"].type, "dir");
    assert.equal(byName["a.jsonl"].type, "file");
    assert.equal(byName["link-to-sub"].type, "symlink");
    assert.equal(byName["link-to-sub"].targetType, "dir");
    assert.equal(byName["dangling"].type, "symlink");
    assert.equal(byName["dangling"].targetType, undefined);

    assert.equal((await fs.stat(join(dir, "sub"))).isDirectory(), true);
    assert.equal((await fs.lstat(join(dir, "link-to-sub"))).isSymbolicLink(), true);
    assert.equal(await fs.exists(join(dir, "dangling")), true);
    assert.equal(await fs.exists(join(dir, "nope")), false);
    assert.equal(await fs.realpath(join(dir, "link-to-sub")), await fs.realpath(join(dir, "sub")));
    await fs.rename(file, join(dir, "renamed.jsonl"));
    assert.equal(await fs.exists(join(dir, "renamed.jsonl")), true);
    await fs.rm(join(dir, "sub"), { recursive: true, force: true });
    assert.equal(await fs.exists(join(dir, "sub")), false);
    await assert.rejects(() => fs.stat(join(dir, "sub")), (error) => error.code === "ENOENT");
  });
});

test("LocalExecutor exec captures output, honors allowFailure and rejects with ExecError", async () => {
  const local = new LocalExecutor();
  const ok = await local.exec([process.execPath, "-e", "process.stdout.write('hi'); process.stderr.write('warn')"]);
  assert.equal(ok.stdout.toString(), "hi");
  assert.equal(ok.stderr, "warn");
  assert.equal(ok.code, 0);
  const failed = await local.exec([process.execPath, "-e", "process.exit(3)"], { allowFailure: true });
  assert.equal(failed.code, 3);
  await assert.rejects(() => local.exec([process.execPath, "-e", "console.error('boom'); process.exit(2)"]), (error) => error instanceof ExecError && error.code === 2 && /boom/.test(error.stderr));
  const echoed = await local.exec([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], { input: "piped" });
  assert.equal(echoed.stdout.toString(), "piped");
  assert.equal(await local.which("definitely-not-a-binary-omp-web"), null);
  const probe = await local.probe();
  assert.equal(typeof probe.home, "string");
});

test("SshExecutor builds a login-shell-proof remote command and ssh arguments", () => {
  const ssh = new SshExecutor({ host: "hetz", user: "twice", port: 2222, identityFile: "/k/id" }, { controlDir: join(tmpdir(), "omp-web-ctl-test") });
  const args = ssh.sshClientArgs();
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ControlMaster=auto"));
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
  assert.deepEqual(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2), ["-l", "twice"]);
  assert.ok(args.includes("IdentitiesOnly=yes"));
  const command = ssh.remoteCommand(["omp", "--mode", "rpc-ui", "--cwd", "/srv/my proj"], { cwd: "/srv/my proj", env: { PI_CODING_AGENT_DIR: "/tmp/x y" } });
  assert.ok(command.startsWith("sh -c '"));
  assert.ok(command.includes("export PATH="));
  assert.ok(command.includes("cd '\\''/srv/my proj'\\'' || exit 127"));
  assert.ok(command.includes("exec env '\\''PI_CODING_AGENT_DIR=/tmp/x y'\\'' omp --mode rpc-ui --cwd '\\''/srv/my proj'\\''"));
});

/** Fake ssh executor: answers fs scripts with canned GNU-flavored output. */
function fakeSsh(responses) {
  const calls = [];
  return {
    calls,
    async ready() {
      return { home: "/home/twice", tmp: "/tmp", platform: "linux", statFlavor: "gnu", findFlavor: "gnu" };
    },
    async exec(argv, options = {}) {
      calls.push({ argv, options });
      const script = argv[2];
      const answer = responses(script, argv.slice(4), options);
      if (answer instanceof Error) throw answer;
      return { stdout: Buffer.isBuffer(answer) ? answer : Buffer.from(answer ?? ""), stderr: "", code: 0, signal: null };
    },
    spawn() {
      throw new Error("not used");
    },
  };
}

test("SshFs parses GNU find/stat output and readSlices frames", async () => {
  const fs = new SshFs(fakeSsh((script, args, options) => {
    if (script.includes("-printf '%y\\t%Y\\t%s\\t%T@\\t%f\\0'")) {
      return "d\td\t4096\t1700000000.5\tsub\0f\tf\t12\t1700000001.9\ta b.jsonl\0l\td\t3\t1700000002\tlink\0l\tN\t3\t1700000003\tbroken\0";
    }
    if (script.includes("-printf '%s\\t%T@\\t%p\\0'")) {
      return `12\t1700000001.9\t${args[0]}/p/a b.jsonl\0`;
    }
    if (script.startsWith("exec stat -L -c")) return "regular file|12|1700000001|81a4\n";
    if (script.includes("[ -d \"$1\" ]") || script.includes('[ -e "$1" ]')) return "";
    if (script.startsWith("S=")) {
      const sentinel = /^S='([\s\S]*?)'\n/.exec(script)[1].replace(/'\\''/g, "'");
      const paths = options.input.split("\n").filter(Boolean);
      const out = [];
      for (const path of paths) {
        if (path.endsWith("missing")) continue;
        out.push(`H 5000 1700000001 ${path}\n`, "P".repeat(10), sentinel, "S".repeat(20), sentinel);
      }
      return out.join("");
    }
    return "";
  }));
  const entries = await fs.readdir("/home/twice");
  assert.deepEqual(entries.map((entry) => [entry.name, entry.type, entry.targetType, entry.size, entry.mtimeMs]), [
    ["sub", "dir", undefined, 4096, 1700000000000],
    ["a b.jsonl", "file", undefined, 12, 1700000001000],
    ["link", "symlink", "dir", 3, 1700000002000],
    ["broken", "symlink", undefined, 3, 1700000003000],
  ]);
  const walked = await fs.walkFiles("/root", { minDepth: 2, maxDepth: 2, suffix: ".jsonl" });
  assert.deepEqual(walked, [{ path: "/root/p/a b.jsonl", size: 12, mtimeMs: 1700000001000 }]);
  const stat = await fs.stat("/home/twice/a b.jsonl");
  assert.equal(stat.isFile(), true);
  assert.equal(stat.size, 12);
  assert.equal(stat.mode, 0o644);
  const slices = await fs.readSlices(["/x/one", "/x/two missing", "/x/thr ee"], 10, 20);
  assert.deepEqual([...slices.keys()], ["/x/one", "/x/thr ee"]);
  assert.equal(slices.get("/x/thr ee").prefix.toString(), "P".repeat(10));
  assert.equal(slices.get("/x/thr ee").suffix.toString(), "S".repeat(20));
  assert.equal(slices.get("/x/one").size, 5000);
  assert.equal(slices.get("/x/one").mtimeMs, 1700000001000);
});

test("SshFs maps command failures to HostFsError codes", async () => {
  const fs = new SshFs(fakeSsh((script) => {
    if (script.startsWith("exec stat")) {
      const error = new ExecError(["stat"], { stdout: Buffer.alloc(0), stderr: "stat: cannot statx '/x': No such file or directory\n", code: 1, signal: null });
      return error;
    }
    if (script.startsWith("exec cat")) {
      return new ExecError(["cat"], { stdout: Buffer.alloc(0), stderr: "cat: /x: Permission denied\n", code: 1, signal: null });
    }
    return "";
  }));
  await assert.rejects(() => fs.stat("/x"), (error) => error instanceof HostFsError && error.code === "ENOENT" && error.path === "/x");
  await assert.rejects(() => fs.readFile("/x"), (error) => error instanceof HostFsError && error.code === "EACCES");
});

test("host fs errors round-trip through readFileSync-style callers", () => {
  const error = new HostFsError("ENOENT", "/p");
  assert.equal(error.code, "ENOENT");
  assert.match(error.message, /ENOENT/);
  assert.equal(readFileSync.name, "readFileSync");
});

// A remote command's arguments are world-readable through /proc on the machine
// running it, so a credential passed as ordinary env would be visible to every
// user there, and to process accounting and any log shipper. Secrets travel on
// stdin instead. This is the property that lets a shared machine be handed a
// per-user gateway token at all.
test("secrets reach the remote environment without entering its command line", () => {
  const ssh = new SshExecutor({ host: "h", user: "u" }, { controlDir: join(tmpdir(), "omp-web-secret-test") });
  const secret = "s3cr3t-token-value";
  const command = ssh.remoteCommand(["omp", "--mode", "rpc-ui"], {
    env: { PLAIN: "visible" },
    secretEnv: { GW_TOKEN: secret },
  });

  assert.doesNotMatch(command, new RegExp(secret), "the secret must never appear in the remote command line");
  assert.match(command, /PLAIN=visible/, "ordinary env still rides along as usual");
  // Read one line per secret, export it, and only then exec: `read` on a pipe
  // consumes a byte at a time, so the command's own stdin is left untouched.
  assert.match(command, /IFS= read -r GW_TOKEN \|\| exit 127/);
  assert.ok(command.indexOf("read -r GW_TOKEN") < command.indexOf("exec "), "secrets are read before exec");

  // The value is delivered as the first line of stdin, ahead of real input.
  assert.equal(SshExecutor.secretPreamble({ secretEnv: { GW_TOKEN: secret } }), `${secret}\n`);
  assert.equal(SshExecutor.secretPreamble({}), "");
});

test("a secret containing a newline is refused rather than silently truncated", () => {
  // The wire format is one value per line, so an embedded newline would make
  // the remote read half a token and treat the rest as the command's input.
  assert.throws(
    () => SshExecutor.secretPreamble({ secretEnv: { GW_TOKEN: "line-one\nline-two" } }),
    /cannot contain a newline/,
  );
});
