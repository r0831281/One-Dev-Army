import type { Queryable } from "./index.js";

export interface OperationsPolicy {
  dailyLimitUsd: number | null;
  taskLimitUsd: number | null;
  reservationUsd: number;
  maxConcurrentRuns: number;
  paused: boolean;
  unpricedPolicy: "allow" | "block";
  timezone: string;
}
export const DEFAULT_OPERATIONS: OperationsPolicy = {
  dailyLimitUsd: null,
  taskLimitUsd: null,
  reservationUsd: 0.5,
  maxConcurrentRuns: 3,
  paused: false,
  unpricedPolicy: "allow",
  timezone: "Europe/Brussels",
};
export function validateOperations(p: OperationsPolicy): OperationsPolicy {
  if (
    !p ||
    !Number.isInteger(p.maxConcurrentRuns) ||
    p.maxConcurrentRuns < 1 ||
    p.maxConcurrentRuns > 100 ||
    typeof p.paused !== "boolean" ||
    !["allow", "block"].includes(p.unpricedPolicy) ||
    typeof p.timezone !== "string"
  )
    throw new Error("INVALID_OPERATIONS_POLICY");
  for (const value of [p.dailyLimitUsd, p.taskLimitUsd, p.reservationUsd])
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1000000))
      throw new Error("INVALID_SPENDING_LIMIT");
  if (p.reservationUsd === null || p.reservationUsd < 0.000001) throw new Error("INVALID_RESERVATION");
  try {
    new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
  } catch {
    throw new Error("INVALID_TIMEZONE");
  }
  return {
    dailyLimitUsd: p.dailyLimitUsd,
    taskLimitUsd: p.taskLimitUsd,
    reservationUsd: p.reservationUsd,
    maxConcurrentRuns: p.maxConcurrentRuns,
    paused: p.paused,
    unpricedPolicy: p.unpricedPolicy,
    timezone: p.timezone,
  };
}
export class WorkspaceOperations {
  constructor(
    private readonly db: Queryable,
    readonly workspaceId: string,
  ) {}
  async policy(): Promise<OperationsPolicy> {
    const r = await this.db.query<{ policy: OperationsPolicy }>(
      "SELECT policy FROM workspace_operations WHERE workspace_id=$1",
      [this.workspaceId],
    );
    return r.rows[0]?.policy ?? { ...DEFAULT_OPERATIONS };
  }
  async save(value: OperationsPolicy) {
    const p = validateOperations(value);
    await this.db.query(
      "INSERT INTO workspace_operations(workspace_id,policy) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET policy=$2,updated_at=now()",
      [this.workspaceId, p],
    );
    await this.db.query(
      "UPDATE command_requests SET available_at=now() WHERE workspace_id=$1 AND state='PENDING' AND command_type='RUN_START'",
      [this.workspaceId],
    );
    return p;
  }
  async releaseFinished() {
    await this.db.query(
      "DELETE FROM run_admissions a USING workflow_runs r WHERE r.id=a.run_id AND a.workspace_id=$1 AND r.state IN ('COMPLETED','CANCELLED','FAILED','NEEDS_ATTENTION')",
      [this.workspaceId],
    );
  }
  async status(taskId: string | null = null) {
    const policy = await this.policy();
    const r = await this.db.query<{
      spent: number;
      task_spent: number;
      unpriced: number;
      reserved: number;
      active: number;
    }>(
      `
      WITH usage AS (
        SELECT u.*, r.task_id,
          coalesce(u.amount_microusd + coalesce((SELECT sum(delta_microusd) FROM usage_adjustments WHERE attempt_id=u.attempt_id),0),
            (SELECT (final_usage->>'amountMicrousd')::bigint FROM usage_adjustments WHERE attempt_id=u.attempt_id ORDER BY recorded_at DESC LIMIT 1)) AS cost
        FROM model_usage u JOIN workflow_runs r ON r.id=u.run_id WHERE r.workspace_id=$1
      ) SELECT
        coalesce((SELECT sum(cost) FROM usage WHERE (observed_at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date),0)::float8/1000000 AS spent,
        coalesce((SELECT sum(cost) FROM usage WHERE task_id=$2),0)::float8/1000000 AS task_spent,
        (SELECT count(*) FROM usage WHERE cost IS NULL AND (observed_at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date)::int AS unpriced,
        coalesce((SELECT sum(greatest(0,coalesce(a.reserved_microusd,0)-coalesce((SELECT sum(cost) FROM usage WHERE run_id=admitted.id),0),
          coalesce((SELECT sum(max_microusd) FROM usage_reservations WHERE run_id=admitted.id AND state='RESERVED' AND expires_at>now()),0)))
          FROM workflow_runs admitted LEFT JOIN run_admissions a ON a.run_id=admitted.id
          WHERE admitted.workspace_id=$1 AND admitted.state NOT IN ('COMPLETED','CANCELLED','FAILED','NEEDS_ATTENTION')),0)::float8/1000000 AS reserved,
        (SELECT count(*) FROM workflow_runs r WHERE r.workspace_id=$1 AND r.state NOT IN ('COMPLETED','CANCELLED','FAILED','NEEDS_ATTENTION')
          AND (r.state<>'QUEUED' OR EXISTS(SELECT 1 FROM run_admissions a WHERE a.run_id=r.id)))::int AS active
    `,
      [this.workspaceId, taskId, policy.timezone],
    );
    const s = r.rows[0]!;
    return {
      policy,
      ...s,
      remaining:
        policy.dailyLimitUsd === null ? null : Math.max(0, policy.dailyLimitUsd - s.spent - s.reserved),
    };
  }
  async waiting(taskId: string, runId: string) {
    await this.releaseFinished();
    const own = await this.db.query("SELECT run_id FROM run_admissions WHERE run_id=$1 AND workspace_id=$2", [
      runId,
      this.workspaceId,
    ]);
    if (own.rows.length) return null; // A retry of an already-admitted start keeps its reservation.
    const s = await this.status(taskId);
    const reserve = Math.min(s.policy.reservationUsd, s.policy.taskLimitUsd ?? Infinity);
    const micros = (value: number) => Math.round(value * 1000000);
    if (s.policy.paused) return "PAUSED";
    if (s.policy.unpricedPolicy === "block" && s.unpriced) return "UNPRICED_USAGE";
    if (
      (s.policy.taskLimitUsd !== null &&
        micros(s.task_spent) + micros(reserve) > micros(s.policy.taskLimitUsd)) ||
      s.policy.taskLimitUsd === 0
    )
      return "TASK_BUDGET";
    if (s.remaining !== null && micros(reserve) > micros(s.remaining)) return "DAILY_BUDGET";
    if (s.active >= s.policy.maxConcurrentRuns) return "CAPACITY";
    return null;
  }
  async admit(runId: string) {
    const p = await this.policy();
    await this.db.query(
      "INSERT INTO run_admissions(run_id,workspace_id,reserved_microusd) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING",
      [runId, this.workspaceId, Math.round(Math.min(p.reservationUsd, p.taskLimitUsd ?? Infinity) * 1000000)],
    );
  }
}
