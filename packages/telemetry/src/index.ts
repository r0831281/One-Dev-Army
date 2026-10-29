import { createHash, randomUUID } from "node:crypto";

export interface UsageAttempt {
  attemptId: string;
  operationId: string;
  runId: string;
  stepId: string;
  provider: string;
  model: string;
  category: "model" | "sandbox-compute";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  amountMicrousd: number | null;
  pricingSnapshotId: string | null;
  observedAt: string;
}
export interface UsageAdjustment {
  adjustmentId: string;
  attemptId: string;
  deltaMicrousd: number | null;
  finalUsage: Omit<
    UsageAttempt,
    "attemptId" | "operationId" | "runId" | "stepId" | "provider" | "model" | "category" | "observedAt"
  >;
  reason: "provider-final" | "invoice" | "correction";
  recordedAt: string;
}
export interface Budget {
  maxCalls: number;
  maxMicrousd: number;
  reservedCalls: number;
  reservedMicrousd: number;
  spentMicrousd: number;
  unpricedCalls: number;
}

export class UsageLedger {
  private readonly attempts = new Map<string, UsageAttempt>();
  private readonly operations = new Map<string, string>();
  private readonly adjustments = new Map<string, UsageAdjustment>();
  private consumedCalls = 0;
  constructor(private budget: Budget) {}
  reserve(operationId: string, maxMicrousd: number, priced: boolean): void {
    if (this.operations.has(operationId)) return;
    if (this.consumedCalls + this.budget.reservedCalls + 1 > this.budget.maxCalls)
      throw new Error("BUDGET_EXHAUSTED_CALLS");
    if (
      priced &&
      this.budget.spentMicrousd + this.budget.reservedMicrousd + maxMicrousd > this.budget.maxMicrousd
    )
      throw new Error("BUDGET_EXHAUSTED_COST");
    this.budget.reservedCalls += 1;
    if (priced) this.budget.reservedMicrousd += maxMicrousd;
    this.operations.set(operationId, `reserved:${maxMicrousd}:${priced}`);
  }
  record(attempt: UsageAttempt, reservedMicrousd: number): { duplicate: boolean } {
    const priorId = this.operations.get(attempt.operationId);
    if (priorId && !priorId.startsWith("reserved:") && priorId !== attempt.attemptId)
      throw new Error("USAGE_OPERATION_CONFLICT");
    const prior = this.attempts.get(attempt.attemptId);
    if (prior) {
      if (hash(prior) !== hash(attempt)) throw new Error("USAGE_ATTEMPT_CONFLICT");
      return { duplicate: true };
    }
    assertUsage(attempt);
    this.attempts.set(attempt.attemptId, structuredClone(attempt));
    this.operations.set(attempt.operationId, attempt.attemptId);
    this.budget.reservedCalls = Math.max(0, this.budget.reservedCalls - 1);
    this.consumedCalls += 1;
    this.budget.reservedMicrousd = Math.max(0, this.budget.reservedMicrousd - reservedMicrousd);
    if (attempt.amountMicrousd === null) this.budget.unpricedCalls += 1;
    else this.budget.spentMicrousd += attempt.amountMicrousd;
    return { duplicate: false };
  }
  adjust(adjustment: UsageAdjustment): void {
    if (!this.attempts.has(adjustment.attemptId)) throw new Error("USAGE_ATTEMPT_NOT_FOUND");
    const prior = this.adjustments.get(adjustment.adjustmentId);
    if (prior) {
      if (hash(prior) !== hash(adjustment)) throw new Error("USAGE_ADJUSTMENT_CONFLICT");
      return;
    }
    if (adjustment.deltaMicrousd !== null) this.budget.spentMicrousd += adjustment.deltaMicrousd;
    this.adjustments.set(adjustment.adjustmentId, structuredClone(adjustment));
  }
  snapshot(): { budget: Budget; attempts: UsageAttempt[]; adjustments: UsageAdjustment[] } {
    return {
      budget: structuredClone(this.budget),
      attempts: [...this.attempts.values()].map((v) => structuredClone(v)),
      adjustments: [...this.adjustments.values()].map((v) => structuredClone(v)),
    };
  }
}

function assertUsage(value: UsageAttempt): void {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "amountMicrousd",
  ] as const) {
    const quantity = value[field];
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 0))
      throw new Error("INVALID_USAGE");
  }
  if ((value.amountMicrousd === null) !== (value.pricingSnapshotId === null))
    throw new Error("UNPRICED_USAGE_INVARIANT");
}

export interface EventEnvelope {
  protocolVersion: "1.0";
  workspaceId: string;
  seq: number;
  epoch: string;
  eventId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}
