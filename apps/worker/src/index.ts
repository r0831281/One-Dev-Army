import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import pg from "pg";
import { createPersistentActivities } from "./activities.js";
import { TASK_RUN_QUEUE } from "./types.js";

const { Pool } = pg;

export interface WorkerOptions {
  temporalAddress?: string;
  namespace?: string;
  databaseUrl?: string;
  taskQueue?: string;
}

export async function createTaskRunWorker(options: WorkerOptions = {}): Promise<{
  worker: Worker;
  close(): Promise<void>;
}> {
  const connection = await NativeConnection.connect({
    address: options.temporalAddress ?? process.env.ODA_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  const pool = new Pool({
    connectionString:
      options.databaseUrl ??
      process.env.ODA_PRODUCT_DATABASE_URL ??
      "postgres://oda_product:oda-product-local-only@127.0.0.1:5433/oda_product",
  });
  const current = dirname(fileURLToPath(import.meta.url));
  const worker = await Worker.create({
    connection,
    namespace: options.namespace ?? process.env.ODA_TEMPORAL_NAMESPACE ?? "default",
    taskQueue: options.taskQueue ?? TASK_RUN_QUEUE,
    workflowsPath: resolve(current, "workflows.js"),
    activities: createPersistentActivities(pool),
  });
  return {
    worker,
    async close() {
      await pool.end();
      await connection.close();
    },
  };
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const runtime = await createTaskRunWorker(options);
  try {
    await runtime.worker.run();
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorker();
}
