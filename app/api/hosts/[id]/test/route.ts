import { NextResponse } from "next/server";
import { getHost, hostSummaries } from "@/lib/hosts/registry";

export const dynamic = "force-dynamic";

// POST /api/hosts/[id]/test — re-probe connectivity and the omp install.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const host = getHost(id);
  if (!host) return NextResponse.json({ error: "Host not found", code: "host_not_found" }, { status: 404 });
  let ok = true;
  let error: string | null = null;
  try {
    await host.refresh();
  } catch (failure) {
    ok = false;
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const summary = hostSummaries().find((entry) => entry.id === id) ?? null;
  return NextResponse.json({ ok, error, host: summary }, { status: ok ? 200 : 503 });
}
