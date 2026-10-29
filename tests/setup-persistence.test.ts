import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EncryptedFileVault, setup } from "../packages/cli/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";
import { runMigrations, type Queryable } from "../packages/persistence/src/index.js";
import { PGlite } from "@electric-sql/pglite";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

test("setup journal resumes without duplicating operations", async () => {
  await mkdir(join(process.cwd(), ".test-tmp"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".test-tmp", "oda-setup-"));
  const first = await setup({ root, repositoryPath: process.cwd(), setupId: "resume-test" });
  const second = await setup({ root, repositoryPath: process.cwd(), setupId: "resume-test" });
  assert.equal(first.setupId, second.setupId);
  const journal = JSON.parse(await readFile(join(root, "setup-journal.json"), "utf8")) as {
    entries: unknown[];
    complete: boolean;
  };
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.complete, true);
});

test("encrypted fallback authenticates secrets and does not expose plaintext", async () => {
  await mkdir(join(process.cwd(), ".test-tmp"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".test-tmp", "oda-vault-"));
  const vault = new EncryptedFileVault(root, Buffer.from("correct horse battery staple"));
  await vault.put("vault://oda/provider/test", Buffer.from("super-secret-value"));
  assert.equal(Buffer.from(await vault.get("vault://oda/provider/test")).toString(), "super-secret-value");
  const envelope = await readFile(join(root, "provider_test.json"), "utf8");
  assert.equal(envelope.includes("super-secret-value"), false);
  const wrong = new EncryptedFileVault(root, Buffer.from("wrong passphrase"));
  await assert.rejects(wrong.get("vault://oda/provider/test"));
});

test("context revisions are immutable and deliveries deduplicate", () => {
  const repository = new MemoryTaskRepository();
  const first = repository.ingest(fixture, "delivery-1");
  const duplicate = repository.ingest(fixture, "delivery-1");
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.contextRevision, 1);
  const revised = structuredClone(fixture);
  revised.source.revision = "2";
  revised.title = "Changed";
  const second = repository.ingest(revised);
  assert.equal(second.contextRevision, 2);
  assert.equal(repository.getContext(first.taskId, 1)?.title, "Fixture task");
});

test("failed migration rolls its transaction back", async () => {
  const database = new PGlite();
  const adapter = { query: (text: string, values?: unknown[]) => database.query(text, values) } as Queryable;
  await assert.rejects(
    runMigrations(adapter, join(process.cwd(), "packages/persistence/fixtures/migrations-failure")),
  );
  const check = await database.query<{ relation: string | null }>(
    "SELECT to_regclass('should_be_rolled_back')::text AS relation",
  );
  assert.equal(check.rows[0]?.relation, null);
  await database.close();
});
