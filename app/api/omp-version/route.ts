import { NextResponse } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { getOmpVersion } from "@/lib/omp/omp-cli";

export const dynamic = "force-dynamic";

/** Runtime probe of the omp binary installed on the host ("omp/17.1.3"),
 * separate from the build-time omp-web version — the two can legitimately
 * drift. */
export const GET = withHostRoute(async () => {
  const host = currentHost();
  const version = await getOmpVersion(host);
  return NextResponse.json({ version, host: host.id });
});
