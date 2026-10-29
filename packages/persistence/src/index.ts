import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceOperations } from "./operations.js";
import type { Pool, PoolClient, QueryResult } from "pg";
import type {
  DecisionReceipt,
  GateDecisionInput,
  Json,
  RunManifest,
  TaskContext,
  WorkflowProjection,
} from "../../contracts/src/index.js";
import {
  plannedFor,
  validateDecisionReceipt,
  validateRunManifest,
  validateStepProjection,
  validateTaskContext,
  validateWorkflowProjection,
} from "../../contracts/src/index.js";

export interface Queryable {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
export interface IngestReceipt {
  taskId: string;
  contextRevision: number;
  duplicate: boolean;
  deliveryId: string | null;
}
export interface CommandRecord {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  payloadSha256: string;
  commandType: string;
  payload: Json;
  state: "PENDING" | "DISPATCHED" | "COMPLETED" | "FAILED";
  result: Json | null;
}
export interface ExternalOperationRecord {
  id: string;
  operationKey: string;
  kind: "comment" | "status";
  requestSha256: string;
  state: "INTENT" | "IN_FLIGHT" | "APPLIED" | "UNCERTAIN" | "FAILED";
  receipt: Json | null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
export const canonicalSha256 = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const sha = canonicalSha256;

export async function runMigrations(
  client: Queryable,
  migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
): Promise<void> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const names = (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const name of names) {
    const version = Number(name.split("_")[0]);
    const sql = await readFile(join(migrationDir, name), "utf8");
    const checksum = sha(sql);
    const found = await client.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version=$1",
      [version],
    );
    if (found.rows[0]) {
      if (found.rows[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${version}`);
      continue;
    }
    try {
      await client.query("BEGIN");
      await client.query(sql.replace(/^BEGIN;|COMMIT;$/gm, ""));
      await client.query("INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)", [
        version,
        name,
        checksum,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendOutbox(
  client: Queryable,
  workspaceId: string,
  eventType: string,
  payload: Json,
): Promise<number> {
  const counter = await client.query<{ last_seq: string }>(
    "INSERT INTO workspace_event_counters(workspace_id,last_seq) VALUES($1,1) ON CONFLICT(workspace_id) DO UPDATE SET last_seq=workspace_event_counters.last_seq+1 RETURNING last_seq",
    [workspaceId],
  );
  const seq = Number(counter.rows[0]?.last_seq);
  await client.query(
    "INSERT INTO outbox_events(workspace_id,seq,event_id,event_type,schema_version,payload,occurred_at) VALUES($1,$2,$3,$4,'1.0',$5,now())",
    [workspaceId, seq, randomUUID(), eventType, payload],
  );
  return seq;
}

export class PgTaskRepository {
  constructor(private readonly pool: Pool) {}
  async ingest(
    workspaceId: string,
    contextValue: unknown,
    deliveryId: string | null,
    payloadHash: string,
  ): Promise<IngestReceipt> {
    const context = validateTaskContext(contextValue);
    return transaction(this.pool, async (client) => {
      if (deliveryId) {
        const prior = await client.query<{ receipt: IngestReceipt }>(
          "SELECT receipt FROM ingest_deliveries WHERE source_plugin_id=$1 AND delivery_id=$2 FOR UPDATE",
          [context.source.instanceId, deliveryId],
        );
        if (prior.rows[0]) return { ...prior.rows[0].receipt, duplicate: true };
      }
      await client.query(
        "INSERT INTO tasks(id,workspace_id,source_plugin_id,external_id,source_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_plugin_id,external_id) DO NOTHING",
        [
          context.taskId,
          workspaceId,
          context.source.instanceId,
          context.source.externalId,
          context.source.key,
        ],
      );
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE source_plugin_id=$1 AND external_id=$2",
        [context.source.instanceId, context.source.externalId],
      );
      const taskId = existing.rows[0]?.id ?? context.taskId;
      const latest = await client.query<{ revision: number; source_revision: string | null }>(
        "SELECT revision,source_revision FROM task_contexts WHERE task_id=$1 ORDER BY revision DESC LIMIT 1",
        [taskId],
      );
      if (latest.rows[0]?.source_revision === context.source.revision) {
        const receipt: IngestReceipt = {
          taskId,
          contextRevision: latest.rows[0].revision,
          duplicate: true,
          deliveryId,
        };
        if (deliveryId)
          await client.query(
            "INSERT INTO ingest_deliveries(source_plugin_id,delivery_id,payload_sha256,task_id,receipt) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_plugin_id,delivery_id) DO NOTHING",
            [context.source.instanceId, deliveryId, payloadHash, taskId, receipt],
          );
        return receipt;
      }
      const revision = (latest.rows[0]?.revision ?? 0) + 1;
      const stored = validateTaskContext({ ...context, taskId, revision });
      await client.query(
        "INSERT INTO task_contexts(task_id,revision,source_revision,context,context_sha256) VALUES($1,$2,$3,$4,$5)",
        [taskId, revision, stored.source.revision, stored, sha(stored)],
      );
      const receipt: IngestReceipt = { taskId, contextRevision: revision, duplicate: false, deliveryId };
      if (deliveryId)
        await client.query(
          "INSERT INTO ingest_deliveries(source_plugin_id,delivery_id,payload_sha256,task_id,receipt) VALUES($1,$2,$3,$4,$5)",
          [stored.source.instanceId, deliveryId, payloadHash, taskId, receipt],
        );
      await appendOutbox(client, workspaceId, "task.context.ingested", receipt as unknown as Json);
      return receipt;
    });
  }
  async getContext(taskId: string, revision?: number): Promise<TaskContext | null> {
    const result = revision
      ? await this.pool.query<{ context: TaskContext }>(
          "SELECT context FROM task_contexts WHERE task_id=$1 AND revision=$2",
          [taskId, revision],
        )
      : await this.pool.query<{ context: TaskContext }>(
          "SELECT context FROM task_contexts WHERE task_id=$1 ORDER BY revision DESC LIMIT 1",
          [taskId],
        );
    return result.rows[0] ? validateTaskContext(result.rows[0].context) : null;
  }
}

export class PgCommandRepository {
  constructor(private readonly pool: Pool) {}
  async createOrGet(
    workspaceId: string,
    idempotencyKey: string,
    commandType: string,
    payload: Json,
  ): Promise<{ command: CommandRecord; duplicate: boolean }> {
    const payloadSha256 = sha(payload);
    const id = randomUUID();
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO command_requests(id,workspace_id,idempotency_key,payload_sha256,command_type,payload,state) VALUES($1,$2,$3,$4,$5,$6,'PENDING') ON CONFLICT(idempotency_key) DO NOTHING RETURNING id",
        [id, workspaceId, idempotencyKey, payloadSha256, commandType, payload],
      );
      const result = await client.query<{
        id: string;
        workspace_id: string;
        idempotency_key: string;
        payload_sha256: string;
        command_type: string;
        payload: Json;
        state: CommandRecord["state"];
        result: Json | null;
      }>(
        "SELECT id,workspace_id,idempotency_key,payload_sha256,command_type,payload,state,result FROM command_requests WHERE idempotency_key=$1 FOR UPDATE",
        [idempotencyKey],
      );
      const row = result.rows[0];
      if (!row) throw new Error("COMMAND_CREATE_FAILED");
      if (
        row.payload_sha256 !== payloadSha256 ||
        row.command_type !== commandType ||
        row.workspace_id !== workspaceId
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return {
        duplicate: inserted.rowCount === 0,
        command: {
          id: row.id,
          workspaceId: row.workspace_id,
          idempotencyKey: row.idempotency_key,
          payloadSha256: row.payload_sha256,
          commandType: row.command_type,
          payload: row.payload,
          state: row.state,
          result: row.result,
        },
      };
    });
  }
  async transition(
    id: string,
    expected: CommandRecord["state"],
    next: CommandRecord["state"],
    result: Json | null = null,
  ): Promise<boolean> {
    const updated = await this.pool.query(
      "UPDATE command_requests SET state=$3,result=$4,updated_at=now() WHERE id=$1 AND state=$2",
      [id, expected, next, result],
    );
    return updated.rowCount === 1;
  }
  async byKey(idempotencyKey: string): Promise<CommandRecord | null> {
    const result = await this.pool.query<{
      id: string;
      workspace_id: string;
      idempotency_key: string;
      payload_sha256: string;
      command_type: string;
      payload: Json;
      state: CommandRecord["state"];
      result: Json | null;
    }>(
      "SELECT id,workspace_id,idempotency_key,payload_sha256,command_type,payload,state,result FROM command_requests WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          idempotencyKey: row.idempotency_key,
          payloadSha256: row.payload_sha256,
          commandType: row.command_type,
          payload: row.payload,
          state: row.state,
          result: row.result,
        }
      : null;
  }
  async pending(limit = 50, workspaceId: string | null = null): Promise<CommandRecord[]> {
    const result = await this.pool.query<{
      id: string;
      workspace_id: string;
      idempotency_key: string;
      payload_sha256: string;
      command_type: string;
      payload: Json;
      state: CommandRecord["state"];
      result: Json | null;
    }>(
      "SELECT id,workspace_id,idempotency_key,payload_sha256,command_type,payload,state,result FROM command_requests WHERE state='PENDING' AND command_type IN ('RUN_START','RUN_CANCEL','GATE_DECISION') AND available_at<=now() AND ($2::uuid IS NULL OR workspace_id=$2) ORDER BY CASE WHEN command_type='RUN_CANCEL' THEN 0 ELSE 1 END,created_at,id LIMIT $1",
      [limit, workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      idempotencyKey: row.idempotency_key,
      payloadSha256: row.payload_sha256,
      commandType: row.command_type,
      payload: row.payload,
      state: row.state,
      result: row.result,
    }));
  }
}

export class PgExternalOperationRepository {
  constructor(private readonly pool: Pool) {}
  async begin(
    workspaceId: string,
    sourcePluginId: string,
    operationKey: string,
    kind: "comment" | "status",
    request: Json,
  ): Promise<{ operation: ExternalOperationRecord; duplicate: boolean }> {
    const requestSha256 = sha(request);
    const id = randomUUID();
    return transaction(this.pool, async (client) => {
      const inserted = await client.query(
        "INSERT INTO external_operations(id,workspace_id,source_plugin_id,operation_key,kind,request_sha256,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,'INTENT') ON CONFLICT(operation_key) DO NOTHING RETURNING id",
        [id, workspaceId, sourcePluginId, operationKey, kind, requestSha256, request],
      );
      const selected = await client.query<{
        id: string;
        operation_key: string;
        kind: "comment" | "status";
        request_sha256: string;
        state: ExternalOperationRecord["state"];
        receipt: Json | null;
      }>(
        "SELECT id,operation_key,kind,request_sha256,state,receipt FROM external_operations WHERE operation_key=$1 FOR UPDATE",
        [operationKey],
      );
      const row = selected.rows[0];
      if (!row) throw new Error("EXTERNAL_OPERATION_CREATE_FAILED");
      if (row.kind !== kind || row.request_sha256 !== requestSha256) throw new Error("IDEMPOTENCY_CONFLICT");
      return {
        duplicate: inserted.rowCount === 0,
        operation: {
          id: row.id,
          operationKey: row.operation_key,
          kind: row.kind,
          requestSha256: row.request_sha256,
          state: row.state,
          receipt: row.receipt,
        },
      };
    });
  }
  async transition(
    id: string,
    expected: ExternalOperationRecord["state"][],
    next: ExternalOperationRecord["state"],
    receipt: Json | null = null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE external_operations SET state=$3,receipt=$4,updated_at=now() WHERE id=$1 AND state=ANY($2::text[])",
      [id, expected, next, receipt],
    );
    return result.rowCount === 1;
  }
  async pending(): Promise<ExternalOperationRecord[]> {
    const result = await this.pool.query<{
      id: string;
      operation_key: string;
      kind: "comment" | "status";
      request_sha256: string;
      state: ExternalOperationRecord["state"];
      receipt: Json | null;
    }>(
      "SELECT id,operation_key,kind,request_sha256,state,receipt FROM external_operations WHERE state IN ('INTENT','IN_FLIGHT','UNCERTAIN') ORDER BY created_at,id",
    );
    return result.rows.map((row) => ({
      id: row.id,
      operationKey: row.operation_key,
      kind: row.kind,
      requestSha256: row.request_sha256,
      state: row.state,
      receipt: row.receipt,
    }));
  }
}

export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  state: WorkflowProjection["state"];
  stateRevision: number;
  manifest: RunManifest;
  manifestSha256: string;
  projection: WorkflowProjection;
}

export class PgWorkflowRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    workspaceId: string,
    manifestValue: unknown,
    workflowId: string,
    projectionValue: unknown,
  ): Promise<{ run: WorkflowRunRecord; duplicate: boolean }> {
    const manifest = validateRunManifest(manifestValue);
    const projection = validateWorkflowProjection(projectionValue);
    const manifestSha256 = sha(manifest);
    return transaction(this.pool, async (client) => {
      const inserted = await client.query(
        "INSERT INTO workflow_runs(id,workspace_id,task_id,context_revision,repository_id,base_sha,workflow_id,workflow_version,state,state_revision,manifest,manifest_sha256,projection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING RETURNING id",
        [
          manifest.runId,
          workspaceId,
          manifest.taskId,
          manifest.contextRevision,
          manifest.repository.id,
          manifest.repository.baseSha,
          workflowId,
          manifest.workflowVersion,
          projection.state,
          projection.stateRevision,
          manifest,
          manifestSha256,
          projection,
        ],
      );
      const selected = await client.query<{
        id: string;
        workflow_id: string;
        workflow_version: number;
        state: WorkflowProjection["state"];
        state_revision: string;
        manifest: RunManifest;
        manifest_sha256: string;
        projection: WorkflowProjection;
      }>(
        "SELECT id,workflow_id,workflow_version,state,state_revision,manifest,manifest_sha256,projection FROM workflow_runs WHERE id=$1 FOR UPDATE",
        [manifest.runId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error("RUN_CREATE_FAILED");
      if (row.workflow_id !== workflowId || row.manifest_sha256 !== manifestSha256)
        throw new Error("IDEMPOTENCY_CONFLICT");
      if (inserted.rowCount === 1)
        await appendOutbox(client, workspaceId, "run.created", {
          runId: manifest.runId,
          workflowId,
          stateRevision: projection.stateRevision,
        });
      return {
        duplicate: inserted.rowCount === 0,
        run: mapRun(row),
      };
    });
  }

  async get(runId: string, workspaceId: string | null = null): Promise<WorkflowRunRecord | null> {
    const result = await this.pool.query<{
      id: string;
      workflow_id: string;
      workflow_version: number;
      state: WorkflowProjection["state"];
      state_revision: string;
      manifest: RunManifest;
      manifest_sha256: string;
      projection: WorkflowProjection;
    }>(
      "SELECT id,workflow_id,workflow_version,state,state_revision,manifest,manifest_sha256,projection FROM workflow_runs WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)",
      [runId, workspaceId],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async list(limit = 100, workspaceId: string | null = null): Promise<WorkflowRunRecord[]> {
    const result = await this.pool.query<{
      id: string;
      workflow_id: string;
      workflow_version: number;
      state: WorkflowProjection["state"];
      state_revision: string;
      manifest: RunManifest;
      manifest_sha256: string;
      projection: WorkflowProjection;
    }>(
      "SELECT id,workflow_id,workflow_version,state,state_revision,manifest,manifest_sha256,projection FROM workflow_runs WHERE ($2::uuid IS NULL OR workspace_id=$2) ORDER BY updated_at DESC,id LIMIT $1",
      [limit, workspaceId],
    );
    return result.rows.map(mapRun);
  }

  async project(
    workspaceId: string,
    projectionValue: unknown,
    temporalExecutionId: string,
  ): Promise<boolean> {
    const projection = validateWorkflowProjection(projectionValue);
    return transaction(this.pool, async (client) => {
      const run = await client.query<{ manifest_sha256: string }>(
        "SELECT manifest_sha256 FROM workflow_runs WHERE id=$1 FOR UPDATE",
        [projection.runId],
      );
      const manifestSha256 = run.rows[0]?.manifest_sha256;
      if (!manifestSha256) throw new Error("RUN_NOT_FOUND");
      const updated = await client.query(
        "UPDATE workflow_runs SET state=$2,state_revision=$3,projection=$4,updated_at=now() WHERE id=$1 AND state_revision<$3",
        [projection.runId, projection.state, projection.stateRevision, projection],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        "INSERT INTO state_checkpoints(id,run_id,state_revision,workflow_id,temporal_execution_id,manifest_sha256,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,state_revision) DO NOTHING",
        [
          randomUUID(),
          projection.runId,
          projection.stateRevision,
          projection.workflowId,
          temporalExecutionId,
          manifestSha256,
          projection,
        ],
      );
      await appendOutbox(client, workspaceId, "run.projected", {
        runId: projection.runId,
        state: projection.state,
        stateRevision: projection.stateRevision,
      });
      return true;
    });
  }

  async openGate(workspaceId: string, projectionValue: unknown): Promise<boolean> {
    const projection = validateWorkflowProjection(projectionValue);
    const gate = projection.currentGate;
    if (!gate || gate.state !== "PENDING") throw new Error("PENDING_GATE_REQUIRED");
    return transaction(this.pool, async (client) => {
      await client.query(
        "UPDATE decision_gates SET state='SUPERSEDED',closed_at=now(),state_revision=$2 WHERE run_id=$1 AND state='PENDING' AND (id<>$3 OR version<>$4)",
        [projection.runId, projection.stateRevision, gate.id, gate.version],
      );
      await client.query(
        "INSERT INTO decision_gates(id,version,run_id,kind,state,state_revision,artifact_hash,proposal,opened_at) VALUES($1,$2,$3,$4,'PENDING',$5,$6,$7,now()) ON CONFLICT(id,version) DO NOTHING",
        [
          gate.id,
          gate.version,
          projection.runId,
          gate.kind,
          projection.stateRevision,
          gate.artifactHash,
          gate.proposal,
        ],
      );
      const run = await client.query(
        "UPDATE workflow_runs SET state=$2,state_revision=$3,projection=$4,updated_at=now() WHERE id=$1 AND state_revision<$3",
        [projection.runId, projection.state, projection.stateRevision, projection],
      );
      if (run.rowCount !== 1) return false;
      await appendOutbox(client, workspaceId, "gate.opened", {
        runId: projection.runId,
        gateId: gate.id,
        gateVersion: gate.version,
        stateRevision: projection.stateRevision,
      });
      return true;
    });
  }

  async projectStep(workspaceId: string, value: unknown): Promise<boolean> {
    const step = validateStepProjection(value);
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        "INSERT INTO agent_steps(id,run_id,step_key,logical_iteration,state,state_revision,projection) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,step_key,logical_iteration) DO UPDATE SET state=EXCLUDED.state,state_revision=EXCLUDED.state_revision,projection=EXCLUDED.projection,updated_at=now() WHERE agent_steps.state_revision<EXCLUDED.state_revision RETURNING id",
        [step.stepId, step.runId, step.stepKey, step.iteration, step.state, step.stateRevision, step],
      );
      if (result.rowCount !== 1) return false;
      await appendOutbox(client, workspaceId, "step.projected", {
        runId: step.runId,
        stepId: step.stepId,
        stepKey: step.stepKey,
        state: step.state,
        stateRevision: step.stateRevision,
      });
      return true;
    });
  }

  async persistDecision(
    workspaceId: string,
    actorId: string,
    input: GateDecisionInput,
    receiptValue: unknown,
    projectionValue: unknown,
  ): Promise<DecisionReceipt> {
    const receipt = validateDecisionReceipt(receiptValue);
    const projection = validateWorkflowProjection(projectionValue);
    const payloadSha256 = sha(input);
    return transaction(this.pool, async (client) => {
      const prior = await client.query<{ payload_sha256: string; receipt: DecisionReceipt }>(
        "SELECT payload_sha256,receipt FROM gate_decisions WHERE idempotency_key=$1 FOR UPDATE",
        [input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_sha256 !== payloadSha256) throw new Error("IDEMPOTENCY_CONFLICT");
        return validateDecisionReceipt(prior.rows[0].receipt);
      }
      const gate = await client.query<{ state: string; version: number }>(
        "SELECT state,version FROM decision_gates WHERE id=$1 AND run_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [input.gateId, input.runId],
      );
      if (!gate.rows[0] || gate.rows[0].version !== input.expectedGateVersion)
        throw new Error("GATE_VERSION_CONFLICT");
      if (gate.rows[0].state !== "PENDING") throw new Error("GATE_ALREADY_DECIDED");
      await client.query(
        "INSERT INTO gate_decisions(id,run_id,gate_id,gate_version,idempotency_key,payload_sha256,decision,reason,actor_id,receipt,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          receipt.decisionId,
          input.runId,
          input.gateId,
          input.expectedGateVersion,
          input.idempotencyKey,
          payloadSha256,
          input.decision,
          input.reason ?? null,
          actorId,
          receipt,
          receipt.recordedAt,
        ],
      );
      await client.query(
        "UPDATE decision_gates SET state='DECIDED',closed_at=$3,state_revision=$4 WHERE id=$1 AND version=$2",
        [input.gateId, input.expectedGateVersion, receipt.recordedAt, receipt.stateRevision],
      );
      await client.query(
        "UPDATE workflow_runs SET state=$2,state_revision=$3,projection=$4,updated_at=now() WHERE id=$1 AND state_revision<$3",
        [input.runId, projection.state, projection.stateRevision, projection],
      );
      await appendOutbox(client, workspaceId, "gate.decided", {
        runId: input.runId,
        gateId: input.gateId,
        gateVersion: input.expectedGateVersion,
        decision: input.decision,
        stateRevision: receipt.stateRevision,
      });
      return receipt;
    });
  }

  async decisionByKey(idempotencyKey: string): Promise<DecisionReceipt | null> {
    const result = await this.pool.query<{ receipt: DecisionReceipt }>(
      "SELECT receipt FROM gate_decisions WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    return result.rows[0] ? validateDecisionReceipt(result.rows[0].receipt) : null;
  }
}

function mapRun(row: {
  id: string;
  workflow_id: string;
  workflow_version: number;
  state: WorkflowProjection["state"];
  state_revision: string;
  manifest: RunManifest;
  manifest_sha256: string;
  projection: WorkflowProjection;
}): WorkflowRunRecord {
  return {
    runId: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    state: row.state,
    stateRevision: Number(row.state_revision),
    manifest: validateRunManifest(row.manifest),
    manifestSha256: row.manifest_sha256,
    projection: validateWorkflowProjection(row.projection),
  };
}

export class MemoryProjectionStore {
  private readonly runs = new Map<string, WorkflowProjection>();
  apply(projectionValue: unknown): boolean {
    const projection = validateWorkflowProjection(projectionValue);
    const current = this.runs.get(projection.runId);
    if (current && current.stateRevision >= projection.stateRevision) return false;
    this.runs.set(projection.runId, structuredClone(projection));
    return true;
  }
  get(runId: string): WorkflowProjection | null {
    const projection = this.runs.get(runId);
    return projection ? structuredClone(projection) : null;
  }
}

export class MemoryTaskRepository {
  private readonly contexts = new Map<string, TaskContext[]>();
  private readonly deliveries = new Map<string, IngestReceipt>();
  restore(values: TaskContext[]) {
    for (const value of values) {
      const context = validateTaskContext(value);
      const revisions = this.contexts.get(context.taskId) ?? [];
      if (!revisions.some((r) => r.revision === context.revision)) revisions.push(structuredClone(context));
      revisions.sort((a, b) => a.revision - b.revision);
      this.contexts.set(context.taskId, revisions);
    }
  }
  ingest(contextValue: unknown, deliveryId: string | null = null): IngestReceipt {
    const context = validateTaskContext(contextValue);
    const deliveryKey = deliveryId ? `${context.source.instanceId}:${deliveryId}` : null;
    const prior = deliveryKey ? this.deliveries.get(deliveryKey) : undefined;
    if (prior) return { ...prior, duplicate: true };
    const existingTask = [...this.contexts.entries()].find(
      ([, values]) =>
        values[0]?.source.instanceId === context.source.instanceId &&
        values[0]?.source.externalId === context.source.externalId,
    );
    const taskId = existingTask?.[0] ?? context.taskId;
    const revisions = this.contexts.get(taskId) ?? [];
    const same = revisions.find((entry) => entry.source.revision === context.source.revision);
    if (same) return { taskId, contextRevision: same.revision, duplicate: true, deliveryId };
    const stored = validateTaskContext({
      ...structuredClone(context),
      taskId,
      revision: revisions.length + 1,
    });
    revisions.push(stored);
    this.contexts.set(taskId, revisions);
    const receipt = {
      taskId,
      contextRevision: stored.revision,
      duplicate: false,
      deliveryId,
    };
    if (deliveryKey) this.deliveries.set(deliveryKey, receipt);
    return receipt;
  }
  getContext(taskId: string, revision?: number): TaskContext | null {
    const values = this.contexts.get(taskId) ?? [];
    return structuredClone(
      revision ? (values.find((value) => value.revision === revision) ?? null) : (values.at(-1) ?? null),
    );
  }
  list(): Array<
    TaskContext & { plannedFor: string | null; planningRevision: number; planningUpdatedAt: string | null }
  > {
    return [...this.contexts.values()]
      .map((values) => values.at(-1))
      .filter((value): value is TaskContext => Boolean(value))
      .map((context) => {
        return structuredClone({
          ...context,
          plannedFor: plannedFor(context),
          planningRevision: context.revision,
          planningUpdatedAt: context.provenance.fetchedAt,
        });
      });
  }
}

export class PgPhase3Repository {
  constructor(private readonly pool: Pool) {}

  async appendProfile(
    workspaceId: string,
    value: {
      id: string;
      revision: number;
      name: string;
      role: string;
      provider: string;
      model: string;
      profile: Json;
    },
  ): Promise<boolean> {
    const profileSha256 = sha(value.profile);
    const result = await this.pool.query(
      "INSERT INTO agent_profiles(id,revision,workspace_id,name,role,provider,model,profile,profile_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id,revision) DO NOTHING",
      [
        value.id,
        value.revision,
        workspaceId,
        value.name,
        value.role,
        value.provider,
        value.model,
        value.profile,
        profileSha256,
      ],
    );
    if (result.rowCount === 0) {
      const prior = await this.pool.query<{ profile_sha256: string }>(
        "SELECT profile_sha256 FROM agent_profiles WHERE id=$1 AND revision=$2",
        [value.id, value.revision],
      );
      if (prior.rows[0]?.profile_sha256 !== profileSha256) throw new Error("PROFILE_REVISION_CONFLICT");
    }
    return result.rowCount === 1;
  }

  async appendPromptArtifact(value: {
    id: string;
    profileId: string;
    profileRevision: number;
    artifact: Json;
    compilerVersion: string;
    templateRevision: number;
    schemaHash: string;
    policyHash: string;
  }): Promise<boolean> {
    const promptHash = sha(value.artifact);
    const result = await this.pool.query(
      "INSERT INTO prompt_artifacts(id,profile_id,profile_revision,prompt_sha256,compiler_version,template_revision,schema_sha256,policy_sha256,artifact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(profile_id,profile_revision,prompt_sha256) DO NOTHING",
      [
        value.id,
        value.profileId,
        value.profileRevision,
        promptHash,
        value.compilerVersion,
        value.templateRevision,
        value.schemaHash,
        value.policyHash,
        value.artifact,
      ],
    );
    return result.rowCount === 1;
  }

  async reserveUsage(value: {
    operationId: string;
    runId: string;
    maxMicrousd: number | null;
    expiresAt: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const run = await client.query<{ workspace_id: string; task_id: string }>(
        "SELECT workspace_id,task_id FROM workflow_runs WHERE id=$1",
        [value.runId],
      );
      const r = run.rows[0];
      if (!r) throw new Error("RUN_NOT_FOUND");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [r.workspace_id]);
      const existing = await client.query(
        "SELECT operation_id FROM usage_reservations WHERE operation_id=$1",
        [value.operationId],
      );
      if (existing.rows.length) return false;
      const status = await new WorkspaceOperations(client, r.workspace_id).status(r.task_id);
      if (value.maxMicrousd === null && status.policy.unpricedPolicy === "block")
        throw new Error("UNPRICED_USAGE_BLOCKED");
      if (value.maxMicrousd !== null && (!Number.isSafeInteger(value.maxMicrousd) || value.maxMicrousd < 0))
        throw new Error("INVALID_RESERVATION");
      const reservations = await client.query<{ pending: number; task: number; own: number }>(
        `SELECT
        coalesce(sum(u.max_microusd) FILTER(WHERE u.run_id=$3),0)::float8/1000000 AS pending,
        coalesce(sum(u.max_microusd) FILTER(WHERE r.task_id=$2),0)::float8/1000000 AS task,
        greatest(coalesce(sum(u.max_microusd) FILTER(WHERE u.run_id=$3),0),coalesce((SELECT greatest(0,a.reserved_microusd-coalesce((SELECT sum(coalesce(m.amount_microusd,0)+coalesce((SELECT sum(delta_microusd) FROM usage_adjustments WHERE attempt_id=m.attempt_id),0)) FROM model_usage m WHERE m.run_id=$3),0)) FROM run_admissions a WHERE a.run_id=$3),0))::float8/1000000 AS own
        FROM usage_reservations u JOIN workflow_runs r ON r.id=u.run_id WHERE r.workspace_id=$1 AND r.state NOT IN ('COMPLETED','CANCELLED','FAILED','NEEDS_ATTENTION') AND u.state='RESERVED' AND u.expires_at>now()`,
        [r.workspace_id, r.task_id, value.runId],
      );
      const totals = reservations.rows[0]!;
      const amount = (value.maxMicrousd ?? 0) / 1000000;
      const micros = (value: number) => Math.round(value * 1000000);
      if (
        status.policy.taskLimitUsd !== null &&
        micros(status.task_spent) + micros(totals.task) + micros(amount) > micros(status.policy.taskLimitUsd)
      )
        throw new Error("TASK_BUDGET_EXHAUSTED");
      if (
        status.policy.dailyLimitUsd !== null &&
        micros(status.spent) +
          Math.max(0, micros(status.reserved) - micros(totals.own)) +
          micros(totals.pending) +
          micros(amount) >
          micros(status.policy.dailyLimitUsd)
      )
        throw new Error("DAILY_BUDGET_EXHAUSTED");
      const result = await client.query(
        "INSERT INTO usage_reservations(operation_id,run_id,max_microusd,state,expires_at) VALUES($1,$2,$3,'RESERVED',$4) ON CONFLICT(operation_id) DO NOTHING",
        [value.operationId, value.runId, value.maxMicrousd, value.expiresAt],
      );
      return result.rowCount === 1;
    });
  }

  async appendUsage(value: {
    attemptId: string;
    operationId: string;
    runId: string;
    stepId: string | null;
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
    usage: Json;
    observedAt: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        "INSERT INTO model_usage(attempt_id,operation_id,run_id,step_id,provider,model,category,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,amount_microusd,pricing_snapshot_id,usage,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(operation_id) DO NOTHING",
        [
          value.attemptId,
          value.operationId,
          value.runId,
          value.stepId,
          value.provider,
          value.model,
          value.category,
          value.inputTokens,
          value.outputTokens,
          value.cacheReadTokens,
          value.cacheWriteTokens,
          value.reasoningTokens,
          value.amountMicrousd,
          value.pricingSnapshotId,
          value.usage,
          value.observedAt,
        ],
      );
      if (result.rowCount === 0) {
        const prior = await client.query<{ attempt_id: string; usage: Json }>(
          "SELECT attempt_id,usage FROM model_usage WHERE operation_id=$1",
          [value.operationId],
        );
        if (prior.rows[0]?.attempt_id !== value.attemptId || sha(prior.rows[0]?.usage) !== sha(value.usage))
          throw new Error("USAGE_OPERATION_CONFLICT");
        return false;
      }
      await client.query(
        "UPDATE usage_reservations SET state='CONSUMED' WHERE operation_id=$1 AND state='RESERVED'",
        [value.operationId],
      );
      return true;
    });
  }

  /** Frees reservations whose call never produced usage (the call failed), so retries are not blocked. */
  async releaseUsage(operationIds: string[]): Promise<number> {
    if (!operationIds.length) return 0;
    const result = await this.pool.query(
      "UPDATE usage_reservations SET state='RELEASED' WHERE operation_id=ANY($1::uuid[]) AND state='RESERVED'",
      [operationIds],
    );
    return result.rowCount ?? 0;
  }

  async appendUsageAdjustment(value: {
    id: string;
    attemptId: string;
    deltaMicrousd: number | null;
    finalUsage: Json;
    reason: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      "INSERT INTO usage_adjustments(id,attempt_id,delta_microusd,final_usage,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
      [value.id, value.attemptId, value.deltaMicrousd, value.finalUsage, value.reason],
    );
    return result.rowCount === 1;
  }

  async upsertCommandReceipt(value: {
    operationId: string;
    sandboxId: string;
    requestHash: string;
    state: string;
    receipt: Json;
    startedAt: string;
    completedAt: string | null;
  }): Promise<"inserted" | "updated" | "duplicate"> {
    return transaction(this.pool, async (client) => {
      const prior = await client.query<{ request_sha256: string; state: string; receipt: Json }>(
        "SELECT request_sha256,state,receipt FROM sandbox_command_receipts WHERE operation_id=$1 FOR UPDATE",
        [value.operationId],
      );
      if (!prior.rows[0]) {
        await client.query(
          "INSERT INTO sandbox_command_receipts(operation_id,sandbox_id,request_sha256,state,receipt,started_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            value.operationId,
            value.sandboxId,
            value.requestHash,
            value.state,
            value.receipt,
            value.startedAt,
            value.completedAt,
          ],
        );
        return "inserted";
      }
      if (prior.rows[0].request_sha256 !== value.requestHash) throw new Error("OPERATION_ID_CONFLICT");
      if (prior.rows[0].state !== "RUNNING") return "duplicate";
      await client.query(
        "UPDATE sandbox_command_receipts SET state=$2,receipt=$3,completed_at=$4 WHERE operation_id=$1 AND state='RUNNING'",
        [value.operationId, value.state, value.receipt, value.completedAt],
      );
      return "updated";
    });
  }

  async sealCandidate(value: {
    id: string;
    runId: string;
    generation: number;
    candidateHash: string;
    baseSha: string;
    diffLocator: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query(
        "UPDATE candidate_artifacts SET superseded_at=now() WHERE run_id=$1 AND superseded_at IS NULL AND candidate_sha256<>$2",
        [value.runId, value.candidateHash],
      );
      const result = await client.query(
        "INSERT INTO candidate_artifacts(id,run_id,generation,candidate_sha256,base_sha,diff_locator,sealed_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(run_id,candidate_sha256) DO NOTHING",
        [value.id, value.runId, value.generation, value.candidateHash, value.baseSha, value.diffLocator],
      );
      return result.rowCount === 1;
    });
  }

  async appendEvidence(
    workspaceId: string,
    value: {
      id: string;
      runId: string;
      candidateHash: string;
      kind: string;
      operationId: string;
      artifactHash: string;
      passed: boolean;
    },
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const current = await client.query<{ candidate_sha256: string }>(
        "SELECT candidate_sha256 FROM candidate_artifacts WHERE run_id=$1 AND superseded_at IS NULL ORDER BY generation DESC LIMIT 1",
        [value.runId],
      );
      if (current.rows[0]?.candidate_sha256 !== value.candidateHash)
        throw new Error("STALE_CANDIDATE_EVIDENCE");
      const result = await client.query(
        "INSERT INTO execution_evidence(id,run_id,candidate_sha256,kind,operation_id,artifact_sha256,passed) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(operation_id) DO NOTHING",
        [
          value.id,
          value.runId,
          value.candidateHash,
          value.kind,
          value.operationId,
          value.artifactHash,
          value.passed,
        ],
      );
      if (result.rowCount === 1)
        await appendOutbox(client, workspaceId, "run.evidence.recorded", {
          runId: value.runId,
          candidateHash: value.candidateHash,
          kind: value.kind,
          passed: value.passed,
        });
      return result.rowCount === 1;
    });
  }

  async appendTelemetryLog(
    workspaceId: string,
    value: {
      id: string;
      runId: string | null;
      level: string;
      body: Json;
      redactionVersion: number;
      occurredAt: string;
      expiresAt: string;
    },
  ): Promise<number> {
    return transaction(this.pool, async (client) => {
      const seq = await appendOutbox(client, workspaceId, "telemetry.log", {
        runId: value.runId,
        level: value.level,
        body: value.body,
      });
      await client.query(
        "INSERT INTO telemetry_logs(id,workspace_id,run_id,seq,level,body,body_sha256,redaction_version,occurred_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          value.id,
          workspaceId,
          value.runId,
          seq,
          value.level,
          value.body,
          sha(value.body),
          value.redactionVersion,
          value.occurredAt,
          value.expiresAt,
        ],
      );
      return seq;
    });
  }

  async eventHistory(
    workspaceId: string,
    after: number,
    limit = 500,
  ): Promise<Array<{ seq: number; eventId: string; type: string; payload: Json; occurredAt: string }>> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("INVALID_CURSOR");
    const result = await this.pool.query<{
      seq: string;
      event_id: string;
      event_type: string;
      payload: Json;
      occurred_at: Date;
    }>(
      "SELECT seq,event_id,event_type,payload,occurred_at FROM outbox_events WHERE workspace_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
      [workspaceId, after, limit],
    );
    return result.rows.map((row) => ({
      seq: Number(row.seq),
      eventId: row.event_id,
      type: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }
  async latestCursor(workspaceId: string): Promise<number> {
    const result = await this.pool.query<{ last_seq: string }>(
      "SELECT last_seq FROM workspace_event_counters WHERE workspace_id=$1",
      [workspaceId],
    );
    return Number(result.rows[0]?.last_seq ?? 0);
  }
}
