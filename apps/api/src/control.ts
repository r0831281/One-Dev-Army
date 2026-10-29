import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { WorkflowIdConflictPolicy } from "@temporalio/common";
import type {
  DecisionReceipt,
  GateDecisionInput,
  Json,
  RunManifest,
  TaskContext,
  WorkflowProjection,
} from "../../../packages/contracts/src/index.js";
import {
  validateGateDecisionInput,
  validateRunManifest,
  validateTaskContext,
} from "../../../packages/contracts/src/index.js";
import {
  canonicalSha256,
  PgCommandRepository,
  PgWorkflowRepository,
  type CommandRecord,
} from "../../../packages/persistence/src/index.js";
import { cancelRun, submitGateDecision, TaskRunWorkflow } from "../../worker/src/workflows.js";
import {
  TASK_RUN_QUEUE,
  type CancelReceipt,
  type CancelRunInput,
  type TaskRunWorkflowInput,
} from "../../worker/src/types.js";
import type { Pool } from "pg";
import { WorkHorizon } from "./horizon.js";
import { WorkspaceOperations } from "../../../packages/persistence/src/operations.js";

export interface TemporalGateway {
  start(input: TaskRunWorkflowInput, workflowId: string): Promise<void>;
  decide(workflowId: string, input: GateDecisionInput): Promise<DecisionReceipt>;
  cancel(workflowId: string, input: CancelRunInput): Promise<CancelReceipt>;
}

