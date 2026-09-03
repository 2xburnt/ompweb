import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import type { Host } from "@/lib/hosts/registry";
import { withSessionRoute } from "@/lib/hosts/route";
import { hostPath, hostTmpdir } from "@/lib/omp/paths";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";

export const runtime = "nodejs";

// Ceiling on the rendered HTML pulled back from the host into one response.
const MAX_EXPORT_HTML_BYTES = 256 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 60_000;
const REMOTE_TOO_LARGE_EXIT = 46;

class ExportTooLargeError extends Error {
  constructor() {
    super("Exported session is too large to download");
    this.name = "ExportTooLargeError";
  }
}

// Remote hosts: render, size-check, stream back and clean up in ONE round
// trip. omp's stdout is dropped (only the file is the export); its stderr
// reaches the ExecError when it fails.
const REMOTE_EXPORT_SCRIPT = [
  'bin="$1"; src="$2"; out="$3"; max="$4"',
  'mkdir -p -- "$(dirname -- "$out")" || exit 1',
  'if ! "$bin" --export "$src" "$out" >/dev/null; then rm -f -- "$out"; exit 1; fi',
  'sz=$(wc -c < "$out" 2>/dev/null | tr -d " ") || { rm -f -- "$out"; exit 1; }',
  `if [ "$sz" -gt "$max" ]; then rm -f -- "$out"; exit ${REMOTE_TOO_LARGE_EXIT}; fi`,
  'cat -- "$out"; rc=$?',
  'rm -f -- "$out"',
  "exit $rc",
].join("\n");

/**
 * Render a session to self-contained HTML by running the host's omp binary:
 * `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 * The output lands in the host's temp dir and is read back bounded, then
 * removed — nothing is mirrored to local disk.
 */
async function exportSessionHtml(host: Host, filePath: string): Promise<Buffer> {
  const bin = resolveOmpBin(host);
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  const pathApi = hostPath();
  const tempDir = pathApi.join(hostTmpdir(), "omp-web-export");
  const outputPath = pathApi.join(tempDir, `${randomUUID()}.html`);

  if (!host.isLocal) {
    const result = await host.executor.exec(
      ["sh", "-c", REMOTE_EXPORT_SCRIPT, "sh", bin, filePath, outputPath, String(MAX_EXPORT_HTML_BYTES)],
      { cwd: hostTmpdir(), timeoutMs: EXPORT_TIMEOUT_MS + 60_000, maxBuffer: MAX_EXPORT_HTML_BYTES + 4096, allowFailure: true },
    );
    if (result.code === REMOTE_TOO_LARGE_EXIT) throw new ExportTooLargeError();
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`omp --export failed${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
  }

  await host.fs.mkdir(tempDir, { recursive: true });
  try {
    await host.executor.exec([bin, "--export", filePath, outputPath], {
      cwd: hostTmpdir(),
      timeoutMs: EXPORT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if ((await host.fs.stat(outputPath)).size > MAX_EXPORT_HTML_BYTES) throw new ExportTooLargeError();
    return await host.fs.readFile(outputPath);
  } finally {
    await host.fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

export const GET = withSessionRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    const host = currentHost();

    const sessionBase = hostPath().basename(filePath, ".jsonl");
    const fileName = `omp-session-${sessionBase}.html`;
    const html = await exportSessionHtml(host, filePath);
    return new Response(new Uint8Array(html), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": getContentDisposition(fileName, inline, "session.html"),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ExportTooLargeError) {
      return NextResponse.json({ error: message, code: "export_too_large" }, { status: 413 });
    }
    if (message.includes("omp binary not found")) {
      return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
    }
    return apiErrorResponse(error);
  }
});
