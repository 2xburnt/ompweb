import { isMap, parseDocument, stringify } from "yaml";
import { currentHost, withHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { isRecord } from "../type-guards";
import { readTextFile } from "./host-io";
import { resolveSettingsPath } from "./paths";

export type ModelRoles = Record<string, string>;

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** The host's config.yml (config.yaml fallback), parsed; a missing file is an
 * empty document. */
async function readConfigDocument(host: Host) {
  const path = await withHost(host, () => resolveSettingsPath());
  const source = await readTextFile(host, path, MAX_CONFIG_BYTES);
  const doc = parseDocument(source ?? "");
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  return { path, doc, exists: source !== null };
}

/** Reads the native OMP role selectors from config.yml without touching other settings. */
export async function readModelRoles(host: Host = currentHost()): Promise<{ path: string; roles: ModelRoles }> {
  const { path, doc, exists } = await readConfigDocument(host);
  if (!exists) return { path, roles: {} };
  const data = doc.toJS();
  if (!isRecord(data) || !isRecord(data.modelRoles)) return { path, roles: {} };
  return {
    path,
    roles: Object.fromEntries(Object.entries(data.modelRoles).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

/** Updates only modelRoles, preserving the user's remaining native OMP config. */
export async function writeModelRoles(roles: ModelRoles, host: Host = currentHost()): Promise<void> {
  const { path, doc } = await readConfigDocument(host);
  await host.fs.mkdir(host.pathApi.dirname(path), { recursive: true });
  let text: string;
  if (doc.contents === null) {
    text = stringify({ modelRoles: roles });
  } else {
    if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
    doc.set("modelRoles", roles);
    text = doc.toString();
  }
  // Atomic on the host (temp file + rename).
  await host.fs.writeFile(path, text);
}

export async function readDisabledProviders(host: Host = currentHost()): Promise<Set<string>> {
  const { doc, exists } = await readConfigDocument(host);
  if (!exists) return new Set();
  const data = doc.toJS();
  if (!isRecord(data) || !Array.isArray(data.disabledProviders)) return new Set();
  return new Set(data.disabledProviders.filter((provider): provider is string => typeof provider === "string"));
}

/** Re-enable a provider after a successful native OMP login. */
export async function enableProvider(provider: string, host: Host = currentHost()): Promise<void> {
  const { path, doc, exists } = await readConfigDocument(host);
  if (!exists) return;
  if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  const data = doc.toJS();
  const disabled = isRecord(data) && Array.isArray(data.disabledProviders)
    ? data.disabledProviders.filter((value): value is string => typeof value === "string")
    : [];
  const next = disabled.filter((value) => value !== provider);
  if (next.length === disabled.length) return;
  doc.set("disabledProviders", next);
  await host.fs.writeFile(path, doc.toString());
}
