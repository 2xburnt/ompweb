import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { MachineScopeNote, machineScopeText } = await jiti.import("./MachineScopeNote.tsx");

test("machineScopeText joins the machine name with its omp version", () => {
  assert.equal(machineScopeText("Workstation", "omp v18.1.3"), "Workstation · omp v18.1.3");
});

test("machineScopeText drops the version half when the machine was never probed", () => {
  assert.equal(machineScopeText("Workstation", null), "Workstation");
  assert.equal(machineScopeText("Workstation", undefined), "Workstation");
  assert.equal(machineScopeText("  Workstation  ", "   "), "Workstation");
});

test("machineScopeText falls back to the version when the name is empty", () => {
  assert.equal(machineScopeText("", "omp v18.1.3"), "omp v18.1.3");
  assert.equal(machineScopeText("   ", null), "");
});

test("MachineScopeNote renders nothing before the machine list is known", () => {
  const html = renderToStaticMarkup(React.createElement(MachineScopeNote));
  assert.equal(html, "");
});

// Every panel below reads or writes ONE machine's omp installation. Subscribing
// to the selection is what makes a machine switch reload the panel instead of
// leaving the previous machine's rows on screen (and saving them to the new
// machine), so guard the subscription itself.
const HOST_SCOPED_PANELS = [
  "SettingsConfig",
  "ModelsConfig",
  "McpConfig",
  "AgentsConfig",
  "SkillsConfig",
  "PluginsConfig",
  "UsageConfig",
  "ArchiveBrowser",
  "AppShell",
];

test("host-scoped panels subscribe to the selected machine and reload on a switch", async () => {
  for (const panel of HOST_SCOPED_PANELS) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.match(source, /useHosts\(\)/, `${panel} must subscribe to the machine selection`);
    assert.match(source, /\}, \[[^\]]*hostId[^\]]*\]\)/, `${panel} must key an effect on the selected machine`);
  }
});

test("interface preferences and the machines list stay machine-independent", async () => {
  const machines = await readFile(new URL("./MachinesConfig.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(machines, /MachineScopeNote/);
  const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const generalPanel = settings.slice(
    settings.indexOf('id="settings-panel-general"'),
    settings.indexOf('id="settings-panel-safety"'),
  );
  assert.ok(generalPanel.length > 0);
  assert.doesNotMatch(generalPanel, /MachineScopeNote/);
});
