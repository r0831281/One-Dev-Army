import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as recovery from "../apps/worker/src/qa-recovery.js";
import type { TaskRunActivities, TaskRunWorkflowInput } from "../apps/worker/src/types.js";
import type { GateDecisionInput, WorkflowProjection } from "../packages/contracts/src/index.js";

// Run the real workflow with a deterministic in-memory Temporal runtime. Gate
// decisions and activity outcomes are controlled here; replay is tested separately.
async function run(outcomes: Array<string | null>, budget = 3, rejectRecovery = false) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const gates: WorkflowProjection["currentGate"][] = [];
  const executions: Parameters<TaskRunActivities["executePhase3"]>[0][] = [];
  const states: string[] = [];
  let plans = 0;
  let ids = 0;
  const activities = {
    inventoryRepository: async () => ({}),
    reviewContext: async () => ({ sufficient: true }),
    createPlan: async () => ({ plan: { revision: ++plans }, artifactHash: "plan" }),
    projectStep: async () => {},
    persistDecision: async () => {},
    projectRun: async ({ projection }: { projection: WorkflowProjection }) => {
      states.push(projection.state);
    },
    openGate: async ({ projection }: { projection: WorkflowProjection }) => {
      const gate = projection.currentGate!;
      gates.push(structuredClone(gate));
      await handlers.get("submitGateDecision")!({
        runId: projection.runId,
        workflowId: projection.workflowId,
        gateId: gate.id,
        expectedGateVersion: gate.version,
        idempotencyKey: gate.id,
        protocolVersion: "1.0",
        ...(rejectRecovery && gate.kind === "RECOVERY"
          ? { decision: "REJECT", reason: "Stop" }
          : { decision: "APPROVE" }),
      } satisfies GateDecisionInput);
    },
    executePhase3: async (input: Parameters<TaskRunActivities["executePhase3"]>[0]) => {
      executions.push(input);
      assert.ok(executions.length <= outcomes.length, "Unexpected execution loop");
      const failure = outcomes[executions.length - 1];
      return {
        candidateHash: `candidate-${executions.length}`,
        testArtifactHash: `test-${executions.length}`,
        finalBundleHash: "bundle",
        reviewArtifactHash: "review",
        usageArtifactHash: "usage",
        testOperationId: "test",
        reviewOperationId: "review",
        qa: failure
          ? { passed: false, failure: { fingerprint: failure, summary: failure } }
          : { passed: true },
      };
    },
    publishPhase3Report: async () => ({ state: "APPLIED" }),
  };
  const runtime = {
    proxyActivities: () => activities,
    patched: () => true,
    workflowInfo: () => ({ workflowId: "workflow", runId: "temporal" }),
    defineQuery: (name: string) => name,
    defineUpdate: (name: string) => name,
    setHandler: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    uuid4: () => `id-${++ids}`,
    allHandlersFinished: () => true,
    condition: async (predicate: () => boolean) => {
      assert.ok(predicate(), "Workflow unexpectedly blocked");
    },
  };
  const source = await readFile("dist/apps/worker/src/workflows.js", "utf8");
  const compiled =
    source
      .replace(
        /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];/g,
        (_match, names: string, name: string) => `const {${names}} = require(${JSON.stringify(name)});`,
      )
      .replace(/export /g, "") + "\nexports.TaskRunWorkflow = TaskRunWorkflow;";
  const exports: Record<string, any> = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === "@temporalio/workflow") return runtime;
      if (name === "./qa-recovery.js") return recovery;
      throw new Error(`Unexpected workflow import: ${name}`);
    },
  });
  const input = {
    manifest: {
      runId: "run",
      workflowVersion: 2,
      repository: { id: "repo", baseSha: "base" },
      correctionBudget: { humanReplans: 5, testRepairs: budget },
    },
    context: { constraints: [], source: { instanceId: "source" } },
    workspaceId: "workspace",
    manifestHash: "manifest",
  } as unknown as TaskRunWorkflowInput;
  const result = (await exports.TaskRunWorkflow(input)) as WorkflowProjection;
  return { result, gates, executions, states, plans };
}

test("QA failure automatically repairs with evidence, then reaches final approval", async () => {
  const runResult = await run(["check-A", null]);
  assert.equal(runResult.result.state, "COMPLETED");
  assert.equal(runResult.plans, 1);
  assert.deepEqual(
    runResult.gates.map((g) => g?.kind),
    ["PLAN_APPROVAL", "FINAL_APPROVAL"],
  );
  assert.equal(runResult.executions[1]?.repairFeedback?.testArtifactHash, "test-1");
  assert.deepEqual(
    runResult.executions.map((e) => e.generation),
    [0, 1],
  );
});

test("same failure after two repairs returns to planning and requires approval", async () => {
  const r = await run(["A", "A", "A", null]);
  assert.equal(r.plans, 2);
  assert.deepEqual(
    r.gates.map((g) => g?.kind),
    ["PLAN_APPROVAL", "PLAN_APPROVAL", "FINAL_APPROVAL"],
  );
  assert.ok(r.result.constraints.some((c) => c.sourceRef === "artifact://test-3"));
});

test("different failures reset persistence count, but exhaust the cumulative budget", async () => {
  const r = await run(["A", "B", "C", "D", null]);
  const gate = r.gates.find((g) => g?.kind === "RECOVERY")!;
  assert.equal((gate.proposal as any).repairsUsed, 3);
  assert.deepEqual((gate.proposal as any).extension, { testRepairs: 1 });
  assert.equal(r.result.state, "COMPLETED");
});

test("replanning does not reset budget and rejecting recovery stops execution", async () => {
  const r = await run(["A", "A", "A", "B", "B"], 3, true);
  assert.equal(r.plans, 2);
  assert.equal(r.executions.length, 5);
  assert.equal(r.result.state, "CANCELLED");
  assert.equal(r.gates.filter((g) => g?.kind === "FINAL_APPROVAL").length, 0);
});

test("zero repair budget opens recovery on the first failure", async () => {
  const r = await run(["A"], 0, true);
  assert.equal(r.executions.length, 1);
  assert.equal(r.gates[1]?.kind, "RECOVERY");
});
