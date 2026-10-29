import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { horizonEligibility, validateHorizon, WorkHorizon } from "../apps/api/src/horizon.js";
import { RunControlService, createRunManifest, type TemporalGateway } from "../apps/api/src/control.js";
import {
  runMigrations,
  PgTaskRepository,
  PgPhase3Repository,
  type Queryable,
} from "../packages/persistence/src/index.js";
import { WorkspaceConfiguration } from "../apps/api/src/configuration.js";
import { ProfileRegistry } from "../packages/agents/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";
import type { IngestionDependencies } from "../apps/api/src/index.js";
import { readFile } from "node:fs/promises";
import type { AgentProfile } from "../packages/prompt-compiler/src/index.js";
import { validateTaskContext } from "../packages/contracts/src/index.js";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

const dated = (date: string) => ({ extensions: { "community.jira.planning": { plannedFor: date } } });
test("work horizon includes overdue dates and cutoff, excludes undated and invalid dates, and respects local calendar/DST", () => {
  const settings = { days: 7, timezone: "Europe/Brussels" };
  const now = new Date("2026-10-24T22:30:00Z"); // Already Oct 25 in Brussels, across the DST boundary.
  assert.equal(horizonEligibility(dated("2026-11-01"), settings, false, now).eligible, true);
  assert.equal(horizonEligibility(dated("2026-11-02"), settings, false, now).eligible, false);
  assert.equal(horizonEligibility(dated("2026-01-01"), settings, false, now).eligible, true);
  assert.equal(horizonEligibility({}, settings, false, now).reason, "UNDATED");
  assert.equal(horizonEligibility(dated("2026-02-30"), settings, false, now).reason, "UNDATED");
  assert.equal(horizonEligibility({}, settings, true, now).eligible, true);
  assert.equal(horizonEligibility(dated("2026-10-26"), { ...settings, days: 0 }, false, now).eligible, false);
  for (const days of [-1, 1.5, 366, NaN]) assert.throws(() => validateHorizon({ ...settings, days }));
  assert.throws(() => validateHorizon({ ...settings, timezone: "bad/timezone" }));
});

