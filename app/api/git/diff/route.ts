import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";

// GET /api/git/diff?cwd=<abs>&path=<abs>[&host=<id>]
export const GET = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path", code: "cwd_must_be_absolute" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path", code: "path_must_be_absolute" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(host);
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    const [cwdAllowed, fileAllowed] = await Promise.all([
      isExistingFilePathAllowed(cwd, allowedRoots, host),
      isExistingFilePathAllowed(filePath, allowedRoots, host),
    ]);
    if (!cwdAllowed || !fileAllowed) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitFileDiff(cwd, filePath, host));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
