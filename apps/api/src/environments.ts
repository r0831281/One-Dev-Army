import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import type { Queryable } from "../../../packages/persistence/src/index.js";
import { StreamingRedactor } from "../../../packages/telemetry/src/index.js";

const execFileAsync = promisify(execFile);

/**
 * Local Odoo work environments follow the convention `<root>/odoo-<version>-<customer>/` with the custom
 * addons in `addons/` (git) and the server configuration in `odoo/.odoorc`.
 */
export interface EnvironmentSettings {
  root: string;
  backupDir: string;
  restoreScript: string;
}
export const defaultEnvironmentSettings = (): EnvironmentSettings => ({
  root: join(homedir(), "odoo"),
  backupDir: join(homedir(), "Downloads"),
  restoreScript: join(homedir(), "odoo", "_scripts", "restore_db.sh"),
});
export interface DatabaseInfo {
  name: string;
  sizeBytes: number;
}
export interface WorkEnvironment {
  /** Folder name, e.g. odoo-19-acme; unique under the root. */
  id: string;
  path: string;
  version: string;
  /** Customer part of the folder name, e.g. acme or zentaro-staging. */
  customer: string;
  gitRoot: string | null;
  branches: string[];
  defaultBranch: string | null;
  odoo: { host: string; port: number; user: string; dataDir: string | null; httpPort: number | null } | null;
  database: { name: string; exists: boolean; sizeBytes: number | null };
  scratch: DatabaseInfo[];
  issues: string[];
}
export interface OdooConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const FOLDER = /^odoo-(\d{2})-([A-Za-z0-9][A-Za-z0-9_-]{0,80})$/;
const SCRATCH = /^(codex|claude|oda)_/;
export const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, "-c", "core.fsmonitor=", ...args], {
    timeout: 10_000,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

/** Parses the INI-style `.odoorc`; values are returned raw, including the password. */
export async function readOdoorc(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const match = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

async function gitInfo(path: string) {
  for (const candidate of [join(path, "addons"), path]) {
    try {
      // An empty prefix means the candidate itself is the top level (robust to path case and symlinks).
      if ((await git(candidate, ["rev-parse", "--show-prefix"])) !== "") continue;
      const root = await git(candidate, ["rev-parse", "--show-toplevel"]);
      const branches = (await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
        .split("\n")
        .filter(Boolean)
        .sort();
      const current = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
      const staging = branches.find((b) => b.toLowerCase() === "staging");
      const usable = async (branch: string | undefined) =>
        branch
          ? await git(root, ["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`]).then(
              () => branch,
              () => null,
            )
          : null;
      return { gitRoot: root, branches, defaultBranch: (await usable(staging)) ?? (await usable(current)) };
    } catch {
      // Not a git root; try the next candidate.
    }
  }
  return { gitRoot: null, branches: [], defaultBranch: null };
}

/** Lists databases per Postgres server, using the credentials of any environment on that server. */
async function databasesByServer(
  servers: Map<string, OdooConnection>,
): Promise<Map<string, DatabaseInfo[] | null>> {
  const result = new Map<string, DatabaseInfo[] | null>();
  await Promise.all(
    [...servers].map(async ([key, connection]) => {
      const client = new pg.Client({ ...connection, database: "postgres", connectionTimeoutMillis: 3000 });
      try {
        await client.connect();
        const rows = await client.query<{ datname: string; size: string }>(
          "SELECT datname, pg_database_size(datname)::text AS size FROM pg_database WHERE NOT datistemplate",
        );
        result.set(
          key,
          rows.rows.map((r) => ({ name: r.datname, sizeBytes: Number(r.size) })),
        );
      } catch {
        result.set(key, null);
      } finally {
        await client.end().catch(() => undefined);
      }
    }),
  );
  return result;
}
const serverKey = (c: { host: string; port: number; user: string }) => `${c.host}:${c.port}:${c.user}`;

/** Connection for an environment's database; the password never leaves the process. */
export async function odooConnection(
  env: Pick<WorkEnvironment, "path">,
  database?: string,
): Promise<OdooConnection> {
  const rc = await readOdoorc(join(env.path, "odoo", ".odoorc"));
  return {
    host: rc.db_host && rc.db_host !== "False" ? rc.db_host : "127.0.0.1",
    port: Number(rc.db_port) || 5432,
    user: rc.db_user || "odoo",
    password: rc.db_password && rc.db_password !== "False" ? rc.db_password : "",
    database: database ?? (rc.db_name || ""),
  };
}

export async function scanEnvironments(settings: EnvironmentSettings): Promise<WorkEnvironment[]> {
  const root = resolve(settings.root);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && FOLDER.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const environments = await Promise.all(
    entries.map(async (id) => {
      const [, version, customer] = FOLDER.exec(id)!;
      const path = join(root, id);
      const issues: string[] = [];
      const gitData = await gitInfo(path);
      if (!gitData.gitRoot) issues.push("No git checkout in addons/");
      let odoo: WorkEnvironment["odoo"] = null;
      let connection: OdooConnection | null = null;
      try {
        connection = await odooConnection({ path });
        const rc = await readOdoorc(join(path, "odoo", ".odoorc"));
        odoo = {
          host: connection.host,
          port: connection.port,
          user: connection.user,
          dataDir: rc.data_dir || null,
          httpPort: Number(rc.http_port) || null,
        };
      } catch {
        issues.push("No odoo/.odoorc");
      }
      return { id, path, version: version!, customer: customer!, gitData, odoo, connection, issues };
    }),
  );
  const servers = new Map<string, OdooConnection>();
  for (const env of environments) if (env.connection) servers.set(serverKey(env.connection), env.connection);
  const databases = await databasesByServer(servers);
  return environments.map((env) => {
    const mainName = env.connection?.database || env.id;
    const onServer = env.connection ? databases.get(serverKey(env.connection)) : null;
    if (env.connection && onServer === null) env.issues.push("Database server unreachable");
    const slug = normalize(env.customer.split("-")[0]!);
    const main = onServer?.find((d) => d.name === mainName);
    return {
      id: env.id,
      path: env.path,
      version: env.version,
      customer: env.customer,
      gitRoot: env.gitData.gitRoot,
      branches: env.gitData.branches,
      defaultBranch: env.gitData.defaultBranch,
      odoo: env.odoo,
      database: { name: mainName, exists: Boolean(main), sizeBytes: main?.sizeBytes ?? null },
      scratch: (onServer ?? [])
        .filter((d) => SCRATCH.test(d.name) && slug.length >= 3 && normalize(d.name).includes(slug))
        .sort((a, b) => a.name.localeCompare(b.name)),
      issues: env.issues,
    };
  });
}

/** True when `candidate` is inside `directory` (after resolving), so paths cannot escape it. */
export function isInside(directory: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const dir = resolve(directory);
  const target = resolve(candidate);
  return target === dir || target.startsWith(`${dir}${sep}`);
}

export async function listBackups(dir: string, env: Pick<WorkEnvironment, "customer">) {
  const slug = normalize(env.customer.split("-")[0]!);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".zip"));
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name));
      return { path: join(dir, name), name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
    }),
  );
  const relevant = (name: string) => (slug.length >= 3 && normalize(name).includes(slug) ? 0 : 1);
  return files.sort(
    (a, b) => relevant(a.name) - relevant(b.name) || b.modifiedAt.localeCompare(a.modifiedAt),
  );
}

