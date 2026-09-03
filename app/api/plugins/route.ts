import { NextResponse, type NextRequest } from "next/server";
import { currentHost } from "@/lib/hosts/context";
import type { Host } from "@/lib/hosts/registry";
import { withHostRoute } from "@/lib/hosts/route";
import { existingPaths } from "@/lib/omp/host-io";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

// Plugin management is delegated to the host's omp binary (`omp plugin ...`
// through the host executor); omp-web never embeds the Bun-only SDK. `--json`
// output shapes are mirrored from oh-my-pi coding-agent src/cli/plugin-cli.ts
// + extensibility/plugins.

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

interface OmpPluginManifest {
  name?: string;
  version?: string;
  description?: string;
  tools?: string;
  hooks?: string;
  extensions?: string[];
  commands?: string[];
  features?: Record<string, unknown>;
}

interface OmpNpmPlugin {
  name: string;
  version: string;
  path: string;
  manifest?: OmpPluginManifest;
  enabledFeatures?: string[] | null;
  enabled: boolean;
}

interface OmpMarketplaceEntry {
  scope?: "user" | "project";
  installPath?: string;
  version?: string;
  enabled?: boolean;
}

interface OmpMarketplacePlugin {
  id: string;
  scope?: "user" | "project";
  entries?: OmpMarketplaceEntry[];
  shadowedBy?: string;
}

