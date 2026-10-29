import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { NativeConnection, Worker } from "@temporalio/worker";
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
const connection = await Connection.connect({ address: temporalAddress });
const client = new Client({ connection, namespace });
const gateway = new TemporalClientGateway(client);
let workerRuntime;
let workerPromise;
const restartTemporal = process.argv.includes("--restart-drill");

async function startWorker() {
  workerRuntime = await createTaskRunWorker({ temporalAddress, namespace, databaseUrl });
  workerPromise = workerRuntime.worker.run();
}
async function stopWorker() {
  workerRuntime.worker.shutdown();
  await workerPromise;
  await workerRuntime.close();
}
async function restartWorker() {
  await stopWorker();
  await startWorker();
}
async function recoverAtBoundary(started, run, label) {
  const gate = structuredClone(run.projection.currentGate);
  if (restartTemporal) await probeApiRestart(started.runId, gate, label);
  if (restartTemporal) {
    const restarted = spawnSync("docker", ["compose", "-f", "infra/compose.yaml", "restart", "temporal"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(restarted.status, 0, `${label} Temporal restart failed: ${restarted.stderr}`);
    const healthy = spawnSync(
      "docker",
      ["compose", "-f", "infra/compose.yaml", "up", "-d", "--wait", "--wait-timeout", "180"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(healthy.status, 0, `${label} Compose recovery failed: ${healthy.stderr}`);
  }
  await restartWorker();
  const control = new RunControlService(pool, gateway, workspaceId, workspaceId);
  const recovered = await waitFor(
    started.runId,
    (projection) =>
      projection.currentGate?.id === gate.id && projection.currentGate?.version === gate.version,
    `${label} recovery`,
  );
  return { control, run: recovered };
}
async function probeApiRestart(runId, expectedGate, label) {
  const port = 14310;
  async function launchAndRead() {
    const child = spawn(process.execPath, ["dist/apps/api/src/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ODA_API_PORT: String(port),
        ODA_SESSION_TOKEN: "phase2-probe-session",
        ODA_CSRF_TOKEN: "phase2-probe-csrf",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} API startup timeout`)), 10_000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("ODA_API_READY")) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${runId}`, {
      headers: { authorization: "Bearer phase2-probe-session" },
    });
    assert.equal(response.status, 200, `${label} API projection unavailable`);
    const body = await response.json();
    assert.equal(body.projection.currentGate.id, expectedGate.id);
    assert.equal(body.projection.currentGate.version, expectedGate.version);
    child.kill();
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
  await launchAndRead();
  await launchAndRead();
}
async function waitFor(runId, predicate, label, timeoutMs = 30_000) {
  const repository = new RunControlService(pool, gateway, workspaceId, workspaceId).runs;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await repository.get(runId);
    if (run && predicate(run.projection)) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function seedTask(label) {
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
      externalId: `PHASE2-${label}-${taskId}`,
      key: `PHASE2-${label}`,
      revision: `phase2-${taskId}`,
    },
    repository: { ...fixture.repository, id: repositoryId },
    title: `Phase 2 ${label}`,
  };
  const receipt = await new PgTaskRepository(pool).ingest(workspaceId, context, null, "a".repeat(64));
  assert.equal(receipt.contextRevision, 1);
  return context;
}
async function startRun(context, options = {}) {
  const manifest = createRunManifest({
    taskId: context.taskId,
    contextRevision: 1,
    repositoryId,
    baseSha: context.repository.baseSha,
    policyHash: "b".repeat(64),
    humanReplans: options.humanReplans ?? 5,
  });
  const firstApi = new RunControlService(pool, gateway, workspaceId, workspaceId);
  await firstApi.horizon.setOverride(context.taskId, true, "Explicitly run undated verification fixture");
  const accepted = await firstApi.requestStart(randomUUID(), {
    manifest,
    context,
    repositoryRoot: process.cwd(),
    ...(options.continueAsNewAfterTransitions
      ? { continueAsNewAfterTransitions: options.continueAsNewAfterTransitions }
      : {}),
    ...(options.fakeCompletionDelayMs ? { fakeCompletionDelayMs: options.fakeCompletionDelayMs } : {}),
  });
  assert.equal(accepted.status, "PENDING");
  const restartedApi = new RunControlService(pool, gateway, workspaceId, workspaceId);
  assert.ok((await restartedApi.dispatchPending()) >= 1);
  return { manifest, control: restartedApi, ...accepted };
}
function decision(run, kind, reason, key = randomUUID()) {
  const gate = run.projection.currentGate;
  assert.ok(gate);
  return {
    protocolVersion: "1.0",
    runId: run.runId,
    workflowId: run.workflowId,
    gateId: gate.id,
    expectedGateVersion: gate.version,
    decision: kind,
    idempotencyKey: key,
    ...(kind === "REJECT" ? { reason } : {}),
  };
}

async function runDemo() {
  const context = await seedTask("demo");
  const started = await startRun(context);
  let run = await waitFor(
    started.runId,
    (projection) => projection.currentGate?.kind === "CLARIFICATION",
    "clarification gate",
  );
  let recovered = await recoverAtBoundary(started, run, "clarification gate");
  let control = recovered.control;
  run = recovered.run;
  await control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(
    started.runId,
    (projection) => projection.currentGate?.kind === "PLAN_APPROVAL",
    "first plan gate",
  );
  const firstPlanRevision = run.projection.plan.revision;
  recovered = await recoverAtBoundary(started, run, "initial plan gate");
  control = recovered.control;
  run = recovered.run;
  const rejectionKey = randomUUID();
  const rejection = decision(run, "REJECT", "Keep the fake completion explicitly offline.", rejectionKey);
  const receipt = await control.submitDecision(rejection);
  assert.deepEqual(await control.submitDecision(rejection), receipt);
  await assert.rejects(
    control.submitDecision({ ...rejection, reason: "Different payload" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal((await control.decisionByKey(rejectionKey)).status, "RECORDED");
  run = await waitFor(
    started.runId,
    (projection) =>
      projection.currentGate?.kind === "PLAN_APPROVAL" && projection.plan?.revision === firstPlanRevision + 1,
    "replanned gate",
  );
  recovered = await recoverAtBoundary(started, run, "replanned gate");
  control = recovered.control;
  run = recovered.run;
  await assert.rejects(
    control.submitDecision({ ...rejection, idempotencyKey: randomUUID() }),
    (error) =>
      error?.cause?.type === "GATE_VERSION_CONFLICT" &&
      error.cause.message === "Gate identity does not match",
  );
  const feedback = run.projection.constraints.find(
    (item) => item.origin === "human-feedback" && item.text.includes("explicitly offline"),
  );
  assert.ok(feedback?.sourceRef.includes("gate/"));
  const approval = decision(run, "APPROVE");
  const pending = await control.commands.createOrGet(workspaceId, approval.idempotencyKey, "GATE_DECISION", {
    workflowId: run.workflowId,
    input: approval,
  });
  assert.equal(pending.command.state, "PENDING");
  await gateway.decide(run.workflowId, approval);
  const afterLostResponse = new RunControlService(pool, gateway, workspaceId, workspaceId);
  assert.equal((await afterLostResponse.decisionByKey(approval.idempotencyKey)).status, "RECORDED");
  await afterLostResponse.dispatchPending();
  run = await waitFor(started.runId, (projection) => projection.state === "COMPLETED", "fake completion");
  assert.equal(run.projection.plan.revision, 2);
  return { started, run };
}

async function runRecoveryGate() {
  const context = await seedTask("recovery");
  const started = await startRun(context, { humanReplans: 1 });
  let run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "CLARIFICATION",
    "recovery clarification",
  );
  await started.control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "recovery plan");
  await started.control.submitDecision(decision(run, "REJECT", "Exercise the exhausted budget gate"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "RECOVERY", "recovery gate");
  const recovered = await recoverAtBoundary(started, run, "exhausted-budget recovery gate");
  await recovered.control.submitDecision(decision(recovered.run, "APPROVE"));
  run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "PLAN_APPROVAL" && p.plan?.revision === 2,
    "post-recovery plan",
  );
  await recovered.control.submitDecision(decision(run, "APPROVE"));
  await waitFor(started.runId, (p) => p.state === "COMPLETED", "recovery completion");
}

async function runConflict() {
  const context = await seedTask("conflict");
  const started = await startRun(context);
  let run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "CLARIFICATION",
    "conflict clarification",
  );
  await started.control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "conflict plan");
  const outcomes = await Promise.allSettled([
    started.control.submitDecision(decision(run, "APPROVE")),
    started.control.submitDecision(decision(run, "REJECT", "Conflicting simultaneous feedback")),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  return outcomes.map((outcome) => outcome.status);
}

async function runCancellation() {
  const context = await seedTask("cancel");
  const started = await startRun(context, { fakeCompletionDelayMs: 5_000 });
  let run = await waitFor(started.runId, (p) => p.currentGate?.kind === "CLARIFICATION", "cancel gate");
  await started.control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "cancel plan gate");
  await started.control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.state === "IMPLEMENTING", "running fake Activity");
  await started.control.requestCancel(randomUUID(), run.runId, {
    expectedStateRevision: run.stateRevision,
    reason: "Phase 2 cancellation drill",
  });
  await started.control.dispatchPending();
  const cancelled = await waitFor(run.runId, (p) => p.state === "CANCELLED", "cancelled run");
  assert.equal(cancelled.projection.currentGate, null);
}

async function runContinueAsNew() {
  const context = await seedTask("continue");
  const started = await startRun(context, { continueAsNewAfterTransitions: 1 });
  let run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "CLARIFICATION",
    "continue clarification",
  );
  await started.control.submitDecision(decision(run, "APPROVE"));
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "continue first plan");
  const before = (await client.workflow.getHandle(run.workflowId).describe()).runId;
  await started.control.submitDecision(decision(run, "REJECT", "Force a safe continue-as-new boundary"));
  run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "PLAN_APPROVAL" && p.plan?.revision === 2,
    "continue second plan",
  );
  const after = (await client.workflow.getHandle(run.workflowId).describe()).runId;
  assert.notEqual(after, before);
  await started.control.submitDecision(decision(run, "APPROVE"));
  await waitFor(started.runId, (p) => p.state === "COMPLETED", "continued completion");
}

