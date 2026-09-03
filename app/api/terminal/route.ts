import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { currentHost } from "@/lib/hosts/context";
import { hostErrorResponse, withHostRoute } from "@/lib/hosts/route";
import { createTerminal, listTerminals, TerminalError } from "@/lib/terminal/manager";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

export function terminalErrorResponse(error: unknown): NextResponse {
  if (error instanceof TerminalError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  const hostError = hostErrorResponse(error);
  if (hostError) return hostError;
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  console.error("[api/terminal]", error);
  return NextResponse.json({ error: "Terminal request failed", code: "terminal_request_failed" }, { status: 500 });
}

// GET /api/terminal[?host=<id>][?all=1] — open terminals on the selected
// machine, or on every machine. The fleet-wide listing is what lets the UI put
// its tabs back after a reload without having to reach each machine first.
export const GET = withHostRoute(async (req: Request) => {
  try {
    const host = currentHost();
    const all = new URL(req.url).searchParams.get("all") === "1";
    return NextResponse.json(
      { terminals: all ? listTerminals() : listTerminals(host.id), host: host.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return terminalErrorResponse(error);
  }
}, { ready: false });

// POST /api/terminal[?host=<id>]  body: { cwd?, cols?, rows? }
// Opens a shell on the selected machine and returns its session.
export const POST = withHostRoute(async (req: Request) => {
  try {
    type CreateBody = { cwd?: unknown; cols?: unknown; rows?: unknown };
    // An empty body is a valid "just open a shell" request.
    const body = await parseJsonWithinLimit<CreateBody>(req, MAX_BODY_BYTES).catch((error): CreateBody => {
      if (error instanceof SyntaxError) return {};
      throw error;
    });
    const terminal = await createTerminal({
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
    });
    return NextResponse.json({ terminal, host: currentHost().id }, { status: 201 });
  } catch (error) {
    return terminalErrorResponse(error);
  }
});