export interface EnvironmentSuggestion {
  environmentId: string | null;
  confidence: "high" | "low" | "none";
  reason: string;
}
const tokens = (value: string) =>
  value
    .normalize("NFD")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/**
 * Picks the environment a task most likely belongs to. Folder slugs must equal a whole token (or the joined leading
 * tokens) of the customer name or title; substrings never match ("Parkside" is not "ark").
 */
export function suggestEnvironment(
  task: { key: string; customer: string | null; title: string; description?: string | null },
  environments: Array<Pick<WorkEnvironment, "id" | "version" | "customer" | "gitRoot">>,
  mappedGitRoot: string | null = null,
): EnvironmentSuggestion {
  if (mappedGitRoot) {
    const mapped = environments.find((env) => env.gitRoot && resolve(env.gitRoot) === resolve(mappedGitRoot));
    if (mapped) return { environmentId: mapped.id, confidence: "high", reason: "Mapped key prefix" };
  }
  const score = (env: (typeof environments)[number], text: string | null) => {
    if (!text) return 0;
    const words = tokens(text);
    const joined = words.map((_, i) => words.slice(0, i + 1).join(""));
    const full = normalize(env.customer);
    const first = normalize(env.customer.split("-")[0]!);
    if (full.length >= 3 && (words.includes(full) || joined.includes(full))) return 3;
    if (first.length >= 3 && first !== full && (words.includes(first) || joined.includes(first))) return 2;
    return 0;
  };
  let candidates = environments
    .map((env) => ({ env, score: Math.max(score(env, task.customer) * 2, score(env, task.title)) }))
    .filter((c) => c.score > 0);
  // Helpdesk tickets often name the customer only in the body; that is a weaker signal, so it is a fallback.
  const fromDescription = !candidates.length;
  if (fromDescription)
    candidates = environments
      .map((env) => ({ env, score: Math.min(score(env, task.description ?? null), 1) }))
      .filter((c) => c.score > 0);
  if (!candidates.length)
    return { environmentId: null, confidence: "none", reason: "No environment matches" };
  const best = Math.max(...candidates.map((c) => c.score));
  let top = candidates.filter((c) => c.score === best);
  // A project key ending in a version (ABC19) points at that version.
  const hinted = /(\d{2})$/.exec(task.key.split("-").slice(0, -1).join("-"))?.[1];
  if (hinted && top.some((c) => c.env.version === hinted)) top = top.filter((c) => c.env.version === hinted);
  const customers = new Set(top.map((c) => c.env.customer));
  if (customers.size > 1)
    return {
      environmentId: null,
      confidence: "none",
      reason: `Several environments match: ${top.map((c) => c.env.id).join(", ")}`,
    };
  const newest = top.sort((a, b) => Number(b.env.version) - Number(a.env.version))[0]!;
  return {
    environmentId: newest.env.id,
    confidence: top.length === 1 && best >= 4 ? "high" : "low",
    reason:
      top.length > 1
        ? `Newest of ${top.map((c) => c.env.id).join(", ")}`
        : `${fromDescription ? "Description mentions" : "Matches"} "${newest.env.customer}"`,
  };
}

