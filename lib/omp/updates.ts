import { currentHost } from "../hosts/context";
import { getHost, type Host } from "../hosts/registry";
import { invalidateOmpCliCache, resolveOmpBin } from "./omp-cli";

export interface OmpUpdateStatus {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

export const OMP_UPDATE_CHECK_TIMEOUT_MS = 15_000;
export const OMP_UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;

export const OMP_UPDATE_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Run a bare `omp update` on the host to install the latest OMP CLI, then
 * drop the cached binary probe and restart the host's live omp children so
 * they pick up the new executable. Install durability for the local machine
 * (lease/status/retry) lives in lib/self-update.ts; this is the raw command. */
export async function runOmpUpdateInstall(timeoutMs = OMP_UPDATE_INSTALL_TIMEOUT_MS, host: Host = currentHost()): Promise<string> {
  const output = await runOmpUpdate([], timeoutMs, host);
  invalidateOmpCliCache(host);
  // Loaded lazily: rpc-manager pulls in the whole session stack, which the
  // update check (and its tests) do not need.
  const { restartAllRpcSessions } = await import("../rpc-manager");
  await restartAllRpcSessions(host.id);
  return output;
}

export async function runOmpUpdate(args: string[], timeoutMs = OMP_UPDATE_CHECK_TIMEOUT_MS, host: Host = currentHost()): Promise<string> {
  const bin = resolveOmpBin(host);
  if (!bin) {
    throw new Error(host.isLocal
      ? "omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."
      : `omp binary not found on host "${host.id}". Install oh-my-pi there or set the host's ompBin.`);
  }
  const result = await host.executor.exec([bin, "update", ...args], {
    timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
    allowFailure: true,
  });
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr;
  if (result.code !== 0) {
    throw new Error((stderr || stdout || `omp update exited with ${result.signal ?? result.code ?? "unknown"}`).trim().slice(-1000));
  }
  return `${stdout}\n${stderr}`.trim();
}

export function parseOmpUpdateStatus(output: string): OmpUpdateStatus {
  const currentVersion = output.match(/^Current version:\s*(\S+)/mi)?.[1] ?? null;
  const availableVersion = output.match(/^New version available:\s*(\S+)/mi)?.[1] ?? null;
  return {
    currentVersion,
    availableVersion,
    updateAvailable: availableVersion !== null,
    updateCommand: "omp update",
  };
}

export function createCachedOmpUpdateCheck(
  run: () => Promise<string> = () => runOmpUpdate(["--check"]),
  now: () => number = () => Date.now(),
) {
  let cached: { checkedAt: number; status: OmpUpdateStatus } | null = null;
  let inFlight: Promise<OmpUpdateStatus> | null = null;

  return async (force = false): Promise<OmpUpdateStatus> => {
    const currentTime = now();
    if (!force && cached && currentTime - cached.checkedAt < OMP_UPDATE_CHECK_TTL_MS) {
      return cached.status;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const output = await run();
        const status = parseOmpUpdateStatus(output);
        cached = { checkedAt: now(), status };
        return status;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };
}

// One cached checker per host: each machine has its own omp install.
const cachedChecks = new Map<string, ReturnType<typeof createCachedOmpUpdateCheck>>();

function cachedCheckFor(host: Host): ReturnType<typeof createCachedOmpUpdateCheck> {
  let check = cachedChecks.get(host.id);
  if (!check) {
    // Resolve the live Host on every run: hosts.json edits rebuild Host objects.
    check = createCachedOmpUpdateCheck(() => runOmpUpdate(["--check"], OMP_UPDATE_CHECK_TIMEOUT_MS, getHost(host.id) ?? host));
    cachedChecks.set(host.id, check);
  }
  return check;
}

export async function checkOmpUpdate(force = false, host: Host = currentHost()): Promise<OmpUpdateStatus> {
  return cachedCheckFor(host)(force);
}
