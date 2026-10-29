import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  MemoryTaskRepository,
  PgPhase3Repository,
  PgTaskRepository,
  canonicalSha256,
} from "../../../packages/persistence/src/index.js";
import { ProfileRegistry } from "../../../packages/agents/src/index.js";
import { connectTemporalGateway, RunControlService, type TemporalGateway } from "./control.js";
import { createLocalApi, IngestionService, type IngestionDependencies } from "./index.js";
import { WorkspaceConfiguration } from "./configuration.js";
import { horizonWindow } from "./horizon.js";
import { WorkEnvironments } from "./environments.js";

const { Pool } = pg;

export async function runApi(): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.ODA_PRODUCT_DATABASE_URL ??
      "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product",
  });
  let temporal: Awaited<ReturnType<typeof connectTemporalGateway>> | null = null;
  let connecting: Promise<Awaited<ReturnType<typeof connectTemporalGateway>>> | null = null;
  const gateway = async () => {
    if (temporal) return temporal.gateway;
    connecting ??= connectTemporalGateway();
    try {
      temporal = await connecting;
      return temporal.gateway;
    } finally {
      connecting = null;
    }
  };
  const temporalGateway: TemporalGateway = {
    start: async (input, id) => (await gateway()).start(input, id),
    decide: async (id, input) => (await gateway()).decide(id, input),
    cancel: async (id, input) => (await gateway()).cancel(id, input),
  };
  const workspaceId = process.env.ODA_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000001";
  const profiles = new ProfileRegistry();
  const phase3 = new PgPhase3Repository(pool);
  const durableTasks = new PgTaskRepository(pool);
  const dependencies: IngestionDependencies = {
    rules: [],
    connectors: new Map(),
    connectorContexts: new Map(),
    repository: new MemoryTaskRepository(),
    async persist(context, deliveryId) {
      const receipt = await durableTasks.ingest(workspaceId, context, deliveryId, canonicalSha256(context));
      return { receipt, context: (await durableTasks.getContext(receipt.taskId, receipt.contextRevision))! };
    },
  };
  const configuration = new WorkspaceConfiguration(pool, workspaceId, profiles, dependencies);
  dependencies.resolveRepository = (key) => configuration.resolveRepository(key);
  await configuration.initialize();
  const ingestion = new IngestionService(dependencies);
  const control = new RunControlService(pool, temporalGateway, workspaceId, workspaceId, (taskId) =>
    ingestion.getTask(taskId),
  );
  const api = createLocalApi({
    service: ingestion,
    runControl: control,
    profiles,
    configuration,
    environments: new WorkEnvironments(pool, workspaceId),
    async telemetry() {
      const observedAt = new Date().toISOString();
      const windowEnd = Math.floor(Date.parse(observedAt) / 1000);
      const result = await pool.query(
        `
        WITH usage AS (
          SELECT floor(extract(epoch FROM u.observed_at)/10)*10 AS bucket,
            sum(u.input_tokens) AS input, sum(u.output_tokens) AS output,
            count(*) FILTER (WHERE u.input_tokens IS NULL OR u.output_tokens IS NULL) AS unknown_tokens,
            sum(u.amount_microusd + coalesce((SELECT sum(a.delta_microusd) FROM usage_adjustments a WHERE a.attempt_id=u.attempt_id),0)) AS spend,
            count(*) FILTER (WHERE u.amount_microusd IS NULL) AS unpriced
          FROM model_usage u JOIN workflow_runs r ON r.id=u.run_id
          WHERE r.workspace_id=$1 AND u.category='model' AND u.observed_at >= to_timestamp($2-300)
            AND u.observed_at <= to_timestamp($2)
          GROUP BY 1
        ), steps AS (
          SELECT floor(extract(epoch FROM s.updated_at)/10)*10 AS bucket, count(*) AS completed
          FROM agent_steps s JOIN workflow_runs r ON r.id=s.run_id
          WHERE r.workspace_id=$1 AND s.state='COMPLETED' AND s.updated_at >= to_timestamp($2-300)
            AND s.updated_at <= to_timestamp($2) GROUP BY 1
        )
        SELECT b::float8 AS time, coalesce(u.input,0)::float8 AS input, coalesce(u.output,0)::float8 AS output,
          coalesce(u.spend,0)::float8/1000000 AS spend, coalesce(u.unpriced,0)::int AS unpriced,
          coalesce(u.unknown_tokens,0)::int AS unknown_tokens, coalesce(s.completed,0)::int AS completed
        FROM generate_series(floor(($2::numeric-290)/10)*10, floor($2::numeric/10)*10, 10) b
        LEFT JOIN usage u ON u.bucket=b LEFT JOIN steps s ON s.bucket=b ORDER BY b
      `,
        [workspaceId, windowEnd],
      );
      const runs = await pool.query(
        `SELECT count(*) FILTER (WHERE state='QUEUED')::int AS queued,
        count(*) FILTER (WHERE state IN ('IMPLEMENTING','TESTING','REVIEWING','PLANNING','REPORTING','CONTEXT_REVIEW'))::int AS active
        FROM workflow_runs WHERE workspace_id=$1`,
        [workspaceId],
      );
      const contributions = await pool.query(
        `SELECT (floor(extract(epoch FROM u.observed_at)/10)*10)::float8 AS time,
          CASE WHEN nullif(u.usage->>'agentId','') IS NOT NULL THEN 'agent:' || (u.usage->>'agentId')
            WHEN s.step_key IS NOT NULL THEN 'role:' || s.step_key ELSE 'unattributed' END AS "agentId",
          coalesce(nullif(u.usage->>'agentName',''), nullif(u.usage->>'agentId',''), s.step_key || ' (step role)', 'Unattributed') AS "agentName",
          u.run_id AS "runId",r.task_id AS "taskId",s.step_key AS "stepKey",s.id AS "stepId",
          bool_or(s.state='COMPLETED') AS "stepCompleted", max(s.logical_iteration) AS "stepIteration",count(*)::int AS attempts,
          u.provider, u.model,
          coalesce(sum(u.input_tokens),0)::float8 AS input,
          coalesce(sum(u.output_tokens),0)::float8 AS output,
          coalesce(sum(u.amount_microusd + coalesce((SELECT sum(a.delta_microusd) FROM usage_adjustments a WHERE a.attempt_id=u.attempt_id),0)),0)::float8/1000000 AS spend,
          count(*) FILTER (WHERE u.amount_microusd IS NULL)::int AS unpriced,
          count(*) FILTER (WHERE u.input_tokens IS NULL OR u.output_tokens IS NULL)::int AS unknown_tokens
        FROM model_usage u JOIN workflow_runs r ON r.id=u.run_id
        LEFT JOIN agent_steps s ON s.id=u.step_id AND s.run_id=u.run_id
        WHERE r.workspace_id=$1 AND u.category='model'
          AND u.observed_at >= to_timestamp($2-300) AND u.observed_at <= to_timestamp($2)
        GROUP BY 1,2,3,u.provider,u.model,u.run_id,r.task_id,s.step_key,s.id ORDER BY 1,2,u.provider,u.model`,
        [workspaceId, windowEnd],
      );
      return { observedAt, buckets: result.rows, contributions: contributions.rows, ...runs.rows[0] };
    },
    events: {
      async snapshot() {
        return {
          journalEpoch: process.env.ODA_JOURNAL_EPOCH ?? "local-epoch-1",
          snapshotCursor: await phase3.latestCursor(workspaceId),
          runs: await control.listRuns(),
        };
      },
      async history(after, limit) {
        const events = await phase3.eventHistory(workspaceId, after, limit);
        const latestCursor = await phase3.latestCursor(workspaceId);
        return {
          journalEpoch: process.env.ODA_JOURNAL_EPOCH ?? "local-epoch-1",
          events,
          latestCursor,
          resync:
            after > latestCursor ||
            (!events.length && latestCursor > after) ||
            (events.length > 0 && events[0]!.seq > after + 1),
        };
      },
    },
    sessionToken: process.env.ODA_SESSION_TOKEN ?? "phase2-local-session",
    csrfToken: process.env.ODA_CSRF_TOKEN ?? "phase2-local-csrf",
  });
  const port = Number(process.env.ODA_API_PORT ?? "4310");
  const dispatcher = setInterval(
    () =>
      void control
        .dispatchPending()
        .catch((error) => console.error("DISPATCH_FAILED", error.code ?? "unavailable")),
    250,
  );
  const planningPoller = setInterval(
    () =>
      void control.horizon
        .settings()
        .then((settings) => ingestion.sync(horizonWindow(settings)))
        .catch(() => console.error("CONNECTOR_REFRESH_FAILED")),
    30 * 60 * 1000,
  );
  await new Promise<void>((resolvePromise, reject) => {
    api.server.once("error", reject);
    api.server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`ODA_API_READY:${port}\n`);
    });
    const close = () => {
      clearInterval(dispatcher);
      clearInterval(planningPoller);
      api.server.close(() => resolvePromise());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  if (temporal) await (temporal as Awaited<ReturnType<typeof connectTemporalGateway>>).close();
  await pool.end();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runApi();
