import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import type { Pool } from "pg";
import type { Clarification, Constraint, Plan, TaskContext } from "../../../packages/contracts/src/index.js";
import {
  canonicalSha256,
  PgPhase3Repository,
  PgWorkflowRepository,
} from "../../../packages/persistence/src/index.js";
import {
  compilePrompt,
  hashPromptValue,
  type AgentProfile,
  type SoulSpec,
} from "../../../packages/prompt-compiler/src/index.js";
import {
  ANTHROPIC_PRICING,
  anthropicUsage,
  costMicrousd,
  worstCaseMicrousd,
  type ModelPricing,
  type ModelTurn,
} from "../../../packages/providers/src/anthropic.js";
import {
  AgentFailure,
  CLARIFICATION_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  acceptClarification,
  acceptPlan,
  renderTask,
  runAgent,
  type DbReader,
  type RepoReader,
} from "./live-agent.js";

export type LiveRole = "context-reviewer" | "planner";
export interface LiveStepInput {
  workspaceId: string;
  runId: string;
  role: LiveRole;
  binding: { id: string; revision: number };
  context: TaskContext;
  repositoryRoot: string;
  constraints: Constraint[];
  /** 1-based attempt of this role within the run (re-reviews and re-plans increase it). */
  iteration: number;
  planRevision?: number;
  /** Present only when the user allowed read-only queries against a local database copy. */
  dataSource?: { environmentPath: string; database: string };
}
export type LiveStepResult<T> =
  | { ok: true; output: T; artifactHash: string; calls: number; costMicrousd: number | null }
  | { ok: false; code: string; detail: string };
export interface LiveActivities {
  analyseContext(input: LiveStepInput): Promise<LiveStepResult<Clarification>>;
  planTask(input: LiveStepInput): Promise<LiveStepResult<Plan>>;
}
export interface LiveDependencies {
  modelTurn: ModelTurn;
  readerFor(root: string, baseSha: string): Promise<RepoReader | null>;
  /** Opens a read-only query connection; the caller closes it when the step ends. */
  dbFor?(source: {
    environmentPath: string;
    database: string;
  }): Promise<(DbReader & { close(): Promise<void> }) | null>;
}

