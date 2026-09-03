import { NextResponse } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { hostHomedir } from "@/lib/omp/paths";

// GET /api/home[?host=<id>]  →  { home, host }
// Home directory of the selected host (the wrapper probes the host first, so
// a remote home is known here).
export const GET = withHostRoute(async () => {
  return NextResponse.json({ home: hostHomedir(), host: currentHost().id });
});
