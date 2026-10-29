import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Context } from "@temporalio/activity";
import type { Pool } from "pg";
import { WorkspaceOperations } from "../../../packages/persistence/src/operations.js";
import {
  validateClarification,
  validatePlan,
  validateRepositoryInventory,
} from "../../../packages/contracts/src/index.js";
import {
  canonicalSha256,
  PgExternalOperationRepository,
  PgPhase3Repository,
  PgWorkflowRepository,
} from "../../../packages/persistence/src/index.js";
import type {
  DecisionPersistenceInput,
  FakeCompletion,
  InventoryInput,
  PlanInput,
  ProjectionInput,
  ReviewContextInput,
  TaskRunActivities,
  Phase3ExecutionResult,
  Phase3ReportResult,
} from "./types.js";

const ignored = new Set([".git", "node_modules", "dist", ".test-tmp"]);

export async function inventoryRepository(input: InventoryInput) {
  const root = resolve(input.repositoryRoot);
  const files: string[] = [];
  let truncated = false;
  async function walk(directory: string): Promise<void> {
    if (files.length >= 10_000) {
      truncated = true;
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
        throw new Error("REPOSITORY_ESCAPE_DENIED");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
      if (files.length >= 10_000) {
        truncated = true;
        return;
      }
    }
  }
  await walk(root);
  files.sort();
  return validateRepositoryInventory({
    schemaVersion: "1.0",
    repositoryId: input.repositoryId,
    baseSha: input.baseSha,
    files,
    truncated,
  });
}

export async function reviewContext(input: ReviewContextInput) {
  const hasAcceptedAssumption = input.constraints.some(
    (constraint) => constraint.origin === "accepted-assumption",
  );
  return validateClarification({
    schemaVersion: "1.0",
    sufficient: hasAcceptedAssumption,
    questions: hasAcceptedAssumption
      ? []
      : ["May the fake backend complete without changing repository files?"],
    proposedAssumptions: hasAcceptedAssumption
      ? []
      : ["Phase 2 uses the deterministic fake completion backend and performs no repository writes."],
    relevantPaths: input.inventory.files.slice(0, 20),
  });
}

export async function createPlan(input: PlanInput) {
  const feedback = input.constraints.filter((constraint) => constraint.origin === "human-feedback");
  const plan = validatePlan({
    schemaVersion: "1.0",
    revision: input.revision,
    title: feedback.length
      ? `Revised fake plan for ${input.context.title}`
      : `Fake plan for ${input.context.title}`,
    steps: [
      {
        id: "fake-completion",
        title: "Complete with the fake backend",
        description: feedback.length
          ? `Honor feedback: ${feedback.map((item) => item.text).join("; ")}`
          : "Return a deterministic receipt without provider, source, package, image, or repository writes.",
        tests: ["Verify the fake completion receipt is durable and projection revision increases."],
      },
    ],
    constraints: input.constraints,
    acceptanceMapping: input.context.acceptanceCriteria,
    risks: ["This Phase 2 plan proves orchestration only; code execution remains a Phase 3 boundary."],
  });
  return { plan, artifactHash: canonicalSha256(plan) };
}

export async function completeFakeRun(input: { runId: string; delayMs?: number }): Promise<FakeCompletion> {
  const deadline = Date.now() + (input.delayMs ?? 0);
  while (Date.now() < deadline) {
    Context.current().heartbeat({ operationId: `fake-complete/${input.runId}` });
    await Promise.race([
      new Promise((resolvePromise) => setTimeout(resolvePromise, 100)),
      Context.current().cancelled,
    ]);
  }
  return {
    status: "COMPLETED",
    summary: "Deterministic fake backend completed without external side effects.",
    operationId: `fake-complete/${input.runId}`,
  };
}

export async function executePhase3(input: {
  runId: string;
  manifestHash: string;
  plan: unknown;
  generation?: number;
}): Promise<Phase3ExecutionResult> {
  const candidateHash = canonicalSha256({
    runId: input.runId,
    plan: input.plan,
    kind: "fake-provider-candidate-v1",
    ...(input.generation === undefined ? {} : { generation: input.generation }),
  });
  const testArtifactHash = canonicalSha256({ candidateHash, command: "fixture-test", exitCode: 0, tests: 1 });
  const reviewArtifactHash = canonicalSha256({ candidateHash, recommendation: "APPROVE", findings: [] });
  const usageArtifactHash = canonicalSha256({
    runId: input.runId,
    provider: "fake",
    pricingStatus: "UNPRICED",
    attempts: 1,
  });
  const finalBundleHash = canonicalSha256({
    manifestHash: input.manifestHash,
    candidateHash,
    testArtifactHash,
    reviewArtifactHash,
    usageArtifactHash,
  });
  return {
    qa: { passed: true },
    candidateHash,
    testArtifactHash,
    reviewArtifactHash,
    usageArtifactHash,
    finalBundleHash,
    testOperationId: `test/${input.runId}/${candidateHash}`,
    reviewOperationId: `review/${input.runId}/${candidateHash}`,
  };
}

