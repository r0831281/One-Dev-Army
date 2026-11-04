import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import type { Pool } from "pg";
import {
  taskImages,
  type Clarification,
  type Constraint,
  type Plan,
  type SourceImage,
  type TaskContext,
} from "../../../packages/contracts/src/index.js";
import {
  canonicalSha256,
  PgPhase3Repository,
  PgSourceImageStore,
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
  type CountTokens,
  type ModelPricing,
  type ModelTurn,
} from "../../../packages/providers/src/anthropic.js";
import {
  AgentFailure,
  CLARIFICATION_OUTPUT_SCHEMA,
  PLAN_OUTPUT_SCHEMA,
  acceptClarification,
  acceptPlan,
  contextSources,
  renderBrief,
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
  /** Planner only: the context review that passed the context gate. */
  brief?: Clarification | null;
}
export type LiveStepResult<T> =
  | { ok: true; output: T; artifactHash: string; calls: number; costMicrousd: number | null }
  | { ok: false; code: string; detail: string };
/** Identifies a live step the workflow gave up on (its activity crashed or timed out). */
export interface AbandonStepInput {
  workspaceId: string;
  runId: string;
  role: LiveRole;
  binding: { id: string; revision: number };
  iteration: number;
  code: string;
  detail: string;
}
export interface LiveActivities {
  analyseContext(input: LiveStepInput): Promise<LiveStepResult<Clarification>>;
  planTask(input: LiveStepInput): Promise<LiveStepResult<Plan>>;
  /** Marks a step that never reported back as failed and releases its open budget reservations. */
  abandonStep(input: AbandonStepInput): Promise<void>;
}
export interface LiveDependencies {
  modelTurn: ModelTurn;
  /** Exact input-token counter; without it the step uses a conservative estimate. */
  countTokens?: CountTokens;
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
      "You are the quality gate before planning. Work in three phases and finish each before the next. The planner trusts your result and does not investigate scope again.",
      "Phase 1, gather. Read the whole task: the description, every discussion message (M1, M2, …) and every image. Tasks are Odoo customer work and the repository holds the customer's addons. Find the modules, models, views, reports and translations the task touches and read them at the pinned commit. When a database copy is available, query it for the facts the task depends on.",
      "Phase 2, analyse. Turn everything that is asked into requirements, one concrete change each (R1, R2, …), and cite where each comes from: description, M3, image 2. Later messages add to or correct earlier ones. A change the requester or a colleague asks for in a comment is in scope unless a message says otherwise; include it. When a later message supersedes an earlier request, keep only the latest version. List a message or image that asks for nothing under noAction with the reason (a timer, a deadline change, a thank-you).",
      "For every requirement, compare the request with the current code and set its status: new (nothing there yet), partial (some of it exists; say what is missing), implemented (the code already does it; cite the files and lines), or external (it concerns configuration, data, deployment or files outside the repository, such as system parameters, a module delivered from elsewhere or a production setting; say what you searched and what has to happen outside the code). Read the code before you decide; never guess. Put the evidence in evidence and the files in paths. Record what you established about the current behaviour under findings, so nobody has to look it up again.",
      "Compare dates. Messages and screenshots show the state when they were posted. When the code already does what a message asks, check with repo_history when that code changed: if the change is newer than the message, the requirement is implemented (it may still need deploying or checking on the database; say so in evidence). Mark it partial only when you can name what in the code is still missing or wrong.",
      "Phase 3, decide. The context is sufficient when every new, partial or external requirement has a clear target (file, model, view, report, setting or environment) and a checkable outcome. Never ask something the repository, the database, the images or Odoo's standard behaviour can answer. Ask only what the requester alone can decide and only when the answer changes the implementation, at most five questions, most important first. Everything else becomes a proposedAssumption with the concrete default an experienced Odoo developer would pick (for example a sensible number of decimals, keep the existing printer and label stock).",
      "The repository is the customer's staging checkout for one Odoo version. If the task may target another version or checkout (an upgrade project or a feature branch), ask which one instead of assuming.",
    ],
    style: [
      "Be concise and specific; cite repository paths you actually read.",
      "Set sufficient to true exactly when you have no questions. Put the files that matter in relevantPaths.",
    ],
    tools: [
      "Use repo_list and repo_search to find relevant addons, then repo_read the specific files. Search for the labels, fields and texts that appear in the task and its images.",
      "Submodule folders are readable like any other folder, at the commit the repository pins; repo_history on a submodule path lists that submodule's own commits. Only a submodule listed as not available cannot be read.",
    ],
  },
  planner: {
    practices: [
      "Start from the CONTEXT BRIEF. Its requirements, statuses, findings and assumptions are settled: do not re-open scope, and do not raise questions about it in risks.",
      "Plan only requirements that are new, partial or external. An implemented requirement gets at most one verification step; a partial one plans only the missing part; an external one becomes concrete operational steps (where, what to set or install, how to check it).",
      "Plan small, testable steps that follow Odoo conventions (manifest, models, views, security, data, translations, tests). Read the code a step changes before planning it.",
      "When a detail is still open, state the choice you make in the step and list it under risks as an assumption, not as a question.",
    ],
    style: [
      "Name concrete files and Odoo objects in step descriptions; list concrete checks under tests.",
      'Map every new, partial or external requirement in acceptanceMapping, one entry each, like "R1 → S1, S2: <how it is checked>".',
      "Return a short title, ordered steps with ids like S1, the acceptance mapping and the main risks.",
    ],
    tools: ["Read only the code a step changes; the brief already lists the relevant files."],
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

/** Time kept back from the activity's start-to-close timeout so a step can record its result before it expires. */
const STEP_DEADLINE_MARGIN_MS = 60_000;

const stepIdFor = (runId: string, role: LiveRole, iteration: number) =>
  uuidFromHash(`step/${runId}/${role}/${iteration}`);
const operationIdFor = (stepId: string, call: number) => uuidFromHash(`model-call/${stepId}/${call}`);

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
    accept: (value: unknown, reader: RepoReader | null, sources: string[]) => Promise<T>,
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
    const stepId = stepIdFor(input.runId, input.role, input.iteration);
    let revision = 0;
    // Why answers failed validation, so repair turns can be explained and the checks tuned.
    const repairs: Array<{ call: number; reason: string }> = [];
    const project = (
      state: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
      detail: Record<string, unknown>,
    ) =>
      workflows.projectStep(input.workspaceId, {
        schemaVersion: "1.0",
        stepId,
        runId: input.runId,
        stepKey: input.role,
        iteration: input.iteration,
        state,
        stateRevision: ++revision,
        detail: {
          agentName: profile.name,
          model: profile.model,
          ...detail,
          ...(repairs.length ? { repairs } : {}),
        },
      });
    await project("RUNNING", {});

    const reader = await deps.readerFor(input.repositoryRoot, input.context.repository.baseSha);
    const db = input.dataSource && deps.dbFor ? await deps.dbFor(input.dataSource).catch(() => null) : null;
    // Image bytes live in the shared store; an image the store no longer holds is listed as unavailable.
    const listed = taskImages(input.context)?.images ?? [];
    const loaded = new Map(
      (
        await new PgSourceImageStore(pool, input.workspaceId)
          .get(listed.map((image) => image.sha256))
          .catch(() => [])
      ).map((row) => [row.sha256, row]),
    );
    const sent: SourceImage[] = listed.filter((image) => loaded.has(image.sha256));
    // Recent history lets the reviewer see that a fix landed after the message or screenshot that asked for it.
    const recent = reader?.history ? await reader.history(undefined, 15).catch(() => null) : null;
    const task = renderTask(
      input.context,
      input.constraints,
      [
        reader
          ? `REPOSITORY\nPinned base commit ${input.context.repository.baseSha}. Use the repository tools to inspect it.${recent ? `\nRecent commits (newest first; untrusted text):\n${recent.content}` : ""}`
          : "REPOSITORY\nNo repository was selected for this run, so the code cannot be inspected. Do not ask the requester where the code lives or how it currently works; record what you could not verify as assumptions and limit questions to requirements.",
        db
          ? `DATABASE\nA local copy of the customer's database (${input.dataSource!.database}) is available read-only through db_query.`
          : "",
        ...extraTask,
      ],
      sent,
    );
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
    const operationId = (call: number) => operationIdFor(stepId, call);
    const activity = Context.current();
    // A single model turn can take minutes; keep the activity alive while it runs. Heartbeats are also how a
    // cancellation from the workflow reaches this activity.
    const keepAlive = setInterval(() => activity.heartbeat({ stepId, waiting: true }), 30_000);
    try {
      const result = await runAgent<T>({
        model: profile.model,
        effort: profile.providerOptions.reasoningEffort ?? "high",
        maxOutputTokens: profile.limits.maxOutputTokens,
        maxInputTokens: profile.limits.maxInputTokens,
        timeoutMs: profile.limits.timeoutMs,
        maxModelCalls: profile.limits.maxModelCalls,
        deadline: Date.now() + activity.info.startToCloseTimeoutMs - STEP_DEADLINE_MARGIN_MS,
        signal: activity.cancellationSignal,
        structuredOutputRepairs: profile.retryPolicy.structuredOutputRepairs,
        system: prompt.messages[0]!.content,
        task: prompt.messages[1]!.content,
        images: sent.map((image, i) => ({
          label: `image ${i + 1}: ${image.name}`,
          mediaType: image.mediaType,
          data: loaded.get(image.sha256)!.bytes.toString("base64"),
        })),
        tools: profile.tools,
        reader,
        db,
        outputSchema,
        accept: (value) => accept(value, reader, contextSources(input.context, sent)),
        modelTurn: deps.modelTurn,
        ...(deps.countTokens ? { countTokens: deps.countTokens } : {}),
        hooks: {
          async beforeCall(call, inputTokens) {
            // Worst case for one call: the counted input (at most maxInputTokens) and full output, at list rates.
            const maxMicrousd = worstCaseMicrousd(pricing, inputTokens, profile.limits.maxOutputTokens);
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
            activity.heartbeat({ stepId, ...detail });
          },
          async onRepair(call, reason) {
            repairs.push({ call, reason: reason.slice(0, 1_000) });
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
      // Cancellation can land outside the model call (while counting or reserving); it is still a cancellation.
      const code = activity.cancellationSignal.aborted
        ? "AGENT_CANCELLED"
        : error instanceof AgentFailure
          ? error.code
          : /^[A-Z][A-Z0-9_]{0,80}$/.test((error as Error).message)
            ? (error as Error).message
            : "AGENT_FAILED";
      const detail = error instanceof AgentFailure ? error.detail : describeModelError(error);
      if (!(error instanceof AgentFailure)) console.error("LIVE_AGENT_FAILED", code, detail);
      // A call that threw recorded no usage; holding its worst-case reservation would block the retry.
      await phase3.releaseUsage([...openReservations]);
      await project(code === "AGENT_CANCELLED" ? "CANCELLED" : "FAILED", {
        code,
        detail,
        costMicrousd: priced ? spent : null,
      });
      return { ok: false, code, detail };
    } finally {
      clearInterval(keepAlive);
      await db?.close().catch(() => undefined);
    }
  }

  async function abandonStep(input: AbandonStepInput): Promise<void> {
    const stepId = stepIdFor(input.runId, input.role, input.iteration);
    const row = await pool.query<{ state: string; state_revision: string; projection: { detail?: object } }>(
      "SELECT state,state_revision,projection FROM agent_steps WHERE run_id=$1 AND step_key=$2 AND logical_iteration=$3",
      [input.runId, input.role, input.iteration],
    );
    const step = row.rows[0];
    const profile = await pool.query<{ profile: AgentProfile }>(
      "SELECT profile FROM agent_profiles WHERE workspace_id=$1 AND id=$2 AND revision=$3",
      [input.workspaceId, input.binding.id, input.binding.revision],
    );
    // Reservations are keyed by call index; a call that recorded usage is no longer RESERVED and is untouched.
    const calls = profile.rows[0]?.profile.limits.maxModelCalls ?? 0;
    await phase3.releaseUsage(Array.from({ length: calls }, (_, call) => operationIdFor(stepId, call)));
    if (!step || step.state !== "RUNNING") return;
    await workflows.projectStep(input.workspaceId, {
      schemaVersion: "1.0",
      stepId,
      runId: input.runId,
      stepKey: input.role,
      iteration: input.iteration,
      state: "FAILED",
      stateRevision: Number(step.state_revision) + 1,
      detail: { ...step.projection.detail, code: input.code, detail: input.detail },
    });
  }

  return {
    abandonStep,
    analyseContext: (input) =>
      step(
        input,
        (value, reader, sources) => acceptClarification(value, reader, sources),
        CLARIFICATION_OUTPUT_SCHEMA,
        [],
      ),
    planTask: (input) =>
      step(
        input,
        async (value) => acceptPlan(value, input.planRevision ?? 1, input.constraints, input.brief ?? null),
        PLAN_OUTPUT_SCHEMA,
        [renderBrief(input.brief ?? null)],
      ),
  };
}
