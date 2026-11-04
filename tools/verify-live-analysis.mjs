// Drives workflow v3 (live analyse-and-plan) runs through real Temporal and Postgres with a scripted model, so no
// provider is called and nothing is spent. Uses its own task queue and workspace. Besides the gate path it checks
// that a crashed step reaches the recovery gate, that cancelling a run stops the running model call, and that a
// budget running out during a step fails that step cleanly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createRunManifest, RunControlService, TemporalClientGateway } from "../dist/apps/api/src/control.js";
import { createPersistentActivities } from "../dist/apps/worker/src/activities.js";
import { createLiveActivities } from "../dist/apps/worker/src/live-activities.js";
import {
  PgPhase3Repository,
  PgTaskRepository,
  runMigrations,
} from "../dist/packages/persistence/src/index.js";
import { createRepoReader } from "../dist/packages/sandboxes/src/repo-read.js";

const { Pool } = pg;
const queue = "oda-live-verify";
const databaseUrl =
  process.env.ODA_PRODUCT_DATABASE_URL ??
  "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product";
const temporalAddress = process.env.ODA_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.ODA_TEMPORAL_NAMESPACE ?? "default";
const workspaceId = randomUUID();
const repositoryId = randomUUID();
const instanceId = randomUUID();

await mkdir(".test-tmp", { recursive: true });
const repoRoot = await mkdtemp(resolve(".test-tmp/live-verify-"));
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
    },
  ).trim();
git("init", "-q", "-b", "main");
await mkdir(join(repoRoot, "addons/sale_custom/models"), { recursive: true });
await writeFile(
  join(repoRoot, "addons/sale_custom/models/sale.py"),
  "class SaleOrder(models.Model):\n    _inherit = 'sale.order'\n",
);
git("add", ".");
git("commit", "-q", "-m", "init");
const baseSha = git("rev-parse", "HEAD");

