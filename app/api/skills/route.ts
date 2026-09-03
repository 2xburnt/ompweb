import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { readTextFile } from "@/lib/omp/host-io";
import {
  getSkillScanRootDirs,
  loadSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

// SKILL.md files are prose; anything past this is not a skill definition.
const MAX_SKILL_BYTES = 1024 * 1024;

// GET /api/skills?cwd=<path>
// Scans the same skill roots omp discovers (~/.omp/agent/skills, project
// .omp/skills, and the .claude/.agents/.codex/.github compat directories).
export const GET = withHostRoute(async (req: NextRequest) => {
  const host = currentHost();
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots(host);
    if (!(await isExistingFilePathAllowed(cwd, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return NextResponse.json({ ...(await loadSkillsWithInstallInfo(cwd, host)), host: host.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
});

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export const PATCH = withHostRoute(async (req: NextRequest) => {
  try {
    const host = currentHost();
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean; cwd?: string };
    const { filePath, disableModelInvocation, cwd } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required", code: "file_path_required" }, { status: 400 });
    if (host.pathApi.basename(filePath) !== "SKILL.md") {
      return NextResponse.json({ error: "not a SKILL.md file", code: "not_a_skill_file" }, { status: 400 });
    }
    if (!(await host.fs.exists(filePath))) return NextResponse.json({ error: "file not found", code: "file_not_found" }, { status: 404 });
    // Every root the scanner reads must be writable here, or skills in the
    // compat dirs (~/.agents/skills — where the app's own global installs land,
    // ~/.claude/skills, ~/.codex/skills, managed-skills) could be listed but
    // never toggled. Session cwds cover the project-scope roots.
    const allowedRoots = new Set(await getAllowedFileRoots(host));
    // An optional cwd (already an allowed root) additionally covers the
    // project walk-up roots discovery visits above the session directory.
    const scanCwd = cwd && (await isExistingFilePathAllowed(cwd, allowedRoots, host)) ? cwd : undefined;
    for (const dir of await getSkillScanRootDirs(scanCwd, host)) allowedRoots.add(dir);
    // Resolve symlinks once up front and authorize the resolved path: the
    // read/write below then operate on the same resolved path, so a symlink
    // swapped between the authorization check and the write cannot redirect
    // it outside the checked roots.
    const resolvedFilePath = await host.fs.realpath(filePath);
    if (!(await isExistingFilePathAllowed(resolvedFilePath, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const content = await readTextFile(host, resolvedFilePath, MAX_SKILL_BYTES);
    if (content === null) return NextResponse.json({ error: "file not found", code: "file_not_found" }, { status: 404 });
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    if (updated !== content) await host.fs.writeFile(resolvedFilePath, updated);

    // Report what the file now says rather than what was asked for.
    const { frontmatter } = parseSkillFrontmatter(updated);
    return NextResponse.json({ success: true, disableModelInvocation: readDisableModelInvocation(frontmatter), host: host.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
});