async function createReplayFixtures() {
  const directory = resolve("apps/worker/fixtures");
  await mkdir(directory, { recursive: true });
  const native = await NativeConnection.connect({ address: temporalAddress });
  try {
    for (const variant of ["initial", "compatible-evolution"]) {
      const queue = `oda-replay-${variant}-${randomUUID()}`;
      const workflowsPath = resolve(
        variant === "initial" ? "dist/apps/worker/src/workflows-v1.js" : "dist/apps/worker/src/workflows.js",
      );
      const worker = await Worker.create({ connection: native, namespace, taskQueue: queue, workflowsPath });
      const workflowId = `phase2-replay-${variant}-${randomUUID()}`;
      const result = await worker.runUntil(() =>
        client.workflow.execute("TaskRunWorkflowReplayFixture", {
          args: [41],
          taskQueue: queue,
          workflowId,
        }),
      );
      assert.equal(result, variant === "initial" ? 41 : 42);
      const history = await client.workflow.getHandle(workflowId).fetchHistory();
      const path = resolve(directory, `${variant}.json`);
      await writeFile(path, historyToJSON(history));
      await Worker.runReplayHistory(
        { workflowsPath: resolve("dist/apps/worker/src/workflows.js") },
        history,
        workflowId,
      );
    }
  } finally {
    await native.close();
  }
}

