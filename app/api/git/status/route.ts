import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";

// GET /api/git/status?cwd=<abs>[&host=<id>]
export const GET = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(host);
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    let isDirectory: boolean;
    try {
      isDirectory = (await host.fs.stat(cwd)).isDirectory();
    } catch {
      return NextResponse.json({ error: "Directory not found", code: "directory_not_found" }, { status: 404 });
    }
    if (!isDirectory) {
      return NextResponse.json({ error: "Not a directory", code: "not_a_directory" }, { status: 400 });
    }
    if (!(await isExistingFilePathAllowed(cwd, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitStatus(cwd, host));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
