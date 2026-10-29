import { access, readFile } from "node:fs/promises";
const required = [
  "packages/agents/src/index.ts",
  "packages/prompt-compiler/src/index.ts",
  "packages/prompt-compiler/templates/system-v1.txt",
  "packages/prompt-compiler/templates/roles.json",
  "packages/providers/src/index.ts",
  "packages/sandboxes/src/index.ts",
  "packages/telemetry/src/index.ts",
  "packages/reporting/src/index.ts",
  "apps/sandbox-broker/Dockerfile",
  "infra/sandbox-node.Dockerfile",
  "packages/persistence/migrations/005_phase3_execution.sql",
  "artifacts/phase-3/cost-accounting-fixtures.json",
  "artifacts/phase-3/full-execution-demo.json",
  "docs/reports/phase-3-security-integration.md",
  "docs/runbooks/phase-3-recovery.md",
  "docs/handoffs/phase-3.md",
  "tools/export-phase3.mjs",
  "tools/retain-phase3.mjs",
  "tools/verify-phase3.mjs",
];
await Promise.all(required.map((path) => access(path)));
const compose = await readFile("infra/compose.yaml", "utf8");
for (const line of compose.split(/\r?\n/u).filter((value) => /^\s*image:/u.test(value)))
  if (!line.includes("@sha256:")) throw new Error(`UNPINNED_COMPOSE_IMAGE:${line.trim()}`);
const demo = JSON.parse(await readFile("artifacts/phase-3/full-execution-demo.json", "utf8"));
for (const [key, passed] of Object.entries(demo.assertions ?? {}))
  if (passed !== true) throw new Error(`PHASE3_DEMO_ASSERTION_FAILED:${key}`);
const migration = await readFile("packages/persistence/migrations/005_phase3_execution.sql", "utf8");
for (const table of [
  "agent_profiles",
  "prompt_artifacts",
  "model_usage",
  "usage_adjustments",
  "sandbox_command_receipts",
  "execution_evidence",
  "telemetry_logs",
])
  if (!migration.includes(`TABLE IF NOT EXISTS ${table}`))
    throw new Error(`PHASE3_MIGRATION_MISSING:${table}`);
console.log(
  JSON.stringify({
    requiredArtifacts: required.length,
    demoAssertions: Object.keys(demo.assertions).length,
    composeImagesPinned: true,
  }),
);
