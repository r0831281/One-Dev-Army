import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { promisify } from "node:util";
import { stringify as toYaml } from "yaml";
import { argon2id } from "hash-wasm";
import pg from "pg";
import { MemoryTaskRepository, runMigrations } from "../../persistence/src/index.js";
import { FakeConnector } from "../../connectors/src/index.js";
import { previewRoute, resolveRoute, type RoutingRule } from "../../routing/src/index.js";
import type { TaskContext } from "../../contracts/src/index.js";

const execFileAsync = promisify(execFile);
const deriveKey = async (password: Uint8Array, salt: Uint8Array): Promise<Buffer> =>
  Buffer.from(
    await argon2id({
      password,
      salt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65_536,
      hashLength: 32,
      outputType: "binary",
    }),
  );
function execCaptureInput(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveCommand(stdout.trim())
        : reject(new Error(`${command} failed (${code}): ${stderr}`)),
    );
    child.stdin.end(input);
  });
}
const execWithInput = async (command: string, args: string[], input: string): Promise<void> => {
  await execCaptureInput(command, args, input);
};

export interface ProbeResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}
export async function runProbes(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      required: true,
      detail: process.version,
    },
  ];
  for (const [name, args, required] of [
    ["docker", ["--version"], true],
    ["git", ["--version"], true],
  ] as const) {
    try {
      const value = await execFileAsync(name, [...args], { timeout: 5_000, windowsHide: true });
      results.push({ name, ok: true, required, detail: value.stdout.trim() });
    } catch (error) {
      results.push({ name, ok: false, required, detail: (error as Error).message });
    }
  }
  const ports = [
    Number(process.env.ODA_API_PORT ?? 4310),
    Number(process.env.ODA_POSTGRES_PORT ?? 5433),
    Number(process.env.ODA_TEMPORAL_PORT ?? 7233),
    Number(process.env.ODA_OTLP_GRPC_PORT ?? 4317),
    Number(process.env.ODA_OTLP_HTTP_PORT ?? 4318),
    Number(process.env.ODA_OTEL_METRICS_PORT ?? 9464),
    Number(process.env.ODA_PROMETHEUS_PORT ?? 9090),
  ];
  for (const port of ports) results.push(await probePort(port));
  return results;
}

async function probePort(port: number): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (error) =>
      resolveProbe({
        name: `port:${port}`,
        ok: false,
        required: true,
        detail: (error as NodeJS.ErrnoException).code ?? "unavailable",
      }),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close(() =>
        resolveProbe({ name: `port:${port}`, ok: true, required: true, detail: "available" }),
      ),
    );
  });
}

export type JournalState = "PENDING" | "APPLIED" | "ROLLED_BACK" | "FAILED";
export interface JournalEntry {
  operationId: string;
  action: string;
  state: JournalState;
  inputHash: string;
  detail?: string;
}
export interface SetupJournalData {
  schemaVersion: "1.0";
  setupId: string;
  createdAt: string;
  updatedAt: string;
  complete: boolean;
  entries: JournalEntry[];
}
export class SetupJournal {
  private constructor(
    readonly path: string,
    readonly data: SetupJournalData,
  ) {}
  static async open(path: string, setupId: string = randomUUID()): Promise<SetupJournal> {
    try {
      return new SetupJournal(path, JSON.parse(await readFile(path, "utf8")) as SetupJournalData);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new SetupJournal(path, {
        schemaVersion: "1.0",
        setupId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        complete: false,
        entries: [],
      });
    }
  }
  async run(
    operationId: string,
    action: string,
    inputHash: string,
    fn: () => Promise<string | void>,
  ): Promise<void> {
    const prior = this.data.entries.find((entry) => entry.operationId === operationId);
    if (prior?.state === "APPLIED") {
      if (prior.inputHash !== inputHash) throw new Error(`SETUP_OPERATION_CONFLICT:${operationId}`);
      return;
    }
    const entry: JournalEntry = prior ?? { operationId, action, inputHash, state: "PENDING" };
    if (!prior) this.data.entries.push(entry);
    await this.save();
    try {
      const detail = await fn();
      if (detail !== undefined) entry.detail = detail;
      entry.state = "APPLIED";
      await this.save();
    } catch (error) {
      entry.state = "FAILED";
      entry.detail = (error as Error).message;
      await this.save();
      throw error;
    }
  }
  async complete(): Promise<void> {
    this.data.complete = true;
    await this.save();
  }
  private async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    await atomicWrite(this.path, JSON.stringify(this.data, null, 2));
  }
}

