/** Normative review contracts. Generate public declarations from JSON Schema before SDK release. */
export type UUID = string;
export type Timestamp = string;
export type Decimal = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Provider = "openai" | "anthropic" | "ollama" | "openrouter" | "gemini" | "bedrock";
export type AgentRole = "context-reviewer" | "planner" | "implementer" | "tester" | "reviewer" | "reporter" | "setup";
export type RunState = "QUEUED" | "CONTEXT_REVIEW" | "AWAITING_CONTEXT" | "PLANNING" | "AWAITING_PLAN" | "IMPLEMENTING" | "TESTING" | "REVIEWING" | "AWAITING_FINAL" | "NEEDS_ATTENTION" | "REPORT_PENDING" | "COMPLETED" | "FAILED" | "CANCELLING" | "CANCELLED";
export type GateKind = "CLARIFICATION" | "PLAN_APPROVAL" | "FINAL_APPROVAL" | "RECOVERY";
export type Tool = "repo.read" | "repo.search" | "sandbox.read" | "sandbox.write" | "sandbox.exec" | "test.run" | "static.run";
export type SourceStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE";

export interface RepositoryTarget { id: UUID; baseSha: string }
export interface Constraint {
  id: string;
  text: string;
  origin: "policy" | "task" | "human-feedback" | "accepted-assumption";
  sourceRef: string;
}
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
  acceptanceCriteria: string[];
  attachments: Array<{ id: string; name: string; url: string; mediaType: string | null; sizeBytes: number | null }>;
  labels: string[];
  requester: { id: string; displayName: string } | null;
  constraints: Constraint[];
  provenance: { fetchedAt: Timestamp; pluginId: string; pluginVersion: string; payloadArtifactId: UUID | null };
  extensions?: { [namespace: string]: Json };
}

export interface AgentProfile {
  schemaVersion: "1.0";
  id: UUID;
  name: string;
  revision: number;
  role: AgentRole;
  provider: Provider;
  model: string;
  credentialRef: string | null;
  providerOptions: { temperature: number | null; reasoningEffort: "minimal" | "low" | "medium" | "high" | null };
  limits: { maxInputTokens: number; maxOutputTokens: number; timeoutMs: number; maxModelCalls: number };
  tools: Tool[];
  prompt: { templateId: string; templateRevision: number; intent: string; compiledArtifactId: UUID | null };
  outputSchemaRef: string;
  retryPolicy: { transportAttempts: number; structuredOutputRepairs: number };
  fallbackProfileIds: UUID[];
}

export type GateDecisionInput = {
  protocolVersion: "1.0";
  runId: UUID;
  workflowId: string;
  gateId: UUID;
  expectedGateVersion: number;
  idempotencyKey: UUID;
} & ({ decision: "APPROVE"; reason?: never } | { decision: "REJECT"; reason: string });
export type GateDecision = GateDecisionInput & { decisionId: UUID; actorId: UUID; recordedAt: Timestamp };
export interface DecisionReceipt {
  decisionId: UUID;
  status: "RECORDED" | "PENDING";
  gateVersion: number;
  stateRevision: number;
  recordedAt: Timestamp | null;
}
export interface DecisionGate {
  id: UUID; runId: UUID; version: number; kind: GateKind;
  state: "PENDING" | "DECIDED" | "SUPERSEDED" | "CANCELLED";
  artifactIds: UUID[]; artifactHashes: string[];
  proposal: Json; openedAt: Timestamp;
}

export interface TelemetryEvent {
  schemaVersion: "1.0";
  eventId: UUID;
  sequence: Decimal;
  workspaceId: UUID;
  runId: UUID;
  stepId: UUID | null;
  attemptId: UUID | null;
  operationId: string | null;
  occurredAt: Timestamp;
  kind: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  measurements: Record<string, number>;
  attributes: Record<string, string | number | boolean>;
  payload: Json;
}
export interface EventEnvelope {
  protocolVersion: "1.0";
  cursor: Decimal;
  type: string;
  occurredAt: Timestamp;
  runId: UUID | null;
  stateRevision: number | null;
  payload: Json;
  resync?: { reason: "RETENTION_GAP" | "EPOCH_CHANGED"; snapshotUrl: string; journalEpoch: UUID };
}

