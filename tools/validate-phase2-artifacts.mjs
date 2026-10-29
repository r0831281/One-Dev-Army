import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const required = [
  "apps/dashboard/index.html",
  "apps/worker/Dockerfile",
  "apps/worker/fixtures/initial.json",
  "apps/worker/fixtures/compatible-evolution.json",
  "docs/reference/phase2-api.openapi.yaml",
  "docs/runbooks/phase-2-recovery.md",
  "docs/reports/phase-2-upgrade-compatibility.md",
  "artifacts/phase-2/fake-run-history.json",
  "artifacts/phase-2/verification.json",
];
await Promise.all(required.map((path) => access(path)));
const api = parseYaml(await readFile("docs/reference/phase2-api.openapi.yaml", "utf8"));
assert.equal(api.openapi, "3.1.0");
for (const path of [
  "/tasks/{taskId}/runs",
  "/runs",
  "/runs/{runId}",
  "/runs/{runId}/gates/{gateId}/decisions",
  "/decisions/by-key/{key}",
  "/runs/{runId}/cancel",
])
  assert.ok(api.paths[path], `OpenAPI path missing: ${path}`);
for (const fixture of required.filter((path) => path.endsWith(".json")))
  JSON.parse(await readFile(fixture, "utf8"));
const release = JSON.parse(await readFile("infra/release-manifest.json", "utf8"));
assert.equal(release.release, "0.2.0-phase.2");
assert.equal(release.databaseMigrationHead, 4);
assert.equal(release.workflow.version, 1);
console.log(`Phase 2 release artifacts validated: ${required.length} files, 6 API paths`);