export interface StreamBatch {
  kind: "events" | "resync" | "backpressure";
  events: EventEnvelope[];
  latestSeq: number;
  epoch: string;
  reason?: string;
}
const secretKey = /(authorization|cookie|token|secret|password|api[-_]?key|credential)/iu;
const secretValue = /(bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16})/giu;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[REDACTED:DEPTH]";
  if (typeof value === "string") return value.replace(secretValue, "[REDACTED]");
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redact(entry, depth + 1),
      ]),
    );
  return value;
}
export class EventJournal {
  private events: EventEnvelope[] = [];
  private nextSeq = 1;
  constructor(
    readonly workspaceId: string,
    private epoch: string,
    private readonly retain = 10_000,
    private readonly maxPayloadBytes = 64 * 1024,
  ) {}
  append(type: string, payload: unknown): EventEnvelope {
    const safe = redact(payload);
    if (Buffer.byteLength(JSON.stringify(safe)) > this.maxPayloadBytes) throw new Error("LOG_OVERFLOW");
    const event: EventEnvelope = {
      protocolVersion: "1.0",
      workspaceId: this.workspaceId,
      seq: this.nextSeq++,
      epoch: this.epoch,
      eventId: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      payload: safe,
    };
    this.events.push(event);
    if (this.events.length > this.retain) this.events.splice(0, this.events.length - this.retain);
    return structuredClone(event);
  }
  read(after: number, epoch: string, limit = 500, clientCapacity = 500): StreamBatch {
    if (epoch !== this.epoch)
      return {
        kind: "resync",
        events: [],
        latestSeq: this.nextSeq - 1,
        epoch: this.epoch,
        reason: "EPOCH_CHANGED",
      };
    const oldest = this.events[0]?.seq ?? this.nextSeq;
    if (after < oldest - 1)
      return {
        kind: "resync",
        events: [],
        latestSeq: this.nextSeq - 1,
        epoch: this.epoch,
        reason: "CURSOR_EXPIRED",
      };
    const pending = this.events.filter((event) => event.seq > after);
    if (pending.length > clientCapacity)
      return {
        kind: "backpressure",
        events: [],
        latestSeq: this.nextSeq - 1,
        epoch: this.epoch,
        reason: "SLOW_CLIENT",
      };
    return {
      kind: "events",
      events: pending.slice(0, Math.min(500, limit)).map((event) => structuredClone(event)),
      latestSeq: this.nextSeq - 1,
      epoch: this.epoch,
    };
  }
  restoreEpoch(epoch: string): void {
    this.epoch = epoch;
    this.events = [];
    this.nextSeq = 1;
  }
  export(): EventEnvelope[] {
    return this.events.map((event) => structuredClone(event));
  }
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const ODA_METRICS = [
  "oda_agent_step_duration_seconds",
  "oda_model_tokens_total",
  "oda_model_estimated_cost_usd_total",
  "oda_tool_calls_total",
  "oda_tool_duration_seconds",
  "oda_retry_iterations_total",
  "oda_runs_total",
  "oda_active_runs",
  "oda_pending_gates",
  "oda_event_delivery_lag_seconds",
  "oda_plugin_rpc_duration_seconds",
  "oda_sandbox_memory_bytes",
  "oda_provider_adapter_health",
  "oda_sandbox_leak_count",
  "oda_usage_reconciliation_errors_total",
  "oda_redaction_failures_total",
] as const;

export class StreamingRedactor {
  private tail = "";
  constructor(private readonly knownSecrets: string[] = []) {}
  push(chunk: string, final = false): string {
    const combined = this.tail + chunk;
    const keep = final ? 0 : Math.min(128, combined.length);
    const emit = keep === 0 ? combined : combined.slice(0, -keep);
    this.tail = keep === 0 ? "" : combined.slice(-keep);
    return this.clean(emit);
  }
  flush(): string {
    const value = this.clean(this.tail);
    this.tail = "";
    return value;
  }
  private clean(value: string): string {
    let clean = value.replace(
      /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/gu,
      "[CONTROL]",
    );
    clean = String(redact(clean));
    for (const secret of this.knownSecrets)
      if (secret.length >= 4) clean = clean.split(secret).join("[REDACTED]");
    return clean;
  }
}

export interface OperationalExporter {
  export(event: EventEnvelope): Promise<void>;
}
export class TelemetryRecorder {
  exportFailures = 0;
  constructor(
    private readonly journal: EventJournal,
    private readonly exporter: OperationalExporter,
  ) {}
  async record(type: string, payload: unknown): Promise<EventEnvelope> {
    const committed = this.journal.append(type, payload);
    try {
      await this.exporter.export(committed);
    } catch {
      this.exportFailures += 1;
    }
    return committed;
  }
}

export class StreamConnection {
  private queued: EventEnvelope[] = [];
  private bytes = 0;
  closed: { code: 4008; reason: "SLOW_CLIENT" } | null = null;
  enqueue(event: EventEnvelope): void {
    if (this.closed) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (this.queued.length + 1 > 1000 || this.bytes + size > 1024 * 1024) {
      this.closed = { code: 4008, reason: "SLOW_CLIENT" };
      this.queued = [];
      this.bytes = 0;
      return;
    }
    this.queued.push(structuredClone(event));
    this.bytes += size;
  }
  drain(limit = 100): EventEnvelope[] {
    const values = this.queued.splice(0, limit);
    this.bytes -= values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
    return values;
  }
}
