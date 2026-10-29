import { createHash } from "node:crypto";
export type ReportState = "INTENT" | "IN_FLIGHT" | "APPLIED" | "UNCERTAIN" | "FAILED" | "REPORT_PENDING";
export interface ReportOperation {
  operationKey: string;
  runId: string;
  sourceId: string;
  kind: "comment" | "status";
  requestHash: string;
  marker: string;
  state: ReportState;
  receipt: unknown | null;
}
export interface SourceReporter {
  publish(operation: ReportOperation, signal?: AbortSignal): Promise<{ remoteId: string; marker: string }>;
  findByMarker(marker: string): Promise<{ remoteId: string; marker: string } | null>;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ReconciledReporter {
  private readonly operations = new Map<string, ReportOperation>();
  constructor(private readonly source: SourceReporter) {}
  begin(input: {
    operationKey: string;
    runId: string;
    sourceId: string;
    kind: "comment" | "status";
    request: unknown;
    finalGateApproved: boolean;
  }): ReportOperation {
    if (!input.finalGateApproved) throw new Error("FINAL_GATE_APPROVAL_REQUIRED");
    const requestHash = hash(input.request);
    const existing = this.operations.get(input.operationKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.kind !== input.kind)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return structuredClone(existing);
    }
    const operation: ReportOperation = {
      operationKey: input.operationKey,
      runId: input.runId,
      sourceId: input.sourceId,
      kind: input.kind,
      requestHash,
      marker: `<!-- oda:${input.operationKey} -->`,
      state: "INTENT",
      receipt: null,
    };
    this.operations.set(input.operationKey, operation);
    return structuredClone(operation);
  }
  async dispatch(operationKey: string, timeoutMs = 30_000): Promise<ReportOperation> {
    const operation = this.required(operationKey);
    if (operation.state === "APPLIED") return structuredClone(operation);
    const reconciled = await this.source.findByMarker(operation.marker);
    if (reconciled) return this.transition(operation, "APPLIED", reconciled);
    if (operation.state === "UNCERTAIN" || operation.state === "REPORT_PENDING")
      return this.transition(operation, "REPORT_PENDING", operation.receipt);
    operation.state = "IN_FLIGHT";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("source publication timeout"), timeoutMs);
    try {
      const receipt = await this.source.publish(structuredClone(operation), controller.signal);
      if (receipt.marker !== operation.marker) throw new Error("SOURCE_MARKER_MISMATCH");
      return this.transition(operation, "APPLIED", receipt);
    } catch (error) {
      if (controller.signal.aborted)
        return this.transition(operation, "UNCERTAIN", { error: "PUBLICATION_TIMEOUT" });
      return this.transition(operation, "FAILED", { error: (error as Error).message });
    } finally {
      clearTimeout(timeout);
    }
  }
  async reconcile(operationKey: string): Promise<ReportOperation> {
    const operation = this.required(operationKey);
    const receipt = await this.source.findByMarker(operation.marker);
    return receipt
      ? this.transition(operation, "APPLIED", receipt)
      : this.transition(operation, "REPORT_PENDING", operation.receipt);
  }
  private required(key: string): ReportOperation {
    const value = this.operations.get(key);
    if (!value) throw new Error("REPORT_OPERATION_NOT_FOUND");
    return value;
  }
  private transition(operation: ReportOperation, state: ReportState, receipt: unknown): ReportOperation {
    operation.state = state;
    operation.receipt = structuredClone(receipt);
    return structuredClone(operation);
  }
}
