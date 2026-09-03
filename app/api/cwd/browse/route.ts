import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";

// GET /api/cwd/browse?path=...[&host=<id>]：列出所选主机文件系统中的可读子目录。
// The Windows drive picker only applies to the local machine on win32; remote
// hosts are POSIX and start at their home directory.
export const GET = withHostRoute(async (request: NextRequest) => {
  try {
    const host = currentHost();
    const requested = request.nextUrl.searchParams.get("path")?.trim();
    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({ path: "", parentPath: null, drives: await listWindowsDrives(host), directories: [], host: host.id });
    }
    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate, host);
    } catch {
      return NextResponse.json({ error: "Directory does not exist", code: "directory_not_found" }, { status: 404 });
    }

    const directoryStat = await host.fs.stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory", code: "not_a_directory" }, { status: 400 });
    }

    // ?files=1 turns this into a file picker as well, for settings that name
    // a file rather than a directory (an SSH key, the omp binary).
    const includeFiles = request.nextUrl.searchParams.get("files") === "1";
    const directories = await listDirectories(resolved, host, { includeFiles });

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
      host: host.id,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
});
