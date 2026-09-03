import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { AGENT_NAME_RE, MAX_AGENT_BYTES, deleteAgent, discoverAgents, readAgentFile, resolveAgentsScope, unpackBundled, validateAgentFileReference, validateAgentPayload, writeAgent, type AgentPayload } from "@/lib/omp/agents-service";
import { getUserAgentsDir, resolveProjectAgentsDir } from "@/lib/omp/paths";

export const dynamic = "force-dynamic";

// JSON can expand control characters in a maximum-size agent prompt to six
// bytes each, with room for the envelope fields.
const MAX_AGENT_REQUEST_BYTES = MAX_AGENT_BYTES * 6 + 64 * 1024;

type Scope = "all" | "user" | "project" | "bundled";

async function allowedCwd(value: unknown, required = true): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error("cwd is required");
    return undefined;
  }
  const host = currentHost();
  const roots = await getAllowedFileRoots(host);
  try {
    if (!(await host.fs.stat(value)).isDirectory()) throw new Error("Workspace is not allowed");
  } catch {
    throw new Error("Workspace is not allowed");
  }
  if (!(await isExistingFilePathAllowed(value, roots, host))) throw new Error("Workspace is not allowed");
  return value;
}

async function allowedProjectScope(value: unknown): Promise<{ cwd: string; dir: string }> {
  const cwd = await allowedCwd(value);
  if (!cwd) throw new Error("cwd is required");
  const host = currentHost();
  const dir = await resolveProjectAgentsDir(cwd);
  const roots = await getAllowedFileRoots(host);
  const pathApi = host.pathApi;
  let probe = pathApi.resolve(dir);
  while (!(await host.fs.exists(probe))) {
    const parent = pathApi.dirname(probe);
    if (parent === probe) throw new Error("Workspace is not allowed");
    probe = parent;
  }
  if (!(await isExistingFilePathAllowed(probe, roots, host))) throw new Error("Workspace is not allowed");
  return { cwd, dir };
}

function parseScope(value: string | null | undefined, allowBundled = true): Scope {
  const scope = value ?? "all";
  if (scope === "user" || scope === "project" || (allowBundled && scope === "bundled") || scope === "all") return scope as Scope;
  throw new Error("scope must be all, user, project, or bundled");
}

export const GET = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const params = new URL(request.url).searchParams;
    const scope = parseScope(params.get("scope"));
    const cwdParam = params.get("cwd");
    if (scope === "project" && !cwdParam) throw new Error("cwd is required for project scope");
    // A workspace is needed to discover project agents (and for the default
    // all-scope view), but user/bundled-only reads do not depend on it.
    const project = scope === "project" || (scope === "all" && cwdParam)
      ? await allowedProjectScope(cwdParam)
      : undefined;
    const cwd = project?.cwd;
    const result = await discoverAgents(cwd, host);
    const agents = scope === "all" ? result.agents : result.agents.filter((agent) => agent.scope === scope);
    return NextResponse.json({
      agents,
      diagnostics: result.diagnostics,
      userPath: getUserAgentsDir(),
      projectPath: project?.dir ?? null,
      bundledPath: result.bundledPath,
      host: host.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
});

export const POST = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await parseJsonWithinLimit<{ action?: unknown; cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; agent?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.action === "unpack") {
      if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
      const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
      const cwd = project?.cwd;
      const targetDir = project?.dir ?? await resolveAgentsScope(cwd, body.scope, host);
      return NextResponse.json({ success: true, ...(await unpackBundled(targetDir, false, host)), host: host.id });
    }
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    if (!AGENT_NAME_RE.test(body.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    validateAgentPayload({ ...(body.agent as Record<string, unknown>), name: body.name });
    const scopeDir = project?.dir ?? await resolveAgentsScope(cwd, body.scope, host);
    const written = await writeAgent(scopeDir, body.name.trim(), body.agent as AgentPayload, body.previousName, host);
    const agent = await readAgentFile(written.path, host);
    return NextResponse.json({ success: true, ...written, agent, host: host.id });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
});

export const PUT = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown; previousName?: unknown; agent?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    if (!AGENT_NAME_RE.test(body.name.trim())) throw new Error(`name must match ${AGENT_NAME_RE.source}`);
    if (body.previousName !== undefined && typeof body.previousName !== "string") throw new Error("previousName must be a string");
    validateAgentPayload({ ...(body.agent as Record<string, unknown>), name: body.name });
    const scopeDir = project?.dir ?? await resolveAgentsScope(cwd, body.scope, host);
    const written = await writeAgent(scopeDir, body.name.trim(), body.agent as AgentPayload, body.previousName, host);
    return NextResponse.json({ success: true, ...written, agent: await readAgentFile(written.path, host), host: host.id });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /not allowed/i.test(message) ? 403 : 400 });
  }
});

export const DELETE = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const body = await parseJsonWithinLimit<{ cwd?: unknown; scope?: unknown; name?: unknown }>(request, MAX_AGENT_REQUEST_BYTES);
    if (body.scope !== "user" && body.scope !== "project") throw new Error("scope must be user or project");
    const project = body.scope === "project" ? await allowedProjectScope(body.cwd) : undefined;
    const cwd = project?.cwd;
    if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required");
    const scopeDir = project?.dir ?? await resolveAgentsScope(cwd, body.scope, host);
    await validateAgentFileReference(scopeDir, body.name.trim(), host);
    return NextResponse.json({ success: true, ...(await deleteAgent(scopeDir, body.name.trim(), host)), host: host.id });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Agent request is too large" }, { status: 413 });
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /not allowed/i.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
});
