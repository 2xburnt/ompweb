import { NextResponse } from "next/server";
import { HostConfigError } from "./config";
import { withHost } from "./context";
import { getDefaultHost, getHost, HostNotFoundError, HostUnavailableError, listHosts, type Host } from "./registry";

/**
 * Route-handler wrappers that select the host for a request.
 *
 * Host-scoped routes (session list, files, git, settings, ...) take the host
 * from `?host=<id>` or the `x-omp-host` header and fall back to the default
 * host. Session-scoped routes (`/api/sessions/[id]/...`, `/api/agent/[id]`)
 * derive the host from the session id, since ids are unique across machines.
 */

export const HOST_QUERY_PARAM = "host";
export const HOST_HEADER = "x-omp-host";

export function hostIdFromRequest(req: Request): string | null {
  try {
    const fromQuery = new URL(req.url).searchParams.get(HOST_QUERY_PARAM)?.trim();
    if (fromQuery) return fromQuery;
  } catch {
    // Relative/invalid URL in tests: fall through to the header.
  }
  const fromHeader = req.headers.get(HOST_HEADER)?.trim();
  return fromHeader || null;
}

/** JSON error response for host-layer failures, or null for other errors. */
export function hostErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof HostNotFoundError) {
    return NextResponse.json({ error: error.message, code: error.code, hostId: error.hostId }, { status: 404 });
  }
  if (error instanceof HostUnavailableError) {
    return NextResponse.json({ error: error.message, code: error.code, hostId: error.hostId }, { status: 503 });
  }
  if (error instanceof HostConfigError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }
  return null;
}

// A client that forgets the host parameter silently gets the DEFAULT machine's
// answer, which reads as "the feature is broken" rather than as a routing bug
// (it shipped once: the composer showed the default machine's model registry
// for every session). With one machine configured the fallback is correct and
// silent; with several it is almost always a missing parameter, so say so once
// per route in the server log.
const warnedImplicitHostRoutes = new Set<string>();

function warnImplicitHost(req: Request): void {
  if (listHosts().length < 2) return;
  let route = "unknown";
  try {
    route = new URL(req.url).pathname;
  } catch {
    // Relative URL in tests: the generic warning is still useful.
  }
  if (warnedImplicitHostRoutes.has(route)) return;
  warnedImplicitHostRoutes.add(route);
  console.warn(`[omp-web] ${route} was called without a host; falling back to the default machine. The caller should pass ?host= or the ${HOST_HEADER} header.`);
}

export function resolveRequestHost(req: Request): Host | NextResponse {
  const id = hostIdFromRequest(req);
  if (!id) {
    warnImplicitHost(req);
    return getDefaultHost();
  }
  const host = getHost(id);
  if (!host || !host.enabled) {
    return NextResponse.json({ error: `Unknown host "${id}"`, code: "host_not_found", hostId: id }, { status: 404 });
  }
  return host;
}

type RouteHandler<A extends unknown[]> = (...args: A) => Promise<Response> | Response;

export interface WithHostOptions {
  /** Probe the host before running the handler (default true). Disable for
   * routes that only touch local state. */
  ready?: boolean;
}

async function runWithHost<A extends unknown[]>(host: Host, handler: RouteHandler<A>, args: A, options: WithHostOptions): Promise<Response> {
  if (options.ready !== false) {
    try {
      await host.ready();
    } catch (error) {
      return hostErrorResponse(error) ?? NextResponse.json({ error: String(error), code: "host_unavailable", hostId: host.id }, { status: 503 });
    }
  }
  try {
    return await withHost(host, () => handler(...args));
  } catch (error) {
    const response = hostErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** Wrap a host-scoped route handler. The request must be the first argument. */
export function withHostRoute<A extends unknown[]>(handler: RouteHandler<A>, options: WithHostOptions = {}): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const req = args[0] as Request;
    const host = resolveRequestHost(req);
    if (host instanceof NextResponse) return host;
    return runWithHost(host, handler, args, options);
  };
}

type SessionRouteContext = { params: Promise<{ id: string }> };

/** Wrap a session-scoped route handler (`[id]` segment). An explicit host
 * parameter wins; otherwise the host that owns the session is used, and an
 * unknown session runs against the default host so the handler can 404. */
export function withSessionRoute<A extends [Request, SessionRouteContext, ...unknown[]]>(
  handler: RouteHandler<A>,
  options: WithHostOptions = {},
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const req = args[0];
    const explicit = hostIdFromRequest(req);
    let host: Host | undefined;
    if (explicit) {
      host = getHost(explicit);
      if (!host || !host.enabled) {
        return NextResponse.json({ error: `Unknown host "${explicit}"`, code: "host_not_found", hostId: explicit }, { status: 404 });
      }
    } else {
      const { id } = await args[1].params;
      const { resolveSessionHost } = await import("@/lib/session-reader");
      host = (await resolveSessionHost(id)) ?? getDefaultHost();
    }
    return runWithHost(host, handler, args, options);
  };
}