const usage = {
  input_tokens: 1200,
  output_tokens: 300,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const reply = (content, stop_reason) => ({
  id: `msg_${randomUUID()}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_details: null,
  usage,
});
const text = (value) => reply([{ type: "text", text: JSON.stringify(value) }], "end_turn");
// The task's only part is its description; the review must account for it.
const requirement = {
  id: "R1",
  text: "Change the discount compute",
  sources: ["description"],
  status: "partial",
  evidence: "SaleOrder exists but has no discount rule.",
  paths: ["addons/sale_custom/models/sale.py"],
};
const script = [
  // Review 1: reads code, then asks a question.
  reply(
    [{ type: "tool_use", id: "t1", name: "repo_search", input: { pattern: "SaleOrder", pathGlob: null } }],
    "tool_use",
  ),
  text({
    requirements: [requirement],
    noAction: [],
    findings: ["The discount is computed in SaleOrder."],
    sufficient: false,
    questions: ["Which price list applies?"],
    proposedAssumptions: [],
    relevantPaths: ["addons/sale_custom/models/sale.py"],
  }),
  // Review 2 after the human answers: sufficient.
  text({
    requirements: [requirement],
    noAction: [],
    findings: ["The discount is computed in SaleOrder."],
    sufficient: true,
    questions: [],
    proposedAssumptions: [],
    relevantPaths: ["addons/sale_custom/models/sale.py"],
  }),
  // Plan revision 1, then revision 2 after feedback.
  text({
    title: "Plan v1",
    steps: [{ id: "S1", title: "Patch", description: "Change compute", tests: ["Unit test"] }],
    acceptanceMapping: ["R1 → S1"],
    risks: [],
  }),
  text({
    title: "Plan v2",
    steps: [{ id: "S1", title: "Patch", description: "Change compute, keep API", tests: ["Unit test"] }],
    acceptanceMapping: ["R1 → S1"],
    risks: ["None"],
  }),
];
const seen = [];
// Script entries are replies, or functions of the turn input for calls that hang or change state first.
const modelTurn = async (input) => {
  seen.push(input.messages.at(0)?.content ?? "");
  const next = script.shift();
  if (!next) throw new Error("SCRIPT_EXHAUSTED");
  return typeof next === "function" ? next(input) : next;
};
const sufficientReview = () =>
  text({
    requirements: [requirement],
    noAction: [],
    findings: [],
    sufficient: true,
    questions: [],
    proposedAssumptions: [],
    relevantPaths: ["addons/sale_custom/models/sale.py"],
  });
const simplePlan = () =>
  text({
    title: "Plan",
    steps: [{ id: "S1", title: "Patch", description: "Change compute", tests: ["Unit test"] }],
    acceptanceMapping: ["R1 → S1"],
    risks: [],
  });
// One-shot fault: the next step fails before its agent loop starts, as if the worker lost the repository.
let crashNextReader = false;

const pool = new Pool({ connectionString: databaseUrl });
const connection = await Connection.connect({ address: temporalAddress });
const client = new Client({ connection, namespace });
class QueueGateway extends TemporalClientGateway {
  async start(input, workflowId) {
    await client.workflow.start("TaskRunWorkflow", { args: [input], taskQueue: queue, workflowId });
  }
}
const gateway = new QueueGateway(client);
const nativeConnection = await NativeConnection.connect({ address: temporalAddress });
const worker = await Worker.create({
  connection: nativeConnection,
  namespace,
  taskQueue: queue,
  workflowsPath: resolve(dirname(fileURLToPath(import.meta.url)), "../dist/apps/worker/src/workflows.js"),
  activities: {
    ...createPersistentActivities(pool),
    ...createLiveActivities(pool, {
      modelTurn,
      readerFor: async (root, sha) => {
        if (crashNextReader) {
          crashNextReader = false;
          throw new Error("simulated worker fault");
        }
        return createRepoReader({ root, baseSha: sha });
      },
    }),
  },
});
const running = worker.run();

const control = new RunControlService(pool, gateway, workspaceId, workspaceId);
async function waitFor(runId, predicate, label) {
  const deadline = Date.now() + 60_000;
  let run;
  while (Date.now() < deadline) {
    await control.dispatchPending().catch(() => undefined);
    run = await control.runs.get(runId);
    if (run && predicate(run.projection)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `timeout:${label} (state ${run?.projection.state ?? "none"}, gate ${run?.projection.currentGate?.kind ?? "none"})`,
  );
}
const decide = (run, decision, reason) =>
  control.submitDecision({
    protocolVersion: "1.0",
    runId: run.runId,
    workflowId: run.workflowId,
    gateId: run.projection.currentGate.id,
    expectedGateVersion: run.projection.currentGate.version,
    decision,
    idempotencyKey: randomUUID(),
    ...(reason ? { reason } : {}),
  });

try {
  await runMigrations(pool, resolve("packages/persistence/migrations"));
  await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'live analysis verification')", [workspaceId]);
  await pool.query(
    "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch,task_key_prefixes) VALUES($1,$2,'verify',$3,'main','{ABC}')",
    [repositoryId, workspaceId, repoRoot],
  );
  await pool.query(
    "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config) VALUES($1,$2,'verify','1','{}')",
    [instanceId, workspaceId],
  );
  const fixture = JSON.parse(
    await readFile("packages/contracts/fixtures/task-context.compatible.json", "utf8"),
  );
  let taskNumber = 43;
  const newTask = async () => {
    const taskId = randomUUID();
    const key = `ABC-${++taskNumber}`;
    const context = {
      ...fixture,
      taskId,
      revision: 1,
      source: { ...fixture.source, instanceId, externalId: String(taskNumber), key, revision: taskId },
      repository: { id: repositoryId, baseSha },
      title: "Rounding error on sale order totals",
    };
    await new PgTaskRepository(pool).ingest(workspaceId, context, null, "a".repeat(64));
    await control.horizon.setOverride(taskId, true, "verification");
    return context;
  };
  const context = await newTask();
  const phase3 = new PgPhase3Repository(pool);
  const assignments = {};
  for (const role of ["context-reviewer", "planner"]) {
    const id = randomUUID();
    const profile = {
      schemaVersion: "1.0",
      id,
      name: `Verify ${role}`,
      revision: 1,
      role,
      provider: "anthropic",
      model: "claude-opus-5-5",
      credentialRef: "env:ANTHROPIC_API_KEY",
      providerOptions: { reasoningEffort: "medium" },
      limits: { maxInputTokens: 50000, maxOutputTokens: 8000, timeoutMs: 120000, maxModelCalls: 6 },
      tools: ["repo.read", "repo.search"],
      prompt: { templateId: "system-v1", templateRevision: 1, intent: "Verify", compiledArtifactId: null },
      outputSchemaRef: "oda.agent.result.v1",
      retryPolicy: { transportAttempts: 2, structuredOutputRepairs: 1 },
      fallbackProfileIds: [],
      localOnly: false,
    };
    await phase3.appendProfile(workspaceId, { ...profile, profile });
    assignments[role] = id;
  }
  await pool.query("INSERT INTO workspace_operations(workspace_id,policy,assignments) VALUES($1,$2,$3)", [
    workspaceId,
    {
      dailyLimitUsd: 20,
      taskLimitUsd: 2,
      reservationUsd: 0.5,
      maxConcurrentRuns: 3,
      paused: false,
      unpricedPolicy: "block",
      timezone: "Europe/Brussels",
    },
    assignments,
  ]);
  process.env.ODA_WORKER_CREDENTIALS = "ANTHROPIC_API_KEY";
  const startRun = (task) =>
    control.requestStart(randomUUID(), {
      manifest: createRunManifest({
        taskId: task.taskId,
        contextRevision: 1,
        repositoryId,
        baseSha,
        policyHash: "c".repeat(64),
        profileRevisions: { "context-reviewer": 1, planner: 1 },
        workflowVersion: 3,
      }),
      context: task,
      repositoryRoot: repoRoot,
    });
  const stepStates = async (runId) =>
    (
      await pool.query(
        "SELECT step_key,logical_iteration,state FROM agent_steps WHERE run_id=$1 ORDER BY step_key,logical_iteration",
        [runId],
      )
    ).rows.map((s) => `${s.step_key}#${s.logical_iteration}:${s.state}`);
  const openReservations = async (runId) =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM usage_reservations WHERE run_id=$1 AND state='RESERVED'",
        [runId],
      )
    ).rows[0].n;
  const started = await startRun(context);

  let run = await waitFor(started.runId, (p) => p.currentGate?.kind === "CLARIFICATION", "clarification");
  assert.deepEqual(run.projection.currentGate.proposal.questions, ["Which price list applies?"]);
  await decide(run, "REJECT", "Use the customer's pricelist.");
  run = await waitFor(started.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "plan 1");
  assert.equal(run.projection.plan.title, "Plan v1");
  assert.ok(
    seen.some((task) => /Use the customer's pricelist/.test(task)),
    "answers reach the re-review",
  );
  await decide(run, "REJECT", "Keep the public API unchanged.");
  run = await waitFor(
    started.runId,
    (p) => p.currentGate?.kind === "PLAN_APPROVAL" && p.currentGate.version === 2,
    "plan 2",
  );
  assert.equal(run.projection.plan.title, "Plan v2");
  await decide(run, "APPROVE");
  run = await waitFor(started.runId, (p) => p.state === "COMPLETED", "completed");
  const completed = run;

  assert.deepEqual(await stepStates(started.runId), [
    "context-reviewer#1:COMPLETED",
    "context-reviewer#2:COMPLETED",
    "planner#1:COMPLETED",
    "planner#2:COMPLETED",
  ]);
  const cost = await pool.query(
    "SELECT count(*)::int AS calls, sum(amount_microusd)::int AS micro, count(*) FILTER (WHERE step_id IS NULL)::int AS unattributed FROM model_usage WHERE run_id=$1",
    [started.runId],
  );
  // 5 scripted calls × (1200 × $4 + 300 × $20) / MTok = 5 × 10 800 micro-USD.
  assert.deepEqual(cost.rows[0], { calls: 5, micro: 54_000, unattributed: 0 });

  // A step whose activity fails outside the agent loop opens the recovery gate; approving retries it.
  crashNextReader = true;
  script.push(sufficientReview(), simplePlan());
  const crashed = await startRun(await newTask());
  run = await waitFor(crashed.runId, (p) => p.currentGate?.kind === "RECOVERY", "recovery after crash");
  assert.equal(run.projection.currentGate.proposal.code, "STEP_FAILED");
  assert.deepEqual(await stepStates(crashed.runId), ["context-reviewer#1:FAILED"]);
  await decide(run, "APPROVE");
  run = await waitFor(crashed.runId, (p) => p.currentGate?.kind === "PLAN_APPROVAL", "plan after retry");
  await decide(run, "APPROVE");
  await waitFor(crashed.runId, (p) => p.state === "COMPLETED", "completed after retry");
  assert.deepEqual(await stepStates(crashed.runId), [
    "context-reviewer#1:FAILED",
    "context-reviewer#2:COMPLETED",
    "planner#1:COMPLETED",
  ]);

  // Cancelling during a step aborts the hanging model call and releases its reservation.
  let hanging = false;
  script.push(
    (input) =>
      new Promise((_, reject) => {
        hanging = true;
        input.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")));
      }),
  );
  const cancelled = await startRun(await newTask());
  run = await waitFor(cancelled.runId, (p) => p.state === "CONTEXT_REVIEW" && hanging, "hanging review");
  await control.requestCancel(randomUUID(), cancelled.runId, {
    reason: "verification",
    expectedStateRevision: run.projection.stateRevision,
  });
  const cancelAt = Date.now();
  await waitFor(cancelled.runId, (p) => p.state === "CANCELLED", "cancelled");
  // The activity learns of the cancellation at its next heartbeat (every 30 s).
  const stepDeadline = Date.now() + 90_000;
  while (
    (await stepStates(cancelled.runId))[0] !== "context-reviewer#1:CANCELLED" &&
    Date.now() < stepDeadline
  )
    await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(await stepStates(cancelled.runId), ["context-reviewer#1:CANCELLED"]);
  const cancelSeconds = Math.round((Date.now() - cancelAt) / 1000);
  assert.equal(await openReservations(cancelled.runId), 0);
  assert.equal(script.length, 0, "no call started after the cancellation");

  // The task budget running out between two calls of a step fails that step with its budget code.
  const budgetTask = await newTask();
  script.push(async () => {
    await pool.query(
      "UPDATE workspace_operations SET policy=jsonb_set(policy,'{taskLimitUsd}','0.01') WHERE workspace_id=$1",
      [workspaceId],
    );
    return reply([{ type: "tool_use", id: "t9", name: "repo_list", input: { dir: null } }], "tool_use");
  });
  const starved = await startRun(budgetTask);
  run = await waitFor(starved.runId, (p) => p.currentGate?.kind === "RECOVERY", "recovery after budget");
  assert.equal(run.projection.currentGate.proposal.code, "TASK_BUDGET_EXHAUSTED");
  assert.deepEqual(await stepStates(starved.runId), ["context-reviewer#1:FAILED"]);
  assert.equal(await openReservations(starved.runId), 0);
  await pool.query(
    "UPDATE workspace_operations SET policy=jsonb_set(policy,'{taskLimitUsd}','2') WHERE workspace_id=$1",
    [workspaceId],
  );
  await decide(run, "REJECT", "Stop after the budget ran out.");
  await waitFor(starved.runId, (p) => p.state === "CANCELLED", "cancelled after budget");
  console.log(
    JSON.stringify({
      status: "passed",
      runId: started.runId,
      state: completed.projection.state,
      planRevision: completed.projection.plan.revision,
      scenarios: ["gates", "crash-recovery", "cancel-during-step", "budget-during-step"],
      cancelSeconds,
      calls: cost.rows[0].calls,
      costUsd: cost.rows[0].micro / 1e6,
    }),
  );
} finally {
  worker.shutdown();
  await running.catch(() => undefined);
  await nativeConnection.close();
  await connection.close();
  await pool.end();
  await rm(repoRoot, { recursive: true, force: true });
}
