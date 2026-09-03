import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SettingsTabs, SETTINGS_CATEGORIES } = await jiti.import("./SettingsTabs.tsx");

test("horizontal settings tabs expose every category description", () => {
  const html = renderToStaticMarkup(React.createElement(SettingsTabs, {
    active: "general",
    onSelect: () => {},
    layout: "horizontal",
  }));

  for (const category of SETTINGS_CATEGORIES) {
    assert.ok(html.includes(`>${category.description}<`), `description is not visibly rendered for ${category.id}`);
  }
});

test("settings expose a Machines category between extensions and system", () => {
  const ids = SETTINGS_CATEGORIES.map((category) => category.id);
  const machines = ids.indexOf("machines");
  assert.ok(machines > ids.indexOf("mcp"), "machines follows extensions");
  assert.ok(machines < ids.indexOf("system"), "machines precedes system");
  const category = SETTINGS_CATEGORIES[machines];
  assert.equal(category.label, "Machines");
  assert.match(category.description, /SSH/);
});
