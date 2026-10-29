import type { ScopedHttp, TaskPlanning } from "./index.js";

export const TEMPO_ORIGIN = "https://api.tempo.io";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;
const JIRA_BATCH = 100;
/** Task keys written in free text, e.g. `ABC-78 Website` or `FRZ-973 + FRZ-975`. */
const TASK_KEYS = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[1-9]\d*)(?![A-Za-z0-9-])/g;
const MAX_KEYS_PER_PLAN = 10;

interface TempoPlan {
  id: number | string;
  description?: string | null;
  startDate?: string;
  endDate?: string;
  plannedSecondsPerDay?: number;
  planItem?: { id?: number | string; type?: string };
  dates?: { values?: Array<{ date?: string; timePlannedSeconds?: number }> };
}
interface TempoPage {
  metadata?: { count?: number; next?: string };
  results?: TempoPlan[];
}
/** One Tempo plan on a Jira issue, clipped to the requested window. */
export interface PlannedIssue {
  planId: string;
  issueId: string;
  /** The plan's own description; often names the Odoo task when the issue is a generic bucket. */
  description: string;
  dates: Array<{ date: string; seconds: number }>;
}
export interface PlannedTarget {
  /** Identifier to route and ingest: the helpdesk Jira key or the Odoo task key. */
  identifier: string;
  planning: TaskPlanning;
}
export interface PlanningResult {
  planned: number;
  targets: PlannedTarget[];
  /** Plans that are not on a helpdesk ticket and name no task key, as `JIRA-KEY: plan description`. */
  unlinked: string[];
}

const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

function planDates(plan: TempoPlan, from: string, to: string): Array<{ date: string; seconds: number }> {
  const values = plan.dates?.values;
  if (Array.isArray(values))
    return values
      .filter((v) => isDate(v.date) && v.date >= from && v.date <= to && (v.timePlannedSeconds ?? 0) > 0)
      .map((v) => ({ date: v.date as string, seconds: v.timePlannedSeconds ?? 0 }));
  if (!isDate(plan.startDate) || !isDate(plan.endDate)) return [];
  const dates: Array<{ date: string; seconds: number }> = [];
  const day = new Date(`${plan.startDate > from ? plan.startDate : from}T00:00:00Z`);
  const last = plan.endDate < to ? plan.endDate : to;
  for (let i = 0; i < 366 && day.toISOString().slice(0, 10) <= last; i++) {
    dates.push({ date: day.toISOString().slice(0, 10), seconds: plan.plannedSecondsPerDay ?? 0 });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

export class TempoPlanningSource {
  constructor(
    private readonly tempo: ScopedHttp,
    private readonly origin = TEMPO_ORIGIN,
  ) {}
  /** Lists the Tempo plans on Jira issues for one user in [from, to]. */
  async listPlanned(input: { accountId: string; from: string; to: string }): Promise<PlannedIssue[]> {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.accountId) || !isDate(input.from) || !isDate(input.to))
      throw new Error("VALIDATION_FAILED");
    const byPlan = new Map<string, PlannedIssue>();
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        from: input.from,
        to: input.to,
        offset: String(offset),
        limit: String(PAGE_LIMIT),
      });
      const result = await this.tempo.request<TempoPage>({
        method: "GET",
        url: `${this.origin}/4/plans/user/${encodeURIComponent(input.accountId)}?${query}`,
      });
      const plans = result.results ?? [];
      for (const plan of plans) {
        if (plan.planItem?.type !== "ISSUE" || plan.planItem.id === undefined) continue;
        const dates = planDates(plan, input.from, input.to);
        if (!dates.length) continue;
        byPlan.set(String(plan.id), {
          planId: String(plan.id),
          issueId: String(plan.planItem.id),
          description: typeof plan.description === "string" ? plan.description.slice(0, 2000) : "",
          dates,
        });
      }
      if (!result.metadata?.next || plans.length === 0) break;
      offset += plans.length;
    }
    return [...byPlan.values()];
  }
}

function mergeDates(dates: Array<{ date: string; seconds: number }>) {
  const totals = new Map<string, number>();
  for (const { date, seconds } of dates) totals.set(date, (totals.get(date) ?? 0) + seconds);
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
}

