import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { runMigrations, type Queryable } from "../packages/persistence/src/index.js";
import {
  WorkEnvironments,
  isInside,
  scanEnvironments,
  suggestEnvironment,
} from "../apps/api/src/environments.js";

async function environment(root: string, id: string, branch = "staging") {
  const addons = join(root, id, "addons");
  await mkdir(addons, { recursive: true });
  await mkdir(join(root, id, "odoo"), { recursive: true });
  // Port 1 is never a Postgres server, so the scan reports the server as unreachable instead of hanging.
  await writeFile(
    join(root, id, "odoo", ".odoorc"),
    "[options]\ndb_host = 127.0.0.1\ndb_port = 1\ndb_user = odoo\ndb_password = s3cret-pass\ndb_name =\nhttp_port = 8069\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", [
      "-C",
      addons,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "-q", "-b", branch);
  await writeFile(join(addons, "README.md"), "addons\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

test("work environments are discovered by convention without exposing database passwords", async () => {
  await mkdir(".test-tmp", { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/envs-"));
  try {
    await environment(root, "odoo-19-acme");
    await environment(root, "odoo-17-acme", "Staging");
    await mkdir(join(root, "odoo-18-nogit"), { recursive: true });
    await mkdir(join(root, "not-an-environment"), { recursive: true });
    const envs = await scanEnvironments({ root, backupDir: root, restoreScript: join(root, "restore.sh") });
    assert.deepEqual(
      envs.map((e) => e.id),
      ["odoo-17-acme", "odoo-18-nogit", "odoo-19-acme"],
    );
    const acme = envs.find((e) => e.id === "odoo-19-acme")!;
    assert.equal(acme.version, "19");
    assert.equal(acme.defaultBranch, "staging");
    assert.equal(acme.database.name, "odoo-19-acme", "the main copy follows the folder name");
    assert.equal(envs.find((e) => e.id === "odoo-17-acme")!.defaultBranch, "Staging");
    assert.ok(envs.find((e) => e.id === "odoo-18-nogit")!.issues.some((i) => /git/.test(i)));
    assert.doesNotMatch(JSON.stringify(envs), /s3cret-pass/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tasks match environments on whole customer tokens, prefer hinted versions and refuse ties", () => {
  const envs = [
    { id: "odoo-19-ark", version: "19", customer: "ark", gitRoot: "/r/ark" },
    { id: "odoo-17-nordwind", version: "17", customer: "nordwind", gitRoot: "/r/rev17" },
    { id: "odoo-19-nordwind", version: "19", customer: "nordwind", gitRoot: "/r/rev19" },
    { id: "odoo-19-bakkerinterieur", version: "19", customer: "bakkerinterieur", gitRoot: "/r/lin" },
    { id: "odoo-19-zentaro-staging", version: "19", customer: "zentaro-staging", gitRoot: "/r/alfa1" },
    {
      id: "odoo-19-zentaro-ft-general",
      version: "19",
      customer: "zentaro-ft-general",
      gitRoot: "/r/alfa2",
    },
  ];
  const pick = (key: string, customer: string | null, title = "x", mapped: string | null = null) =>
    suggestEnvironment({ key, customer, title }, envs, mapped).environmentId;
  assert.equal(pick("PRK-1", "Parkside bv"), null, "a substring is not a match");
  assert.equal(pick("ARK-1", "Ark Belgium"), "odoo-19-ark");
  assert.equal(pick("BKI-3", "Bakker Interieur"), "odoo-19-bakkerinterieur", "joined tokens match");
  assert.equal(pick("NOR-1", "Nordwind"), "odoo-19-nordwind", "the newest version by default");
  assert.equal(pick("HELP-9", null, "Odoo bij Nordwind"), "odoo-19-nordwind", "helpdesk titles match too");
  assert.equal(pick("X-Y-62", "Zentaro NV"), null, "several checkouts of one customer are a tie");
  assert.equal(
    pick("X-Y-62", "Zentaro NV", "x", "/r/alfa1"),
    "odoo-19-zentaro-staging",
    "a mapping overrides",
  );
  assert.equal(
    suggestEnvironment({ key: "NOR17-4", customer: "Nordwind", title: "x" }, envs).environmentId,
    "odoo-17-nordwind",
    "a version in the project key wins",
  );
});

test("restores and scratch deletes refuse unsafe paths, names and missing confirmations", async () => {
  await mkdir(".test-tmp", { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/envops-"));
  const db = new PGlite();
  const query = async (sql: string, values?: unknown[]) => {
    const result = values ? await db.query(sql, values) : (await db.exec(sql)).at(-1)!;
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  try {
    await runMigrations(pool as Queryable, resolve("packages/persistence/migrations"));
    const workspace = randomUUID();
    await query("INSERT INTO workspaces(id,name) VALUES($1,'envs')", [workspace]);
    await environment(root, "odoo-19-acme");
    const backups = join(root, "downloads");
    await mkdir(backups);
    await writeFile(join(backups, "acme_2026.zip"), "zip");
    await writeFile(join(root, "elsewhere.zip"), "zip");
    const script = join(root, "restore.sh");
    await writeFile(script, '#!/bin/sh\necho restoring "$@"\n');
    await chmod(script, 0o755);
    const environments = new WorkEnvironments(pool as unknown as Queryable, workspace);
    await assert.rejects(
      environments.saveSettings({ root: "relative", backupDir: backups, restoreScript: script }),
      /INVALID_ENVIRONMENT_SETTINGS/,
    );
    await environments.saveSettings({ root, backupDir: backups, restoreScript: script });
    assert.deepEqual(
      (await environments.backups("odoo-19-acme")).map((b) => b.name),
      ["acme_2026.zip"],
    );
    const restore = (zipPath: string, database: string, confirm = database) =>
      environments.restore("odoo-19-acme", { zipPath, database, confirm });
    await assert.rejects(
      restore(join(backups, "acme_2026.zip"), "odoo-19-acme", "wrong"),
      /CONFIRMATION_REQUIRED/,
    );
    await assert.rejects(restore(join(root, "elsewhere.zip"), "odoo-19-acme"), /BACKUP_PATH_DENIED/);
    await assert.rejects(restore(join(backups, "../elsewhere.zip"), "odoo-19-acme"), /BACKUP_PATH_DENIED/);
    await assert.rejects(
      restore(join(backups, "acme_2026.zip"), "odoo-19-other"),
      /DATABASE_NOT_IN_ENVIRONMENT/,
    );
    await assert.rejects(restore(join(backups, "acme_2026.zip"), "oda_product"), /INVALID_DATABASE_NAME/);
    await assert.rejects(restore(join(backups, "acme_2026.zip"), "x; rm -rf /"), /INVALID_DATABASE_NAME/);
    await assert.rejects(
      environments.restore("../etc", { zipPath: "", database: "", confirm: "" }),
      /ENVIRONMENT_NOT_FOUND/,
    );

    // A valid restore runs the configured script with an argument list (no shell) and records its output.
    let job = await restore(join(backups, "acme_2026.zip"), "oda_acme_test");
    await assert.rejects(restore(join(backups, "acme_2026.zip"), "oda_acme_test"), /RESTORE_ALREADY_RUNNING/);
    for (let i = 0; i < 50 && job.state === "RUNNING"; i++) await new Promise((r) => setTimeout(r, 50));
    job = environments.job(job.id)!;
    assert.equal(job.state, "SUCCEEDED");
    assert.match(
      job.log.join("\n"),
      /restoring -f .*acme_2026\.zip -d oda_acme_test -c .*odoo-19-acme\/odoo\/\.odoorc --drop/,
    );

    await assert.rejects(
      environments.dropScratch("odoo-19-acme", "odoo-19-acme", "odoo-19-acme"),
      /DATABASE_NOT_SCRATCH/,
    );
    await assert.rejects(
      environments.dropScratch("odoo-19-acme", "codex_unrelated", "codex_unrelated"),
      /DATABASE_NOT_IN_ENVIRONMENT/,
    );
    assert.equal(isInside(backups, join(backups, "a.zip")), true);
    assert.equal(isInside(backups, `${backups}-evil/a.zip`), false);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
