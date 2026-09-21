import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getConfigRoot } from "@/lib/omp/paths";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Honor HTTP(S)_PROXY/NO_PROXY for server-side fetch (update checks, skill
  // search, model connection tests). Node's built-in fetch ignores proxy env
  // vars (NODE_USE_ENV_PROXY is Node 24+ only; engines floor is 22).
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Startup diagnostics: configured hosts. Kept to one line each so they grep
  // cleanly; failures here must never block boot.
  try {
    const { listHosts, getDefaultHostId } = await import("@/lib/hosts/registry");
    const { getHostsFilePath } = await import("@/lib/hosts/config");
    const hosts = listHosts({ includeDisabled: true });
    console.log(
      `[omp-web] starting (hosts ${hosts.map((host) => `${host.id}${host.enabled ? "" : " (disabled)"}`).join(", ")}; default ${getDefaultHostId()}; config ${getHostsFilePath()})`,
    );
  } catch (error) {
    console.warn(`[omp-web] host registry failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Probe every enabled host in the background so the first page load already
  // knows which machines are reachable, then warm the utility omp process on
  // each so the first models/auth request does not pay the multi-second cold
  // spawn (measured 1.2-4s on a real install). Fire-and-forget: register()
  // must not block boot, and a missing omp binary is reported per-request by
  // the routes — log once here and move on. The shared processes register
  // their own SIGINT/SIGTERM/exit disposal hook on first use
  // (lib/omp/rpc-utility.ts), as the session registry does.
  void (async () => {
    const { listHosts } = await import("@/lib/hosts/registry");
    const { withHost } = await import("@/lib/hosts/context");
    await Promise.allSettled(listHosts().map(async (host) => {
      try {
        await host.ready();
        console.log(`[omp-web] host ${host.id} ready (${host.executor.label}; omp ${host.ompVersion ?? "not found"}; agent-dir ${withHost(host, () => host.isLocal ? "local" : host.agentDir)})`);
      } catch (error) {
        console.warn(`[omp-web] host ${host.id} unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!host.ompBin) {
        console.warn(`[omp-web] host ${host.id}: omp binary not found; install oh-my-pi there or set the host's ompBin`);
        return;
      }
      try {
        const { runUtilityCommand } = await import("@/lib/omp/rpc-utility");
        await withHost(host, () => runUtilityCommand({ type: "get_state" }, 60_000, host));
        console.log(`[omp-web] host ${host.id}: omp utility ready`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[omp-web] host ${host.id}: omp utility warm-up failed (routes will retry on demand): ${detail}`);
      }
    }));
  })();

  // Crash/stall journal: a long-running server that dies or wedges while the
  // user is away leaves no trace in a terminal that no longer exists (CLI runs
  // are killed with their terminal; pages then show endless loading until the
  // process is restarted). Append fatal errors and event-loop stalls to a file
  // so the next incident explains itself. Node's default crash semantics are
  // preserved — this only adds the record before exiting.
  const logDir = join(getConfigRoot(), "omp-web");
  const logPath = join(logDir, "diagnostics.log");
  const appendDiag = (kind: string, detail: string) => {
    try {
      mkdirSync(logDir, { recursive: true });
      try {
        if (statSync(logPath).size > 1_000_000) renameSync(logPath, `${logPath}.old`);
      } catch { /* first write or unreadable — append anyway */ }
      appendFileSync(logPath, `${new Date().toISOString()} [${kind}] ${detail}\n`, { encoding: "utf8" });
    } catch { /* diagnostics must never crash the server */ }
  };
  const describe = (value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` : String(value));
  process.on("uncaughtException", (error) => {
    appendDiag("crash", `uncaughtException ${describe(error)}`);
    // An uncaughtException listener suppresses Node's default exit; keep the
    // crash-visible semantics by exiting explicitly.
    process.exit(2);
  });
  process.on("unhandledRejection", (reason) => {
    appendDiag("crash", `unhandledRejection ${describe(reason)}`);
    // Same as above: preserve Node's crash-on-unhandled-rejection default.
    process.exit(2);
  });
  let lastTick = Date.now();
  let lastCpu = process.cpuUsage();
  const watchdog = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const drift = now - lastTick;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    lastTick = now;
    lastCpu = cpu;
    if (drift > 45_000) {
      // Wall-clock drift alone cannot tell a blocked loop from a sleeping
      // machine: an hour with the lid closed looks like an hour-long stall
      // but burns no CPU. Label accordingly so the journal does not mislead
      // the next long-idle investigation.
      const seconds = Math.round(drift / 1000);
      if (cpuMs < Math.min(5_000, drift / 2)) {
        appendDiag("sleep", `event loop gap of ~${seconds}s with negligible CPU time — machine was asleep/suspended or CPU-starved, not a synchronous block`);
      } else {
        appendDiag("stall", `event loop unresponsive for ~${seconds}s — a synchronous operation is blocking every request`);
      }
    }
  }, 15_000);
  watchdog.unref?.();
}