function uuidFromHash(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const ROLE_GUIDANCE: Record<LiveRole, { practices: string[]; style: string[]; tools: string[] }> = {
  "context-reviewer": {
    practices: [
      "Tasks are Odoo customer work; the repository holds Odoo addons. Locate the modules, models, views and reports the task touches before judging it.",
      "Investigate before asking. Never ask something the repository, the database or Odoo's standard behaviour can answer (which module, which field, current format, printer flow); look it up and cite it.",
      "Ask only what the requester alone can decide, such as business choices with no sensible default or a missing attachment, and only when the answer changes the implementation. Ask at most five questions, most important first.",
      "Turn everything else into a proposedAssumption with a concrete default an experienced Odoo developer would pick (for example: keep the existing printer and label stock, use the delivery address, ISO country name in the partner's language, wrap long lines). The requester can correct an assumption cheaply.",
      "The repository is the customer's staging checkout for one Odoo version. If the task may target another version or checkout (for example an upgrade project prepared next to the current version, or a feature branch), ask which one instead of assuming.",
    ],
    style: [
      "Be concise and specific; cite repository paths you actually read.",
      "Set sufficient to true only if a developer could implement the task without asking anything; otherwise list the questions. Put safe defaults in proposedAssumptions and the files that matter in relevantPaths.",
    ],
    tools: ["Use repo_list and repo_search to find relevant addons, then repo_read the specific files."],
  },
  planner: {
    practices: [
      "Plan small, testable steps that follow Odoo conventions (manifest, models, views, security, data, tests).",
      "Map every acceptance criterion, or the task description when there are none, to at least one step.",
    ],
    style: [
      "Name concrete files and Odoo objects in step descriptions; list concrete checks under tests.",
      "Return a short title, ordered steps with ids like step-1, the acceptance mapping and the main risks.",
    ],
    tools: ["Read the code a step changes before planning it."],
  },
};

/**
 * A short, secret-free description of an unexpected failure. Anthropic API errors carry an HTTP status, a
 * request id and the API's own message, which never includes the key; anything else keeps only its class and
 * first line, with credentials in connection strings masked.
 */
export function describeModelError(error: unknown): string {
  const value = error as {
    status?: unknown;
    requestID?: unknown;
    request_id?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const message = String(value?.message ?? "")
    .split("\n")[0]!
    .replace(/(\w+:\/\/)[^@\s/]+@/g, "$1***@")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-***")
    .slice(0, 500);
  const requestId = value?.requestID ?? value?.request_id;
  if (typeof value?.status === "number")
    return `Anthropic API ${value.status}${requestId ? ` (request ${String(requestId)})` : ""}: ${message}`;
  return `${String(value?.name ?? "Error")}: ${message || "no message"}`;
}

async function loadSoul(role: LiveRole, outputSchemaRef: string): Promise<SoulSpec> {
  const roles = JSON.parse(
    await readFile(join(process.cwd(), "packages", "prompt-compiler", "templates", "roles.json"), "utf8"),
  ) as Record<string, { identity: string; objective: string }>;
  const guidance = ROLE_GUIDANCE[role];
  return {
    identity: roles[role]!.identity,
    objective: roles[role]!.objective,
    domainPractices: guidance.practices,
    workingStyle: guidance.style,
    toolGuidance: guidance.tools,
    outputSchemaRef,
  };
}

export function createLiveActivities(pool: Pool, deps: LiveDependencies): LiveActivities {
  const phase3 = new PgPhase3Repository(pool);
  const workflows = new PgWorkflowRepository(pool);

  async function pricingSnapshot(pricing: ModelPricing): Promise<string> {
    const id = uuidFromHash(`pricing/${pricing.snapshotId}`);
    await pool.query(
      "INSERT INTO pricing_snapshots(id,provider,model,currency,prices,effective_at) VALUES($1,'anthropic',$2,'USD',$3,'2026-10-06T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      [id, pricing.model, pricing],
    );
    return id;
  }

  async function step<T>(
    input: LiveStepInput,
    accept: (value: unknown, reader: RepoReader | null) => Promise<T>,
    outputSchema: Record<string, unknown>,
    extraTask: string[],
  ): Promise<LiveStepResult<T>> {
    const row = await pool.query<{ profile: AgentProfile }>(
      "SELECT profile FROM agent_profiles WHERE workspace_id=$1 AND id=$2 AND revision=$3",
      [input.workspaceId, input.binding.id, input.binding.revision],
    );
    const profile = row.rows[0]?.profile;
    if (!profile || profile.provider !== "anthropic")
      return {
        ok: false,
        code: "PROVIDER_UNAVAILABLE",
        detail: `${input.role} profile is not an Anthropic profile`,
      };
    const pricing = ANTHROPIC_PRICING[profile.model];
    if (!pricing) return { ok: false, code: "UNPRICED_MODEL", detail: `No pricing for ${profile.model}` };
    const pricingSnapshotId = await pricingSnapshot(pricing);
    const stepId = uuidFromHash(`step/${input.runId}/${input.role}/${input.iteration}`);
    let revision = 0;
    const project = (state: "RUNNING" | "COMPLETED" | "FAILED", detail: Record<string, unknown>) =>
      workflows.projectStep(input.workspaceId, {
        schemaVersion: "1.0",
        stepId,
        runId: input.runId,
        stepKey: input.role,
        iteration: input.iteration,
        state,
        stateRevision: ++revision,
        detail: { agentName: profile.name, model: profile.model, ...detail },
      });
    await project("RUNNING", {});

    const reader = await deps.readerFor(input.repositoryRoot, input.context.repository.baseSha);
    const db = input.dataSource && deps.dbFor ? await deps.dbFor(input.dataSource).catch(() => null) : null;
    const task = renderTask(input.context, input.constraints, [
      reader
        ? `REPOSITORY\nPinned base commit ${input.context.repository.baseSha}. Use the repository tools to inspect it.`
        : "REPOSITORY\nNo repository was selected for this run, so the code cannot be inspected. Do not ask the requester where the code lives or how it currently works; record what you could not verify as assumptions and limit questions to requirements.",
      db
        ? `DATABASE\nA local copy of the customer's database (${input.dataSource!.database}) is available read-only through db_query.`
        : "",
      ...extraTask,
    ]);
    const prompt = await compilePrompt({
      profile,
      soul: await loadSoul(input.role, profile.outputSchemaRef),
      baseSha: input.context.repository.baseSha,
      approvedPlanHash: null,
      constraints: input.constraints.map((c) => `[${c.origin}] ${c.text}`),
      effectiveTools: profile.tools.filter((tool) =>
        tool === "db.query" ? Boolean(db) : tool.startsWith("repo.") ? Boolean(reader) : true,
      ),
      remainingLimits: {
        maxModelCalls: profile.limits.maxModelCalls,
        maxOutputTokens: profile.limits.maxOutputTokens,
      },
      schemaHash: hashPromptValue(outputSchema),
      policyHash: hashPromptValue({ role: input.role, tools: profile.tools }),
      taskContent: task,
    });

    let spent = 0;
    // Reservations of calls that have not produced usage yet; released if the step fails.
    const openReservations = new Set<string>();
    let priced = true;
    const operationId = (call: number) => uuidFromHash(`model-call/${stepId}/${call}`);
    // A single model turn can take minutes; keep the activity alive while it runs.
    const keepAlive = setInterval(() => Context.current().heartbeat({ stepId, waiting: true }), 30_000);
    try {
      const result = await runAgent<T>({
        model: profile.model,
        effort: profile.providerOptions.reasoningEffort ?? "high",
        maxOutputTokens: profile.limits.maxOutputTokens,
        timeoutMs: profile.limits.timeoutMs,
        maxModelCalls: profile.limits.maxModelCalls,
        structuredOutputRepairs: profile.retryPolicy.structuredOutputRepairs,
        system: prompt.messages[0]!.content,
        task: prompt.messages[1]!.content,
        tools: profile.tools,
        reader,
        db,
        outputSchema,
        accept: (value) => accept(value, reader),
        modelTurn: deps.modelTurn,
        hooks: {
          async beforeCall(call) {
            // Worst case for one call: full output plus a generous input allowance, priced at list rates.
            const maxMicrousd = worstCaseMicrousd(
              pricing,
              profile.limits.maxInputTokens,
              profile.limits.maxOutputTokens,
            );
            await phase3.reserveUsage({
              operationId: operationId(call),
              runId: input.runId,
              maxMicrousd,
              expiresAt: new Date(Date.now() + profile.limits.timeoutMs + 60_000).toISOString(),
            });
            openReservations.add(operationId(call));
          },
          async afterCall(call, message) {
            const usage = anthropicUsage(message);
            const amount = costMicrousd(usage, pricing);
            if (amount === null) priced = false;
            else spent += amount;
            await phase3.appendUsage({
              attemptId: uuidFromHash(`model-attempt/${stepId}/${call}`),
              operationId: operationId(call),
              runId: input.runId,
              stepId,
              provider: "anthropic",
              model: message.model,
              category: "model",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              reasoningTokens: null,
              amountMicrousd: amount,
              pricingSnapshotId: amount === null ? null : pricingSnapshotId,
              usage: {
                agentName: profile.name,
                agentId: profile.id,
                role: input.role,
                call,
                stopReason: message.stop_reason,
                messageId: message.id,
                pricingStatus: amount === null ? "UNPRICED" : "PRICED",
              },
              observedAt: new Date().toISOString(),
            });
            openReservations.delete(operationId(call));
            await project("RUNNING", { calls: call + 1, costMicrousd: priced ? spent : null });
          },
          heartbeat(detail) {
            Context.current().heartbeat({ stepId, ...detail });
          },
        },
      });
      const artifactHash = canonicalSha256(result.output as never);
      await project("COMPLETED", { calls: result.calls, costMicrousd: priced ? spent : null, artifactHash });
      return {
        ok: true,
        output: result.output,
        artifactHash,
        calls: result.calls,
        costMicrousd: priced ? spent : null,
      };
    } catch (error) {
      const code =
        error instanceof AgentFailure
          ? error.code
          : /^[A-Z][A-Z0-9_]{0,80}$/.test((error as Error).message)
            ? (error as Error).message
            : "AGENT_FAILED";
      const detail = error instanceof AgentFailure ? error.detail : describeModelError(error);
      if (!(error instanceof AgentFailure)) console.error("LIVE_AGENT_FAILED", code, detail);
      // A call that threw recorded no usage; holding its worst-case reservation would block the retry.
      await phase3.releaseUsage([...openReservations]);
      await project("FAILED", { code, detail, costMicrousd: priced ? spent : null });
      return { ok: false, code, detail };
    } finally {
      clearInterval(keepAlive);
      await db?.close().catch(() => undefined);
    }
  }

  return {
    analyseContext: (input) =>
      step(input, (value, reader) => acceptClarification(value, reader), CLARIFICATION_OUTPUT_SCHEMA, []),
    planTask: (input) =>
      step(
        input,
        async (value) => acceptPlan(value, input.planRevision ?? 1, input.constraints),
        PLAN_OUTPUT_SCHEMA,
        [],
      ),
  };
}
