import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { type OmpLoginProvider, runUtilityCommand } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

// Login-capable providers via the omp RPC get_login_providers command. This is
// omp's own /login list (OAuth subscriptions plus key-creation flows), so no
// hardcoded exclusions or display-name overrides are needed anymore.
export const GET = withHostRoute(async () => {
  const host = currentHost();
  try {
    const response = await runUtilityCommand<{ providers?: unknown }>(
      { type: "get_login_providers" },
      30_000,
      host,
    );
    const providers = Array.isArray(response.providers)
      ? response.providers.filter((provider): provider is OmpLoginProvider => (
        typeof provider === "object" && provider !== null
        && typeof (provider as OmpLoginProvider).id === "string"
        && typeof (provider as OmpLoginProvider).name === "string"
        && typeof (provider as OmpLoginProvider).authenticated === "boolean"
      ))
      : [];
    const result = providers
      .filter((p) => p.available !== false)
      .map((p) => ({
        id: p.id,
        name: p.name,
        usesCallbackServer: false,
        loggedIn: p.authenticated,
      }));
    return Response.json({ providers: result, host: host.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ providers: [], error: message, host: host.id }, { status: 500 });
  }
});
