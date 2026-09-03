import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import {
  createBashOutputReadStream,
  MAX_INLINE_BASH_OUTPUT_BYTES,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "@/lib/bash-output";
import { withSessionRoute } from "@/lib/hosts/route";
import { hostTmpdir } from "@/lib/omp/paths";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";

// GET /api/agent/[id]/bash-output?path=<absPath>[&download=1]
// Serves the full output of a bash execution whose session entry recorded a
// `fullOutputPath` temp file — on the host that ran the session, in its temp
// directory. Inline display is size-limited (413 when the file exceeds
// MAX_INLINE_BASH_OUTPUT_BYTES); `download=1` streams the file without
// buffering it. Access requires the session to actually reference the path —
// a path alone is never enough.
export const GET = withSessionRoute(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  let path: string | null = null;
  let download = false;
  try {
    const url = new URL(_req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const resolved = resolveBashOutputPath(path, hostTmpdir());
  if (!resolved) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  if (!await isBashOutputPathReferencedBySession(resolved, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (download) {
      const stream = Readable.toWeb(await createBashOutputReadStream(resolved)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"bash-output.log\"",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) {
      return NextResponse.json({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413 });
    }
    return NextResponse.json({ success: true, data: { output: result.content } });
  } catch {
    return NextResponse.json({ error: "full output unavailable" }, { status: 404 });
  }
});
