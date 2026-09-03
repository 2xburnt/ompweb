import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";

export const dynamic = "force-dynamic";

export const GET = withHostRoute(async () => {
  try {
    const host = currentHost();
    return NextResponse.json({ ...(await readModelRoles(host)), host: host.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
});

export const PUT = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await request.json() as { roles?: unknown };
    if (!body.roles || typeof body.roles !== "object" || Array.isArray(body.roles)) {
      return NextResponse.json({ error: "roles must be an object" }, { status: 400 });
    }
    const roles = Object.fromEntries(Object.entries(body.roles).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].trim().length > 0 && entry[1].trim().length > 0,
    ));
    await writeModelRoles(roles, host);
    invalidateModelsCache(host.id);
    return NextResponse.json({ success: true, roles, host: host.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
});
