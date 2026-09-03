import { NextResponse } from "next/server";
import { resolveSessionPath, type ResolveSessionOptions } from "./session-reader";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to its file path ON THE SESSION'S HOST, or a 404 JSON
 * response. Replaces the repeated `resolveSessionPath(id)` + "Session not
 * found" guard across routes. Callers run inside withSessionRoute, so
 * currentHost() is the host the returned path lives on.
 *
 * Pass `{ verify: true }` before spawning omp with --resume: without it a path
 * listed within the last few seconds is trusted without an existence probe,
 * and omp would silently create a new session for a deleted file. */
export async function resolveSessionPathOr404(
  id: string,
  options: ResolveSessionOptions = {},
): Promise<{ filePath: string } | { response: NextResponse }> {
  const filePath = await resolveSessionPath(id, options);
  if (!filePath) return { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  return { filePath };
}

/** Uniform JSON error body used by most API routes. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: String(error) }, { status });
}
