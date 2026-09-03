import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

export const POST = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await request.json() as { provider?: unknown };
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    await enableProvider(body.provider, host);
    invalidateModelsCache(host.id);
    disposeUtilityRpc(host.id);
    return NextResponse.json({ success: true, host: host.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
});
