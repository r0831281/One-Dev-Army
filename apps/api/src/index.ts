import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apiError, type TaskContext } from "../../../packages/contracts/src/index.js";
import {
  verifyWebhook,
  type ConnectorContext,
  type TaskConnector,
} from "../../../packages/connectors/src/index.js";
import { MemoryTaskRepository } from "../../../packages/persistence/src/index.js";
import {
  previewRoute,
  resolveRoute,
  type RouteInput,
  type RoutingRule,
} from "../../../packages/routing/src/index.js";
import type { RunControlService } from "./control.js";
import type { ProfileRegistry } from "../../../packages/agents/src/index.js";
import type { AgentProfile, CompileInput } from "../../../packages/prompt-compiler/src/index.js";
import { horizonEligibility, type HorizonSettings } from "./horizon.js";
import type { WorkspaceConfiguration } from "./configuration.js";
import type { OperationsPolicy } from "../../../packages/persistence/src/operations.js";
import dashboardAssets from "../../dashboard/assets.json" with { type: "json" };
const assets: Record<string, string> = dashboardAssets;

export interface IngestionDependencies {
  rules: RoutingRule[];
  connectors: Map<string, TaskConnector>;
  connectorContexts: Map<string, ConnectorContext>;
  repository: MemoryTaskRepository;
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
  } = { lastCheckedAt: null, checked: 0, updated: 0, failed: 0, skipped: 0 };
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
  ): Promise<{ receipt: ReturnType<MemoryTaskRepository["ingest"]>; context: TaskContext }> {
    const rule = resolveRoute(this.dependencies.rules, { kind: "identifier", value: identifier });
    const connector = this.dependencies.connectors.get(rule.pluginInstanceId);
    const context = this.dependencies.connectorContexts.get(rule.pluginInstanceId);
    if (!connector || !context) throw new Error("CONNECTOR_NOT_CONFIGURED");
    const task = await connector.fetchTask(connector.normalize(identifier), {
      ...context,
      fetchedAt: new Date().toISOString(),
    });
    return this.store(task);
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
  async refreshTasks() {
    const tasks = this.dependencies.repository.list();
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
        const context = await connector.fetchTask(
          { externalId: task.source.externalId, key: task.source.key },
          { ...connectorContext, fetchedAt: new Date().toISOString() },
        );
        if (!(await this.store(context)).receipt.duplicate) updated++;
      } catch {
        failed++;
      }
    }
    this.lastPlanningSync = {
      lastCheckedAt: new Date().toISOString(),
      checked,
      updated,
      failed,
      skipped,
    };
    return this.planningSyncStatus();
  }
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
          return json(response, 200, await options.service.refreshTasks());
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
