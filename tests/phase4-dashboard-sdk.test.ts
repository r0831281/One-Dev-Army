import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runPluginConformance, type CommunityTaskSourcePlugin } from "../packages/plugin-sdk/src/index.js";

test("Phase 4 dashboard has stable zones, accessible decisions, truthful states, and bounded rendering", async () => {
  const [html, script, styles] = await Promise.all([
    readFile("apps/dashboard/index.html", "utf8"),
    readFile("apps/dashboard/dashboard.js", "utf8"),
    readFile("apps/dashboard/styles/dashboard.css", "utf8"),
  ]);
  for (const value of [
    "Run inspector",
    "Live activity",
    "APPROVE",
    "Request changes",
    "Low power",
    "prefers-reduced-motion",
    "Expired artifacts",
    "unpriced",
    "unavailable",
  ])
    assert.ok(`${html}\n${script}\n${styles}`.includes(value), `missing ${value}`);
  assert.match(html, /aria-label="Execution steps"/);
  assert.match(html, /role="log"/);
  assert.match(script, /length\s*>\s*10000/);
  assert.match(script, /slice\(-60\)/);
  assert.match(script, /GATE_VERSION_CONFLICT/);
  assert.doesNotMatch(`${html}\n${script}`, /innerHTML/);
});

test("public SDK conformance is offline and fails unpinned community images", async () => {
  const base = {
    healthCheck: async () => ({ status: "READY" }),
    normalizePayload: async () => ({ key: "FIXTURE-1" }),
    fetchTask: async () => ({}),
    updateStatus: async () => ({}),
    postComment: async () => ({}),
  };
  const plugin: CommunityTaskSourcePlugin = {
    ...base,
    getManifest: async () => ({
      schemaVersion: "1.0",
      id: "community.fixture",
      version: "1.0.0",
      protocolRange: "^1.0.0",
      displayName: "Fixture",
      runtime: "stdio-container",
      image: `example.invalid/fixture@sha256:${"a".repeat(64)}`,
      capabilities: ["task:read"],
      httpOrigins: ["https://api.example.invalid"],
      configSchemaRef: "plugin://community.fixture/config/1",
      writeReconciliation: "marker-search",
    }),
  };
  assert.equal((await runPluginConformance(plugin)).passed, true);
  const invalid = await runPluginConformance({
    ...plugin,
    getManifest: async () => ({ ...(await plugin.getManifest()), image: "latest" }),
  });
  assert.equal(invalid.passed, false);
});