interface OmpPluginList {
  npm?: OmpNpmPlugin[];
  marketplace?: OmpMarketplacePlugin[];
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

async function runOmp(
  host: Host,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveOmpBin(host);
  if (!bin) {
    throw new Error(host.isLocal
      ? "omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN."
      : `omp binary not found on host "${host.id}". Install oh-my-pi there or set the host's ompBin.`);
  }
  const result = await host.executor.exec([bin, ...args], {
    cwd: opts.cwd,
    timeoutMs: opts.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { FORCE_COLOR: "0", NO_COLOR: "1" },
    allowFailure: true,
  });
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr;
  if (result.code !== 0) {
    const detail = (stderr || stdout || `exit ${result.signal ?? result.code ?? "unknown"}`).replace(ANSI_RE, "").trim();
    throw new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`);
  }
  return { stdout, stderr };
}

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}

/** Best-effort scan of a plugin's skills/ directory on the host (omp discovers
 * plugin-root skills the same way) so the UI can show a resource count. */
async function scanPluginSkills(host: Host, pluginPath: string): Promise<PluginResourceInfo[]> {
  const pathApi = host.pathApi;
  const skillsDir = pathApi.join(pluginPath, "skills");
  let entries;
  try {
    entries = await host.fs.readdir(skillsDir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => ({ name: entry.name, path: pathApi.join(skillsDir, entry.name, "SKILL.md") }));
  const present = await existingPaths(host, candidates.map((candidate) => candidate.path));
  return candidates
    .filter((candidate) => present.has(candidate.path))
    .map((candidate) => ({
      kind: "skill" as const,
      name: candidate.name,
      path: candidate.path,
      relativePath: pathApi.join("skills", candidate.name, "SKILL.md"),
    }));
}

function manifestResources(host: Host, pluginPath: string, manifest: OmpPluginManifest | undefined): PluginResourceInfo[] {
  const pathApi = host.pathApi;
  const resources: PluginResourceInfo[] = [];
  const push = (kind: PluginResourceInfo["kind"], rel: string) => {
    const file = pathApi.basename(rel);
    const ext = pathApi.extname(file);
    resources.push({
      kind,
      name: ext ? file.slice(0, -ext.length) : file,
      path: pathApi.join(pluginPath, rel),
      relativePath: rel,
    });
  };
  for (const rel of manifest?.extensions ?? []) push("extension", rel);
  if (manifest?.tools) push("extension", manifest.tools);
  if (manifest?.hooks) push("extension", manifest.hooks);
  // omp "commands" (slash commands) are the closest analog of pi prompts.
  for (const rel of manifest?.commands ?? []) push("prompt", rel);
  return resources;
}

async function toNpmPackageInfo(host: Host, plugin: OmpNpmPlugin): Promise<PluginPackageInfo> {
  const resources = [
    ...manifestResources(host, plugin.path, plugin.manifest),
    ...(await scanPluginSkills(host, plugin.path)),
  ];
  const counts = emptyCounts();
  for (const resource of resources) {
    if (resource.kind === "extension") counts.extensions += 1;
    else if (resource.kind === "skill") counts.skills += 1;
    else if (resource.kind === "prompt") counts.prompts += 1;
    else counts.themes += 1;
  }
  const installed = Boolean(plugin.path && (await host.fs.exists(plugin.path)));
  const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
  return {
    source: plugin.name,
    scope: "global",
    filtered: Array.isArray(plugin.enabledFeatures),
    disabled: plugin.enabled === false,
    installedPath: plugin.path || undefined,
    packageName: plugin.name,
    version: plugin.version || plugin.manifest?.version,
    configuredVersion: undefined,
    counts,
    resources,
    status: plugin.enabled === false
      ? "disabled"
      : resourceCount > 0
        ? "loaded"
        : installed
          ? "installed"
          : "missing",
  };
}

async function toMarketplacePackageInfo(host: Host, plugin: OmpMarketplacePlugin): Promise<PluginPackageInfo> {
  const entry = plugin.entries?.[0];
  const installedPath = entry?.installPath;
  const installed = Boolean(installedPath && (await host.fs.exists(installedPath)));
  const resources = installedPath ? await scanPluginSkills(host, installedPath) : [];
  const counts = emptyCounts();
  counts.skills = resources.length;
  const disabled = entry?.enabled === false;
  return {
    source: plugin.id,
    scope: plugin.scope === "project" ? "project" : "global",
    filtered: false,
    disabled,
    installedPath: installedPath || undefined,
    packageName: plugin.id,
    version: entry?.version,
    configuredVersion: undefined,
    counts,
    resources,
    status: disabled ? "disabled" : resources.length > 0 ? "loaded" : installed ? "installed" : "missing",
  };
}

async function readPlugins(host: Host, cwd: string): Promise<PluginsResponse & { host: string }> {
  const diagnostics: PluginDiagnostic[] = [];
  const packages: PluginPackageInfo[] = [];
  const totals = emptyCounts();

  try {
    const { stdout } = await runOmp(host, ["plugin", "list", "--json"], { cwd, timeout: 60_000 });
    const list = parseJsonLoose<OmpPluginList>(stdout);
    if (!list) {
      diagnostics.push({
        type: "error",
        message: "Could not parse `omp plugin list --json` output.",
      });
    } else {
      for (const plugin of list.npm ?? []) {
        packages.push(await toNpmPackageInfo(host, plugin));
      }
      for (const plugin of list.marketplace ?? []) {
        const info = await toMarketplacePackageInfo(host, plugin);
        if (plugin.shadowedBy) {
          diagnostics.push({
            type: "warning",
            source: plugin.id,
            message: `Shadowed by a ${plugin.shadowedBy}-scoped install of the same plugin.`,
          });
        }
        packages.push(info);
      }
      for (const pkg of packages) {
        totals.extensions += pkg.counts.extensions;
        totals.skills += pkg.counts.skills;
        totals.prompts += pkg.counts.prompts;
        totals.themes += pkg.counts.themes;
      }
    }
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { packages, totals, diagnostics, host: host.id };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

/** Dynamic CLI failures keep their message; a missing omp binary is the one
 * known cause worth a stable code for client-side localization. */
function pluginErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("omp binary not found")) {
    return NextResponse.json({ error: message, code: "omp_not_found" }, { status: 500 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

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
    return NextResponse.json(await readPlugins(host, cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
});

// POST /api/plugins body: { action, source?, scope?, cwd }
export const POST = withHostRoute(async (req: NextRequest) => {
  const host = currentHost();
  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required", code: "action_required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots(host);
    if (!(await isExistingFilePathAllowed(body.cwd, allowedRoots, host))) {
      return NextResponse.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const source = body.source?.trim();
    const scopeArgs = readScope(body.scope) === "project" ? ["--scope", "project"] : [];

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(host, ["plugin", "install", source, "--json", ...scopeArgs], { cwd: body.cwd, timeout: 300_000 });
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(host, ["plugin", "uninstall", source, "--json", ...scopeArgs], { cwd: body.cwd, timeout: 120_000 });
    } else if (body.action === "update") {
      await runOmp(host, ["plugin", "upgrade", ...(source ? [source, ...scopeArgs] : [])], { cwd: body.cwd, timeout: 300_000 });
    } else if (body.action === "disable" || body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(host, ["plugin", body.action, source, "--json", ...scopeArgs], { cwd: body.cwd, timeout: 60_000 });
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}`, code: "plugin_unsupported_action" }, { status: 400 });
    }

    return NextResponse.json(await readPlugins(host, body.cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
});
