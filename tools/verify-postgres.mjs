import pg from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runMigrations,
  PgCommandRepository,
  PgExternalOperationRepository,
  PgTaskRepository,
} from "../dist/packages/persistence/src/index.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.ODA_PRODUCT_DATABASE_URL ??
    "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product",
});
const workspaceId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const instanceId = "22222222-2222-4222-8222-222222222222";
try {
  await runMigrations(pool, resolve("packages/persistence/migrations"));
  await pool.query(
    "INSERT INTO workspaces(id,name) VALUES($1,'Phase 1 verification') ON CONFLICT(id) DO NOTHING",
    [workspaceId],
  );
  await pool.query(
    "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch) VALUES($1,$2,'fixture',$3,'main') ON CONFLICT(id) DO NOTHING",
    [repositoryId, workspaceId, process.cwd()],
  );
  await pool.query(
    "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config) VALUES($1,$2,'oda.fake','1.0.0','{}') ON CONFLICT(id) DO NOTHING",
    [instanceId, workspaceId],
  );
  const context = JSON.parse(
    await readFile("packages/contracts/fixtures/task-context.compatible.json", "utf8"),
  );
  const repository = new PgTaskRepository(pool);
  const deliveryId = `postgres-${Date.now()}`;
  const first = await repository.ingest(workspaceId, context, deliveryId, "a".repeat(64));
  const second = await new PgTaskRepository(pool).ingest(workspaceId, context, deliveryId, "a".repeat(64));
  if (
    !second.duplicate ||
    first.taskId !== second.taskId ||
    !(await repository.getContext(first.taskId, first.contextRevision))
  )
    throw new Error("PostgreSQL ingestion verification failed");
  let immutable = false;
  try {
    await pool.query("UPDATE task_contexts SET context=context WHERE task_id=$1", [first.taskId]);
  } catch {
    immutable = true;
  }
  if (!immutable) throw new Error("Immutable task context trigger did not reject update");
  const commands = new PgCommandRepository(pool);
  const idempotencyKey = randomUUID();
  const command = await commands.createOrGet(workspaceId, idempotencyKey, "INGEST", {
    identifier: "FAKE-1",
  });
  const replay = await commands.createOrGet(workspaceId, idempotencyKey, "INGEST", {
    identifier: "FAKE-1",
  });
  if (command.duplicate || !replay.duplicate || command.command.id !== replay.command.id)
    throw new Error("Command idempotency verification failed");
  let conflict = false;
  try {
    await commands.createOrGet(workspaceId, idempotencyKey, "INGEST", { identifier: "OTHER" });
  } catch (error) {
    conflict = error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT";
  }
  if (!conflict) throw new Error("Command idempotency conflict was not detected");
  const external = new PgExternalOperationRepository(pool);
  const operationKey = `comment-${randomUUID()}`;
  const intent = await external.begin(workspaceId, instanceId, operationKey, "comment", {
    body: "fixture",
  });
  if (!(await external.transition(intent.operation.id, ["INTENT"], "IN_FLIGHT")))
    throw new Error("External operation did not enter IN_FLIGHT");
  const recovered = new PgExternalOperationRepository(pool);
  if (!(await recovered.pending()).some((operation) => operation.id === intent.operation.id))
    throw new Error("External operation was not recovered after simulated crash");
  const receipt = { status: "APPLIED", operationId: operationKey, remoteId: "fixture-1", url: null };
  if (!(await recovered.transition(intent.operation.id, ["IN_FLIGHT", "UNCERTAIN"], "APPLIED", receipt)))
    throw new Error("External operation reconciliation failed");
  const externalReplay = await recovered.begin(workspaceId, instanceId, operationKey, "comment", {
    body: "fixture",
  });
  if (!externalReplay.duplicate || externalReplay.operation.state !== "APPLIED")
    throw new Error("External operation receipt replay failed");
  console.log(
    JSON.stringify(
      {
        migrations: "passed",
        ingestion: "passed",
        duplicateDelivery: "passed",
        immutableContext: "passed",
        commandIdempotency: "passed",
        crashRecovery: "passed",
        externalWriteReconciliation: "passed",
        receipt: second,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