export class TemporalClientGateway implements TemporalGateway {
  constructor(private readonly client: Client) {}
  async start(input: TaskRunWorkflowInput, workflowId: string): Promise<void> {
    await this.client.workflow.start(TaskRunWorkflow, {
      args: [input],
      taskQueue: TASK_RUN_QUEUE,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
  }
  async decide(workflowId: string, input: GateDecisionInput): Promise<DecisionReceipt> {
    return this.client.workflow.getHandle(workflowId).executeUpdate(submitGateDecision, {
      args: [input],
      updateId: input.idempotencyKey,
    });
  }
  async cancel(workflowId: string, input: CancelRunInput): Promise<CancelReceipt> {
    return this.client.workflow.getHandle(workflowId).executeUpdate(cancelRun, {
      args: [input],
      updateId: input.idempotencyKey,
    });
  }
}

export async function connectTemporalGateway(
  address = process.env.ODA_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  namespace = process.env.ODA_TEMPORAL_NAMESPACE ?? "default",
): Promise<{ gateway: TemporalClientGateway; close(): Promise<void> }> {
  const connection = await Connection.connect({ address });
  return {
    gateway: new TemporalClientGateway(new Client({ connection, namespace })),
    close: () => connection.close(),
  };
}

interface RunStartCommandPayload {
  workflowId: string;
  input: TaskRunWorkflowInput;
}
interface CancelCommandPayload {
  workflowId: string;
  input: CancelRunInput;
}
interface DecisionCommandPayload {
  workflowId: string;
  input: GateDecisionInput;
}

export class RunControlService {
  readonly commands: PgCommandRepository;
  readonly runs: PgWorkflowRepository;
  readonly horizon: WorkHorizon;
  readonly operations: WorkspaceOperations;
  private dispatching = false;
  constructor(
    private readonly pool: Pool,
    private readonly temporal: TemporalGateway,
    private readonly workspaceId: string,
    private readonly actorId: string,
    private readonly latestContext?: (taskId: string) => TaskContext | null,
  ) {
    this.commands = new PgCommandRepository(pool);
    this.runs = new PgWorkflowRepository(pool);
    this.horizon = new WorkHorizon(pool, workspaceId, actorId);
    this.operations = new WorkspaceOperations(pool, workspaceId);
  }

  async requestStart(
    idempotencyKey: string,
    value: {
      manifest: unknown;
      context: unknown;
      repositoryRoot: string;
      continueAsNewAfterTransitions?: number;
      fakeCompletionDelayMs?: number;
    },
  ) {
    const manifest = validateRunManifest(value.manifest);
    const context = validateTaskContext(value.context);
    if (context.taskId !== manifest.taskId || context.revision !== manifest.contextRevision)
      throw new Error("CONTEXT_MANIFEST_MISMATCH");
    const workflowId = `task/${manifest.taskId}/run/${manifest.runId}`;
    const manifestHash = canonicalSha256(manifest);
    const projection: WorkflowProjection = {
      schemaVersion: "1.0",
      runId: manifest.runId,
      workflowId,
      state: "QUEUED",
      stateRevision: 0,
      manifestHash,
      plan: null,
      currentGate: null,
      constraints: structuredClone(context.constraints),
      budget: {
        humanReplansUsed: 0,
        humanReplansLimit: manifest.correctionBudget.humanReplans,
      },
      cancelRequested: false,
      updatedAt: new Date().toISOString(),
    };
    const input: TaskRunWorkflowInput = {
      workspaceId: this.workspaceId,
      actorId: this.actorId,
      manifest,
      manifestHash,
      context,
      repositoryRoot: value.repositoryRoot,
      ...(value.continueAsNewAfterTransitions === undefined
        ? {}
        : { continueAsNewAfterTransitions: value.continueAsNewAfterTransitions }),
      ...(value.fakeCompletionDelayMs === undefined
        ? {}
        : { fakeCompletionDelayMs: value.fakeCompletionDelayMs }),
    };
    const prior = await this.commands.byKey(idempotencyKey);
    const previousBindings = (prior?.payload as unknown as RunStartCommandPayload | undefined)?.input
      ?.profileBindings;
    if (previousBindings) input.profileBindings = previousBindings;
    else {
      const assignments = await this.pool.query<{ assignments: Record<string, string> }>(
        "SELECT assignments FROM workspace_operations WHERE workspace_id=$1",
        [this.workspaceId],
      );
      input.profileBindings = {};
      for (const [role, id] of Object.entries(assignments.rows[0]?.assignments ?? {})) {
        const result = await this.pool.query<{
          id: string;
          revision: number;
          provider: string;
          model: string;
        }>(
          "SELECT id,revision,provider,model FROM agent_profiles WHERE workspace_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 1",
          [this.workspaceId, id],
        );
        const p = result.rows[0];
        if (!p || manifest.profileRevisions[role] !== p.revision)
          throw new Error("PROFILE_REVISION_CONFLICT");
        input.profileBindings[role] = p;
      }
    }
    const command = await this.commands.createOrGet(this.workspaceId, idempotencyKey, "RUN_START", {
      workflowId,
      input,
    } as unknown as Json);
    await this.runs.create(this.workspaceId, manifest, workflowId, projection);
    const eligibility = await this.horizon.eligibility(await this.contextForStart(context));
    const waitingReason = !eligibility.eligible
      ? eligibility.reason
      : await this.operations.waiting(context.taskId, manifest.runId);
    if (waitingReason && command.command.state === "PENDING")
      await this.pool.query("UPDATE command_requests SET result=$2 WHERE id=$1", [
        command.command.id,
        { reason: waitingReason, cutoff: eligibility.cutoff, plannedFor: eligibility.plannedFor },
      ]);
    return {
      status: command.command.state === "COMPLETED" ? "RECORDED" : waitingReason ? "DEFERRED" : "PENDING",
      waitingReason,
      eligibility,
      runId: manifest.runId,
      workflowId,
      commandId: command.command.id,
      duplicate: command.duplicate,
    };
  }

  async requestCancel(idempotencyKey: string, runId: string, input: Omit<CancelRunInput, "idempotencyKey">) {
    const run = await this.runs.get(runId, this.workspaceId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    if (
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      !Number.isSafeInteger(input.expectedStateRevision)
    )
      throw new Error("INVALID_CANCELLATION");
    const prior = await this.commands.byKey(idempotencyKey);
    if (!prior && run.projection.stateRevision !== input.expectedStateRevision)
      throw new Error("STATE_CONFLICT");
    const payload: CancelCommandPayload = {
      workflowId: run.workflowId,
      input: { ...input, idempotencyKey },
    };
    const command = await this.commands.createOrGet(
      this.workspaceId,
      idempotencyKey,
      "RUN_CANCEL",
      payload as unknown as Json,
    );
    return {
      status: command.command.state === "COMPLETED" ? "RECORDED" : "PENDING",
      commandId: command.command.id,
      duplicate: command.duplicate,
    };
  }

  async submitDecision(value: unknown): Promise<DecisionReceipt> {
    const input = validateGateDecisionInput(value);
    const run = await this.runs.get(input.runId, this.workspaceId);
    if (!run || run.workflowId !== input.workflowId) throw new Error("RUN_NOT_FOUND");
    const command = await this.commands.createOrGet(this.workspaceId, input.idempotencyKey, "GATE_DECISION", {
      workflowId: run.workflowId,
      input,
    } as unknown as Json);
    if (command.command.state === "COMPLETED" && command.command.result)
      return command.command.result as unknown as DecisionReceipt;
    return this.dispatchDecision(command.command, { workflowId: run.workflowId, input });
  }

  async decisionByKey(key: string) {
    const receipt = await this.runs.decisionByKey(key);
    if (receipt) return { status: "RECORDED", receipt };
    const command = await this.commands.byKey(key);
    if (command?.state === "COMPLETED" && command.result)
      return { status: "RECORDED", receipt: command.result as unknown as DecisionReceipt };
    return command ? { status: "PENDING", commandId: command.id } : { status: "ABSENT" };
  }

  async dispatchPending(limit = 50): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    let lock;
    try {
      lock = await this.pool.connect();
    } catch (error) {
      this.dispatching = false;
      throw error;
    }
    let held = false;
    try {
      const acquired = await lock.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
        [this.workspaceId],
      );
      held = acquired.rows[0]?.held === true;
      if (!held) return 0;
      const commands = await this.commands.pending(limit, this.workspaceId);
      for (const command of commands) {
        if (command.workspaceId !== this.workspaceId) continue;
        try {
          await this.dispatch(command);
        } catch (error) {
          const failure = error as Error & { cause?: { nonRetryable?: boolean; type?: string } };
          if (failure.cause?.nonRetryable)
            await this.commands.transition(command.id, "PENDING", "FAILED", {
              code: failure.cause.type ?? "COMMAND_REJECTED",
            });
          else if (["STATE_CONFLICT", "RUN_NOT_FOUND", "INVALID_CANCELLATION"].includes(failure.message))
            await this.commands.transition(command.id, "PENDING", "FAILED", { code: failure.message });
        }
      }
      return commands.length;
    } finally {
      try {
        if (held) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [this.workspaceId]);
      } finally {
        lock.release();
        this.dispatching = false;
      }
    }
  }