export interface SecretVault {
  put(ref: string, value: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array>;
  delete(ref: string): Promise<void>;
}
function assertVaultRef(ref: string): string {
  if (!/^vault:\/\/oda\/[A-Za-z0-9/_-]+$/.test(ref)) throw new Error("INVALID_VAULT_REF");
  return ref.slice("vault://oda/".length);
}

export class CommandVault implements SecretVault {
  constructor(private readonly kind: "macos" | "linux") {}
  async put(ref: string, value: Uint8Array): Promise<void> {
    const key = assertVaultRef(ref);
    if (this.kind === "macos")
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-a",
        key,
        "-s",
        "oda",
        "-w",
        Buffer.from(value).toString("base64"),
      ]);
    else
      await execWithInput(
        "secret-tool",
        ["store", "--label=O-D-A", "service", "oda", "key", key],
        Buffer.from(value).toString("base64"),
      );
  }
  async get(ref: string): Promise<Uint8Array> {
    const key = assertVaultRef(ref);
    const result =
      this.kind === "macos"
        ? await execFileAsync("security", ["find-generic-password", "-a", key, "-s", "oda", "-w"])
        : await execFileAsync("secret-tool", ["lookup", "service", "oda", "key", key]);
    return Buffer.from(result.stdout.trim(), "base64");
  }
  async delete(ref: string): Promise<void> {
    const key = assertVaultRef(ref);
    if (this.kind === "macos")
      await execFileAsync("security", ["delete-generic-password", "-a", key, "-s", "oda"]);
    else await execFileAsync("secret-tool", ["clear", "service", "oda", "key", key]);
  }
}

export class WindowsDpapiVault implements SecretVault {
  constructor(private readonly root: string) {}
  private path(ref: string): string {
    return join(this.root, `${assertVaultRef(ref).replaceAll("/", "_")}.dpapi`);
  }
  async put(ref: string, value: Uint8Array): Promise<void> {
    const script =
      "Add-Type -AssemblyName System.Security;$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('O-D-A/v1');$p=[Security.Cryptography.ProtectedData]::Protect($v,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
    const protectedValue = await execCaptureInput(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      Buffer.from(value).toString("base64"),
    );
    await mkdir(this.root, { recursive: true });
    await atomicWrite(this.path(ref), protectedValue);
  }
  async get(ref: string): Promise<Uint8Array> {
    const script =
      "Add-Type -AssemblyName System.Security;$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('O-D-A/v1');$p=[Security.Cryptography.ProtectedData]::Unprotect($v,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
    const clearValue = await execCaptureInput(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      await readFile(this.path(ref), "utf8"),
    );
    return Buffer.from(clearValue, "base64");
  }
  async delete(ref: string): Promise<void> {
    await rm(this.path(ref), { force: true });
  }
}

export function nativeVault(root: string): SecretVault {
  if (platform() === "win32") return new WindowsDpapiVault(join(root, "vault"));
  if (platform() === "darwin") return new CommandVault("macos");
  return new CommandVault("linux");
}

