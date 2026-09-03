import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { allowFileRoot } from "@/lib/file-access";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { hostHomedir, hostPath } from "@/lib/omp/paths";

// POST /api/default-cwd[?host=<id>]  →  { cwd, host }
// Creates <home>/omp-cwd-<YYYYMMDD> on the selected host if it doesn't exist
// and returns the path.
export const POST = withHostRoute(async () => {
  try {
    const host = currentHost();
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = hostPath().join(hostHomedir(), `omp-cwd-${date}`);
    await host.fs.mkdir(dir, { recursive: true });
    allowFileRoot(dir, host);
    return NextResponse.json({ cwd: dir, host: host.id });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
