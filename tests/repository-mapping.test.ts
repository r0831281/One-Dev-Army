import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { runMigrations, MemoryTaskRepository, type Queryable } from "../packages/persistence/src/index.js";
import { WorkspaceConfiguration } from "../apps/api/src/configuration.js";
import { IngestionService, type IngestionDependencies } from "../apps/api/src/index.js";
import { ProfileRegistry } from "../packages/agents/src/index.js";
import { FakeConnector } from "../packages/connectors/src/index.js";
import { validateTaskContext } from "../packages/contracts/src/index.js";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

const run = promisify(execFile);
async function gitRepo(root: string): Promise<string> {
  const git = (...args: string[]) =>
    run("git", [
      "-C",
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  await git("init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "addons\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "init");
  return (await git("rev-parse", "HEAD")).stdout.trim();
}

test("repositories claim task-key prefixes and ingestion pins tasks to them", async () => {
  await mkdir(".test-tmp", { recursive: true });
  const dir = await mkdtemp(resolve(".test-tmp/repo-map-"));
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values ? await db.query(sql, values) : (await db.exec(sql)).at(-1)!;
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  try {
    const head = await gitRepo(dir);
    await runMigrations(pool as Queryable, resolve("packages/persistence/migrations"));
    const workspace = randomUUID();
    await query("INSERT INTO workspaces(id,name) VALUES($1,'map')", [workspace]);
    const dependencies: IngestionDependencies = {
      rules: [],
      connectors: new Map(),
      connectorContexts: new Map(),
      repository: new MemoryTaskRepository(),
    };
    const configuration = new WorkspaceConfiguration(pool, workspace, new ProfileRegistry(), dependencies);
    const valid = {
      name: "Customer ABC",
      localPath: dir,
      defaultBranch: "main",
      keyPrefixes: ["abc", "X-Y"],
    };
    const { id } = await configuration.saveRepository(valid);

    await assert.rejects(
      configuration.saveRepository({ ...valid, name: "Other" }),
      /REPOSITORY_PREFIX_CONFLICT/,
    );
    await assert.rejects(
      configuration.saveRepository({
        ...valid,
        name: "Nope",
        localPath: resolve(dir, "missing"),
        keyPrefixes: [],
      }),
      /REPOSITORY_NOT_GIT/,
    );
    await assert.rejects(
      configuration.saveRepository({ ...valid, localPath: "relative/path", keyPrefixes: [] }),
      /INVALID_REPOSITORY_CONFIG/,
    );
    await assert.rejects(configuration.saveRepository({ ...valid, keyPrefixes: ["bad prefix"] }), /INVALID/);

    assert.deepEqual(await configuration.resolveRepository("ABC-44"), { id, baseSha: head });
    assert.deepEqual(await configuration.resolveRepository("X-Y-62"), { id, baseSha: head });
    assert.equal(
      await configuration.resolveRepository("ABCX-1"),
      null,
      "a prefix must be followed by a dash",
    );
    assert.equal(await configuration.resolveRepository("DEF-47"), null);
    assert.equal(await configuration.repositoryPath(id), dir);

    // Ingestion replaces the connector's repository with the one claiming the key prefix.
    const task = validateTaskContext({
      ...fixture,
      source: { ...fixture.source, key: "ABC-44", externalId: "44" },
    });
    const instanceId = task.source.instanceId;
    const service = new IngestionService({
      rules: [
        {
          id: "r",
          revision: 1,
          enabled: true,
          priority: 100,
          matchKind: "prefix",
          pattern: "ABC-",
          pluginInstanceId: instanceId,
          repositoryId: task.repository.id,
        },
      ],
      connectors: new Map([[instanceId, new FakeConnector(new Map([["ABC-44", task]]))]]),
      connectorContexts: new Map([
        [instanceId, { instanceId, repository: task.repository, fetchedAt: task.provenance.fetchedAt }],
      ]),
      repository: new MemoryTaskRepository(),
      resolveRepository: (key) => configuration.resolveRepository(key),
    });
    const contexts: unknown[] = [];
    const original = FakeConnector.prototype.fetchTask;
    FakeConnector.prototype.fetchTask = async function (ref, context) {
      contexts.push(context);
      return original.call(this, ref, context);
    };
    try {
      await service.ingestIdentifier("ABC-44");
    } finally {
      FakeConnector.prototype.fetchTask = original;
    }
    assert.deepEqual((contexts[0] as { repository: unknown }).repository, { id, baseSha: head });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
