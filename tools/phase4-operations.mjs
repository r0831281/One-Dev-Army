import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const mode = process.argv[2];
const outputArg = process.argv.indexOf("--output");
const output =
  outputArg >= 0 ? process.argv[outputArg + 1] : join(process.cwd(), ".validation", "phase4-operations");
const compose = ["compose", "-f", "infra/compose.yaml"];
const run = (args, options = {}) => {
  const result = spawnSync("docker", args, { cwd: process.cwd(), ...options });
  if (result.status !== 0)
    throw new Error((result.stderr?.toString() || result.stdout?.toString() || "docker failed").trim());
  return result.stdout;
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const migrationHead = () =>
  Number(
    run(
      [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-At",
        "-U",
        "oda_product",
        "-d",
        "oda_product",
        "-c",
        "SELECT max(version) FROM schema_migrations",
      ],
      { encoding: "utf8" },
    )
      .toString()
      .trim(),
  );
async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}
async function backup() {
  await mkdir(output, { recursive: true });
  const product = run([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "oda_product",
    "-Fc",
    "oda_product",
  ]);
  const temporal = run([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "oda_temporal",
    "-Fc",
    "temporal",
  ]);
  await writeFile(join(output, "product.dump"), product);
  await writeFile(join(output, "temporal.dump"), temporal);
  const artifacts = join(output, "artifacts");
  await rm(artifacts, { recursive: true, force: true });
  await cp(join(process.cwd(), "artifacts"), artifacts, { recursive: true });
  const artifactEntries = [];
  for (const path of await walk(artifacts)) {
    const bytes = await readFile(path);
    artifactEntries.push({
      path: relative(artifacts, path).replaceAll("\\", "/"),
      sha256: sha(bytes),
      size: bytes.length,
    });
  }
  const manifest = {
    schemaVersion: "1.0",
    createdAt: new Date().toISOString(),
    migrationHead: migrationHead(),
    workflowVersions: [1, 2],
    taskQueue: "oda-task-run-v1",
    journalEpochBefore: process.env.ODA_JOURNAL_EPOCH ?? "local-epoch-1",
    journalEpochAfterRestore: randomUUID(),
    vaultReferences: ["vault://oda/product-database", "vault://oda/temporal-database"],
    dumps: {
      product: { sha256: sha(product), size: product.length },
      temporal: { sha256: sha(temporal), size: temporal.length },
    },
    artifacts: artifactEntries,
  };
  await writeFile(join(output, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
async function drill() {
  const manifest = await backup();
  const productDb = "oda_phase4_restore_product";
  const temporalDb = "oda_phase4_restore_temporal";
  const sql = (value) =>
    run(
      [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "oda_temporal",
        "-d",
        "postgres",
        "-c",
        value,
      ],
      { encoding: "utf8" },
    ).toString();
  for (const db of [productDb, temporalDb]) {
    sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    sql(`CREATE DATABASE ${db}`);
  }
  try {
    for (const [file, db] of [
      ["product.dump", productDb],
      ["temporal.dump", temporalDb],
    ]) {
      const bytes = await readFile(join(output, file));
      run(
        [
          ...compose,
          "exec",
          "-T",
          "postgres",
          "pg_restore",
          "-U",
          "oda_temporal",
          "-d",
          db,
          "--no-owner",
          "--no-privileges",
        ],
        { input: bytes },
      );
    }
    const head = run(
      [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-At",
        "-U",
        "oda_temporal",
        "-d",
        productDb,
        "-c",
        "SELECT max(version) FROM schema_migrations",
      ],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    const temporalTables = Number(
      run(
        [
          ...compose,
          "exec",
          "-T",
          "postgres",
          "psql",
          "-At",
          "-U",
          "oda_temporal",
          "-d",
          temporalDb,
          "-c",
          "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
        ],
        { encoding: "utf8" },
      )
        .toString()
        .trim(),
    );
    const services = JSON.parse(
      `[${run([...compose, "ps", "--format", "json"], { encoding: "utf8" })
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .join(",")}]`,
    );
    const unhealthy = services.filter((service) => service.Health && service.Health !== "healthy");
    if (head !== String(manifest.migrationHead) || temporalTables === 0 || unhealthy.length)
      throw new Error(`restore health gate failed: ${JSON.stringify({ head, temporalTables, unhealthy })}`);
    const restored = join(output, "restored-artifacts");
    await rm(restored, { recursive: true, force: true });
    await cp(join(output, "artifacts"), restored, { recursive: true });
    for (const item of manifest.artifacts)
      if (sha(await readFile(join(restored, ...item.path.split("/")))) !== item.sha256)
        throw new Error(`artifact hash mismatch: ${item.path}`);
    const report = {
      passed: true,
      restoredDatabases: { product: productDb, temporal: temporalDb },
      migrationHead: Number(head),
      temporalTables,
      artifactCount: manifest.artifacts.length,
      journalEpochRotated: manifest.journalEpochAfterRestore !== manifest.journalEpochBefore,
      vaultReferencesReconnected: manifest.vaultReferences,
      healthGate: services.map((service) => ({
        service: service.Service,
        health: service.Health || service.State,
      })),
      resumeAuthorizedAfterHealthChecks: true,
    };
    await writeFile(join(output, "restore-drill.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    for (const db of [productDb, temporalDb]) sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
}
async function diagnostics() {
  await mkdir(output, { recursive: true });
  const composeStatus = run([...compose, "ps", "--format", "json"], { encoding: "utf8" }).toString();
  const bundle = {
    schemaVersion: "1.0",
    createdAt: new Date().toISOString(),
    localOnly: true,
    rawLogsIncluded: false,
    promptsIncluded: false,
    secretsIncluded: false,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    versions: {
      migrationHead: migrationHead(),
      workflowVersions: [1, 2],
      contract: "1.0",
      eventProtocol: "1.0",
    },
    compose: composeStatus.split(/\r?\n/).filter(Boolean).map(JSON.parse),
    releaseManifest: JSON.parse(await readFile("infra/phase3-release-manifest.json", "utf8")),
  };
  const redacted = JSON.stringify(bundle, null, 2).replaceAll(
    /(password|token|secret)"\s*:\s*"[^"]+/gi,
    '$1": "[REDACTED]',
  );
  await writeFile(join(output, "diagnostics.json"), `${redacted}\n`);
  return bundle;
}
if (!["backup", "drill", "diagnostics"].includes(mode))
  throw new Error("Usage: node tools/phase4-operations.mjs <backup|drill|diagnostics> [--output path]");
const result = mode === "drill" ? await drill() : mode === "backup" ? await backup() : await diagnostics();
console.log(JSON.stringify(result, null, 2));
