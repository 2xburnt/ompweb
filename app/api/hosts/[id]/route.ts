import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { loadHostsFile, normalizeHostConfig, removeHostConfig, saveHostsFile, upsertHostConfig } from "@/lib/hosts/config";
import { getHost, hostSummaries, reloadHostRegistry } from "@/lib/hosts/registry";
import { hostErrorResponse } from "@/lib/hosts/route";
import { destroyRpcSessionsForHost } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

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

const NOT_FOUND = { error: "Host not found", code: "host_not_found" } as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const summary = hostSummaries().find((host) => host.id === id);
  if (!summary) return NextResponse.json(NOT_FOUND, { status: 404 });
  return NextResponse.json({ host: summary }, { headers: { "Cache-Control": "no-store" } });
}

// PATCH /api/hosts/[id] — partial update of the host config (id is immutable).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit<Record<string, unknown>>(req, MAX_BODY_BYTES);
    const loaded = loadHostsFile();
    const existing = loaded.file.hosts.find((host) => host.id === id);
    if (!existing) return NextResponse.json(NOT_FOUND, { status: 404 });
    const merged: Record<string, unknown> = { ...existing, ...body, id, kind: existing.kind };
    if (body.ssh && typeof body.ssh === "object" && existing.ssh) {
      merged.ssh = { ...existing.ssh, ...(body.ssh as Record<string, unknown>) };
    }
    // Explicit empty strings clear optional fields.
    for (const key of ["ompBin", "agentDir", "defaultCwd"] as const) {
      if (body[key] === "" || body[key] === null) delete merged[key];
    }
    const config = normalizeHostConfig(merged);
    saveHostsFile(upsertHostConfig(loaded.file, config));
    reloadHostRegistry();
    invalidateSessionListCache();
    if (!config.enabled) await destroyRpcSessionsForHost(id).catch(() => {});
    const host = getHost(id);
    if (host?.enabled) await host.refresh().catch(() => {});
    return NextResponse.json({ host: hostSummaries().find((summary) => summary.id === id) ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const loaded = loadHostsFile();
    if (!loaded.file.hosts.some((host) => host.id === id)) return NextResponse.json(NOT_FOUND, { status: 404 });
    if (loaded.file.hosts.length === 1) {
      return NextResponse.json({ error: "The last host cannot be removed", code: "last_host" }, { status: 400 });
    }
    await destroyRpcSessionsForHost(id).catch(() => {});
    saveHostsFile(removeHostConfig(loaded.file, id));
    reloadHostRegistry();
    invalidateSessionListCache();
    return NextResponse.json({ success: true, hosts: hostSummaries() });
  } catch (error) {
    return errorResponse(error);
  }
}
