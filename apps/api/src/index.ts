import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apiError, type TaskContext } from "../../../packages/contracts/src/index.js";
import {
  TEMPO_PLANNING_EXTENSION,
  verifyWebhook,
  type ConnectorContext,
  type TaskConnector,
  type TaskPlanning,
} from "../../../packages/connectors/src/index.js";
import { MemoryTaskRepository, canonicalSha256 } from "../../../packages/persistence/src/index.js";
import {
  previewRoute,
  resolveRoute,
  type RouteInput,
  type RoutingRule,
} from "../../../packages/routing/src/index.js";
import { createRunManifest, type RunControlService } from "./control.js";
import type { ProfileRegistry } from "../../../packages/agents/src/index.js";
import type { AgentProfile, CompileInput } from "../../../packages/prompt-compiler/src/index.js";
import { DEFAULT_HORIZON, horizonEligibility, horizonWindow, type HorizonSettings } from "./horizon.js";
import type { PlanningSourceBinding, WorkspaceConfiguration } from "./configuration.js";
import { suggestEnvironment, type WorkEnvironments } from "./environments.js";
import { collectPlanning } from "../../../packages/connectors/src/tempo.js";
import type { OperationsPolicy } from "../../../packages/persistence/src/operations.js";
import dashboardAssets from "../../dashboard/assets.json" with { type: "json" };
const assets: Record<string, string> = dashboardAssets;