export interface PluginManifest {
  schemaVersion: "1.0";
  id: string; version: string; protocolRange: string; displayName: string;
  runtime: "stdio-container";
  image: string;
  capabilities: Array<"task:read" | "task:status" | "task:comment">;
  httpOrigins: string[];
  configSchemaRef: string;
  writeReconciliation: "marker-search" | "native-idempotency" | "none";
}
export interface HealthResult {
  healthy: boolean; identity: string | null;
  capabilities: PluginManifest["capabilities"]; warnings: string[];
}
export type NormalizeInput = { kind: "identifier"; identifier: string } | { kind: "webhook"; payload: Json };
export interface SourceTaskRef { externalId: string; key: string }
export interface StatusUpdate { ref: SourceTaskRef; status: SourceStatus; operationId: string }
export interface SourceComment { ref: SourceTaskRef; body: string; operationId: string }
export interface WriteReceipt {
  status: "APPLIED" | "ALREADY_APPLIED" | "UNCERTAIN";
  operationId: string; remoteId: string | null; url: string | null;
}
export interface BrokerRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string>;
  body?: Json;
}
export interface HttpBroker {
  /** Validates responses against connector-registered schemas; injects credentials host-side. */
  request<T>(request: BrokerRequest): Promise<T>;
}
export interface PluginContext {
  instanceId: UUID;
  taskId: UUID;
  contextRevision: number;
  repository: RepositoryTarget;
  fetchedAt: Timestamp;
  http: HttpBroker;
}
export interface TaskSourcePlugin {
  getManifest(): Promise<PluginManifest>;
  healthCheck(context: PluginContext): Promise<HealthResult>;
  normalizePayload(input: NormalizeInput, context: PluginContext): Promise<SourceTaskRef>;
  fetchTask(ref: SourceTaskRef, context: PluginContext): Promise<TaskContext>;
  updateStatus(input: StatusUpdate, context: PluginContext): Promise<WriteReceipt>;
  postComment(input: SourceComment, context: PluginContext): Promise<WriteReceipt>;
}

export interface ProviderCapabilities {
  streaming: boolean; nativeTools: boolean; jsonSchema: boolean;
  maxContextTokens: number; maxOutputTokens: number;
  temperature: boolean; reasoningEfforts: string[];
  usageCategories: string[];
}
export interface ModelRequest {
  operationId: string; profile: AgentProfile;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  outputSchema: Json; deadlineAt: Timestamp;
}
export interface ModelUsage {
  inputTokens: number | null; outputTokens: number | null;
  cachedReadTokens: number | null; cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  usageStatus: "FINAL" | "PARTIAL" | "UNKNOWN";
  pricingStatus: "PRICED" | "UNPRICED";
  estimatedCostUsd: Decimal | null;
  pricingSnapshotId: UUID | null;
}
export interface ModelResult {
  resolvedModel: string; providerRequestId: string | null;
  output: Json; usage: ModelUsage;
  stopReason: "COMPLETE" | "TOOL_CALL" | "LENGTH" | "REFUSAL" | "ERROR";
}
export interface ModelProvider {
  describeCapabilities(model: string): Promise<ProviderCapabilities>;
  generate(request: ModelRequest, onChunk: (chunk: string) => void): Promise<ModelResult>;
  cancel(operationId: string): Promise<void>;
}

export interface SandboxHandle { id: string; backend: "docker" | "e2b"; runId: UUID }
export interface OperationContext { operationId: string; deadlineAt: Timestamp }
export interface SandboxPolicy {
  imageDigest: string; cpus: number; memoryBytes: number; maxPids: number;
  diskBytes: number; lifetimeMs: number;
  network: "none" | "scoped-proxy";
}
export interface SandboxCommand {
  executable: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number;
}
export interface CommandReceipt {
  operationId: string; state: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  exitCode: number | null; durationMs: number | null;
  stdoutArtifactId: UUID | null; stderrArtifactId: UUID | null;
}
export interface Artifact {
  id: UUID; sha256: string; mediaType: string; sizeBytes: number;
}
export interface SandboxProvider {
  create(runId: UUID, policy: SandboxPolicy, context: OperationContext): Promise<SandboxHandle>;
  prepareRepository(handle: SandboxHandle, repository: RepositoryTarget, context: OperationContext): Promise<{ treeHash: string }>;
  execute(handle: SandboxHandle, command: SandboxCommand, context: OperationContext, onOutput: (stream: "stdout" | "stderr", data: Uint8Array) => void): Promise<CommandReceipt>;
  applyPatch(handle: SandboxHandle, patch: Artifact, expectedTreeHash: string, context: OperationContext): Promise<{ patchHash: string; treeHash: string }>;
  collectArtifacts(handle: SandboxHandle, paths: string[], context: OperationContext): Promise<Artifact[]>;
  inspectResources(handle: SandboxHandle): Promise<{ cpuPercent: number | null; memoryBytes: number | null; diskBytes: number | null; unavailableReason: string | null }>;
  destroy(handle: SandboxHandle, context: OperationContext): Promise<void>;
}

export interface ApiError {
  error: { code: string; message: string; retryable: boolean; requestId: string; details?: Json };
}
