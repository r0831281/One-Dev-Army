import { plannedFor as plannedForOf, type TaskContext } from "../../../packages/contracts/src/index.js";
import type { Queryable } from "../../../packages/persistence/src/index.js";

export interface HorizonSettings {
  days: number;
  timezone: string;
}
export const DEFAULT_HORIZON: HorizonSettings = { days: 7, timezone: "Europe/Brussels" };
export function validateHorizon(value: HorizonSettings): HorizonSettings {
  if (
    !value ||
    !Number.isInteger(value.days) ||
    value.days < 0 ||
    value.days > 365 ||
    typeof value.timezone !== "string"
  )
    throw new Error("INVALID_WORK_HORIZON");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format();
  } catch {
    throw new Error("INVALID_WORK_HORIZON_TIMEZONE");
  }
  return { days: value.days, timezone: value.timezone };
}
/** Today and the horizon cutoff as calendar dates in the workspace timezone. */
export function horizonWindow(settings: HorizonSettings, now = new Date()): { from: string; to: string } {
  validateHorizon(settings);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const from = `${part("year")}-${part("month")}-${part("day")}`;
  const cutoffDate = new Date(`${from}T00:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() + settings.days);
  return { from, to: cutoffDate.toISOString().slice(0, 10) };
}
export function horizonEligibility(
  context: Pick<TaskContext, "extensions">,
  settings: HorizonSettings,
  override = false,
  now = new Date(),
) {
  const { to: cutoff } = horizonWindow(settings, now);
  const plannedFor = plannedForOf(context);
  return {
    eligible: override || (plannedFor !== null && plannedFor <= cutoff),
    reason: override
      ? "MANUAL_OVERRIDE"
      : !plannedFor
        ? "UNDATED"
        : plannedFor > cutoff
          ? "OUTSIDE_HORIZON"
          : "WITHIN_HORIZON",
    plannedFor,
    cutoff,
    override,
  };
}

export class WorkHorizon {
  constructor(
    private readonly db: Queryable,
    private readonly workspaceId: string,
    private readonly actorId: string,
  ) {}
  async settings(): Promise<HorizonSettings> {
    const result = await this.db.query<HorizonSettings>(
      "SELECT days,timezone FROM work_horizon_settings WHERE workspace_id=$1",
      [this.workspaceId],
    );
    return result.rows[0] ?? { ...DEFAULT_HORIZON };
  }
  async save(value: HorizonSettings) {
    const settings = validateHorizon(value);
    await this.db.query(
      "INSERT INTO work_horizon_settings(workspace_id,days,timezone,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET days=$2,timezone=$3,updated_by=$4,updated_at=now()",
      [this.workspaceId, settings.days, settings.timezone, this.actorId],
    );
    await this.wake();
    return settings;
  }
  async overrides() {
    const result = await this.db.query<{ task_id: string }>(
      "SELECT task_id FROM work_horizon_overrides WHERE workspace_id=$1 AND allowed=true",
      [this.workspaceId],
    );
    return result.rows.map((r) => r.task_id);
  }
  async setOverride(taskId: string, allowed: boolean, reason: string) {
    if (typeof allowed !== "boolean" || typeof reason !== "string" || !reason.trim() || reason.length > 1000)
      throw new Error("INVALID_HORIZON_OVERRIDE");
    await this.db.query(
      "INSERT INTO work_horizon_overrides(workspace_id,task_id,allowed,reason,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,task_id) DO UPDATE SET allowed=$3,reason=$4,updated_by=$5,updated_at=now()",
      [this.workspaceId, taskId, allowed, reason.trim(), this.actorId],
    );
    await this.wake();
  }
  async eligibility(context: TaskContext) {
    const [settings, overrides] = await Promise.all([this.settings(), this.overrides()]);
    return horizonEligibility(context, settings, overrides.includes(context.taskId));
  }
  private async wake() {
    await this.db.query(
      "UPDATE command_requests SET available_at=now() WHERE workspace_id=$1 AND state='PENDING' AND command_type='RUN_START'",
      [this.workspaceId],
    );
  }
}
