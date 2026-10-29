import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import {
  GitHubConnector,
  JiraConnector,
  ODOO_TASK_KEY_ROUTE,
  OdooConnector,
  type ScopedHttp,
} from "../../../packages/connectors/src/index.js";
import {
  assertConnectorRequest,
  withOdooRpcCredential,
  type ConnectorScope,
} from "../../../packages/connectors/src/policy.js";
import { TEMPO_ORIGIN, TempoPlanningSource } from "../../../packages/connectors/src/tempo.js";
import { PgPhase3Repository, canonicalSha256 } from "../../../packages/persistence/src/index.js";
import { DEFAULT_OPERATIONS } from "../../../packages/persistence/src/operations.js";
import { validateProfile, type AgentProfile } from "../../../packages/prompt-compiler/src/index.js";
import type { ProfileRegistry } from "../../../packages/agents/src/index.js";
import type { IngestionDependencies } from "./index.js";
import { credentialAvailable } from "./control.js";

const execFileAsync = promisify(execFile);
/** Read-only git query against a registered repository; never runs hooks or reads system config. */
async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, "-c", "core.fsmonitor=", ...args], {
    timeout: 10_000,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}
export interface RepositoryConfiguration {
  id?: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  keyPrefixes: string[];
}
const KEY_PREFIX = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const LIVE_ROLES = ["context-reviewer", "planner"];

export const AGENT_ROLES = [
  "context-reviewer",
  "planner",
  "implementer",
  "tester",
  "reviewer",
  "reporter",
  "setup-onboarding",
];
export interface ConnectorConfiguration {
  id: string;
  name: string;
  provider: "github" | "jira" | "odoo";
  repositoryId: string;
  owner: string;
  repository: string;
  project: string;
  origin: string;
  credentialEnv: string;
  enabled: boolean;
  baseSha: string;
  /** Odoo only. */
  odoo?: { apiVersion: "json2" | "jsonrpc"; database: string; login: string; keyField: string };
  /** Jira only: read the work plan for one Tempo user. */
  tempo?: { accountId: string; credentialEnv: string } | null;
}
/** A Jira connector with Tempo planning, as used by the planning sync. */
export interface PlanningSourceBinding {
  connectorId: string;
  helpdeskPrefix: string;
  jira: ScopedHttp;
  jiraOrigin: string;
  tempo: TempoPlanningSource;
  accountId: string;
}
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,100}$/;

