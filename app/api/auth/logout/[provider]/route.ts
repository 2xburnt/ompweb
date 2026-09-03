import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";

export const dynamic = "force-dynamic";

// omp has no logout RPC command (modes/rpc/rpc-types.ts) and no non-interactive
// CLI logout subcommand (cli-commands.ts) — credential removal only exists as
// the interactive /logout selector in omp's own TUI, backed by the SQLite
// credential store omp-web must never write.
export const POST = withHostRoute(async (
  _req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) => {
  const { provider } = await params;
  return NextResponse.json(
    {
      error:
        `omp-web cannot disconnect "${provider}": omp exposes no logout command outside its own UI. ` +
        "Run `omp` in a terminal and use /logout to remove the credential.",
      code: "logout_unsupported",
      host: currentHost().id,
    },
    { status: 501 },
  );
}, { ready: false });
