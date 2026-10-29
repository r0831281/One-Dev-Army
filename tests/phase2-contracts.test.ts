import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateClarification,
  validateGateDecisionInput,
  validatePlan,
  validateRunManifest,
  validateTaskContext,
  validateWorkflowProjection,
} from "../packages/contracts/src/index.js";
import { canonicalSha256, MemoryProjectionStore } from "../packages/persistence/src/index.js";
import { createPlan, inventoryRepository, reviewContext } from "../apps/worker/src/activities.js";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

const context = validateTaskContext(fixture);

function manifest() {
  return validateRunManifest({
    schemaVersion: "1.0",
    workflowType: "TaskRunWorkflow",
    workflowVersion: 1,
    runId: randomUUID(),
    taskId: context.taskId,
    contextRevision: 1,
    repository: context.repository,
    routingRevision: 1,
    policyHash: "a".repeat(64),
    profileRevisions: { "context-reviewer": 1, planner: 1 },
    correctionBudget: {
      humanReplans: 5,
      testRepairs: 3,
      reviewRepairs: 2,
      structuredOutputRepairs: 2,
      transportAttempts: 3,
    },
    createdAt: new Date().toISOString(),
  });
}

test("Phase 2 contracts reject stale shapes and canonical hashes ignore key order", () => {
  const value = manifest();
  assert.equal(canonicalSha256({ a: 1, b: 2 }), canonicalSha256({ b: 2, a: 1 }));
  assert.throws(() => validateRunManifest({ ...value, workflowVersion: 0 }));
  assert.throws(() =>
    validateGateDecisionInput({
      protocolVersion: "1.0",
      runId: value.runId,
      workflowId: `task/${value.taskId}/run/${value.runId}`,
      gateId: randomUUID(),
      expectedGateVersion: 1,
      decision: "REJECT",
      idempotencyKey: randomUUID(),
    }),
  );
});

test("repository inventory is read-only and fake planning preserves feedback provenance", async () => {
  const inventory = await inventoryRepository({
    repositoryRoot: process.cwd(),
    repositoryId: context.repository.id,
    baseSha: context.repository.baseSha,
  });
  assert.ok(inventory.files.includes("README.md"));
  const clarification = validateClarification(await reviewContext({ context, inventory, constraints: [] }));
  assert.equal(clarification.sufficient, false);
  const constraint = {
    id: "feedback/decision-1",
    text: "Keep the demonstration offline",
    origin: "human-feedback" as const,
    sourceRef: "gate/gate-1/version/1",
  };
  const planned = await createPlan({
    context,
    inventory,
    constraints: [constraint],
    revision: 2,
  });
  assert.equal(validatePlan(planned.plan).constraints[0]?.sourceRef, constraint.sourceRef);
  assert.match(planned.plan.steps[0]!.description, /Keep the demonstration offline/);
});

test("projection replay never overwrites a newer revision", () => {
  const value = manifest();
  const workflowId = `task/${value.taskId}/run/${value.runId}`;
  const base = validateWorkflowProjection({
    schemaVersion: "1.0",
    runId: value.runId,
    workflowId,
    state: "QUEUED",
    stateRevision: 1,
    manifestHash: canonicalSha256(value),
    plan: null,
    currentGate: null,
    constraints: [],
    budget: { humanReplansUsed: 0, humanReplansLimit: 5 },
    cancelRequested: false,
    updatedAt: new Date().toISOString(),
  });
  const store = new MemoryProjectionStore();
  assert.equal(store.apply({ ...base, state: "COMPLETED", stateRevision: 3 }), true);
  assert.equal(store.apply({ ...base, state: "PLANNING", stateRevision: 2 }), false);
  assert.equal(store.get(value.runId)?.state, "COMPLETED");
});
