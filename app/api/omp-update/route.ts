import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import type { Host } from "@/lib/hosts/registry";
import { withHostRoute } from "@/lib/hosts/route";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { checkOmpUpdate, OMP_UPDATE_INSTALL_TIMEOUT_MS, runOmpUpdateInstall } from "@/lib/omp/updates";
import { restartAllRpcSessions } from "@/lib/rpc-manager";
import {
  acknowledgeSelfUpdate,
  commitSelfUpdate,
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  prepareSelfUpdate,
  SelfUpdateError,
  validateCommitSelfUpdate,
} from "@/lib/self-update";

export const dynamic = "force-dynamic";

const OMP_KIND = "omp" as const;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SelfUpdateError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  return NextResponse.json({ error: "The OMP update could not be started", code: "update_failed" }, { status: 500 });
}

// ----------------------------------------------------------------------------
// Remote hosts: `omp update` runs on the host through its executor. There is
// no ompweb process to restart there, so the local lease/launcher machinery in
// lib/self-update.ts does not apply; an in-memory attempt per host mirrors its
// prepare/commit/status/acknowledge protocol so the client flow is unchanged.
// ----------------------------------------------------------------------------

interface RemoteOmpUpdateAttempt {
  attemptId: string;
  kind: typeof OMP_KIND;
  hostId: string;
  state: "prepared" | "running" | "succeeded" | "failed";
  stage: "preparing" | "installing" | "restarting" | "finalizing";
  fromVersion: string;
  targetVersion: string;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  sessionsRestarted?: number;
  output?: string;
}

declare global {
  var __ompRemoteOmpUpdates: Map<string, RemoteOmpUpdateAttempt> | undefined;
}

function remoteAttempts(): Map<string, RemoteOmpUpdateAttempt> {
  return (globalThis.__ompRemoteOmpUpdates ??= new Map());
}

async function prepareRemoteOmpUpdate(host: Host): Promise<RemoteOmpUpdateAttempt> {
  const existing = remoteAttempts().get(host.id);
  if (existing && (existing.state === "prepared" || existing.state === "running")) {
    throw new SelfUpdateError("update_in_progress", "Another update is already in progress", 409);
  }
  const status = await checkOmpUpdate(true, host);
  if (!status.updateAvailable || !status.availableVersion) {
    throw new SelfUpdateError("no_update_available", "No OMP update available", 409);
  }
  const attempt: RemoteOmpUpdateAttempt = {
    attemptId: randomUUID(),
    kind: OMP_KIND,
    hostId: host.id,
    state: "prepared",
    stage: "preparing",
    fromVersion: status.currentVersion ?? "unknown",
    targetVersion: status.availableVersion,
    preparedAt: new Date().toISOString(),
  };
  remoteAttempts().set(host.id, attempt);
  return attempt;
}

function commitRemoteOmpUpdate(host: Host, attemptId: string): RemoteOmpUpdateAttempt {
  const attempt = remoteAttempts().get(host.id);
  if (!attempt || attempt.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  if (attempt.state !== "prepared") return attempt;
  attempt.state = "running";
  attempt.stage = "installing";
  attempt.startedAt = new Date().toISOString();
  void runOmpUpdateInstall(OMP_UPDATE_INSTALL_TIMEOUT_MS, host).then(
    (output) => {
      attempt.output = output.slice(-2000);
      attempt.stage = "finalizing";
      attempt.state = "succeeded";
      attempt.finishedAt = new Date().toISOString();
    },
    (error: unknown) => {
      attempt.state = "failed";
      attempt.error = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      attempt.finishedAt = new Date().toISOString();
    },
  );
  return attempt;
}

function publicAttempt(attempt: RemoteOmpUpdateAttempt): Omit<RemoteOmpUpdateAttempt, "output"> {
  const rest: RemoteOmpUpdateAttempt = { ...attempt };
  delete rest.output;
  return rest;
}

export const POST = withHostRoute(async (request: NextRequest) => {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed", code: "cross_origin_forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, { status: 415 });
  }
  const host = currentHost();
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown> | null>(request, 4_096);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SelfUpdateError("invalid_action", "action must be check, restart, update, status, or acknowledge");
    const keys = Object.keys(body);
    if (body.action === "check") {
      return NextResponse.json({ ...(await checkOmpUpdate(body.force === true, host)), host: host.id });
    }
    if (body.action === "restart" && keys.length === 1) {
      const sessionsRestarted = await restartAllRpcSessions(host.id);
      return NextResponse.json({ success: true, sessionsRestarted, host: host.id });
    }
    if (host.isLocal) {
      // The local machine goes through the durable self-update flow (lease,
      // detached worker, server restart) in lib/self-update.ts.
      if (body.action === "update" && keys.length === 1) {
        const result = await prepareSelfUpdate(OMP_KIND);
        return NextResponse.json({ ...result, host: host.id }, { status: 202 });
      }
      if (body.action === "commit" && keys.length === 2 && typeof body.attemptId === "string") {
        const commitState = validateCommitSelfUpdate(body.attemptId, OMP_KIND);
        if (commitState !== "replay") {
          if (commitState === "ready") markSelfUpdateStopping(body.attemptId, OMP_KIND);
          commitSelfUpdate(body.attemptId, OMP_KIND);
        }
        return NextResponse.json({ accepted: true, attemptId: body.attemptId, host: host.id }, { status: 202 });
      }
      if (body.action === "status" && keys.length === 1) {
        const selfUpdateStatus = getSelfUpdateStatus(OMP_KIND);
        return NextResponse.json(selfUpdateStatus ?? null, { headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "acknowledge" && keys.length === 2 && typeof body.attemptId === "string") {
        return NextResponse.json({ ...acknowledgeSelfUpdate(body.attemptId, OMP_KIND), host: host.id });
      }
    } else {
      if (body.action === "update" && keys.length === 1) {
        const attempt = await prepareRemoteOmpUpdate(host);
        return NextResponse.json({ attemptId: attempt.attemptId, fromVersion: attempt.fromVersion, targetVersion: attempt.targetVersion, host: host.id }, { status: 202 });
      }
      if (body.action === "commit" && keys.length === 2 && typeof body.attemptId === "string") {
        commitRemoteOmpUpdate(host, body.attemptId);
        return NextResponse.json({ accepted: true, attemptId: body.attemptId, host: host.id }, { status: 202 });
      }
      if (body.action === "status" && keys.length === 1) {
        const attempt = remoteAttempts().get(host.id);
        return NextResponse.json(attempt ? publicAttempt(attempt) : null, { headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "acknowledge" && keys.length === 2 && typeof body.attemptId === "string") {
        const attempt = remoteAttempts().get(host.id);
        if (!attempt || attempt.attemptId !== body.attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
        if (attempt.state === "succeeded" || attempt.state === "failed") remoteAttempts().delete(host.id);
        return NextResponse.json({ acknowledged: true, attemptId: body.attemptId, host: host.id });
      }
    }
    throw new SelfUpdateError("invalid_action", "action must be check, restart, update, status, or acknowledge");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message, code: "body_too_large" }, { status: 413 });
    if (error instanceof SyntaxError) return errorResponse(new SelfUpdateError("invalid_json", "Request body must be valid JSON"));
    return errorResponse(error);
  }
});