export interface RestoreJob {
  id: string;
  environmentId: string;
  database: string;
  zipPath: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  log: string[];
}
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
/** Databases that belong to O-D-A itself; never restored into or dropped. */
const PLATFORM_DATABASES = new Set([
  "oda_product",
  "temporal",
  "temporal_visibility",
  "postgres",
  "template0",
  "template1",
]);

/** Discovers work environments and runs the database operations the dashboard offers on them. */
export class WorkEnvironments {
  private cache: { at: number; root: string; list: WorkEnvironment[] } | null = null;
  private readonly jobs = new Map<string, RestoreJob>();
  constructor(
    private readonly pool: Queryable,
    private readonly workspaceId: string,
  ) {}

  async settings(): Promise<EnvironmentSettings> {
    const row = await this.pool.query<{ root: string; backup_dir: string; restore_script: string }>(
      "SELECT root,backup_dir,restore_script FROM work_environment_settings WHERE workspace_id=$1",
      [this.workspaceId],
    );
    const r = row.rows[0];
    return r
      ? { root: r.root, backupDir: r.backup_dir, restoreScript: r.restore_script }
      : defaultEnvironmentSettings();
  }
  async saveSettings(value: EnvironmentSettings): Promise<EnvironmentSettings> {
    for (const path of [value?.root, value?.backupDir, value?.restoreScript])
      if (typeof path !== "string" || !isAbsolute(path) || path.length > 1024)
        throw new Error("INVALID_ENVIRONMENT_SETTINGS");
    try {
      if (!(await stat(value.root)).isDirectory() || !(await stat(value.backupDir)).isDirectory())
        throw new Error();
      if (!(await stat(value.restoreScript)).isFile()) throw new Error();
    } catch {
      throw new Error("ENVIRONMENT_PATH_NOT_FOUND");
    }
    await this.pool.query(
      "INSERT INTO work_environment_settings(workspace_id,root,backup_dir,restore_script) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET root=$2,backup_dir=$3,restore_script=$4,updated_at=now()",
      [this.workspaceId, value.root, value.backupDir, value.restoreScript],
    );
    this.cache = null;
    return this.settings();
  }
  async list(force = false): Promise<WorkEnvironment[]> {
    const settings = await this.settings();
    if (!force && this.cache && this.cache.root === settings.root && Date.now() - this.cache.at < 30_000)
      return this.cache.list;
    const list = await scanEnvironments(settings);
    this.cache = { at: Date.now(), root: settings.root, list };
    return list;
  }
  async get(id: string, force = false): Promise<WorkEnvironment> {
    if (typeof id !== "string" || !FOLDER.test(id)) throw new Error("ENVIRONMENT_NOT_FOUND");
    const env = (await this.list(force)).find((e) => e.id === id);
    if (!env) throw new Error("ENVIRONMENT_NOT_FOUND");
    return env;
  }
  /** Resolves a branch of an environment's checkout to the commit agents will read. */
  async pin(id: string, branch: string): Promise<{ env: WorkEnvironment; baseSha: string }> {
    const env = await this.get(id);
    if (!env.gitRoot || !env.branches.includes(branch)) throw new Error("ENVIRONMENT_BRANCH_NOT_FOUND");
    const baseSha = await git(env.gitRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${branch}^{commit}`,
    ]);
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(baseSha)) throw new Error("ENVIRONMENT_BRANCH_NOT_FOUND");
    return { env, baseSha };
  }
  async backups(id: string) {
    return listBackups((await this.settings()).backupDir, await this.get(id));
  }

  async restore(
    id: string,
    request: { zipPath: string; database: string; confirm: string },
  ): Promise<RestoreJob> {
    const settings = await this.settings();
    const env = await this.get(id, true);
    const { zipPath, database, confirm } = request ?? ({} as never);
    if (!env.odoo) throw new Error("ENVIRONMENT_HAS_NO_ODOORC");
    if (typeof database !== "string" || !DATABASE_NAME.test(database) || PLATFORM_DATABASES.has(database))
      throw new Error("INVALID_DATABASE_NAME");
    // Restores replace the main copy or create a scratch copy; never another environment's database.
    if (database !== env.database.name && !SCRATCH.test(database))
      throw new Error("DATABASE_NOT_IN_ENVIRONMENT");
    if (confirm !== database) throw new Error("CONFIRMATION_REQUIRED");
    if (
      typeof zipPath !== "string" ||
      !zipPath.toLowerCase().endsWith(".zip") ||
      !(isInside(settings.backupDir, zipPath) || isInside(env.path, zipPath))
    )
      throw new Error("BACKUP_PATH_DENIED");
    try {
      if (!(await stat(zipPath)).isFile()) throw new Error();
    } catch {
      throw new Error("BACKUP_NOT_FOUND");
    }
    if ([...this.jobs.values()].some((j) => j.environmentId === id && j.state === "RUNNING"))
      throw new Error("RESTORE_ALREADY_RUNNING");
    const job: RestoreJob = {
      id: randomUUID(),
      environmentId: id,
      database,
      zipPath,
      state: "RUNNING",
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: [],
    };
    this.jobs.set(job.id, job);
    const password = (await odooConnection(env)).password;
    const redactor = new StreamingRedactor(password ? [password] : []);
    // Output arrives in arbitrary chunks; only complete lines enter the log.
    let partial = "";
    const append = (text: string, final = false) => {
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = final ? "" : (lines.pop() ?? "");
      for (const line of lines) if (line.trim()) job.log.push(line);
      if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    };
    const receive = (chunk: string) => append(redactor.push(chunk.replace(ANSI, "")));
    const child = spawn(
      settings.restoreScript,
      ["-f", zipPath, "-d", database, "-c", join(env.path, "odoo", ".odoorc"), "--drop"],
      {
        cwd: env.path,
        shell: false,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANG: process.env.LANG ?? "C.UTF-8",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => receive(String(chunk)));
    child.stderr.on("data", (chunk) => receive(String(chunk)));
    const finish = (code: number | null) => {
      append(redactor.flush(), true);
      job.exitCode = code;
      job.state = code === 0 ? "SUCCEEDED" : "FAILED";
      job.finishedAt = new Date().toISOString();
      this.cache = null;
    };
    child.once("error", (error) => {
      job.log.push(`Could not start the restore script: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      finish(null);
    });
    child.once("exit", (code) => finish(code));
    return job;
  }
  job(id: string): RestoreJob | null {
    return this.jobs.get(id) ?? null;
  }
  jobsFor(environmentId: string): RestoreJob[] {
    return [...this.jobs.values()].filter((j) => j.environmentId === environmentId).slice(-5);
  }

  /** Drops one scratch copy of an environment after a typed confirmation; refuses while it is in use. */
  async dropScratch(id: string, name: string, confirm: string): Promise<{ dropped: string }> {
    const env = await this.get(id, true);
    if (!SCRATCH.test(name) || name === env.database.name || PLATFORM_DATABASES.has(name))
      throw new Error("DATABASE_NOT_SCRATCH");
    if (!env.scratch.some((d) => d.name === name)) throw new Error("DATABASE_NOT_IN_ENVIRONMENT");
    if (confirm !== name) throw new Error("CONFIRMATION_REQUIRED");
    const client = new pg.Client({
      ...(await odooConnection(env, "postgres")),
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      const active = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",
        [name],
      );
      if ((active.rows[0]?.n ?? 0) > 0) throw new Error("DATABASE_IN_USE");
      await client.query(`DROP DATABASE ${client.escapeIdentifier(name)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
    this.cache = null;
    return { dropped: name };
  }
}
