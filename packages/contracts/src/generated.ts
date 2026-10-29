// Generated from docs/reference/schemas.json by tools/generate-contracts.mjs. Do not edit by hand.

/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "UUID".
 */
export type UUID = string;
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "Cursor".
 */
export type Cursor = string;

export interface ODAReferenceContracts {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "RepositoryTarget".
 */
export interface RepositoryTarget {
  id: UUID;
  baseSha: string;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "Constraint".
 */
export interface Constraint {
  id: string;
  text: string;
  origin: "policy" | "task" | "human-feedback" | "accepted-assumption";
  sourceRef: string;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "TaskContext".
 */
export interface TaskContext {
  schemaVersion: "1.0";
  taskId: UUID;
  revision: number;
  source: {
    instanceId: UUID;
    externalId: string;
    key: string;
    url: string;
    revision: string | null;
  };
  repository: RepositoryTarget;
  title: string;
  description: string;
  /**
   * @maxItems 100
   */
  acceptanceCriteria: string[];
  /**
   * @maxItems 100
   */
  attachments: {
    id: string;
    name: string;
    url: string;
    mediaType: string | null;
    sizeBytes: number | null;
  }[];
  /**
   * @maxItems 100
   */
  labels: string[];
  requester: null | {
    id: string;
    displayName: string;
  };
  /**
   * @maxItems 200
   */
  constraints: Constraint[];
  provenance: {
    fetchedAt: Timestamp;
    pluginId: string;
    pluginVersion: string;
    payloadArtifactId: UUID | null;
  };
  extensions?: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "AgentProfile".
 */
export interface AgentProfile {
  schemaVersion: "1.0";
  id: UUID;
  name: string;
  revision: number;
  role: "context-reviewer" | "planner" | "implementer" | "tester" | "reviewer" | "reporter" | "setup";
  provider: "openai" | "anthropic" | "ollama" | "openrouter" | "gemini" | "bedrock";
  model: string;
  credentialRef: string | null;
  providerOptions: {
    temperature: number | null;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
  };
  limits: {
    maxInputTokens: number;
    maxOutputTokens: number;
    timeoutMs: number;
    maxModelCalls: number;
  };
  tools: (
    | "repo.read"
    | "repo.search"
    | "sandbox.read"
    | "sandbox.write"
    | "sandbox.exec"
    | "test.run"
    | "static.run"
  )[];
  prompt: {
    templateId: string;
    templateRevision: number;
    intent: string;
    compiledArtifactId: UUID | null;
  };
  outputSchemaRef: string;
  retryPolicy: {
    transportAttempts: number;
    structuredOutputRepairs: number;
  };
  /**
   * @maxItems 5
   */
  fallbackProfileIds:
    | []
    | [UUID]
    | [UUID, UUID]
    | [UUID, UUID, UUID]
    | [UUID, UUID, UUID, UUID]
    | [UUID, UUID, UUID, UUID, UUID];
}
export interface GateDecisionInput {
  protocolVersion: "1.0";
  runId: UUID;
  workflowId: string;
  gateId: UUID;
  expectedGateVersion: number;
  decision: "APPROVE" | "REJECT";
  reason?: string;
  idempotencyKey: UUID;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "DecisionReceipt".
 */
export interface DecisionReceipt {
  decisionId: UUID;
  status: "RECORDED" | "PENDING";
  gateVersion: number;
  stateRevision: number;
  recordedAt: Timestamp | null;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "RunManifest".
 */
export interface RunManifest {
  schemaVersion: "1.0";
  workflowType: "TaskRunWorkflow";
  workflowVersion: number;
  runId: UUID;
  taskId: UUID;
  contextRevision: number;
  repository: RepositoryTarget;
  routingRevision: number;
  policyHash: string;
  profileRevisions: {
    [k: string]: number;
  };
  correctionBudget: {
    humanReplans: number;
    testRepairs: number;
    reviewRepairs: number;
    structuredOutputRepairs: number;
    transportAttempts: number;
  };
  createdAt: Timestamp;
  extensions?: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "RepositoryInventory".
 */
export interface RepositoryInventory {
  schemaVersion: "1.0";
  repositoryId: UUID;
  baseSha: string;
  /**
   * @maxItems 10000
   */
  files: string[];
  truncated: boolean;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "Clarification".
 */
export interface Clarification {
  schemaVersion: "1.0";
  sufficient: boolean;
  /**
   * @maxItems 50
   */
  questions: string[];
  /**
   * @maxItems 50
   */
  proposedAssumptions: string[];
  /**
   * @maxItems 500
   */
  relevantPaths: string[];
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "Plan".
 */
export interface Plan {
  schemaVersion: "1.0";
  revision: number;
  title: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  steps: [
    {
      id: string;
      title: string;
      description: string;
      /**
       * @maxItems 50
       */
      tests: string[];
    },
    ...{
      id: string;
      title: string;
      description: string;
      /**
       * @maxItems 50
       */
      tests: string[];
    }[]
  ];
  /**
   * @maxItems 200
   */
  constraints: Constraint[];
  /**
   * @maxItems 100
   */
  acceptanceMapping: string[];
  /**
   * @maxItems 100
   */
  risks: string[];
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "WorkflowProjection".
 */
export interface WorkflowProjection {
  schemaVersion: "1.0";
  runId: UUID;
  workflowId: string;
  state:
    | "QUEUED"
    | "CONTEXT_REVIEW"
    | "AWAITING_CONTEXT"
    | "PLANNING"
    | "AWAITING_PLAN"
    | "IMPLEMENTING"
    | "TESTING"
    | "REVIEWING"
    | "AWAITING_FINAL"
    | "REPORTING"
    | "REPORT_PENDING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLING"
    | "CANCELLED"
    | "NEEDS_ATTENTION";
  stateRevision: number;
  manifestHash: string;
  plan: Plan | null;
  currentGate: null | {
    id: UUID;
    version: number;
    kind: "CLARIFICATION" | "PLAN_APPROVAL" | "RECOVERY" | "FINAL_APPROVAL";
    state: "PENDING" | "DECIDED" | "SUPERSEDED" | "CANCELLED";
    artifactHash: string;
    proposal: unknown;
  };
  /**
   * @maxItems 200
   */
  constraints: Constraint[];
  budget: {
    humanReplansUsed: number;
    humanReplansLimit: number;
  };
  cancelRequested: boolean;
  updatedAt: Timestamp;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "StepProjection".
 */
export interface StepProjection {
  schemaVersion: "1.0";
  stepId: UUID;
  runId: UUID;
  stepKey: string;
  iteration: number;
  state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stateRevision: number;
  detail: unknown;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "EventEnvelope".
 */
export interface EventEnvelope {
  protocolVersion: "1.0";
  cursor: Cursor;
  type: string;
  occurredAt: Timestamp;
  runId: UUID | null;
  stateRevision: number | null;
  payload: unknown;
  resync?: {
    reason: "RETENTION_GAP" | "EPOCH_CHANGED";
    snapshotUrl: "/api/v1/snapshot";
    journalEpoch: UUID;
  };
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "TelemetryEvent".
 */
export interface TelemetryEvent {
  schemaVersion: "1.0";
  eventId: UUID;
  sequence: Cursor;
  workspaceId: UUID;
  runId: UUID;
  stepId: UUID | null;
  attemptId: UUID | null;
  operationId: string | null;
  occurredAt: Timestamp;
  kind: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  measurements: {
    [k: string]: number;
  };
  attributes: {
    [k: string]: string | number | boolean;
  };
  payload: unknown;
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "PluginManifest".
 */
export interface PluginManifest {
  schemaVersion: "1.0";
  id: string;
  version: string;
  protocolRange: string;
  displayName: string;
  runtime: "stdio-container";
  image: string;
  capabilities: ("task:read" | "task:status" | "task:comment")[];
  httpOrigins: string[];
  configSchemaRef: string;
  writeReconciliation: "marker-search" | "native-idempotency" | "none";
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "RpcRequest".
 */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: unknown;
  };
}
/**
 * This interface was referenced by `ODAReferenceContracts`'s JSON-Schema
 * via the `definition` "SetupConfig".
 */
export interface SetupConfig {
  schemaVersion: "1.0";
  workspaceId: UUID;
  api: {
    host: "127.0.0.1";
    port: number;
  };
  temporal: {
    address: string;
    namespace: string;
  };
  storage: {
    databaseSecretRef: string;
    artifactRoot: string;
  };
  sandbox: {
    defaultBackend: "docker" | "e2b";
    maxConcurrent: number;
  };
  providers: {
    defaultProfile: string;
    credentialRef: string | null;
  };
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
