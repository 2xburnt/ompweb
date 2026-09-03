import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import { getHost } from "@/lib/hosts/registry";
import { HOST_QUERY_PARAM } from "@/lib/hosts/route";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

// GET /api/sessions[?host=<id>] — sessions of EVERY enabled host (each entry
// carries `host`); an unreachable host contributes nothing rather than
// failing the list. Deliberately not wrapped in withHostRoute: `?host=` is a
// filter on the aggregate, not a target host to probe.
export async function GET(req: Request) {
  try {
    const hostFilter = new URL(req.url).searchParams.get(HOST_QUERY_PARAM)?.trim() || null;
    if (hostFilter && !getHost(hostFilter)) {
      return NextResponse.json(
        { error: `Unknown host "${hostFilter}"`, code: "host_not_found", hostId: hostFilter },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    let sessions = await listAllSessions();
    let runningSessions = getRunningRpcSessions();
    if (hostFilter) {
      sessions = sessions.filter((session) => session.host === hostFilter);
      runningSessions = runningSessions.filter((session) => session.host === hostFilter);
    }
    const runningSessionIds = runningSessions.map((s) => s.id);
    const body = { sessions, runningSessionIds, runningSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new NextResponse(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
