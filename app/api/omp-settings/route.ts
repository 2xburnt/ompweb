import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { invalidateModelsCache } from "@/lib/models-cache";
import { disposeUtilityRpc, runUtilityCommand, type OmpModel } from "@/lib/omp/rpc-utility";
import { readNativeSettings, writeNativeSettings, type NativeSettings } from "@/lib/omp/settings-config";
import { assertNoAmbiguousModelScopes } from "@/lib/model-scope";

export const dynamic = "force-dynamic";

export const GET = withHostRoute(async () => {
  try {
    const host = currentHost();
    return NextResponse.json({ ...(await readNativeSettings(host)), host: host.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
});

export const PUT = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await request.json() as { settings?: NativeSettings };
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      return NextResponse.json({ error: "settings must be an object" }, { status: 400 });
    }
    if (body.settings.enabledModels !== undefined) {
      // The utility process is best-effort here: settings remain editable when
      // omp is unavailable, but an available catalog rejects ambiguous bare IDs.
      try {
        const response = await runUtilityCommand<{ models?: unknown }>({ type: "get_available_models" }, 120_000, host);
        if (Array.isArray(response.models)) {
          const models = response.models.filter((model): model is OmpModel => (
            typeof model === "object" && model !== null
            && typeof (model as OmpModel).id === "string"
            && typeof (model as OmpModel).provider === "string"
          ));
          assertNoAmbiguousModelScopes(body.settings.enabledModels, models);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Ambiguous enabledModels entry")) throw error;
      }
    }
    await writeNativeSettings(body.settings, host);
    if (body.settings.enabledModels !== undefined || body.settings.disabledProviders !== undefined || body.settings.modelProviderOrder !== undefined) {
      invalidateModelsCache(host.id);
      disposeUtilityRpc(host.id);
    }
    return NextResponse.json({ success: true, settings: (await readNativeSettings(host)).settings, host: host.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
});
