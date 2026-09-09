import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextThemePreference, resolveTheme, isDarkTheme, LIGHT_THEMES, DARK_THEMES, ALL_THEMES } = await jiti.import("./useTheme.ts");

test("cycles explicit and system theme preferences", () => {
  assert.equal(nextThemePreference("light"), "dark");
  assert.equal(nextThemePreference("dark"), "omp");
  assert.equal(nextThemePreference("omp"), "system");
  assert.equal(nextThemePreference("system"), "light");
});

test("resolves system theme from the operating system preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("resolves the omp theme independently of the operating system preference", () => {
  assert.equal(resolveTheme("omp", true), "omp");
  assert.equal(resolveTheme("omp", false), "omp");
});

test("correctly classifies light and dark themes", () => {
  for (const theme of LIGHT_THEMES) {
    assert.equal(isDarkTheme(theme.id), false, `${theme.id} should be light`);
  }
  for (const theme of DARK_THEMES) {
    assert.equal(isDarkTheme(theme.id), true, `${theme.id} should be dark`);
  }
});

test("resolves custom themes directly", () => {
  assert.equal(resolveTheme("dracula"), "dracula");
  assert.equal(resolveTheme("nord"), "nord");
  assert.equal(resolveTheme("catppuccin-latte"), "catppuccin-latte");
  assert.equal(resolveTheme("tokyo-night"), "tokyo-night");
});

test("nextThemePreference toggles custom dark themes to light and custom light themes to dark", () => {
  assert.equal(nextThemePreference("dracula"), "light");
  assert.equal(nextThemePreference("nord"), "light");
  assert.equal(nextThemePreference("tokyo-night"), "light");
  assert.equal(nextThemePreference("catppuccin-latte"), "dark");
  assert.equal(nextThemePreference("one-light"), "dark");
});

test("contains all requested light and dark themes in metadata", () => {
  const lightIds = LIGHT_THEMES.map((t) => t.id);
  const darkIds = DARK_THEMES.map((t) => t.id);
  assert.deepEqual(lightIds, ["light", "one-light", "catppuccin-latte", "rose-pine-dawn"]);
  assert.deepEqual(darkIds, [
    "omp",
    "dark",
    "dracula",
    "harbor",
    "one-dark-pro",
    "rose-pine",
    "catppuccin-mocha",
    "gruvbox-dark",
    "nord",
    "tokyo-night",
  ]);
  assert.equal(ALL_THEMES.length, 14);
});
