import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

/** Test helper: a "remote" host backed by the local executor, so the batched
 * POSIX `sh` code paths run against this machine's real shell and coreutils.
 * Not a test file itself (no `.test.mjs` suffix), so importing it from a suite
 * registers nothing. */
const jiti = createJiti(import.meta.url);
const { LocalExecutor } = await jiti.import("../hosts/executor.ts");

export function fakeRemoteHost(overrides = {}) {
  const executor = new LocalExecutor();
  return {
    id: "fake-remote",
    isLocal: false,
    executor,
    fs: executor.fs,
    pathApi: path.posix,
    home: os.homedir(),
    tmp: os.tmpdir(),
    platform: process.platform,
    agentDir: path.posix.join(os.homedir(), ".omp", "agent"),
    ompBin: null,
    ...overrides,
  };
}
