import {
  allHandlersFinished,
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineQuery,
  defineUpdate,
  proxyActivities,
  patched,
  setHandler,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  Constraint,
  DecisionReceipt,
  GateDecisionInput,
  Json,
  WorkflowProjection,
} from "../../../packages/contracts/src/index.js";
import type { CancelReceipt, CancelRunInput, TaskRunActivities, TaskRunWorkflowInput } from "./types.js";
import { routeQaFailure } from "./qa-recovery.js";

export async function TaskRunWorkflowReplayFixture(value: number): Promise<number> {
  if (patched("phase2-compatible-evolution-v2")) return value + 1;
  return value;
}

const activities = proxyActivities<TaskRunActivities>({
  startToCloseTimeout: "30 seconds",
  heartbeatTimeout: "1 second",
  retry: { maximumAttempts: 3, initialInterval: "250 milliseconds", maximumInterval: "5 seconds" },
});

export const submitGateDecision = defineUpdate<DecisionReceipt, [GateDecisionInput]>("submitGateDecision");
export const cancelRun = defineUpdate<CancelReceipt, [CancelRunInput]>("cancelRun");
export const taskRunState = defineQuery<WorkflowProjection>("taskRunState");

function decisionFingerprint(input: GateDecisionInput): string {
  return [
    input.runId,
    input.workflowId,
    input.gateId,
    input.expectedGateVersion,
    input.decision,
    input.reason ?? "",
  ].join("\u001f");
}

