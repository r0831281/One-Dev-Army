import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { createRunManifest, RunControlService, TemporalClientGateway } from "../dist/apps/api/src/control.js";
import { createTaskRunWorker } from "../dist/apps/worker/src/index.js";
import { PgTaskRepository, runMigrations } from "../dist/packages/persistence/src/index.js";
const { Pool } = pg;
const databaseUrl =
  process.env.ODA_PRODUCT_DATABASE_URL ??
  "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product";
const temporalAddress = process.env.ODA_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.ODA_TEMPORAL_NAMESPACE ?? "default";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const instanceId = "22222222-2222-4222-8222-222222222222";
const pool = new Pool({ connectionString: databaseUrl });
await runMigrations(pool, resolve("packages/persistence/migrations"));
const connection = await Connection.connect({ address: temporalAddress });
const client = new Client({ connection, namespace });
const gateway = new TemporalClientGateway(client);
let runtime;
let running;
async function startWorker() {
  runtime = await createTaskRunWorker({ temporalAddress, namespace, databaseUrl });
  running = runtime.worker.run();
}
async function stopWorker() {
  runtime.worker.shutdown();
  await running;
  await runtime.close();
}
async function waitFor(runId, predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await new RunControlService(pool, gateway, workspaceId, workspaceId).runs.get(runId);
    if (run && predicate(run.projection)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout:${label}`);
}
function decision(run, value, reason) {
  const gate = run.projection.currentGate;
  assert.ok(gate);
  return {
    protocolVersion: "1.0",
    runId: run.runId,
    workflowId: run.workflowId,
    gateId: gate.id,
    expectedGateVersion: gate.version,
    decision: value,
    idempotencyKey: randomUUID(),
    ...(reason ? { reason } : {}),
  };
}
try {
  await startWorker();
  const fixture = JSON.parse(
    await readFile("packages/contracts/fixtures/task-context.compatible.json", "utf8"),
  );
  const taskId = randomUUID();
  const context = {
    ...fixture,
    taskId,
    revision: 1,
    source: {
      ...fixture.source,
      instanceId,
      externalId: `PHASE3-${taskId}`,
      key: `PHASE3-${taskId}`,
      revision: taskId,
    },
    repository: { ...fixture.repository, id: repositoryId },
    title: "Phase 3 real Temporal fixture",
  };
  await new PgTaskRepository(pool).ingest(workspaceId, context, null, "a".repeat(64));
  const manifest = createRunManifest({
    taskId,
    contextRevision: 1,
    repositoryId,
    baseSha: context.repository.baseSha,
    policyHash: "b".repeat(64),
    workflowVersion: 2,
  });
  let control = new RunControlService(pool, gateway, workspaceId, workspaceId);
  const started = await control.requestStart(randomUUID(), {
    manifest,
    context,
    repositoryRoot: process.cwd(),
  });
  await control.dispatchPending();
  let run = await waitFor(started.runId, (p) => p.currentGate?.kind === "CLARIFICATION", "clarification");
  await control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "plan");
  await control.submitDecision(decision(run, "REJECT", "Preserve exact Phase 3 evidence."));
  run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "PLAN_APPROVAL" && p.currentGate.version === 2,
    "replan",
  );
  await control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "FINAL_APPROVAL", "final");
  const target = structuredClone(run.projection.currentGate);
  assert.equal(target.artifactHash.length, 64);
  assert.equal(target.proposal.candidateHash.length, 64);
  assert.equal(target.proposal.testArtifactHash.length, 64);
  assert.equal(target.proposal.reviewArtifactHash.length, 64);
  assert.equal(target.proposal.usageArtifactHash.length, 64);
  await stopWorker();
  await startWorker();
  control = new RunControlService(pool, gateway, workspaceId, workspaceId);
  const recovered = await waitFor(
    started.runId,
    (p) => p.currentGate?.id === target.id && p.currentGate?.artifactHash === target.artifactHash,
    "final restart recovery",
  );
  await control.submitDecision(decision(recovered, "APPROVE"));
  const completed = await waitFor(started.runId, (p) => p.state === "COMPLETED", "completed");
  const operationKey = `report/${started.runId}/${target.artifactHash}`;
  const external = await pool.query("SELECT state,receipt FROM external_operations WHERE operation_key=$1", [
    operationKey,
  ]);
  assert.equal(external.rows[0]?.state, "APPLIED");
  const durableEvidence = await pool.query(
    "SELECT (SELECT count(*)::int FROM candidate_artifacts WHERE run_id=$1) AS candidates,(SELECT count(*)::int FROM execution_evidence WHERE run_id=$1) AS evidence,(SELECT count(*)::int FROM model_usage WHERE run_id=$1) AS usage",
    [started.runId],
  );
  assert.deepEqual(durableEvidence.rows[0], { candidates: 1, evidence: 4, usage: 1 });
  const history = await client.workflow.getHandle(started.workflowId).fetchHistory();
  assert.ok(history.events.length > 0);
  await writeFile("apps/worker/fixtures/phase3-execution.json", historyToJSON(history));
  await writeFile(
    "apps/worker/fixtures/phase3-execution.meta.json",
    `${JSON.stringify({ workflowId: started.workflowId }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      runId: started.runId,
      workflowVersion: 2,
      finalState: completed.state,
      planRevision: completed.projection.plan.revision,
      feedbackProvenance: completed.projection.constraints.find((item) => item.origin === "human-feedback"),
      finalGate: target,
      workerRestartAtFinalGate: "passed",
      sourceReportJournal: external.rows[0],
      durableEvidence: durableEvidence.rows[0],
      temporalHistoryEvents: history.events.length,
    }),
  );
} finally {
  if (runtime) await stopWorker().catch(() => {});
  await connection.close();
  await pool.end();
}
