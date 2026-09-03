import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { currentHost, withHost } from "@/lib/hosts/context";
import { getHost } from "@/lib/hosts/registry";
import { hostErrorResponse, withHostRoute } from "@/lib/hosts/route";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { WebRpcError, startRpcSession } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof WebRpcError || error instanceof RpcCommandError) {
    return NextResponse.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return hostErrorResponse(error) ?? apiErrorResponse(error);
}

type NewSessionCommand = { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; [key: string]: unknown };

/** Spawn the session on the CURRENT host (the caller has entered its context). */
async function createSession(cwd: string, command: NewSessionCommand): Promise<Response> {
  const host = currentHost();
  // The cwd lives on the host that will run omp; validate it there.
  let isDirectory = false;
  try {
    isDirectory = (await host.fs.stat(cwd)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
  }

  const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command;
  if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
    return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
  }

  // Use a one-time key so startRpcSession's lock doesn't conflict with real
  // session ids. Must be unique per request: startRpcSession coalesces
  // concurrent callers that share a key onto one session. Date.now() (ms
  // resolution) collides for requests in the same millisecond, merging two
  // new sessions into one.
  const tempKey = `__new__${randomUUID()}`;
  const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames, advisor === true);

  // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
  // in sync so the new cwd is immediately readable via /api/files on this host.
  // Without this, a file request under a brand-new cwd would 403 for up to the
  // cache TTL.
  allowFileRoot(cwd);
  invalidateSessionListCache();

  try {
    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({ success: true, sessionId: realSessionId, host: host.id, data: null });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({ success: true, sessionId: realSessionId, host: host.id, data: result });
  } catch (error) {
    // The child was spawned but the prompt never ran: without this cleanup a
    // failed set_model/set_thinking_level/prompt leaves an orphaned omp
    // process and a registry entry nobody will ever use.
    await session.destroyAndWait();
    throw error;
  }
}

// POST /api/agent/new  body: { cwd: string; host?: string; type: string; message?: string; ... }
// Spawns a brand-new omp session on a host: `host` in the body wins over the
// `?host=` query / x-omp-host header, which win over the default host. Most
// calls immediately send the first command; type:"ensure_session" only creates
// the runtime so clients can query commands.
// Returns { sessionId, host, data } where sessionId is omp's real session id.
// Model/thinking presets are applied post-ready via RPC set_model /
// set_thinking_level (not CLI flags) so failures surface as command errors and
// the live model catalog (incl. background discovery) is consulted.
export const POST = withHostRoute(async (req: Request) => {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; host?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd, host: requestedHost, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }

    if (requestedHost !== undefined && requestedHost !== null) {
      if (typeof requestedHost !== "string" || !requestedHost.trim()) {
        return NextResponse.json({ error: "host must be a host id", code: "invalid_host" }, { status: 400 });
      }
      const hostId = requestedHost.trim();
      if (hostId !== currentHost().id) {
        const target = getHost(hostId);
        if (!target || !target.enabled) {
          return NextResponse.json({ error: `Unknown host "${hostId}"`, code: "host_not_found", hostId }, { status: 404 });
        }
        // The wrapper probed the query/default host; the body names another
        // one, so probe that and re-enter the context for it.
        await target.ready();
        return await withHost(target, () => createSession(cwd, command as NewSessionCommand));
      }
    }

    return await createSession(cwd, command as NewSessionCommand);
  } catch (error) {
    return newSessionErrorResponse(error);
  }
});