function now(): string {
  return new Date().toISOString();
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function TaskRunWorkflow(input: TaskRunWorkflowInput): Promise<WorkflowProjection> {
  const workflowId = workflowInfo().workflowId;
  const temporalExecutionId = workflowInfo().runId;
  const carried = input.carried;
  let projection: WorkflowProjection = carried?.projection ?? {
    schemaVersion: "1.0",
    runId: input.manifest.runId,
    workflowId,
    state: "QUEUED",
    stateRevision: 0,
    manifestHash: input.manifestHash,
    plan: null,
    currentGate: null,
    constraints: clone(input.context.constraints),
    budget: {
      humanReplansUsed: 0,
      humanReplansLimit: input.manifest.correctionBudget.humanReplans,
    },
    cancelRequested: false,
    updatedAt: now(),
  };
  let clarification = carried?.clarification ?? null;
  let transitionCount = carried?.transitionCount ?? 0;
  const qaRecoveryEnabled = input.manifest.workflowVersion >= 2 && patched("qa-repair-routing-v1");
  let qaRecovery = carried?.qaRecovery ?? {
    repairsUsed: 0,
    repairsLimit: input.manifest.correctionBudget.testRepairs,
    failure: null,
    sameFailureRepairs: 0,
  };
  let executionGeneration = carried?.executionGeneration ?? 0;
  let reservedDecision: GateDecisionInput | null = null;
  let activeCompletionScope: CancellationScope | null = null;
  const decisions = new Map(
    (carried?.decisions ?? []).map((item) => [
      item.key,
      { fingerprint: item.fingerprint, receipt: item.receipt },
    ]),
  );
  const cancellationKeys = new Map<string, CancelReceipt>();

  const advance = (state: WorkflowProjection["state"]): void => {
    projection = {
      ...projection,
      state,
      stateRevision: projection.stateRevision + 1,
      updatedAt: now(),
    };
    transitionCount++;
  };
  const projectionInput = () => ({
    workspaceId: input.workspaceId,
    temporalExecutionId,
    projection,
  });

  setHandler(taskRunState, () => projection);
  setHandler(submitGateDecision, async (decision) => {
    const fingerprint = decisionFingerprint(decision);
    const prior = decisions.get(decision.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw ApplicationFailure.nonRetryable("Idempotency key payload differs", "IDEMPOTENCY_CONFLICT");
      return prior.receipt;
    }
    const gate = projection.currentGate;
    if (!gate || gate.state !== "PENDING")
      throw ApplicationFailure.nonRetryable("Gate is not pending", "GATE_ALREADY_DECIDED");
    if (
      decision.runId !== projection.runId ||
      decision.workflowId !== workflowId ||
      decision.gateId !== gate.id
    )
      throw ApplicationFailure.nonRetryable("Gate identity does not match", "GATE_VERSION_CONFLICT");
    if (decision.expectedGateVersion !== gate.version)
      throw ApplicationFailure.nonRetryable("Gate version is stale", "GATE_VERSION_CONFLICT");
    if (reservedDecision)
      throw ApplicationFailure.nonRetryable("Another decision reserved this gate", "GATE_ALREADY_DECIDED");
    if (decision.decision === "REJECT" && !decision.reason?.trim())
      throw ApplicationFailure.nonRetryable("Rejection reason required", "VALIDATION_FAILED");
    if (decision.decision === "APPROVE" && decision.reason !== undefined)
      throw ApplicationFailure.nonRetryable("Approval cannot include a reason", "VALIDATION_FAILED");

    reservedDecision = clone(decision);
    projection = {
      ...projection,
      stateRevision: projection.stateRevision + 1,
      currentGate: { ...gate, state: "DECIDED" },
      updatedAt: now(),
    };
    const receipt: DecisionReceipt = {
      decisionId: uuid4(),
      status: "RECORDED",
      gateVersion: gate.version,
      stateRevision: projection.stateRevision,
      recordedAt: now(),
    };
    await activities.persistDecision({
      ...projectionInput(),
      actorId: input.actorId,
      decision,
      receipt,
    });
    decisions.set(decision.idempotencyKey, { fingerprint, receipt });
    return receipt;
  });
  setHandler(cancelRun, async (cancel) => {
    const prior = cancellationKeys.get(cancel.idempotencyKey);
    if (prior) return prior;
    if (!cancel.reason.trim())
      throw ApplicationFailure.nonRetryable("Cancellation reason required", "VALIDATION_FAILED");
    if (cancel.expectedStateRevision !== projection.stateRevision)
      throw ApplicationFailure.nonRetryable("Run revision is stale", "STATE_CONFLICT");
    projection = {
      ...projection,
      state: "CANCELLING",
      stateRevision: projection.stateRevision + 1,
      cancelRequested: true,
      currentGate: projection.currentGate ? { ...projection.currentGate, state: "CANCELLED" } : null,
      updatedAt: now(),
    };
    const receipt: CancelReceipt = {
      status: "RECORDED",
      stateRevision: projection.stateRevision,
      idempotencyKey: cancel.idempotencyKey,
    };
    cancellationKeys.set(cancel.idempotencyKey, receipt);
    activeCompletionScope?.cancel();
    await activities.projectRun(projectionInput());
    return receipt;
  });

  const waitForGate = async (): Promise<GateDecisionInput | null> => {
    await condition(() => reservedDecision !== null || projection.cancelRequested);
    await condition(allHandlersFinished);
    return reservedDecision;
  };
  const finishCancellation = async (): Promise<WorkflowProjection> => {
    advance("CANCELLED");
    projection = { ...projection, currentGate: null };
    await activities.projectRun(projectionInput());
    return projection;
  };

  if (!clarification) {
    advance("CONTEXT_REVIEW");
    await activities.projectRun(projectionInput());
    const inventory = await activities.inventoryRepository({
      repositoryRoot: input.repositoryRoot,
      repositoryId: input.manifest.repository.id,
      baseSha: input.manifest.repository.baseSha,
    });
    clarification = await activities.reviewContext({
      context: input.context,
      inventory,
      constraints: projection.constraints,
    });
    if (!clarification.sufficient) {
      advance("AWAITING_CONTEXT");
      projection = {
        ...projection,
        currentGate: {
          id: uuid4(),
          version: 1,
          kind: "CLARIFICATION",
          state: "PENDING",
          artifactHash: input.manifestHash,
          proposal: clarification as unknown as Json,
        },
      };
      reservedDecision = null;
      await activities.openGate(projectionInput());
      const clarificationDecision = await waitForGate();
      if (!clarificationDecision || projection.cancelRequested) return finishCancellation();
      if (clarificationDecision.decision === "REJECT") {
        projection.constraints.push({
          id: `feedback/${clarificationDecision.idempotencyKey}`,
          text: clarificationDecision.reason!,
          origin: "human-feedback",
          sourceRef: `gate/${clarificationDecision.gateId}/version/${clarificationDecision.expectedGateVersion}`,
        });
      } else {
        projection.constraints.push(
          ...clarification.proposedAssumptions.map<Constraint>((text, index) => ({
            id: `assumption/${clarificationDecision.idempotencyKey}/${index + 1}`,
            text,
            origin: "accepted-assumption",
            sourceRef: `decision/${clarificationDecision.idempotencyKey}`,
          })),
        );
      }
      clarification = { ...clarification, sufficient: true };
    }
  }

  executionLoop: for (;;) {
    const inventoryAfterClarification = await activities.inventoryRepository({
      repositoryRoot: input.repositoryRoot,
      repositoryId: input.manifest.repository.id,
      baseSha: input.manifest.repository.baseSha,
    });
    while (!projection.cancelRequested) {
      advance("PLANNING");
      await activities.projectRun(projectionInput());
      const planRevision = (projection.plan?.revision ?? 0) + 1;
      const plannerStepId = uuid4();
      await activities.projectStep({
        workspaceId: input.workspaceId,
        step: {
          schemaVersion: "1.0",
          stepId: plannerStepId,
          runId: projection.runId,
          stepKey: "planner",
          iteration: planRevision,
          state: "RUNNING",
          stateRevision: 1,
          detail: { constraints: projection.constraints.length } as Json,
        },
      });
      const planned = await activities.createPlan({
        context: input.context,
        inventory: inventoryAfterClarification,
        constraints: projection.constraints,
        revision: planRevision,
      });
      await activities.projectStep({
        workspaceId: input.workspaceId,
        step: {
          schemaVersion: "1.0",
          stepId: plannerStepId,
          runId: projection.runId,
          stepKey: "planner",
          iteration: planRevision,
          state: "COMPLETED",
          stateRevision: 2,
          detail: { planRevision, artifactHash: planned.artifactHash } as Json,
        },
      });
      advance("AWAITING_PLAN");
      projection = {
        ...projection,
        plan: planned.plan,
        currentGate: {
          id: uuid4(),
          version: planRevision,
          kind: "PLAN_APPROVAL",
          state: "PENDING",
          artifactHash: planned.artifactHash,
          proposal: planned.plan as unknown as Json,
        },
      };
      reservedDecision = null;
      await activities.openGate(projectionInput());
      const planDecision = await waitForGate();
      if (!planDecision || projection.cancelRequested) return finishCancellation();
      if (planDecision.decision === "APPROVE") break;
      const used = projection.budget.humanReplansUsed + 1;
      projection.constraints.push({
        id: `feedback/${planDecision.idempotencyKey}`,
        text: planDecision.reason!,
        origin: "human-feedback",
        sourceRef: `gate/${planDecision.gateId}/version/${planDecision.expectedGateVersion}`,
      });
      projection = {
        ...projection,
        budget: { ...projection.budget, humanReplansUsed: used },
        currentGate: projection.currentGate ? { ...projection.currentGate, state: "SUPERSEDED" } : null,
      };
      if (used >= projection.budget.humanReplansLimit) {
        advance("NEEDS_ATTENTION");
        projection = {
          ...projection,
          currentGate: {
            id: uuid4(),
            version: 1,
            kind: "RECOVERY",
            state: "PENDING",
            artifactHash: projection.manifestHash,
            proposal: { reason: "Human replan budget exhausted", used } as Json,
          },
        };
        reservedDecision = null;
        await activities.openGate(projectionInput());
        const recovery = await waitForGate();
        if (!recovery || projection.cancelRequested || recovery.decision === "REJECT")
          return finishCancellation();
        projection = {
          ...projection,
          budget: { ...projection.budget, humanReplansLimit: projection.budget.humanReplansLimit + 1 },
        };
      }
      if (
        input.continueAsNewAfterTransitions &&
        transitionCount >= input.continueAsNewAfterTransitions &&
        allHandlersFinished()
      ) {
        await continueAsNew<typeof TaskRunWorkflow>({
          ...input,
          carried: {
            projection: { ...projection, currentGate: null },
            clarification,
            decisions: [...decisions].map(([key, value]) => ({ key, ...value })),
            transitionCount: 0,
            ...(qaRecoveryEnabled ? { qaRecovery, executionGeneration } : {}),
          },
        });
      }
    }

    if (projection.cancelRequested) return finishCancellation();
    if (input.manifest.workflowVersion >= 2) {
      let repairFeedback: Parameters<TaskRunActivities["executePhase3"]>[0]["repairFeedback"];
      for (;;) {
        if (projection.cancelRequested) return finishCancellation();
        advance("IMPLEMENTING");
        projection = { ...projection, currentGate: null };
        await activities.projectRun(projectionInput());
        const execution = await activities.executePhase3({
          workspaceId: input.workspaceId,
          runId: projection.runId,
          manifestHash: projection.manifestHash,
          baseSha: input.manifest.repository.baseSha,
          plan: projection.plan!,
          ...(qaRecoveryEnabled
            ? { generation: executionGeneration++, ...(repairFeedback ? { repairFeedback } : {}) }
            : {}),
        });
        advance("TESTING");
        await activities.projectRun(projectionInput());
        if (projection.cancelRequested) return finishCancellation();
        if (qaRecoveryEnabled && execution.qa?.passed === false) {
          const routed = routeQaFailure(qaRecovery, execution.qa.failure);
          qaRecovery = routed.state;
          repairFeedback = {
            failure: execution.qa.failure,
            candidateHash: execution.candidateHash,
            testArtifactHash: execution.testArtifactHash,
          };
          if (routed.route === "IMPLEMENT") continue;
          if (routed.route === "RECOVERY") {
            advance("NEEDS_ATTENTION");
            projection = {
              ...projection,
              currentGate: {
                id: uuid4(),
                version: executionGeneration,
                kind: "RECOVERY",
                state: "PENDING",
                artifactHash: execution.testArtifactHash,
                proposal: {
                  reason: "QA repair budget exhausted",
                  ...qaRecovery,
                  candidateHash: execution.candidateHash,
                  testArtifactHash: execution.testArtifactHash,
                  extension: { testRepairs: 1 },
                } as unknown as Json,
              },
            };
            reservedDecision = null;
            await activities.openGate(projectionInput());
            const recovery = await waitForGate();
            if (!recovery || projection.cancelRequested || recovery.decision === "REJECT")
              return finishCancellation();
            qaRecovery = { ...qaRecovery, repairsLimit: qaRecovery.repairsLimit + 1 };
          }
          projection.constraints.push({
            id: `qa/${executionGeneration}`,
            origin: "task",
            text: `QA requires a revised plan: ${execution.qa.failure.summary}`,
            sourceRef: `artifact://${execution.testArtifactHash}`,
          });
          qaRecovery = { ...qaRecovery, failure: null, sameFailureRepairs: 0 };
          projection = { ...projection, currentGate: null };
          continue executionLoop;
        }
        advance("REVIEWING");
        await activities.projectRun(projectionInput());
        advance("AWAITING_FINAL");
        projection = {
          ...projection,
          currentGate: {
            id: uuid4(),
            version: 1,
            kind: "FINAL_APPROVAL",
            state: "PENDING",
            artifactHash: execution.finalBundleHash,
            proposal: {
              candidateHash: execution.candidateHash,
              testArtifactHash: execution.testArtifactHash,
              reviewArtifactHash: execution.reviewArtifactHash,
              usageArtifactHash: execution.usageArtifactHash,
              testOperationId: execution.testOperationId,
              reviewOperationId: execution.reviewOperationId,
            } as Json,
          },
        };
        reservedDecision = null;
        await activities.openGate(projectionInput());
        const finalDecision = await waitForGate();
        if (!finalDecision || projection.cancelRequested) return finishCancellation();
        if (finalDecision.decision === "REJECT") {
          projection.constraints.push({
            id: `feedback/${finalDecision.idempotencyKey}`,
            text: finalDecision.reason!,
            origin: "human-feedback",
            sourceRef: `gate/${finalDecision.gateId}/version/${finalDecision.expectedGateVersion}`,
          });
          advance("NEEDS_ATTENTION");
          projection = { ...projection, currentGate: null };
          await activities.projectRun(projectionInput());
          return projection;
        }
        advance("REPORTING");
        projection = { ...projection, currentGate: null };
        await activities.projectRun(projectionInput());
        const report = await activities.publishPhase3Report({
          workspaceId: input.workspaceId,
          sourcePluginId: input.context.source.instanceId,
          runId: projection.runId,
          finalBundleHash: execution.finalBundleHash,
        });
        if (report.state === "REPORT_PENDING") {
          advance("REPORT_PENDING");
          await activities.projectRun(projectionInput());
          return projection;
        }
        advance("COMPLETED");
        await activities.projectRun(projectionInput());
        await condition(allHandlersFinished);
        return projection;
      }
    }
    break;
  }
  advance("IMPLEMENTING");
  projection = { ...projection, currentGate: null };
  await activities.projectRun(projectionInput());
  activeCompletionScope = new CancellationScope();
  const completionStepId = uuid4();
  await activities.projectStep({
    workspaceId: input.workspaceId,
    step: {
      schemaVersion: "1.0",
      stepId: completionStepId,
      runId: projection.runId,
      stepKey: "fake-completion",
      iteration: 1,
      state: "RUNNING",
      stateRevision: 1,
      detail: {} as Json,
    },
  });
  try {
    await activeCompletionScope.run(() =>
      activities.completeFakeRun({
        runId: projection.runId,
        plan: projection.plan!,
        ...(input.fakeCompletionDelayMs === undefined ? {} : { delayMs: input.fakeCompletionDelayMs }),
      }),
    );
  } catch (error) {
    if (projection.cancelRequested) {
      await activities.projectStep({
        workspaceId: input.workspaceId,
        step: {
          schemaVersion: "1.0",
          stepId: completionStepId,
          runId: projection.runId,
          stepKey: "fake-completion",
          iteration: 1,
          state: "CANCELLED",
          stateRevision: 2,
          detail: {} as Json,
        },
      });
      return finishCancellation();
    }
    throw error;
  } finally {
    activeCompletionScope = null;
  }
  await activities.projectStep({
    workspaceId: input.workspaceId,
    step: {
      schemaVersion: "1.0",
      stepId: completionStepId,
      runId: projection.runId,
      stepKey: "fake-completion",
      iteration: 1,
      state: "COMPLETED",
      stateRevision: 2,
      detail: {} as Json,
    },
  });
  advance("COMPLETED");
  await activities.projectRun(projectionInput());
  await condition(allHandlersFinished);
  return projection;
}