/** Resolves Jira issue ids to keys and summaries through the Jira connector's read-only transport. */
interface JiraSummary {
  id: string;
  key: string;
  fields?: { summary?: string };
}
export async function resolveJiraIssues(
  jira: ScopedHttp,
  jiraOrigin: string,
  issueIds: string[],
): Promise<Map<string, { key: string; summary: string }>> {
  const resolved = new Map<string, { key: string; summary: string }>();
  const ids = [...new Set(issueIds)].filter((id) => /^[1-9]\d{0,18}$/.test(id));
  for (let i = 0; i < ids.length; i += JIRA_BATCH) {
    const batch = ids.slice(i, i + JIRA_BATCH);
    const query = new URLSearchParams({
      jql: `id in (${batch.join(",")})`,
      fields: "summary",
      maxResults: String(JIRA_BATCH),
    });
    let issues: JiraSummary[];
    try {
      const page = await jira.request<{ issues?: JiraSummary[] }>({
        method: "GET",
        url: `${jiraOrigin}/rest/api/3/search/jql?${query}`,
      });
      issues = page.issues ?? [];
    } catch {
      // JQL rejects the whole batch when one id is deleted or hidden from the token; resolve one by one instead.
      issues = [];
      for (const id of batch)
        try {
          issues.push(
            await jira.request<JiraSummary>({
              method: "GET",
              url: `${jiraOrigin}/rest/api/3/issue/${id}?fields=summary`,
            }),
          );
        } catch {
          // An unreadable issue stays unresolved and is reported as unlinked.
        }
    }
    for (const issue of issues)
      resolved.set(String(issue.id), { key: issue.key, summary: issue.fields?.summary ?? "" });
  }
  return resolved;
}

function taskKeys(text: string, exclude: string): string[] {
  const keys = [...text.matchAll(TASK_KEYS)].map((m) => m[1]!).filter((key) => key !== exclude);
  return [...new Set(keys)].slice(0, MAX_KEYS_PER_PLAN);
}
/**
 * Decides which tasks a plan is for. A plan on a helpdesk ticket is that Jira ticket. Any other plan names its
 * tasks: first the keys in the plan's description (plans on a generic "Odoo project task" issue), then the keys in
 * the Jira summary. Returns no identifiers when neither names a task.
 */
export function classifyPlannedIssue(
  issue: { key: string; summary: string },
  helpdeskPrefix: string,
  planDescription = "",
): string[] {
  if (issue.key.startsWith(helpdeskPrefix)) return [issue.key];
  const fromPlan = taskKeys(planDescription, issue.key);
  return fromPlan.length ? fromPlan : taskKeys(issue.summary, issue.key);
}

export async function collectPlanning(input: {
  tempo: TempoPlanningSource;
  jira: ScopedHttp;
  jiraOrigin: string;
  helpdeskPrefix: string;
  accountId: string;
  from: string;
  to: string;
}): Promise<PlanningResult> {
  const planned = await input.tempo.listPlanned({
    accountId: input.accountId,
    from: input.from,
    to: input.to,
  });
  const issues = await resolveJiraIssues(
    input.jira,
    input.jiraOrigin,
    planned.map((p) => p.issueId),
  );
  const targets = new Map<string, PlannedTarget>();
  const unlinked: string[] = [];
  for (const plan of planned) {
    const issue = issues.get(plan.issueId);
    const identifiers = issue ? classifyPlannedIssue(issue, input.helpdeskPrefix, plan.description) : [];
    if (!issue || !identifiers.length) {
      const label = plan.description.replace(/\s+/g, " ").trim().slice(0, 80);
      unlinked.push(`${issue?.key ?? `issue ${plan.issueId}`}${label ? `: ${label}` : ""}`);
      continue;
    }
    // One task may be planned by several plans and one plan may name several tasks; merge per task.
    for (const identifier of identifiers) {
      const prior = targets.get(identifier)?.planning;
      const dates = mergeDates([...(prior?.dates ?? []), ...plan.dates]);
      targets.set(identifier, {
        identifier,
        planning: {
          plannedFor: dates[0]?.date ?? null,
          dates,
          jiraKey: [...new Set([...(prior?.jiraKey.split(",") ?? []), issue.key])].sort().join(","),
          planIds: [...new Set([...(prior?.planIds ?? []), plan.planId])].sort(),
        },
      });
    }
  }
  return { planned: planned.length, targets: [...targets.values()], unlinked: unlinked.sort() };
}
