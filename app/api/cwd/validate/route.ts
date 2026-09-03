import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { allowFileRoot } from "@/lib/file-access";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { hostProjectKey } from "@/lib/paths";
import { normalizeProjectCwd } from "@/lib/project-registry";
import { resolveProject } from "@/lib/worktree";

// POST /api/cwd/validate[?host=<id>]  body: { cwd: string }
// Validates a candidate workspace on the selected host before the UI selects
// it. Returns { success, cwd, projectRoot, projectKey, host } where projectKey
// is host-scoped (`<hostId>:<identity>`), matching the session list.
export const POST = withHostRoute(async (req: Request) => {
  try {
    const host = currentHost();
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required", code: "path_required" }, { status: 400 });
    }

    const normalizedCwd = normalizeProjectCwd(cwd);
    let isDirectory: boolean;
    try {
      isDirectory = (await host.fs.stat(normalizedCwd)).isDirectory();
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}`, code: "directory_not_found" }, { status: 400 });
    }

    if (!isDirectory) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}`, code: "not_a_directory" }, { status: 400 });
    }

    allowFileRoot(normalizedCwd, host);
    const project = await resolveProject(normalizedCwd, host);
    return NextResponse.json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: project.projectRoot,
      projectKey: hostProjectKey(host.id, project.projectRoot),
      host: host.id,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
