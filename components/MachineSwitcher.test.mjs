import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MachineSwitcher, HostStatusDot, formatOmpVersion, hostStatusLabel } = await jiti.import("./MachineSwitcher.tsx");

const t = (key) => key;

test("formatOmpVersion strips the omp/ prefix and adds a v", () => {
  assert.equal(formatOmpVersion("omp/17.1.3"), "v17.1.3");
  assert.equal(formatOmpVersion("17.1.3"), "v17.1.3");
  assert.equal(formatOmpVersion(null), null);
  assert.equal(formatOmpVersion(""), null);
});

test("hostStatusLabel maps connection states and treats disabled hosts as disabled", () => {
  assert.equal(hostStatusLabel(t, { status: "connected", enabled: true }), "hosts.status.connected");
  assert.equal(hostStatusLabel(t, { status: "connecting", enabled: true }), "hosts.status.connecting");
  assert.equal(hostStatusLabel(t, { status: "error", enabled: true }), "hosts.status.error");
  assert.equal(hostStatusLabel(t, { status: "unknown", enabled: true }), "hosts.status.unknown");
  assert.equal(hostStatusLabel(t, { status: "connected", enabled: false }), "hosts.status.disabled");
});

test("status dot exposes the last error to assistive tech", () => {
  const html = renderToStaticMarkup(React.createElement(HostStatusDot, {
    host: { status: "error", enabled: true, lastError: "ssh: connect refused" },
  }));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Connection error: ssh: connect refused"/);
  assert.match(html, /var\(--status-error\)/);
});

test("machine switcher renders an accessible menu trigger before the host list loads", () => {
  const html = renderToStaticMarkup(React.createElement(MachineSwitcher, { onManageMachines: () => {} }));
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Loading machines…/);
});
