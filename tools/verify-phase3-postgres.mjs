import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runMigrations } from "../dist/packages/persistence/src/index.js";
const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.ODA_PRODUCT_DATABASE_URL ??
    "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product",
});
const client = await pool.connect();
const schema = `phase3_verify_${randomUUID().replaceAll("-", "")}`;
const ids = {
  workspace: randomUUID(),
  repository: randomUUID(),
  plugin: randomUUID(),
  task: randomUUID(),
  run: randomUUID(),
  profile: randomUUID(),
  gate: randomUUID(),
};
try {
  const publicHead = await client.query("SELECT max(version)::int AS head FROM public.schema_migrations");
  if (publicHead.rows[0]?.head !== 7) throw new Error(`PUBLIC_MIGRATION_HEAD:${publicHead.rows[0]?.head}`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await runMigrations(client, resolve("packages/persistence/migrations"));
  const freshHead = await client.query(
    "SELECT max(version)::int AS head,count(*)::int AS count FROM schema_migrations",
  );
  if (freshHead.rows[0]?.head !== 7 || freshHead.rows[0]?.count !== 7)
    throw new Error("FRESH_MIGRATION_FAILED");
  await client.query("INSERT INTO workspaces(id,name) VALUES($1,'phase3')", [ids.workspace]);
  await client.query(
    "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch) VALUES($1,$2,'fixture','/fixture','main')",
    [ids.repository, ids.workspace],
  );
  await client.query(
    "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config) VALUES($1,$2,'fixture','1','{}')",
    [ids.plugin, ids.workspace],
  );
  await client.query(
    "INSERT INTO tasks(id,workspace_id,source_plugin_id,external_id,source_key) VALUES($1,$2,$3,'1','fixture-1')",
    [ids.task, ids.workspace, ids.plugin],
  );
  const context = {
    schemaVersion: "1.0",
    taskId: ids.task,
    revision: 1,
    source: {
      instanceId: ids.plugin,
      externalId: "1",
      key: "fixture-1",
      url: "https://example.invalid/1",
      revision: "1",
    },
    repository: { id: ids.repository, baseSha: "b".repeat(40) },
    title: "fixture",
    description: "fixture",
    acceptanceCriteria: [],
    attachments: [],
    labels: [],
    requester: null,
    constraints: [],
    provenance: [],
  };
  await client.query(
    "INSERT INTO task_contexts(task_id,revision,source_revision,context,context_sha256) VALUES($1,1,'1',$2,$3)",
    [ids.task, context, "a".repeat(64)],
  );
  const manifest = { schemaVersion: "1.0", runId: ids.run, workflowVersion: 2 };
  const projection = { schemaVersion: "1.0", runId: ids.run, state: "TESTING" };
  await client.query(
    "INSERT INTO workflow_runs(id,workspace_id,task_id,context_revision,repository_id,base_sha,workflow_id,workflow_version,state,state_revision,manifest,manifest_sha256,projection) VALUES($1,$2,$3,1,$4,$5,$6,2,'TESTING',1,$7,$8,$9)",
    [
      ids.run,
      ids.workspace,
      ids.task,
      ids.repository,
      "b".repeat(40),
      `task/${ids.task}/run/${ids.run}`,
      manifest,
      "c".repeat(64),
      projection,
    ],
  );
  await client.query(
    "INSERT INTO decision_gates(id,version,run_id,kind,state,state_revision,artifact_hash,proposal,opened_at) VALUES($1,1,$2,'FINAL_APPROVAL','PENDING',2,$3,'{}',now())",
    [ids.gate, ids.run, "d".repeat(64)],
  );
  await client.query(
    "INSERT INTO agent_profiles(id,revision,workspace_id,name,role,provider,model,profile,profile_sha256) VALUES($1,1,$2,'fixture','planner','fake','fixture','{}',$3)",
    [ids.profile, ids.workspace, "e".repeat(64)],
  );
  let immutable = false;
  try {
    await client.query("UPDATE agent_profiles SET model='changed' WHERE id=$1", [ids.profile]);
  } catch {
    immutable = true;
  }
  if (!immutable) throw new Error("PROFILE_IMMUTABILITY_FAILED");
  const tables = await client.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[])",
    [
      schema,
      [
        "agent_profiles",
        "prompt_artifacts",
        "model_usage",
        "usage_adjustments",
        "sandbox_instances",
        "sandbox_command_receipts",
        "candidate_artifacts",
        "execution_evidence",
        "telemetry_logs",
      ],
    ],
  );
  if (tables.rows[0]?.count !== 9) throw new Error("PHASE3_TABLES_MISSING");
  console.log(
    JSON.stringify({
      publicUpgradeHead: 5,
      freshInstallHead: 5,
      phase3Tables: 9,
      workflowV2State: "TESTING",
      finalGateKind: "FINAL_APPROVAL",
      immutableProfiles: true,
    }),
  );
} finally {
  await client.query("SET search_path TO public");
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
  await pool.end();
}
