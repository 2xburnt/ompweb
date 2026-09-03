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
}
