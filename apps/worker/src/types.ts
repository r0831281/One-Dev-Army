import type {
  Clarification,
  Constraint,
  DecisionReceipt,
  GateDecisionInput,
  Plan,
  RepositoryInventory,
  RunManifest,
  StepProjection,
  TaskContext,
  WorkflowProjection,
} from "../../../packages/contracts/src/index.js";
import type { QaFailure, QaRecoveryState } from "./qa-recovery.js";

export const TASK_RUN_QUEUE = "oda-task-run-v1";
export const TASK_RUN_WORKFLOW_VERSION = 1;

export interface TaskRunWorkflowInput {
  workspaceId: string;
  actorId: string;
  manifest: RunManifest;
  manifestHash: string;
  context: TaskContext;
  repositoryRoot: string;
  profileBindings?: Record<string, { id: string; revision: number; provider: string; model: string }>;
  continueAsNewAfterTransitions?: number;
  fakeCompletionDelayMs?: number;
  carried?: {
    projection: WorkflowProjection;
    clarification: Clarification | null;
    decisions: Array<{ key: string; fingerprint: string; receipt: DecisionReceipt }>;
    transitionCount: number;
    qaRecovery?: QaRecoveryState;
    executionGeneration?: number;
  };
}

export interface InventoryInput {
  repositoryRoot: string;
  repositoryId: string;
  baseSha: string;
}
export interface ReviewContextInput {
  context: TaskContext;
  inventory: RepositoryInventory;
  constraints: Constraint[];
}
export interface PlanInput {
  context: TaskContext;
  inventory: RepositoryInventory;
  constraints: Constraint[];
  revision: number;
}
export interface ProjectionInput {
  workspaceId: string;
  temporalExecutionId: string;
  projection: WorkflowProjection;
}
export interface DecisionPersistenceInput extends ProjectionInput {
  actorId: string;
  decision: GateDecisionInput;
  receipt: DecisionReceipt;
}
export interface FakeCompletion {
  status: "COMPLETED";
  summary: string;
  operationId: string;
}
export interface Phase3ExecutionResult {
  /** Absent only for legacy activity histories, whose fixture tests always passed. */
  qa?: { passed: true } | { passed: false; failure: QaFailure };
  candidateHash: string;
  testArtifactHash: string;
  reviewArtifactHash: string;
  usageArtifactHash: string;
  finalBundleHash: string;
  testOperationId: string;
  reviewOperationId: string;
}
export interface Phase3ReportResult {
  state: "APPLIED" | "REPORT_PENDING";
  operationKey: string;
  marker: string;
}

export interface TaskRunActivities {
  inventoryRepository(input: InventoryInput): Promise<RepositoryInventory>;
  reviewContext(input: ReviewContextInput): Promise<Clarification>;
  createPlan(input: PlanInput): Promise<{ plan: Plan; artifactHash: string }>;
  projectRun(input: ProjectionInput): Promise<void>;
  projectStep(input: { workspaceId: string; step: StepProjection }): Promise<void>;
  openGate(input: ProjectionInput): Promise<void>;
  persistDecision(input: DecisionPersistenceInput): Promise<void>;
  completeFakeRun(input: { runId: string; plan: Plan; delayMs?: number }): Promise<FakeCompletion>;
  executePhase3(input: {
    workspaceId: string;
    runId: string;
    manifestHash: string;
    baseSha: string;
    plan: Plan;
    generation?: number;
    repairFeedback?: { failure: QaFailure; candidateHash: string; testArtifactHash: string };
  }): Promise<Phase3ExecutionResult>;
  publishPhase3Report(input: {
    workspaceId: string;
    sourcePluginId: string;
    runId: string;
    finalBundleHash: string;
  }): Promise<Phase3ReportResult>;
}

export interface CancelRunInput {
  expectedStateRevision: number;
  reason: string;
  idempotencyKey: string;
}
export interface CancelReceipt {
  status: "RECORDED";
  stateRevision: number;
  idempotencyKey: string;
}