export interface IngestionDependencies {
  rules: RoutingRule[];
  connectors: Map<string, TaskConnector>;
  connectorContexts: Map<string, ConnectorContext>;
  repository: MemoryTaskRepository;
  planningSources?: PlanningSourceBinding[];
  /** Repository that claims a task key's prefix; overrides the connector's repository when present. */
  resolveRepository?: (key: string) => Promise<{ id: string; baseSha: string } | null>;
  persist?: (
    context: TaskContext,
    deliveryId: string | null,
  ) => Promise<{ receipt: ReturnType<MemoryTaskRepository["ingest"]>; context: TaskContext }>;
}
export class IngestionService {
  private lastPlanningSync: {
    lastCheckedAt: string | null;
    checked: number;
    updated: number;
    failed: number;
    skipped: number;
    planned: number;
    ingested: number;
    unlinked: string[];
    failures: Array<{ identifier: string; code: string }>;
  } = {
    lastCheckedAt: null,
    checked: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
    ingested: 0,
    unlinked: [],
    failures: [],
  };
  /** Planning from the last complete Tempo sync, keyed by task source key; null when it was incomplete. */
  private currentPlanning: Map<string, TaskPlanning> | null = null;
  constructor(private readonly dependencies: IngestionDependencies) {}
  private async store(task: TaskContext, deliveryId: string | null = null) {
    if (this.dependencies.persist) {
      const stored = await this.dependencies.persist(task, deliveryId);
      this.dependencies.repository.restore([stored.context]);
      return stored;
    }
    const receipt = this.dependencies.repository.ingest(task, deliveryId);
    return {
      receipt,
      context: this.dependencies.repository.getContext(receipt.taskId, receipt.contextRevision)!,
    };
  }
  preview(input: RouteInput) {
    return previewRoute(this.dependencies.rules, input);
  }
  async ingestIdentifier(
    identifier: string,
    planning: TaskPlanning | undefined = this.planningFor(identifier),
  ): Promise<{ receipt: ReturnType<MemoryTaskRepository["ingest"]>; context: TaskContext }> {
    const rule = resolveRoute(this.dependencies.rules, { kind: "identifier", value: identifier });
    const connector = this.dependencies.connectors.get(rule.pluginInstanceId);
    const context = this.dependencies.connectorContexts.get(rule.pluginInstanceId);
    if (!connector || !context) throw new Error("CONNECTOR_NOT_CONFIGURED");
    const ref = connector.normalize(identifier);
    const task = await connector.fetchTask(ref, {
      ...context,
      ...(await this.repositoryFor(ref.key)),
      fetchedAt: new Date().toISOString(),
      ...(planning ? { planning } : {}),
    });
    return this.store(task);
  }
  private async repositoryFor(
    key: string,
  ): Promise<{ repository?: { id: string; baseSha: string }; repositoryPinned?: true }> {
    const repository = await this.dependencies.resolveRepository?.(key);
    return repository ? { repository, repositoryPinned: true } : {};
  }
  /** Re-fetches a task pinned to the given repository commit, creating a new context revision when it moved. */
  async repin(taskId: string, repository: { id: string; baseSha: string }) {
    const current = this.dependencies.repository.getContext(taskId);
    if (!current) throw new Error("NOT_FOUND");
    const connector = this.dependencies.connectors.get(current.source.instanceId);
    const context = this.dependencies.connectorContexts.get(current.source.instanceId);
    if (!connector || !context) throw new Error("CONNECTOR_NOT_CONFIGURED");
    const planning = this.planningFor(current.source.key);
    const task = await connector.fetchTask(
      { externalId: current.source.externalId, key: current.source.key },
      {
        ...context,
        repository,
        repositoryPinned: true,
        fetchedAt: new Date().toISOString(),
        ...(planning ? { planning } : {}),
      },
    );
    return this.store(task);
  }
  /** Current Tempo planning for a source key, falling back to what the stored task already carries. */
  private planningFor(key: string): TaskPlanning | undefined {
    if (this.currentPlanning) return this.currentPlanning.get(key);
    const stored = this.dependencies.repository.list().find((task) => task.source.key === key)?.extensions?.[
      TEMPO_PLANNING_EXTENSION
    ];
    return stored ? (stored as TaskPlanning) : undefined;
  }
  /** Reads the Tempo plan for the window and ingests every planned helpdesk ticket and Odoo task. */
  async syncPlanning(window: { from: string; to: string }) {
    const result = {
      planned: 0,
      ingested: 0,
      unlinked: [] as string[],
      failures: [] as Array<{ identifier: string; code: string }>,
      touched: new Set<string>(),
    };
    const sources = this.dependencies.planningSources ?? [];
    if (!sources.length) return result;
    const current = new Map<string, TaskPlanning>();
    let complete = true;
    for (const source of sources) {
      let planning;
      try {
        planning = await collectPlanning({ ...source, ...window });
      } catch (error) {
        complete = false;
        result.failures.push({ identifier: `tempo:${source.accountId}`, code: errorCode(error) });
        continue;
      }
      result.planned += planning.planned;
      result.unlinked.push(...planning.unlinked);
      for (const target of planning.targets) {
        current.set(target.identifier, target.planning);
        try {
          const stored = await this.ingestIdentifier(target.identifier, target.planning);
          result.touched.add(stored.receipt.taskId);
          if (!stored.receipt.duplicate) result.ingested++;
        } catch (error) {
          result.failures.push({ identifier: target.identifier, code: errorCode(error) });
        }
      }
    }
    // Only a complete sync may clear planning from tasks that are no longer planned.
    this.currentPlanning = complete ? current : null;
    return result;
  }
  /** One planning cycle: Tempo discovery first, then a refresh of every other known task. */
  async sync(window: { from: string; to: string }) {
    const planning = await this.syncPlanning(window);
    await this.refreshTasks(planning.touched);
    this.lastPlanningSync = {
      ...this.lastPlanningSync,
      planned: planning.planned,
      ingested: planning.ingested,
      unlinked: planning.unlinked.sort(),
      failures: planning.failures,
    };
    return this.planningSyncStatus();
  }
  async ingestWebhook(
    route: string,
    rawBody: Buffer,
    headers: { signature: string; timestamp: string; deliveryId: string },
    secret: Buffer,
  ): Promise<{ receipt: ReturnType<MemoryTaskRepository["ingest"]>; context: TaskContext }> {
    if (!headers.deliveryId || headers.deliveryId.length > 200) throw new Error("INVALID_DELIVERY_ID");
    verifyWebhook(rawBody, headers.signature, secret, headers.timestamp);
    const rule = resolveRoute(this.dependencies.rules, { kind: "webhook", value: route });
    const connector = this.dependencies.connectors.get(rule.pluginInstanceId);
    const context = this.dependencies.connectorContexts.get(rule.pluginInstanceId);
    if (!connector || !context) throw new Error("CONNECTOR_NOT_CONFIGURED");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("MALFORMED_JSON");
    }
    const task = await connector.fetchTask(connector.normalize(payload), {
      ...context,
      fetchedAt: new Date().toISOString(),
    });
    return this.store(task, headers.deliveryId);
  }
  listTasks() {
    return this.dependencies.repository.list();
  }
  getTask(taskId: string) {
    return this.dependencies.repository.getContext(taskId);
  }
  planningSyncStatus() {
    return { intervalMinutes: 30, ...this.lastPlanningSync };
  }
  async refreshTasks(alreadyFetched: ReadonlySet<string> = new Set()) {
    const tasks = this.dependencies.repository.list().filter((task) => !alreadyFetched.has(task.taskId));
    let updated = 0;
    let failed = 0;
    let checked = 0,
      skipped = 0;
    for (const task of tasks) {
      const connector = this.dependencies.connectors.get(task.source.instanceId);
      const connectorContext = this.dependencies.connectorContexts.get(task.source.instanceId);
      if (!connector || !connectorContext) {
        skipped++;
        continue;
      }
      checked++;
      try {
        const planning = this.planningFor(task.source.key);
        const context = await connector.fetchTask(
          { externalId: task.source.externalId, key: task.source.key },
          {
            ...connectorContext,
            ...(await this.repositoryFor(task.source.key)),
            fetchedAt: new Date().toISOString(),
            ...(planning ? { planning } : {}),
          },
        );
        if (!(await this.store(context)).receipt.duplicate) updated++;
      } catch {
        failed++;
      }
    }
    this.lastPlanningSync = {
      ...this.lastPlanningSync,
      lastCheckedAt: new Date().toISOString(),
      checked,
      updated,
      failed,
      skipped,
    };
    return this.planningSyncStatus();
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(code)) return code;
  const message = (error as Error).message;
  return /^[A-Z][A-Z0-9_]{0,80}$/.test(message) ? message : "CONNECTOR_FAILED";
}