interface Envelope {
  version: 1;
  kdf: "argon2id";
  kdfParameters: { memoryKiB: 65536; iterations: 3; parallelism: 1 };
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}
export class EncryptedFileVault implements SecretVault {
  constructor(
    private readonly root: string,
    private readonly passphrase: Uint8Array,
  ) {}
  private path(ref: string): string {
    return join(this.root, `${assertVaultRef(ref).replaceAll("/", "_")}.json`);
  }
  async put(ref: string, value: Uint8Array): Promise<void> {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = await deriveKey(this.passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      kdf: "argon2id",
      kdfParameters: { memoryKiB: 65536, iterations: 3, parallelism: 1 },
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
    await mkdir(this.root, { recursive: true });
    await atomicWrite(this.path(ref), JSON.stringify(envelope));
    if (platform() !== "win32") await chmod(this.path(ref), 0o600);
  }
  async get(ref: string): Promise<Uint8Array> {
    const envelope = JSON.parse(await readFile(this.path(ref), "utf8")) as Envelope;
    const salt = Buffer.from(envelope.salt, "base64");
    const key = await deriveKey(this.passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  }
  async delete(ref: string): Promise<void> {
    await rm(this.path(ref), { force: true });
  }
}

export function applicationRoot(env = process.env): string {
  if (platform() === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "O-D-A");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "O-D-A");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oda");
}
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.${process.pid}.previous`;
  await writeFile(temporary, content, { mode: 0o600 });
  let hadPrevious = false;
  try {
    await rename(path, backup);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await rename(temporary, path);
    if (hadPrevious) await rm(backup, { force: true });
  } catch (error) {
    if (hadPrevious) await rename(backup, path);
    await rm(temporary, { force: true });
    throw error;
  }
}

export type ServiceAction = "up" | "stop" | "status";
export async function services(
  action: ServiceAction,
  composeFile = resolve(process.cwd(), "infra", "compose.yaml"),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const args =
    action === "up"
      ? ["compose", "-f", composeFile, "up", "-d", "--wait", "--wait-timeout", "120"]
      : action === "stop"
        ? ["compose", "-f", composeFile, "stop"]
        : ["compose", "-f", composeFile, "ps"];
  const result = await execFileAsync("docker", args, {
    timeout: action === "up" ? 180_000 : 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: environment,
  });
  return `${result.stdout}${result.stderr}`.trim();
}
export async function serviceEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const vault = nativeVault(root);
  return {
    ...process.env,
    ODA_PRODUCT_DB_PASSWORD: Buffer.from(await vault.get("vault://oda/product-database")).toString(
      "base64url",
    ),
    ODA_TEMPORAL_DB_PASSWORD: Buffer.from(await vault.get("vault://oda/temporal-database")).toString(
      "base64url",
    ),
  };
}

export interface SetupOptions {
  root: string;
  repositoryPath: string;
  dryRun?: boolean;
  setupId?: string;
  startServices?: boolean;
}
export async function setup(
  options: SetupOptions,
): Promise<{ setupId: string; configPath: string; probes: ProbeResult[] }> {
  const root = resolve(options.root);
  const probes = await runProbes();
  if (options.dryRun)
    return { setupId: options.setupId ?? "dry-run", configPath: join(root, "config.yaml"), probes };
  await mkdir(root, { recursive: true });
  if (platform() !== "win32") await chmod(root, 0o700);
  const journal = await SetupJournal.open(join(root, "setup-journal.json"), options.setupId);
  if (
    options.startServices &&
    !journal.data.entries.some((entry) => entry.operationId === "services-v1" && entry.state === "APPLIED")
  ) {
    const blocking = probes.filter((probe) => probe.required && !probe.ok);
    if (blocking.length)
      throw new Error(`SETUP_PROBE_FAILED:${blocking.map((probe) => probe.name).join(",")}`);
  }
  await journal.run("directories-v1", "create directories", root, async () => {
    await Promise.all(
      ["artifacts", "volumes", "vault"].map((name) => mkdir(join(root, name), { recursive: true })),
    );
  });
  const config = {
    schemaVersion: "1.0",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    api: { bind: "127.0.0.1", port: 4310 },
    temporal: { address: "127.0.0.1:7233", namespace: "oda" },
    storage: { databaseSecretRef: "vault://oda/product-database", artifactRoot: join(root, "artifacts") },
    sandbox: { backend: "docker", allowNetworkByDefault: false },
    providers: { defaultProfile: "fake", credentialRef: null },
    repositories: [{ id: "00000000-0000-4000-8000-000000000002", path: resolve(options.repositoryPath) }],
  };
  await journal.run("config-v1", "write config", JSON.stringify(config), async () => {
    await atomicWrite(join(root, "config.yaml"), toYaml(config));
  });
  if (options.startServices) {
    const vault = nativeVault(root);
    const productRef = "vault://oda/product-database";
    const temporalRef = "vault://oda/temporal-database";
    await journal.run("database-secrets-v1", "create database secrets", "native-vault", async () => {
      try {
        await vault.get(productRef);
      } catch {
        await vault.put(productRef, randomBytes(32));
      }
      try {
        await vault.get(temporalRef);
      } catch {
        await vault.put(temporalRef, randomBytes(32));
      }
    });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ODA_PRODUCT_DB_PASSWORD: Buffer.from(await vault.get(productRef)).toString("base64url"),
      ODA_TEMPORAL_DB_PASSWORD: Buffer.from(await vault.get(temporalRef)).toString("base64url"),
    };
    await journal.run("services-v1", "start pinned local services", "infra/compose.yaml", async () =>
      services("up", undefined, environment),
    );
    await journal.run("migrations-v3", "apply product database migrations", "migration-head-3", async () => {
      const pool = new pg.Pool({
        host: "127.0.0.1",
        port: Number(environment.ODA_POSTGRES_PORT ?? 5433),
        database: "oda_product",
        user: "oda_product",
        password: environment.ODA_PRODUCT_DB_PASSWORD,
        connectionTimeoutMillis: 10_000,
      });
      try {
        await runMigrations(pool, resolve(process.cwd(), "packages", "persistence", "migrations"));
      } finally {
        await pool.end();
      }
    });
  }
  await journal.complete();
  return { setupId: journal.data.setupId, configPath: join(root, "config.yaml"), probes };
}

export async function doctor(
  root: string,
): Promise<{ healthy: boolean; probes: ProbeResult[]; checks: Record<string, boolean> }> {
  const probes = await runProbes();
  const checks: Record<string, boolean> = {};
  for (const file of ["config.yaml", "setup-journal.json"]) {
    try {
      await access(join(root, file));
      checks[file] = true;
    } catch {
      checks[file] = false;
    }
  }
  try {
    const info = await stat(root);
    checks.dataRoot = info.isDirectory();
  } catch {
    checks.dataRoot = false;
  }
  return {
    healthy:
      probes
        .filter((probe) => probe.required && !probe.name.startsWith("port:"))
        .every((probe) => probe.ok) && Object.values(checks).every(Boolean),
    probes,
    checks,
  };
}

export async function demo(): Promise<{
  preview: ReturnType<typeof previewRoute>;
  receipt: ReturnType<MemoryTaskRepository["ingest"]>;
  context: TaskContext | null;
}> {
  const instanceId = "22222222-2222-4222-8222-222222222222";
  const taskId = "11111111-1111-4111-8111-111111111111";
  const task: TaskContext = {
    schemaVersion: "1.0",
    taskId,
    revision: 1,
    source: {
      instanceId,
      externalId: "FAKE-1",
      key: "FAKE-1",
      url: "https://fake.invalid/FAKE-1",
      revision: "1",
    },
    repository: { id: "33333333-3333-4333-8333-333333333333", baseSha: "a".repeat(40) },
    title: "Phase 1 demonstration",
    description: "A deterministic fake task",
    acceptanceCriteria: ["Context is persisted and retrieved"],
    attachments: [],
    labels: ["demo"],
    requester: null,
    constraints: [],
    provenance: {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      pluginId: "oda.fake",
      pluginVersion: "1.0.0",
      payloadArtifactId: null,
    },
  };
  const connector = new FakeConnector(new Map([["FAKE-1", task]]));
  const rules: RoutingRule[] = [
    {
      id: "fake",
      revision: 1,
      enabled: true,
      priority: 100,
      matchKind: "prefix",
      pattern: "FAKE-",
      pluginInstanceId: instanceId,
      repositoryId: task.repository.id,
    },
  ];
  const preview = previewRoute(rules, { kind: "identifier", value: "FAKE-1" });
  resolveRoute(rules, { kind: "identifier", value: "FAKE-1" });
  const context = await connector.fetchTask(connector.normalize("FAKE-1"), {
    instanceId,
    repository: task.repository,
    fetchedAt: task.provenance.fetchedAt,
  });
  const repository = new MemoryTaskRepository();
  const receipt = repository.ingest(context, "demo-delivery-1");
  return { preview, receipt, context: repository.getContext(receipt.taskId, receipt.contextRevision) };
}