export async function publishPhase3Report(input: {
  runId: string;
  finalBundleHash: string;
}): Promise<Phase3ReportResult> {
  const operationKey = `report/${input.runId}/${input.finalBundleHash}`;
  return { state: "APPLIED", operationKey, marker: `<!-- oda:${operationKey} -->` };
}

export function createPersistentActivities(pool: Pool): TaskRunActivities {
  const repository = new PgWorkflowRepository(pool);
  const externalOperations = new PgExternalOperationRepository(pool);
  const phase3 = new PgPhase3Repository(pool);
  return {
    inventoryRepository,
    reviewContext,
    createPlan,
    completeFakeRun,
    async executePhase3(input) {
      const execution = await executePhase3(input);
      await phase3.sealCandidate({
        id: uuidFromHash(`candidate/${input.runId}/${execution.candidateHash}`),
        runId: input.runId,
        generation: input.generation ?? 0,
        candidateHash: execution.candidateHash,
        baseSha: input.baseSha,
        diffLocator: `artifact://candidate/${execution.candidateHash}`,
      });
      const usageOperationId = uuidFromHash(`usage-operation/${input.runId}/${execution.candidateHash}`);
      await phase3.reserveUsage({
        operationId: usageOperationId,
        runId: input.runId,
        maxMicrousd: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await phase3.appendUsage({
        attemptId: uuidFromHash(`usage-attempt/${input.runId}/${execution.candidateHash}`),
        operationId: usageOperationId,
        runId: input.runId,
        stepId: null,
        provider: "fake",
        model: "fixture",
        category: "model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        amountMicrousd: null,
        pricingSnapshotId: null,
        usage: { pricingStatus: "UNPRICED", source: "fake" },
        observedAt: new Date().toISOString(),
      });
      for (const evidence of [
        {
          kind: "test",
          operationId: execution.testOperationId,
          artifactHash: execution.testArtifactHash,
        },
        {
          kind: "review",
          operationId: execution.reviewOperationId,
          artifactHash: execution.reviewArtifactHash,
        },
        {
          kind: "usage",
          operationId: `usage/${input.runId}/${execution.candidateHash}`,
          artifactHash: execution.usageArtifactHash,
        },
        {
          kind: "final-bundle",
          operationId: `bundle/${input.runId}/${execution.candidateHash}`,
          artifactHash: execution.finalBundleHash,
        },
      ])
        await phase3.appendEvidence(input.workspaceId, {
          id: uuidFromHash(`evidence/${evidence.operationId}`),
          runId: input.runId,
          candidateHash: execution.candidateHash,
          kind: evidence.kind,
          operationId: uuidFromHash(evidence.operationId),
          artifactHash: evidence.artifactHash,
          passed: evidence.kind === "test" ? (execution.qa?.passed ?? true) : true,
        });
      return execution;
    },
    async publishPhase3Report(input) {
      const report = await publishPhase3Report(input);
      const started = await externalOperations.begin(
        input.workspaceId,
        input.sourcePluginId,
        report.operationKey,
        "comment",
        {
          runId: input.runId,
          finalBundleHash: input.finalBundleHash,
          marker: report.marker,
          mode: "fake-source",
        },
      );
      if (started.operation.state === "APPLIED") return report;
      if (started.operation.state === "INTENT")
        await externalOperations.transition(started.operation.id, ["INTENT"], "IN_FLIGHT");
      await externalOperations.transition(started.operation.id, ["IN_FLIGHT", "UNCERTAIN"], "APPLIED", {
        marker: report.marker,
        source: "fake",
      });
      return report;
    },
    async projectRun(input: ProjectionInput) {
      await repository.project(input.workspaceId, input.projection, input.temporalExecutionId);
      if (["COMPLETED", "CANCELLED", "FAILED", "NEEDS_ATTENTION"].includes(input.projection.state))
        await new WorkspaceOperations(pool, input.workspaceId).releaseFinished();
    },
    async projectStep(input) {
      await repository.projectStep(input.workspaceId, input.step);
    },
    async openGate(input: ProjectionInput) {
      await repository.openGate(input.workspaceId, input.projection);
    },
    async persistDecision(input: DecisionPersistenceInput) {
      await repository.persistDecision(
        input.workspaceId,
        input.actorId,
        input.decision,
        input.receipt,
        input.projection,
      );
    },
  };
}

export function createMemoryActivities(
  onProjection?: (projection: ProjectionInput) => void,
): TaskRunActivities {
  return {
    inventoryRepository,
    reviewContext,
    createPlan,
    completeFakeRun,
    executePhase3,
    publishPhase3Report,
    async projectRun(input) {
      onProjection?.(structuredClone(input));
    },
    async projectStep() {},
    async openGate(input) {
      onProjection?.(structuredClone(input));
    },
    async persistDecision(input) {
      onProjection?.(structuredClone(input));
    },
  };
}

export function heartbeatCancellation(): void {
  Context.current().heartbeat({ checkedAt: new Date().toISOString() });
}

export function hashFixture(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uuidFromHash(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