export interface ApiOptions {
  service: IngestionService;
  sessionToken?: string;
  csrfToken?: string;
  webhookSecret?: Buffer;
  maxBodyBytes?: number;
  runControl?: RunControlService;
  profiles?: ProfileRegistry;
  telemetry?: () => Promise<unknown>;
  configuration?: WorkspaceConfiguration;
  environments?: WorkEnvironments;
  events?: {
    snapshot(): Promise<unknown>;
    history(after: number, limit: number): Promise<unknown>;
  };
}
export function createLocalApi(options: ApiOptions) {
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url");
  const csrfToken = options.csrfToken ?? randomBytes(24).toString("base64url");
  const server = createServer(async (request, response) => {
    const requestId = createHash("sha256")
      .update(`${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 24);
    try {
      if (
        request.socket.remoteAddress &&
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
      )
        return json(response, 403, apiError("LOCAL_ONLY", "API only accepts loopback clients", requestId));
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        const dashboard = await readFile(resolve(process.cwd(), "apps/dashboard/index.html"), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
          "cache-control": "no-store",
        });
        response.end(dashboard);
        return;
      }
      if (request.method === "GET" && assets[url.pathname]) {
        response.writeHead(200, {
          "content-type": assets[url.pathname]!,
          "cache-control": "no-store",
        });
        response.end(await readFile(resolve(process.cwd(), "apps/dashboard", url.pathname.slice(1)), "utf8"));
        return;
      }
      if (url.pathname.startsWith("/api/v1/webhooks/")) {
        const body = await bodyBytes(request, 2 * 1024 * 1024);
        const result = await options.service.ingestWebhook(
          url.pathname,
          body,
          {
            signature: requiredHeader(request, "x-oda-signature"),
            timestamp: requiredHeader(request, "x-oda-timestamp"),
            deliveryId: requiredHeader(request, "x-oda-delivery-id"),
          },
          options.webhookSecret ?? Buffer.alloc(0),
        );
        return json(response, result.receipt.duplicate ? 200 : 201, result);
      }
      if (request.headers.authorization !== `Bearer ${sessionToken}`)
        return json(response, 401, apiError("UNAUTHORIZED", "Valid local session required", requestId));
      if (request.method === "POST" && request.headers["x-csrf-token"] !== csrfToken)
        return json(response, 403, apiError("CSRF_FAILED", "CSRF token required", requestId));
      if (options.runControl && url.pathname === "/api/v1/operations") {
        if (request.method === "GET")
          return json(response, 200, await options.runControl.operations.status());
        if (request.method === "POST") {
          await options.runControl.operations.save(
            await jsonBody<OperationsPolicy>(request, options.maxBodyBytes),
          );
          return json(response, 200, await options.runControl.operations.status());
        }
      }
      if (options.configuration) {
        if (url.pathname === "/api/v1/configuration" && request.method === "GET")
          return json(response, 200, await options.configuration.snapshot());
        if (options.environments) {
          const environments = options.environments;
          if (url.pathname === "/api/v1/environments" && request.method === "GET")
            return json(response, 200, {
              settings: await environments.settings(),
              environments: await environments.list(url.searchParams.get("refresh") === "1"),
            });
          if (url.pathname === "/api/v1/environments/settings" && request.method === "POST")
            return json(
              response,
              200,
              await environments.saveSettings(await jsonBody(request, options.maxBodyBytes)),
            );
          const envMatch = url.pathname.match(
            /^\/api\/v1\/environments\/([^/]+)\/(backups|restore|jobs|databases\/([^/]+)\/drop)$/,
          );
          if (envMatch) {
            const id = decodeURIComponent(envMatch[1]!);
            if (envMatch[2] === "backups" && request.method === "GET")
              return json(response, 200, { items: await environments.backups(id) });
            if (envMatch[2] === "jobs" && request.method === "GET")
              return json(response, 200, { items: environments.jobsFor(id) });
            if (envMatch[2] === "restore" && request.method === "POST")
              return json(
                response,
                202,
                await environments.restore(id, await jsonBody(request, options.maxBodyBytes)),
              );
            if (envMatch[3] && request.method === "POST") {
              const body = await jsonBody<{ confirm: string }>(request, options.maxBodyBytes);
              return json(
                response,
                200,
                await environments.dropScratch(id, decodeURIComponent(envMatch[3]), body.confirm),
              );
            }
          }
          const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
          if (jobMatch && request.method === "GET") {
            const job = environments.job(jobMatch[1]!);
            return job
              ? json(response, 200, job)
              : json(response, 404, apiError("NOT_FOUND", "Job not found", requestId));
          }
        }
        if (url.pathname === "/api/v1/repositories" && request.method === "POST")
          return json(
            response,
            201,
            await options.configuration.saveRepository(await jsonBody(request, options.maxBodyBytes)),
          );
        if (url.pathname === "/api/v1/connectors" && request.method === "POST")
          return json(
            response,
            201,
            await options.configuration.saveConnector(await jsonBody(request, options.maxBodyBytes)),
          );
        if (url.pathname === "/api/v1/assignments" && request.method === "POST")
          return json(
            response,
            200,
            await options.configuration.assign(await jsonBody(request, options.maxBodyBytes)),
          );
        if (url.pathname === "/api/v1/connectors/sync" && request.method === "POST")
          return json(
            response,
            200,
            await options.service.sync(
              horizonWindow(
                options.runControl ? await options.runControl.horizon.settings() : DEFAULT_HORIZON,
              ),
            ),
          );
      }
      if (options.runControl && url.pathname === "/api/v1/work-horizon") {
        if (request.method === "GET")
          return json(response, 200, {
            ...(await options.runControl.horizon.settings()),
            overrides: await options.runControl.horizon.overrides(),
          });
        if (request.method === "POST")
          return json(
            response,
            200,
            await options.runControl.horizon.save(
              await jsonBody<HorizonSettings>(request, options.maxBodyBytes),
            ),
          );
      }
      const horizonOverride = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/work-horizon$/);
      if (options.runControl && horizonOverride && request.method === "POST") {
        if (!options.service.getTask(horizonOverride[1]!))
          return json(response, 404, apiError("NOT_FOUND", "Task not found", requestId));
        const body = await jsonBody<{ allowed: boolean; reason: string }>(request, options.maxBodyBytes);
        await options.runControl.horizon.setOverride(horizonOverride[1]!, body.allowed, body.reason);
        return json(response, 200, { allowed: body.allowed });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/routing-rules/resolve-preview")
        return json(
          response,
          200,
          options.service.preview(await jsonBody<RouteInput>(request, options.maxBodyBytes)),
        );
      if (request.method === "POST" && url.pathname === "/api/v1/tasks/ingest") {
        const input = await jsonBody<{ identifier: string }>(request, options.maxBodyBytes);
        return json(response, 201, await options.service.ingestIdentifier(input.identifier));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
        const horizon = options.runControl ? await options.runControl.horizon.settings() : null;
        const overrides = options.runControl ? await options.runControl.horizon.overrides() : [];
        return json(response, 200, {
          items: options.service.listTasks().map((task) => ({
            ...task,
            ...(horizon
              ? { workEligibility: horizonEligibility(task, horizon, overrides.includes(task.taskId)) }
              : {}),
          })),
          workHorizon: horizon ? { ...horizon, overrides } : null,
          sync: options.service.planningSyncStatus(),
        });
      }
      const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        const task = options.service.getTask(taskMatch[1]!);
        return task
          ? json(response, 200, task)
          : json(response, 404, apiError("NOT_FOUND", "Task not found", requestId));
      }
      if (options.events && request.method === "GET" && url.pathname === "/api/v1/snapshot")
        return json(response, 200, await options.events.snapshot());
      if (options.telemetry && request.method === "GET" && url.pathname === "/api/v1/telemetry")
        return json(response, 200, await options.telemetry());
      if (options.events && request.method === "GET" && url.pathname === "/api/v1/events/history") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "500");
        return json(response, 200, await options.events.history(after, limit));
      }
      if (options.profiles) {
        if (request.method === "GET" && url.pathname === "/api/v1/profiles")
          return json(response, 200, { items: options.profiles.list() });
        if (request.method === "POST" && url.pathname === "/api/v1/profiles")
          return json(
            response,
            201,
            options.configuration
              ? await options.configuration.saveProfile(
                  await jsonBody<AgentProfile>(request, options.maxBodyBytes),
                )
              : options.profiles.create(await jsonBody<AgentProfile>(request, options.maxBodyBytes)),
          );
        const compileMatch = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/compile$/);
        if (request.method === "POST" && compileMatch) {
          const body = await jsonBody<Omit<CompileInput, "profile"> & { revision: number }>(
            request,
            options.maxBodyBytes,
          );
          const { revision, ...input } = body;
          return json(response, 201, await options.profiles.compile(compileMatch[1]!, revision, input));
        }
      }
      if (options.runControl) {
        const startMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/runs$/);
        if (request.method === "POST" && startMatch) {
          const idempotencyKey = requiredHeader(request, "idempotency-key");
          const body = await jsonBody<{
            manifest: unknown;
            context: unknown;
            repositoryRoot: string;
            continueAsNewAfterTransitions?: number;
            fakeCompletionDelayMs?: number;
          }>(request, options.maxBodyBytes);
          if ((body.manifest as { taskId?: string }).taskId !== startMatch[1])
            throw new Error("TASK_ID_MISMATCH");
          const result = await options.runControl.requestStart(idempotencyKey, body);
          return json(response, 202, result);
        }
        const analyseMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/analyse(-options)?$/);
        if (analyseMatch && options.configuration) {
          const taskId = analyseMatch[1]!;
          let context = options.service.getTask(taskId);
          if (!context) return json(response, 404, apiError("NOT_FOUND", "Task not found", requestId));
          if (request.method === "GET" && analyseMatch[2]) {
            const environments = options.environments ? await options.environments.list() : [];
            const mapped = await options.configuration.resolveRepository(context.source.key);
            const extension = context.extensions?.["community.odoo.task"] as
              | { customer?: string | null }
              | undefined;
            return json(response, 200, {
              environments: environments.map((env) => ({
                id: env.id,
                version: env.version,
                customer: env.customer,
                branches: env.branches,
                defaultBranch: env.defaultBranch,
                database: env.database,
                scratch: env.scratch,
                usable: Boolean(env.gitRoot && env.defaultBranch),
              })),
              suggestion: suggestEnvironment(
                { key: context.source.key, customer: extension?.customer ?? null, title: context.title },
                environments,
                mapped ? await options.configuration.repositoryPath(mapped.id) : null,
              ),
            });
          }
          if (request.method !== "POST" || analyseMatch[2])
            return json(response, 405, apiError("METHOD_NOT_ALLOWED", "Method not allowed", requestId));
          const body = await jsonBody<{
            environment?: string;
            branch?: string;
            database?: string;
            allowDataQueries?: boolean;
          }>(request, options.maxBodyBytes);
          const snapshot = await options.configuration.snapshot();
          if (!snapshot.readiness.liveModelExecution) throw new Error("LIVE_AGENTS_NOT_CONFIGURED");
          const profileRevisions: Record<string, number> = {};
          for (const role of ["context-reviewer", "planner"]) {
            const id = snapshot.assignments[role]!;
            profileRevisions[role] = Math.max(
              ...snapshot.profiles.filter((p) => p.id === id).map((p) => p.revision),
            );
          }
          let repositoryRoot = "";
          let dataSource: { environmentPath: string; database: string } | undefined;
          if (body.environment) {
            if (!options.environments) throw new Error("ENVIRONMENTS_UNAVAILABLE");
            const { env, baseSha } = await options.environments.pin(body.environment, body.branch ?? "");
            const repository = await options.configuration.environmentRepository(env, body.branch!, baseSha);
            // Re-pin the task to the chosen checkout; the manifest is built from the new context revision.
            context = (await options.service.repin(taskId, repository)).context;
            repositoryRoot = env.gitRoot!;
            if (body.allowDataQueries) {
              const database = body.database ?? env.database.name;
              const known = [
                env.database.exists ? env.database.name : null,
                ...env.scratch.map((d) => d.name),
              ];
              if (!known.includes(database)) throw new Error("DATABASE_NOT_IN_ENVIRONMENT");
              dataSource = { environmentPath: env.path, database };
            }
          } else {
            // Without a chosen environment, fall back to an explicit key-prefix mapping, or the task text only.
            const repository = (
              snapshot.repositories as Array<{ id: string; local_path: string; task_key_prefixes: string[] }>
            ).find((r) => r.id === context!.repository.id && r.task_key_prefixes.length > 0);
            repositoryRoot = repository?.local_path ?? "";
          }
          await options.runControl.horizon.setOverride(
            taskId,
            true,
            "Started live analysis from the dashboard",
          );
          const manifest = createRunManifest({
            taskId,
            contextRevision: context.revision,
            repositoryId: context.repository.id,
            baseSha: context.repository.baseSha,
            policyHash: canonicalSha256({
              workflowVersion: 3,
              phase: "analyse-and-plan",
              profileRevisions,
              dataQueries: Boolean(dataSource),
            }),
            profileRevisions,
            workflowVersion: 3,
          });
          const key = request.headers["idempotency-key"];
          const result = await options.runControl.requestStart(
            typeof key === "string" && key ? key : randomUUID(),
            { manifest, context, repositoryRoot, ...(dataSource ? { dataSource } : {}) },
          );
          return json(response, 202, {
            ...result,
            repositoryMapped: Boolean(repositoryRoot),
            dataQueries: Boolean(dataSource),
          });
        }
        if (request.method === "GET" && url.pathname === "/api/v1/runs")
          return json(response, 200, { items: await options.runControl.listRuns() });
        const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
        if (request.method === "GET" && runMatch) {
          const run = await options.runControl.getRun(runMatch[1]!);
          return run
            ? json(response, 200, run)
            : json(response, 404, apiError("NOT_FOUND", "Run not found", requestId));
        }
        const decisionMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/gates\/([^/]+)\/decisions$/);
        if (request.method === "POST" && decisionMatch) {
          const body = await jsonBody<unknown>(request, options.maxBodyBytes);
          return json(response, 200, await options.runControl.submitDecision(body));
        }
        const decisionLookup = url.pathname.match(/^\/api\/v1\/decisions\/by-key\/([^/]+)$/);
        if (request.method === "GET" && decisionLookup)
          return json(response, 200, await options.runControl.decisionByKey(decisionLookup[1]!));
        const cancelMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
        if (request.method === "POST" && cancelMatch) {
          const idempotencyKey = requiredHeader(request, "idempotency-key");
          const body = await jsonBody<{ expectedStateRevision: number; reason: string }>(
            request,
            options.maxBodyBytes,
          );
          return json(
            response,
            202,
            await options.runControl.requestCancel(idempotencyKey, cancelMatch[1]!, body),
          );
        }
      }
      return json(response, 404, apiError("NOT_FOUND", "Route not found", requestId));
    } catch (error) {
      const message = (error as Error).message;
      const code = message.match(/^[A-Z][A-Z0-9_]+$/)?.[0] ?? "REQUEST_FAILED";
      const status = code === "IDEMPOTENCY_CONFLICT" || code.endsWith("_CONFLICT") ? 409 : 400;
      return json(response, status, apiError(code, message, requestId));
    }
  });
  return { server, sessionToken, csrfToken };
}
function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") throw new Error(`MISSING_${name.toUpperCase()}`);
  return value;
}
async function bodyBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
async function jsonBody<T>(request: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("CONTENT_TYPE_REQUIRED");
  return JSON.parse((await bodyBytes(request, limit)).toString("utf8")) as T;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
