import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { createPersistentActivities } from "./activities.js";
import { createLiveActivities } from "./live-activities.js";
import { anthropicModelTurn } from "../../../packages/providers/src/anthropic.js";
import { createRepoReader } from "../../../packages/sandboxes/src/repo-read.js";
import { createDbReader } from "../../../packages/sandboxes/src/db-read.js";
import { odooConnection } from "../../api/src/environments.js";
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
    activities: {
      ...createPersistentActivities(pool),
      ...createLiveActivities(pool, {
        modelTurn: process.env.ANTHROPIC_API_KEY
          ? anthropicModelTurn(new Anthropic({ maxRetries: 2 }))
          : async () => {
              throw new Error("PROVIDER_UNAVAILABLE");
            },
        async dbFor(source) {
          // The API validated the environment and database; re-check the shape before connecting.
          if (
            !isAbsolute(source.environmentPath) ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(source.database)
          )
            return null;
          return createDbReader(await odooConnection({ path: source.environmentPath }, source.database));
        },
        async readerFor(root, baseSha) {
          // Tasks without a mapped repository run from the task text only.
          if (!root) return null;
          try {
            return await createRepoReader({ root, baseSha });
          } catch {
            return null;
          }
        },
      }),
    },
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