/** Builds the read-only transport for one connector scope; credentials are attached only after the policy check. */
export function scopedTransport(
  scope: ConnectorScope,
  credentialEnv: string,
  options: { database?: string } = {},
): ScopedHttp {
  return {
    request: async <T>(request: { method: string; url: string; body?: unknown }): Promise<T> => {
      assertConnectorRequest(scope, request);
      const credential = process.env[credentialEnv];
      if (!credential) throw new Error("CONNECTOR_CREDENTIAL_MISSING");
      const headers: Record<string, string> = { accept: "application/json" };
      let body: unknown = request.body;
      if (scope.kind === "get") headers.authorization = credential;
      else {
        headers["content-type"] = "application/json";
        if (options.database) headers["x-odoo-database"] = options.database;
        if (scope.kind === "odoo-json2") headers.authorization = `bearer ${credential}`;
        else body = withOdooRpcCredential(body, credential);
      }
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`CONNECTOR_HTTP_${response.status}`);
      return (await response.json()) as T;
    },
  };
}
export class WorkspaceConfiguration {
  constructor(
    private readonly pool: Pool,
    private readonly workspaceId: string,
    private readonly profiles: ProfileRegistry,
    private readonly ingestion: IngestionDependencies,
  ) {}
  async initialize() {
    const tasks = await this.pool.query(
      "SELECT c.context FROM task_contexts c JOIN tasks t ON t.id=c.task_id WHERE t.workspace_id=$1 ORDER BY c.revision",
      [this.workspaceId],
    );
    this.ingestion.repository.restore(tasks.rows.map((r) => r.context));
    const profiles = await this.pool.query<{ profile: AgentProfile }>(
      "SELECT profile FROM agent_profiles WHERE workspace_id=$1 ORDER BY revision",
      [this.workspaceId],
    );
    for (const row of profiles.rows) this.profiles.create(row.profile);
    await this.reloadConnectors();
  }
  private async connectorConfigs(): Promise<ConnectorConfiguration[]> {
    const rows = await this.pool.query<{
      config: { connector: ConnectorConfiguration; connectorBaseSha: string };
    }>("SELECT config FROM source_plugins WHERE workspace_id=$1 AND config ? 'connector'", [
      this.workspaceId,
    ]);
    return rows.rows.map((r) => ({ ...r.config.connector, baseSha: r.config.connectorBaseSha }));
  }
  async reloadConnectors() {
    this.ingestion.rules.length = 0;
    this.ingestion.connectors.clear();
    this.ingestion.connectorContexts.clear();
    const planningSources: PlanningSourceBinding[] = [];
    for (const c of await this.connectorConfigs()) {
      if (!c.enabled) continue;
      const repository = await this.pool.query<{ default_branch: string }>(
        "SELECT default_branch FROM repositories WHERE id=$1 AND workspace_id=$2",
        [c.repositoryId, this.workspaceId],
      );
      if (!repository.rows.length) continue;
      if (c.provider === "odoo" && !c.odoo) continue;
      const http =
        c.provider === "odoo"
          ? scopedTransport(
              { kind: c.odoo!.apiVersion === "json2" ? "odoo-json2" : "odoo-jsonrpc", origin: c.origin },
              c.credentialEnv,
              c.odoo!.database ? { database: c.odoo!.database } : {},
            )
          : scopedTransport({ kind: "get", origin: c.origin }, c.credentialEnv);
      this.ingestion.connectors.set(
        c.id,
        c.provider === "github"
          ? new GitHubConnector(c.owner, c.repository, http, c.origin)
          : c.provider === "jira"
            ? new JiraConnector(c.origin, c.project, http)
            : new OdooConnector(c.origin, http, c.odoo!),
      );
      if (c.provider === "jira" && c.tempo)
        planningSources.push({
          connectorId: c.id,
          helpdeskPrefix: `${c.project}-`,
          jira: http,
          jiraOrigin: c.origin,
          tempo: new TempoPlanningSource(
            scopedTransport({ kind: "get", origin: TEMPO_ORIGIN }, c.tempo.credentialEnv),
          ),
          accountId: c.tempo.accountId,
        });
      const base = await this.pool.query<{ context: { repository: { baseSha: string } } }>(
        "SELECT c.context FROM task_contexts c JOIN tasks t ON t.id=c.task_id WHERE t.workspace_id=$1 AND c.context->'repository'->>'id'=$2 ORDER BY c.created_at DESC LIMIT 1",
        [this.workspaceId, c.repositoryId],
      );
      // Repository setup must supply a pinned base SHA; no invented commit is used.
      const config = await this.pool.query<{ config: { connectorBaseSha?: string } }>(
        "SELECT config FROM source_plugins WHERE id=$1",
        [c.id],
      );
      const baseSha = config.rows[0]?.config.connectorBaseSha ?? base.rows[0]?.context.repository.baseSha;
      if (!baseSha) {
        this.ingestion.connectors.delete(c.id);
        continue;
      }
      this.ingestion.connectorContexts.set(c.id, {
        instanceId: c.id,
        repository: { id: c.repositoryId, baseSha },
        fetchedAt: new Date().toISOString(),
      });
      this.ingestion.rules.push({
        id: c.id,
        revision: 1,
        enabled: true,
        priority: 100,
        // A Jira prefix outranks the Odoo regex, so helpdesk keys stay with Jira and other keys go to Odoo.
        matchKind: c.provider === "odoo" ? "regex" : "prefix",
        pattern:
          c.provider === "github"
            ? `${c.owner}/${c.repository}#`
            : c.provider === "jira"
              ? `${c.project}-`
              : ODOO_TASK_KEY_ROUTE,
        pluginInstanceId: c.id,
        repositoryId: c.repositoryId,
      });
    }
    this.ingestion.planningSources = planningSources.filter((p) =>
      this.ingestion.connectors.has(p.connectorId),
    );
  }
  async saveConnector(raw: ConnectorConfiguration & { baseSha: string }) {
    const c = { ...raw, id: raw.id || randomUUID() };
    if (
      !/^[a-f0-9-]{36}$/i.test(c.id) ||
      !c.name?.trim() ||
      !["github", "jira", "odoo"].includes(c.provider) ||
      typeof c.enabled !== "boolean" ||
      !ENV_NAME.test(c.credentialEnv) ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(raw.baseSha)
    )
      throw new Error("INVALID_CONNECTOR_CONFIG");
    let url: URL;
    try {
      url = new URL(c.origin);
    } catch {
      throw new Error("CONNECTOR_ORIGIN_DENIED");
    }
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (c.provider === "github" && url.hostname !== "api.github.com") ||
      (c.provider === "jira" && !/^[-a-z0-9]+\.atlassian\.net$/.test(url.hostname)) ||
      // Customer Odoo domains are arbitrary; require a public-looking host name, not an address.
      (c.provider === "odoo" && (!url.hostname.includes(".") || /^[\d.]+$|^\[/.test(url.hostname)))
    )
      throw new Error("CONNECTOR_ORIGIN_DENIED");
    c.origin = url.origin;
    if (
      (c.provider === "github" &&
        (!/^[a-zA-Z0-9_.-]+$/.test(c.owner) || !/^[a-zA-Z0-9_.-]+$/.test(c.repository))) ||
      (c.provider === "jira" && !/^[A-Z][A-Z0-9_]*$/.test(c.project))
    )
      throw new Error("INVALID_CONNECTOR_SCOPE");
    if (c.provider === "odoo") {
      const odoo = c.odoo;
      if (
        !odoo ||
        !["json2", "jsonrpc"].includes(odoo.apiVersion) ||
        typeof odoo.database !== "string" ||
        !/^[A-Za-z0-9_.-]{0,63}$/.test(odoo.database) ||
        typeof odoo.login !== "string" ||
        odoo.login.length > 254 ||
        (odoo.apiVersion === "jsonrpc" && (!odoo.database || !odoo.login.trim())) ||
        !/^[a-z_][a-z0-9_]{0,63}$/.test(odoo.keyField)
      )
        throw new Error("INVALID_CONNECTOR_SCOPE");
      c.odoo = {
        apiVersion: odoo.apiVersion,
        database: odoo.database,
        login: odoo.login.trim(),
        keyField: odoo.keyField,
      };
    } else delete c.odoo;
    if (c.tempo && c.provider === "jira") {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(c.tempo.accountId) || !ENV_NAME.test(c.tempo.credentialEnv))
        throw new Error("INVALID_CONNECTOR_SCOPE");
      c.tempo = { accountId: c.tempo.accountId, credentialEnv: c.tempo.credentialEnv };
    } else if (c.tempo) throw new Error("INVALID_CONNECTOR_SCOPE");
    else delete c.tempo;
    const repo = await this.pool.query("SELECT id FROM repositories WHERE id=$1 AND workspace_id=$2", [
      c.repositoryId,
      this.workspaceId,
    ]);
    if (!repo.rows.length) throw new Error("REPOSITORY_NOT_FOUND");
    const existing = await this.pool.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM source_plugins WHERE id=$1",
      [c.id],
    );
    if (existing.rows[0] && existing.rows[0].workspace_id !== this.workspaceId)
      throw new Error("CONNECTOR_SCOPE_DENIED");
    const { baseSha, ...connector } = c;
    await this.pool.query(
      "INSERT INTO source_plugins(id,workspace_id,plugin_key,version,config,credential_ref) VALUES($1,$2,$3,'1.0.0',$4,$5) ON CONFLICT(id) DO UPDATE SET config=$4,credential_ref=$5",
      [
        c.id,
        this.workspaceId,
        `community.${c.provider}.${c.id}`,
        { connector, connectorBaseSha: baseSha },
        `env:${c.credentialEnv}`,
      ],
    );
    await this.reloadConnectors();
    return { id: c.id };
  }
  async saveProfile(value: AgentProfile) {
    if (
      !AGENT_ROLES.includes(value.role) ||
      !["fake", "ollama", "openai", "anthropic", "gemini", "openrouter", "bedrock"].includes(
        value.provider,
      ) ||
      !Number.isSafeInteger(value.revision) ||
      !/^[a-f0-9-]{36}$/i.test(value.id)
    )
      throw new Error("INVALID_PROFILE");
    const profile = validateProfile(value);
    if (profile.credentialRef !== null && !/^env:[A-Z_][A-Z0-9_]{0,100}$/.test(profile.credentialRef))
      throw new Error("CREDENTIAL_ENV_REFERENCE_REQUIRED");
    const owner = await this.pool.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM agent_profiles WHERE id=$1 LIMIT 1",
      [profile.id],
    );
    if (owner.rows[0] && owner.rows[0].workspace_id !== this.workspaceId)
      throw new Error("PROFILE_SCOPE_DENIED");
    if (this.profiles.get(profile.id, profile.revision)) throw new Error("PROFILE_REVISION_EXISTS");
    const latest = this.profiles.get(profile.id);
    if (profile.revision !== (latest ? latest.revision + 1 : 1)) throw new Error("PROFILE_REVISION_GAP");
    await new PgPhase3Repository(this.pool).appendProfile(this.workspaceId, {
      ...profile,
      profile: profile as never,
    });
    return this.profiles.create(profile);
  }
  async assign(assignments: Record<string, string>) {
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments))
      throw new Error("INVALID_ASSIGNMENTS");
    for (const [role, id] of Object.entries(assignments))
      if (!AGENT_ROLES.includes(role) || this.profiles.get(id)?.role !== role)
        throw new Error("PROFILE_ROLE_MISMATCH");
    await this.pool.query(
      "INSERT INTO workspace_operations(workspace_id,policy,assignments) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET assignments=$3,updated_at=now()",
      [this.workspaceId, DEFAULT_OPERATIONS, assignments],
    );
    return assignments;
  }
  private repositoryCache = new Map<string, { at: number; value: { id: string; baseSha: string } | null }>();
  async saveRepository(raw: RepositoryConfiguration) {
    const id = raw.id || randomUUID();
    const prefixes = [...new Set((raw.keyPrefixes ?? []).map((p) => String(p).trim().toUpperCase()))];
    if (
      !/^[a-f0-9-]{36}$/i.test(id) ||
      !raw.name?.trim() ||
      raw.name.length > 200 ||
      typeof raw.localPath !== "string" ||
      !isAbsolute(raw.localPath) ||
      !/^[A-Za-z0-9._/-]{1,200}$/.test(raw.defaultBranch ?? "") ||
      prefixes.length > 50 ||
      prefixes.some((p) => !KEY_PREFIX.test(p) || p.length > 50)
    )
      throw new Error("INVALID_REPOSITORY_CONFIG");
    try {
      if (!(await stat(raw.localPath)).isDirectory()) throw new Error("not a directory");
      await git(raw.localPath, ["rev-parse", "--git-dir"]);
      await git(raw.localPath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${raw.defaultBranch}^{commit}`,
      ]);
    } catch {
      throw new Error("REPOSITORY_NOT_GIT");
    }
    const owner = await this.pool.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM repositories WHERE id=$1",
      [id],
    );
    if (owner.rows[0] && owner.rows[0].workspace_id !== this.workspaceId)
      throw new Error("REPOSITORY_SCOPE_DENIED");
    const clash = await this.pool.query<{ name: string }>(
      "SELECT name FROM repositories WHERE workspace_id=$1 AND id<>$2 AND task_key_prefixes && $3::text[]",
      [this.workspaceId, id, prefixes],
    );
    if (clash.rows.length) throw new Error("REPOSITORY_PREFIX_CONFLICT");
    await this.pool.query(
      "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch,task_key_prefixes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$3,local_path=$4,default_branch=$5,task_key_prefixes=$6",
      [id, this.workspaceId, raw.name.trim(), raw.localPath, raw.defaultBranch, prefixes],
    );
    this.repositoryCache.clear();
    return { id };
  }
  /** Repository claiming the longest matching prefix of a task key, pinned to its default branch head. */
  async resolveRepository(key: string): Promise<{ id: string; baseSha: string } | null> {
    const cached = this.repositoryCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const rows = await this.pool.query<{
      id: string;
      local_path: string;
      default_branch: string;
      prefix: string;
    }>(
      "SELECT r.id,r.local_path,r.default_branch,p AS prefix FROM repositories r, unnest(r.task_key_prefixes) p WHERE r.workspace_id=$1 AND starts_with($2, p || '-') ORDER BY length(p) DESC LIMIT 1",
      [this.workspaceId, key],
    );
    const row = rows.rows[0];
    let value: { id: string; baseSha: string } | null = null;
    if (row)
      try {
        const sha = await git(row.local_path, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${row.default_branch}^{commit}`,
        ]);
        if (/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sha)) value = { id: row.id, baseSha: sha };
      } catch {
        value = null;
      }
    this.repositoryCache.set(key, { at: Date.now(), value });
    return value;
  }
  /** Repository row for a work environment checkout on one branch, so a task context can pin to it. */
  async environmentRepository(
    env: { id: string; gitRoot: string | null },
    branch: string,
    baseSha: string,
  ): Promise<{ id: string; baseSha: string }> {
    if (!env.gitRoot) throw new Error("ENVIRONMENT_HAS_NO_GIT");
    const name = `${env.id}@${branch}`;
    const hex = createHash("sha256").update(`environment/${this.workspaceId}/${name}`).digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await this.pool.query(
      "INSERT INTO repositories(id,workspace_id,name,local_path,default_branch) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET local_path=$4,default_branch=$5",
      [id, this.workspaceId, name, env.gitRoot, branch],
    );
    return { id, baseSha };
  }
  async repositoryPath(id: string): Promise<string | null> {
    const row = await this.pool.query<{ local_path: string }>(
      "SELECT local_path FROM repositories WHERE id=$1 AND workspace_id=$2",
      [id, this.workspaceId],
    );
    return row.rows[0]?.local_path ?? null;
  }
  /** True when every live-analysis role is assigned an Anthropic profile whose credential is available. */
  liveAnalysisReady(assignments: Record<string, string>): boolean {
    return LIVE_ROLES.every((role) => {
      const profile = assignments[role] ? this.profiles.get(assignments[role]!) : undefined;
      return (
        profile?.provider === "anthropic" &&
        profile.credentialRef?.startsWith("env:") === true &&
        credentialAvailable(profile.credentialRef.slice(4))
      );
    });
  }
  async snapshot() {
    const connectors = await this.connectorConfigs();
    const repositories = await this.pool.query(
      "SELECT id,name,local_path,default_branch,task_key_prefixes FROM repositories WHERE workspace_id=$1 ORDER BY name",
      [this.workspaceId],
    );
    const assignments = await this.pool.query<{ assignments: Record<string, string> }>(
      "SELECT assignments FROM workspace_operations WHERE workspace_id=$1",
      [this.workspaceId],
    );
    return {
      connectors: connectors.map((c) => ({
        ...c,
        credentialPresent: Boolean(process.env[c.credentialEnv]),
        ...(c.tempo ? { tempoCredentialPresent: Boolean(process.env[c.tempo.credentialEnv]) } : {}),
        ready: this.ingestion.connectors.has(c.id),
      })),
      repositories: repositories.rows,
      profiles: this.profiles.list(),
      assignments: assignments.rows[0]?.assignments ?? {},
      roles: AGENT_ROLES,
      readiness: {
        connectors: connectors.some(
          (c) => c.enabled && Boolean(process.env[c.credentialEnv]) && this.ingestion.connectors.has(c.id),
        ),
        tasksSynced: this.ingestion.repository.list().length > 0,
        agentsConfigured: AGENT_ROLES.filter((r) => r !== "setup-onboarding").every((r) =>
          Boolean(assignments.rows[0]?.assignments[r]),
        ),
        executionBackend: this.liveAnalysisReady(assignments.rows[0]?.assignments ?? {})
          ? "live-analysis"
          : "deterministic",
        liveModelExecution: this.liveAnalysisReady(assignments.rows[0]?.assignments ?? {}),
      },
      configurationHash: canonicalSha256({ connectors, assignments: assignments.rows }),
    };
  }
}