  async listRuns() {
    const runs = await this.runs.list(100, this.workspaceId);
    const pending = await this.pool.query<{
      payload: { input: { manifest: { runId: string } } };
      result: Json;
    }>(
      "SELECT payload,result FROM command_requests WHERE workspace_id=$1 AND state='PENDING' AND command_type='RUN_START'",
      [this.workspaceId],
    );
    const waiting = new Map(pending.rows.map((r) => [r.payload.input.manifest.runId, r.result]));
    const admissions = await this.pool.query<{ run_id: string }>(
      "SELECT run_id FROM run_admissions WHERE workspace_id=$1",
      [this.workspaceId],
    );
    const admitted = new Set(admissions.rows.map((a) => a.run_id));
    return runs.map((r) => ({
      ...r,
      waiting:
        waiting.get(r.runId) ??
        (r.projection.state === "QUEUED" && admitted.has(r.runId) ? { reason: "WORKER" } : null),
    }));
  }
  async getRun(runId: string) {
    return this.runs.get(runId, this.workspaceId);
  }

  private async dispatch(command: CommandRecord): Promise<void> {
    if (command.commandType === "RUN_START") {
      const payload = command.payload as unknown as RunStartCommandPayload;
      const current = await this.pool.query(
        "SELECT id FROM command_requests WHERE id=$1 AND state='PENDING'",
        [command.id],
      );
      if (!current.rows.length) return;
      const projected = await this.runs.get(payload.input.manifest.runId, this.workspaceId);
      if (projected?.projection.state === "CANCELLED") {
        await this.commands.transition(command.id, "PENDING", "FAILED", { code: "CANCELLED_BEFORE_START" });
        return;
      }
      for (const [role, binding] of Object.entries(payload.input.profileBindings ?? {})) {
        const profile = await this.pool.query<{
          id: string;
          revision: number;
          provider: string;
          model: string;
          profile: { credentialRef: string | null };
        }>(
          "SELECT id,revision,provider,model,profile FROM agent_profiles WHERE workspace_id=$1 AND id=$2 AND revision=$3",
          [this.workspaceId, binding.id, binding.revision],
        );
        const p = profile.rows[0];
        if (
          !p ||
          (!["fake", "ollama"].includes(p.provider) &&
            (!p.profile.credentialRef?.startsWith("env:") || !process.env[p.profile.credentialRef.slice(4)]))
        ) {
          await this.pool.query(
            "UPDATE command_requests SET available_at=now()+interval '60 seconds',result=$2 WHERE id=$1",
            [command.id, { reason: "PROVIDER_UNAVAILABLE", role }],
          );
          return;
        }
        // Current workflow execution is deterministic. Do not silently pretend a configured live model was invoked.
        if (p.provider !== "fake") {
          await this.pool.query(
            "UPDATE command_requests SET available_at=now()+interval '60 seconds',result=$2 WHERE id=$1",
            [command.id, { reason: "EXECUTION_BACKEND", role }],
          );
          return;
        }
      }
      // Evaluate current scheduling metadata immediately before starting any agents.
      // The workflow still receives its pinned, immutable execution context.
      const eligibility = await this.horizon.eligibility(await this.contextForStart(payload.input.context));
      const reason = !eligibility.eligible
        ? eligibility.reason
        : await this.operations.waiting(payload.input.manifest.taskId, payload.input.manifest.runId);
      if (reason) {
        await this.pool.query(
          "UPDATE command_requests SET available_at=now()+interval '60 seconds',result=$2 WHERE id=$1 AND state='PENDING'",
          [command.id, { reason, cutoff: eligibility.cutoff, plannedFor: eligibility.plannedFor }],
        );
        return;
      }
      await this.operations.admit(payload.input.manifest.runId);
      try {
        await this.temporal.start(payload.input, payload.workflowId);
      } catch (error) {
        await this.pool.query(
          "UPDATE command_requests SET available_at=now()+interval '5 seconds',result=$2 WHERE id=$1 AND state='PENDING'",
          [command.id, { reason: "EXECUTION_SERVICE" }],
        );
        throw error;
      }
      if (
        await this.commands.transition(command.id, "PENDING", "DISPATCHED", {
          workflowId: payload.workflowId,
        })
      )
        await this.commands.transition(command.id, "DISPATCHED", "COMPLETED", {
          workflowId: payload.workflowId,
        });
      return;
    }
    if (command.commandType === "RUN_CANCEL") {
      const payload = command.payload as unknown as CancelCommandPayload;
      const cancelled = await this.pool.query<{ state_revision: string }>(
        "SELECT state_revision FROM workflow_runs WHERE workspace_id=$1 AND workflow_id=$2 AND state='CANCELLED'",
        [this.workspaceId, payload.workflowId],
      );
      if (cancelled.rows[0]) {
        await this.commands.transition(command.id, "PENDING", "COMPLETED", {
          status: "RECORDED",
          stateRevision: Number(cancelled.rows[0].state_revision),
          idempotencyKey: payload.input.idempotencyKey,
        });
        return;
      }
      const pending = await this.pool.query<{ id: string; payload: RunStartCommandPayload }>(
        "SELECT id,payload FROM command_requests WHERE workspace_id=$1 AND state='PENDING' AND command_type='RUN_START' AND payload->>'workflowId'=$2",
        [this.workspaceId, payload.workflowId],
      );
      if (pending.rows[0]) {
        const start = pending.rows[0];
        const run = await this.runs.get(start.payload.input.manifest.runId, this.workspaceId);
        if (!run) throw new Error("RUN_NOT_FOUND");
        if (run.projection.stateRevision !== payload.input.expectedStateRevision)
          throw new Error("STATE_CONFLICT");
        const projection = {
          ...run.projection,
          state: "CANCELLED",
          cancelRequested: true,
          stateRevision: run.projection.stateRevision + 1,
          updatedAt: new Date().toISOString(),
        };
        await this.runs.project(this.workspaceId, projection, "not-started");
        await this.commands.transition(start.id, "PENDING", "FAILED", { code: "CANCELLED_BEFORE_START" });
        await this.pool.query("DELETE FROM run_admissions WHERE run_id=$1", [run.runId]);
        await this.commands.transition(command.id, "PENDING", "COMPLETED", {
          status: "RECORDED",
          stateRevision: projection.stateRevision,
          idempotencyKey: payload.input.idempotencyKey,
        });
        return;
      }
      const receipt = await this.temporal.cancel(payload.workflowId, payload.input);
      if (await this.commands.transition(command.id, "PENDING", "DISPATCHED", receipt as unknown as Json))
        await this.commands.transition(command.id, "DISPATCHED", "COMPLETED", receipt as unknown as Json);
      return;
    }
    if (command.commandType === "GATE_DECISION") {
      await this.dispatchDecision(command, command.payload as unknown as DecisionCommandPayload);
      return;
    }
    throw new Error(`UNSUPPORTED_COMMAND:${command.commandType}`);
  }

