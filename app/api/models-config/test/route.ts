import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import { withHostRoute } from "@/lib/hosts/route";
import { makeHostTempDir } from "@/lib/omp/host-io";
import {
  type ModelDefinition,
  type ProviderConfig,
  serializeModelsConfig,
  validateModelsConfig,
} from "@/lib/omp/models-config";
import { hostTmpdir } from "@/lib/omp/paths";
import { type OmpModel, runIsolatedUtilityCommand } from "@/lib/omp/rpc-utility";

export const dynamic = "force-dynamic";

// Registry resolution (spawn + model discovery), not a completion round-trip:
// omp-web cannot send test prompts without going through a full agent session.
const TEST_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const POST = withHostRoute(async (req: NextRequest) => {
  const host = currentHost();
  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required", code: "provider_name_required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required", code: "provider_required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required", code: "model_required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required", code: "model_id_required" }, { status: 400 });

    const config = {
      providers: {
        [providerName]: {
          ...(body.provider as ProviderConfig),
          models: [{ ...(body.model as ModelDefinition), id: modelId }],
        },
      },
    };
    try {
      validateModelsConfig(config);
    } catch (error) {
      return NextResponse.json({ ok: false, error: errorMessage(error) });
    }

    // Isolated throwaway agent dir ON THE HOST that runs omp: the spawned omp
    // sees only this candidate config (no stored credentials, no models.db
    // cache) and never touches ~/.omp. Profile/XDG overrides are cleared so the
    // redirect always wins. The candidate may carry an API key, so the file is
    // owner-only.
    tempDir = await makeHostTempDir(host, hostTmpdir(), "omp-web-model-test-");
    await host.fs.writeFile(host.pathApi.join(tempDir, "models.yml"), serializeModelsConfig(config), { mode: 0o600 });

    const startedAt = Date.now();
    const { models } = await runIsolatedUtilityCommand<{ models: OmpModel[] }>(
      { type: "get_available_models" },
      {
        env: { PI_CODING_AGENT_DIR: tempDir, OMP_PROFILE: "", PI_PROFILE: "", XDG_DATA_HOME: "" },
        timeoutMs: TEST_TIMEOUT_MS,
        signal: req.signal,
        host,
      },
    );
    const latencyMs = Date.now() - startedAt;

    const found = models.find((m) => m.provider === providerName && m.id === modelId);
    if (!found) {
      return NextResponse.json({
        ok: false,
        error: `Model ${providerName}/${modelId} did not resolve — check the API key and provider config`,
        code: "model_test_unresolved",
        latencyMs,
        host: host.id,
      });
    }

    return NextResponse.json({
      ok: true,
      latencyMs,
      responseText: `${found.provider}/${found.id} resolved (configuration only; credentials were not contacted)`,
      host: host.id,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) await host.fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