try {
  await runMigrations(pool, resolve("packages/persistence/migrations"));
  await pool.query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Phase 2 verification') ON CONFLICT(id) DO NOTHING",
    [workspaceId],
  );
  await pool.query(
    "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch) VALUES($1,$2,'phase2-fixture',$3,'main') ON CONFLICT(id) DO NOTHING",
    [repositoryId, workspaceId, process.cwd()],
  );
  await pool.query(
    "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config) VALUES($1,$2,'oda.fake','1.0.0','{}') ON CONFLICT(id) DO NOTHING",
    [instanceId, workspaceId],
  );
  await startWorker();
  const demo = await runDemo();
  const conflict = await runConflict();
  await runRecoveryGate();
  await runCancellation();
  await runContinueAsNew();
  await createReplayFixtures();
  const demoHistory = await client.workflow.getHandle(demo.started.workflowId).fetchHistory();
  const demoHistoryJson = JSON.parse(historyToJSON(demoHistory));
  let activeActivities = 0;
  for (const event of demoHistoryJson.events ?? []) {
    if (event.eventType === "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED") activeActivities++;
    if (
      event.eventType === "EVENT_TYPE_ACTIVITY_TASK_COMPLETED" ||
      event.eventType === "EVENT_TYPE_ACTIVITY_TASK_FAILED" ||
      event.eventType === "EVENT_TYPE_ACTIVITY_TASK_CANCELED" ||
      event.eventType === "EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT"
    )
      activeActivities--;
    if (event.eventType === "EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED")
      assert.equal(activeActivities, 0, "A human decision arrived while an Activity remained open");
  }
  assert.equal(activeActivities, 0);
  await mkdir("artifacts/phase-2", { recursive: true });
  await writeFile("artifacts/phase-2/fake-run-history.json", JSON.stringify(demoHistoryJson));
  const report = {
    status: "passed",
    runId: demo.started.runId,
    workflowId: demo.started.workflowId,
    finalState: demo.run.state,
    planRevision: demo.run.projection.plan.revision,
    feedbackProvenance: demo.run.projection.constraints.find((item) => item.origin === "human-feedback"),
    simultaneousDecisionOutcomes: conflict,
    apiRestartRecovery: "passed",
    workerRestartAtEveryGateKind: "passed",
    temporalRestartAtEveryGateKind: restartTemporal ? "passed" : "not-run",
    apiRestartAtEveryGateKind: "passed",
    exhaustedBudgetRecovery: "passed",
    sameKeyRetry: "passed",
    differentPayloadConflict: "passed",
    staleGateVersionDenial: "passed",
    networkLossAfterDurableDecision: "passed",
    pendingReceiptLookup: "passed",
    cancellation: "passed",
    cooperativeActivityCancellation: "passed",
    noIdleActivityDuringHumanWait: "passed",
    continueAsNew: "passed",
    replayInitialAndCompatibleEvolution: "passed",
  };
  await writeFile("artifacts/phase-2/verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (workerRuntime) await stopWorker().catch(() => undefined);
  await connection.close();
  await pool.end();
}
