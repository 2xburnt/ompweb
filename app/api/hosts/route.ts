import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  HostConfigError,
  isValidHostId,
  loadHostsFile,
  normalizeHostConfig,
  saveHostsFile,
  slugifyHostId,
  upsertHostConfig,
} from "@/lib/hosts/config";
import { getHost, hostSummaries, listHosts, reloadHostRegistry } from "@/lib/hosts/registry";
import { hostErrorResponse } from "@/lib/hosts/route";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

function errorResponse(error: unknown): NextResponse {
  const hostError = hostErrorResponse(error);
  if (hostError) return hostError;
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  console.error("[api/hosts]", error);
  return NextResponse.json({ error: "Host request failed", code: "host_request_failed" }, { status: 500 });
}

async function probeAll(): Promise<void> {
  await Promise.allSettled(listHosts().map((host) => Promise.race([
    host.ready(),
    new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ])));
}

// GET /api/hosts[?probe=1] — configured machines and their connection state.
export async function GET(req: Request) {
  try {
    const probe = new URL(req.url).searchParams.get("probe") === "1";
    if (probe) await probeAll();
    const hosts = hostSummaries();
    return NextResponse.json({ hosts, defaultHost: hosts.find((host) => host.isDefault)?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/hosts — add a machine. Body: HostConfig without a required id
// (derived from the name or ssh host when omitted).
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown>>(req, MAX_BODY_BYTES);
    const rawId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : "";
    const ssh = body.ssh && typeof body.ssh === "object" ? (body.ssh as Record<string, unknown>) : undefined;
    const candidate = rawId || slugifyHostId(String(body.name ?? "")) || slugifyHostId(String(ssh?.host ?? ""));
    if (!isValidHostId(candidate)) {
      throw new HostConfigError("invalid_id", "Could not derive a valid host id; provide one explicitly");
    }
    const config = normalizeHostConfig({ ...body, id: candidate, kind: body.kind ?? (ssh ? "ssh" : "local") });
    const loaded = loadHostsFile();
    if (loaded.file.hosts.some((host) => host.id === config.id)) {
      return NextResponse.json({ error: `Host "${config.id}" already exists`, code: "host_exists" }, { status: 409 });
    }
    const next = upsertHostConfig(loaded.file, config);
    saveHostsFile(body.makeDefault === true ? { ...next, defaultHost: config.id } : next);
    reloadHostRegistry();
    const host = getHost(config.id);
    if (host?.enabled) {
      await host.ready().catch(() => {});
    }
    return NextResponse.json({ host: hostSummaries().find((summary) => summary.id === config.id) ?? null }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// PUT /api/hosts — body: { defaultHost: string }
export async function PUT(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ defaultHost?: unknown }>(req, MAX_BODY_BYTES);
    const loaded = loadHostsFile();
    if (!isValidHostId(body.defaultHost) || !loaded.file.hosts.some((host) => host.id === body.defaultHost)) {
      return NextResponse.json({ error: "defaultHost must name a configured host", code: "host_not_found" }, { status: 404 });
    }
    saveHostsFile({ ...loaded.file, defaultHost: body.defaultHost });
    reloadHostRegistry();
    return NextResponse.json({ hosts: hostSummaries(), defaultHost: body.defaultHost });
  } catch (error) {
    return errorResponse(error);
  }
}