test("persisted horizon gates dispatch, rechecks changed planned dates, resumes queued work, and leaves started runs alone", async () => {
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values ? await db.query(sql, values) : (await db.exec(sql)).at(-1)!;
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const workspace = randomUUID();
  try {
    await runMigrations(pool as Queryable, resolve("packages/persistence/migrations"));
    await query("INSERT INTO workspaces(id,name) VALUES($1,'horizon')", [workspace]);
    await query(
      "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch) VALUES($1,$2,'repo','/repo','main')",
      [fixture.repository.id, workspace],
    );
    await query(
      "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config) VALUES($1,$2,'fake','1','{}')",
      [fixture.source.instanceId, workspace],
    );
    const context = validateTaskContext({ ...fixture, ...dated("2999-01-01") });
    await new PgTaskRepository(pool).ingest(workspace, context, null, "a".repeat(64));
    let started = 0;
    const gateway = {
      start: async () => {
        started++;
      },
    } as unknown as TemporalGateway;
    const control = new RunControlService(pool, gateway, workspace, workspace);
    const manifest = createRunManifest({
      taskId: context.taskId,
      contextRevision: 1,
      repositoryId: context.repository.id,
      baseSha: context.repository.baseSha,
      policyHash: "a".repeat(64),
    });
    const accepted = await control.requestStart(randomUUID(), { manifest, context, repositoryRoot: "/repo" });
    assert.equal(accepted.status, "DEFERRED");
    await control.dispatchPending();
    assert.equal(started, 0);
    assert.equal((await control.runs.get(manifest.runId))?.projection.state, "QUEUED");
    await control.horizon.save({ days: 0, timezone: "UTC" });
    const restarted = new RunControlService(pool, gateway, workspace, workspace);
    assert.equal((await restarted.horizon.settings()).days, 0);
    await restarted.dispatchPending();
    assert.equal(started, 0);
    // A source planning refresh brings the queued task into range without changing its pinned run manifest.
    const next = validateTaskContext({
      ...context,
      ...dated("2000-01-01"),
      revision: 2,
      source: { ...context.source, revision: "2" },
    });
    await new PgTaskRepository(pool).ingest(workspace, next, null, "b".repeat(64));
    await control.horizon.save({ days: 7, timezone: "UTC" });
    await restarted.dispatchPending();
    assert.equal(started, 1);
    assert.equal((await restarted.runs.get(manifest.runId))?.manifest.contextRevision, 1);
    await restarted.horizon.save({ days: 0, timezone: "UTC" });
    await restarted.dispatchPending();
    assert.equal(started, 1);
    await restarted.horizon.setOverride(context.taskId, true, "Urgent customer request");
    assert.equal(
      (await new WorkHorizon(pool, workspace, workspace).eligibility(context)).reason,
      "MANUAL_OVERRIDE",
    );
    await restarted.horizon.setOverride(context.taskId, false, "Use schedule again");
    assert.equal((await restarted.horizon.eligibility(context)).eligible, false);
    const otherWorkspace = randomUUID();
    assert.deepEqual(await new WorkHorizon(pool, otherWorkspace, workspace).settings(), {
      days: 7,
      timezone: "Europe/Brussels",
    });
    assert.deepEqual(await new WorkHorizon(pool, otherWorkspace, workspace).overrides(), []);

    const deferredContext = validateTaskContext({
      ...context,
      taskId: randomUUID(),
      source: { ...context.source, externalId: "deferred-2", key: "FAKE-2", revision: "1" },
    });
    await new PgTaskRepository(pool).ingest(workspace, deferredContext, null, "c".repeat(64));
    const deferredManifest = createRunManifest({
      taskId: deferredContext.taskId,
      contextRevision: 1,
      repositoryId: context.repository.id,
      baseSha: context.repository.baseSha,
      policyHash: "a".repeat(64),
    });
    const deferred = await control.requestStart(randomUUID(), {
      manifest: deferredManifest,
      context: deferredContext,
      repositoryRoot: "/repo",
    });
    assert.equal(deferred.status, "DEFERRED");
    const cancelKey = randomUUID();
    const cancellation = { expectedStateRevision: 0, reason: "No longer needed" };
    await control.requestCancel(cancelKey, deferredManifest.runId, cancellation);
    await control.dispatchPending();
    assert.equal((await control.runs.get(deferredManifest.runId))?.projection.state, "CANCELLED");
    assert.equal(started, 1, "deferred cancellation must not invoke Temporal start or cancel");
    assert.equal(
      (await control.requestCancel(cancelKey, deferredManifest.runId, cancellation)).status,
      "RECORDED",
    );
    await assert.rejects(
      control.requestCancel(cancelKey, deferredManifest.runId, { ...cancellation, reason: "different" }),
      /IDEMPOTENCY_CONFLICT/,
    );

    let policy = await control.operations.policy();
    await control.operations.save({ ...policy, paused: true });
    assert.equal(await control.operations.waiting(context.taskId, randomUUID()), "PAUSED");
    await control.operations.save({ ...policy, maxConcurrentRuns: 1 });
    assert.equal(await control.operations.waiting(context.taskId, randomUUID()), "CAPACITY");
    await control.operations.save({ ...policy, dailyLimitUsd: 0 });
    assert.equal(await control.operations.waiting(context.taskId, randomUUID()), "DAILY_BUDGET");
    await control.operations.save({ ...policy, taskLimitUsd: 0 });
    assert.equal(await control.operations.waiting(context.taskId, randomUUID()), "TASK_BUDGET");
    await control.operations.save({ ...policy, taskLimitUsd: 0.05, dailyLimitUsd: 2 });
    const usage = new PgPhase3Repository(pool);
    const operationId = randomUUID();
    assert.equal(
      await usage.reserveUsage({
        operationId,
        runId: manifest.runId,
        maxMicrousd: 30000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      true,
    );
    assert.equal(
      await usage.reserveUsage({
        operationId,
        runId: manifest.runId,
        maxMicrousd: 30000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      false,
    );
    await assert.rejects(
      usage.reserveUsage({
        operationId: randomUUID(),
        runId: manifest.runId,
        maxMicrousd: 30000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      /TASK_BUDGET_EXHAUSTED/,
    );
    // A failed call releases its reservation, so the retry fits in the task budget again.
    assert.equal(await usage.releaseUsage([operationId]), 1);
    assert.equal(await usage.releaseUsage([operationId]), 0, "only open reservations are released");
    assert.equal(
      await usage.reserveUsage({
        operationId: randomUUID(),
        runId: manifest.runId,
        maxMicrousd: 30000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      true,
    );
    await control.operations.save({ ...policy, unpricedPolicy: "block" });
    await assert.rejects(
      usage.reserveUsage({
        operationId: randomUUID(),
        runId: manifest.runId,
        maxMicrousd: null,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      /UNPRICED_USAGE_BLOCKED/,
    );

    const dependencies: IngestionDependencies = {
      rules: [],
      connectors: new Map(),
      connectorContexts: new Map(),
      repository: new MemoryTaskRepository(),
    };
    const registry = new ProfileRegistry();
    const configuration = new WorkspaceConfiguration(pool, workspace, registry, dependencies);
    await configuration.initialize();
    assert.equal(
      dependencies.repository.getContext(context.taskId)?.revision,
      2,
      "task context must survive restart",
    );
    const profile = JSON.parse(
      await readFile("docs/reference/agent-profile.example.json", "utf8"),
    ) as AgentProfile;
    profile.id = randomUUID();
    profile.provider = "fake";
    profile.credentialRef = null;
    profile.model = "fixture";
    profile.localOnly = true;
    profile.prompt.templateId = "system-v1";
    await configuration.saveProfile(profile);
    await configuration.assign({ planner: profile.id });
    await configuration.saveConnector({
      id: randomUUID(),
      name: "GitHub test",
      provider: "github",
      repositoryId: context.repository.id,
      baseSha: context.repository.baseSha,
      origin: "https://api.github.com",
      owner: "example",
      repository: "test",
      project: "",
      credentialEnv: "ODA_TEST_MISSING_CONNECTOR_AUTH",
      enabled: true,
    });
    const restored = new ProfileRegistry();
    const nextConfiguration = new WorkspaceConfiguration(pool, workspace, restored, dependencies);
    await nextConfiguration.initialize();
    const snapshot = await nextConfiguration.snapshot();
    assert.equal(restored.get(profile.id)?.model, "fixture");
    assert.equal(snapshot.assignments.planner, profile.id);
    assert.equal(snapshot.connectors.length, 1);
    assert.equal(snapshot.connectors[0]?.credentialPresent, false);
    assert.equal(snapshot.readiness.liveModelExecution, false);
    await assert.rejects(
      nextConfiguration.saveConnector({ ...snapshot.connectors[0]!, origin: "http://127.0.0.1" }),
      /CONNECTOR_ORIGIN_DENIED/,
    );
    const odoo = {
      id: randomUUID(),
      name: "Odoo test",
      provider: "odoo" as const,
      repositoryId: context.repository.id,
      baseSha: context.repository.baseSha,
      origin: "https://odoo.example.invalid",
      owner: "",
      repository: "",
      project: "",
      credentialEnv: "ODA_TEST_ODOO_KEY",
      enabled: true,
      odoo: {
        apiVersion: "jsonrpc" as const,
        database: "customer",
        login: "api",
        keyField: "project_key_display",
      },
    };
    await nextConfiguration.saveConnector(odoo);
    await assert.rejects(
      nextConfiguration.saveConnector({ ...odoo, odoo: { ...odoo.odoo, login: "" } }),
      /INVALID_CONNECTOR_SCOPE/,
    );
    await assert.rejects(
      nextConfiguration.saveConnector({ ...odoo, odoo: { ...odoo.odoo, keyField: "x'; drop" } }),
      /INVALID_CONNECTOR_SCOPE/,
    );
    await assert.rejects(
      nextConfiguration.saveConnector({ ...odoo, origin: "https://10.0.0.5" }),
      /CONNECTOR_ORIGIN_DENIED/,
    );
    await assert.rejects(
      nextConfiguration.saveConnector({
        ...odoo,
        tempo: { accountId: "acc", credentialEnv: "ODA_TEMPO_AUTH" },
      }),
      /INVALID_CONNECTOR_SCOPE/,
    );
    const { odoo: _odooOnly, ...shared } = odoo;
    await nextConfiguration.saveConnector({
      ...shared,
      id: randomUUID(),
      name: "Jira helpdesk",
      provider: "jira",
      origin: "https://team.atlassian.net",
      project: "HELP",
      credentialEnv: "ODA_TEST_JIRA_AUTH",
      tempo: { accountId: "557058:abc-123", credentialEnv: "ODA_TEST_TEMPO_AUTH" },
    });
    const routed = new Map(dependencies.rules.map((r) => [r.pattern, r.matchKind]));
    assert.equal(routed.get("HELP-"), "prefix");
    assert.equal(routed.get("^[A-Z][A-Z0-9-]*-[1-9][0-9]*$"), "regex");
    assert.equal(dependencies.planningSources?.length, 1);
    const stored = (await nextConfiguration.snapshot()).connectors;
    assert.equal(stored.find((c) => c.provider === "jira")?.odoo, undefined);
    assert.equal(stored.find((c) => c.provider === "odoo")?.odoo?.login, "api");
  } finally {
    await db.close();
  }
});