  private async contextForStart(fallback: TaskContext): Promise<TaskContext> {
    const current = this.latestContext?.(fallback.taskId);
    const result = await this.pool.query<{ context: TaskContext }>(
      "SELECT c.context FROM task_contexts c JOIN tasks t ON t.id=c.task_id WHERE c.task_id=$1 AND t.workspace_id=$2 ORDER BY c.revision DESC LIMIT 1",
      [fallback.taskId, this.workspaceId],
    );
    const persisted = result.rows[0]?.context;
    return current && (!persisted || current.revision > persisted.revision)
      ? current
      : (persisted ?? fallback);
  }

  private async dispatchDecision(
    command: CommandRecord,
    payload: DecisionCommandPayload,
  ): Promise<DecisionReceipt> {
    const receipt = await this.temporal.decide(payload.workflowId, payload.input);
    if (await this.commands.transition(command.id, "PENDING", "DISPATCHED", receipt as unknown as Json))
      await this.commands.transition(command.id, "DISPATCHED", "COMPLETED", receipt as unknown as Json);
    return receipt;
  }
}

export function createRunManifest(input: {
  taskId: string;
  contextRevision: number;
  repositoryId: string;
  baseSha: string;
  routingRevision?: number;
  policyHash: string;
  profileRevisions?: Record<string, number>;
  humanReplans?: number;
  workflowVersion?: 1 | 2;
}): RunManifest {
  return validateRunManifest({
    schemaVersion: "1.0",
    workflowType: "TaskRunWorkflow",
    workflowVersion: input.workflowVersion ?? 1,
    runId: randomUUID(),
    taskId: input.taskId,
    contextRevision: input.contextRevision,
    repository: { id: input.repositoryId, baseSha: input.baseSha },
    routingRevision: input.routingRevision ?? 1,
    policyHash: input.policyHash,
    profileRevisions:
      input.profileRevisions ??
      (input.workflowVersion === 2
        ? { "context-reviewer": 1, planner: 1, implementer: 1, tester: 1, reviewer: 1, reporter: 1 }
        : { "context-reviewer": 1, planner: 1 }),
    correctionBudget: {
      humanReplans: input.humanReplans ?? 5,
      testRepairs: 3,
      reviewRepairs: 2,
      structuredOutputRepairs: 2,
      transportAttempts: 3,
    },
    createdAt: new Date().toISOString(),
  });
}
