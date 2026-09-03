import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { closeTerminal, getTerminal, resizeTerminal, TerminalError, writeTerminal } from "@/lib/terminal/manager";
import { terminalErrorResponse } from "../route";

export const dynamic = "force-dynamic";

// Keystrokes are tiny; a paste is the only realistic bulk case.
const MAX_BODY_BYTES = 512 * 1024;

// GET /api/terminal/[id] — session state (dimensions, exit status).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const terminal = getTerminal(id);
  if (!terminal) return NextResponse.json({ error: "Terminal session not found", code: "terminal_not_found" }, { status: 404 });
  return NextResponse.json({ terminal }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/terminal/[id]  body: { type: "input", data } | { type: "resize", cols, rows }
//
// Deliberately not host-scoped: a terminal id already identifies its machine,
// exactly as a session id does. Input goes to the PTY that owns it.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit<{ type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }>(req, MAX_BODY_BYTES);

    if (body.type === "input") {
      if (typeof body.data !== "string") {
        return NextResponse.json({ error: "input requires string data", code: "invalid_input" }, { status: 400 });
      }
      writeTerminal(id, body.data);
      return NextResponse.json({ success: true });
    }

    if (body.type === "resize") {
      const cols = Number(body.cols);
      const rows = Number(body.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
        return NextResponse.json({ error: "resize requires numeric cols and rows", code: "invalid_resize" }, { status: 400 });
      }
      return NextResponse.json({ success: true, terminal: resizeTerminal(id, cols, rows) });
    }

    throw new TerminalError("invalid_action", 'type must be "input" or "resize"');
  } catch (error) {
    return terminalErrorResponse(error);
  }
}

// DELETE /api/terminal/[id] — close the shell.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ success: closeTerminal(id) });
}
