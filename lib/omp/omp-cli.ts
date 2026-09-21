import { execFile } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { currentHost } from "../hosts/context";
import type { Host } from "../hosts/registry";

/**
 * Locating and probing the `omp` CLI on a host. omp-web never embeds the
 * (Bun-only) @oh-my-pi SDK — every live-agent capability goes through the
 * omp binary, so its absence is a first-class, user-visible state.
 *
 * Remote hosts are probed once by the host registry (Host.ready()); this
 * module reports what that probe found. The local machine keeps the
 * PATH/fallback-dir search below so a GUI-launched server still finds omp.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: { fingerprint: string; value: string; expiresAt: number } | null = null;
let versionMiss: { fingerprint: string | null; retryAt: number } | null = null;
let versionProbe: Promise<string | null> | null = null;

const BIN_NAME = process.platform === "win32" ? "omp.exe" : "omp";
// Retry missing binaries and failed version probes after a short backoff so
// a later install or repair is picked up without a web server restart.
const MISS_TTL_MS = 30_000;
// Launchers can stay unchanged while their underlying package is updated.
const VERSION_TTL_MS = 5 * 60_000;

/** Clear probes after an explicit `omp update` so the next request rechecks it. */
export function invalidateOmpCliCache(host: Host = currentHost()): void {
  if (host.isLocal) {
    cachedBin = null;
    binMissAt = 0;
    cachedVersion = null;
    versionMiss = null;
    versionProbe = null;
  }
  host.invalidateOmp();
}

function probeLocalOmpBin(): string | null {
  const override = process.env.OMP_WEB_OMP_BIN;
  if (override) return existsSync(override) ? override : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, BIN_NAME);
    if (existsSync(candidate)) return candidate;
  }
  // GUI-launched processes often miss homebrew/bun dirs in PATH; probe the
  // usual install locations before giving up.
  const fallbackDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ];
  for (const dir of fallbackDirs) {
    const candidate = join(dir, BIN_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve the omp binary on a host. Local: OMP_WEB_OMP_BIN override, then PATH
 * lookup (a hit is cached for the process lifetime; a miss is re-probed after
 * MISS_TTL_MS). Remote: whatever Host.ready() found (null until probed or when
 * omp is not installed there). */
export function resolveOmpBin(host: Host = currentHost()): string | null {
  if (!host.isLocal) return host.ompBin;
  // A global Bun/npm update can replace or remove its launcher while this
  // Next.js process is still alive. Never keep returning a stale cache entry.
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  cachedBin = null;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probeLocalOmpBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** Return the installed CLI version. Remote metadata comes from Host.ready();
 * local callers share a metadata-aware, expiring probe. */
export async function getOmpVersion(host: Host = currentHost()): Promise<string | null> {
  if (!host.isLocal) {
    try {
      await host.ready();
    } catch {
      return null;
    }
    return host.ompVersion;
  }
  versionProbe ??= probeOmpVersion(host).finally(() => {
    versionProbe = null;
  });
  return versionProbe;
}

function versionFingerprint(bin: string): string | null {
  try {
    const target = realpathSync(bin);
    const stat = statSync(target, { bigint: true });
    return [target, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}

async function probeOmpVersion(host: Host): Promise<string | null> {
  const bin = resolveOmpBin(host);
  const fingerprint = bin ? versionFingerprint(bin) : null;
  const now = Date.now();
  if (fingerprint && cachedVersion?.fingerprint === fingerprint && now < cachedVersion.expiresAt) {
    return cachedVersion.value;
  }
  if (versionMiss?.fingerprint === fingerprint && now < versionMiss.retryAt) return null;
  cachedVersion = null;
  if (!bin) {
    versionMiss = { fingerprint, retryAt: now + MISS_TTL_MS };
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = output.trim();
    if (version) {
      versionMiss = null;
      // Do not cache a probe across an executable replacement.
      if (fingerprint && versionFingerprint(bin) === fingerprint) {
        cachedVersion = { fingerprint, value: version, expiresAt: Date.now() + VERSION_TTL_MS };
      }
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMiss = { fingerprint, retryAt: Date.now() + MISS_TTL_MS };
  return null;
}
