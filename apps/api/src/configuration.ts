import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { GitHubConnector, JiraConnector, type ScopedHttp } from "../../../packages/connectors/src/index.js";
import { PgPhase3Repository, canonicalSha256 } from "../../../packages/persistence/src/index.js";
import { DEFAULT_OPERATIONS } from "../../../packages/persistence/src/operations.js";
import { validateProfile, type AgentProfile } from "../../../packages/prompt-compiler/src/index.js";
import type { ProfileRegistry } from "../../../packages/agents/src/index.js";
import type { IngestionDependencies } from "./index.js";

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
  provider: "github" | "jira";
  repositoryId: string;
  owner: string;
  repository: string;
  project: string;
  origin: string;
  credentialEnv: string;
  enabled: boolean;
  baseSha: string;
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
    for (const c of await this.connectorConfigs()) {
      if (!c.enabled) continue;
      const repository = await this.pool.query<{ default_branch: string }>(
        "SELECT default_branch FROM repositories WHERE id=$1 AND workspace_id=$2",
        [c.repositoryId, this.workspaceId],
      );
      if (!repository.rows.length) continue;
      const http: ScopedHttp = {
        request: async <T>(request: { method: string; url: string; body?: unknown }): Promise<T> => {
          const url = new URL(request.url);
          if (url.origin !== c.origin || request.method !== "GET") throw new Error("CONNECTOR_SCOPE_DENIED");
          const credential = process.env[c.credentialEnv];
          if (!credential) throw new Error("CONNECTOR_CREDENTIAL_MISSING");
          const response = await fetch(url, {
            method: "GET",
            headers: { authorization: credential, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error(`CONNECTOR_HTTP_${response.status}`);
          return (await response.json()) as T;
        },
      };
      this.ingestion.connectors.set(
        c.id,
        c.provider === "github"
          ? new GitHubConnector(c.owner, c.repository, http, c.origin)
          : new JiraConnector(c.origin, c.project, http),
      );
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
        matchKind: "prefix",
        pattern: c.provider === "github" ? `${c.owner}/${c.repository}#` : `${c.project}-`,
        pluginInstanceId: c.id,
        repositoryId: c.repositoryId,
      });
    }
  }
  async saveConnector(raw: ConnectorConfiguration & { baseSha: string }) {
    const c = { ...raw, id: raw.id || randomUUID() };
    if (
      !/^[a-f0-9-]{36}$/i.test(c.id) ||
      !c.name?.trim() ||
      !["github", "jira"].includes(c.provider) ||
      typeof c.enabled !== "boolean" ||
      !/^[A-Z_][A-Z0-9_]{0,100}$/.test(c.credentialEnv) ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(raw.baseSha)
    )
      throw new Error("INVALID_CONNECTOR_CONFIG");
    const url = new URL(c.origin);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (c.provider === "github"
        ? url.hostname !== "api.github.com"
        : !/^[-a-z0-9]+\.atlassian\.net$/.test(url.hostname))
    )
      throw new Error("CONNECTOR_ORIGIN_DENIED");
    c.origin = url.origin;
    if (
      (c.provider === "github" &&
        (!/^[a-zA-Z0-9_.-]+$/.test(c.owner) || !/^[a-zA-Z0-9_.-]+$/.test(c.repository))) ||
      (c.provider === "jira" && !/^[A-Z][A-Z0-9_]*$/.test(c.project))
    )
      throw new Error("INVALID_CONNECTOR_SCOPE");
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
  async snapshot() {
    const connectors = await this.connectorConfigs();
    const repositories = await this.pool.query(
      "SELECT id,name,local_path FROM repositories WHERE workspace_id=$1 ORDER BY name",
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
        executionBackend: "deterministic",
        liveModelExecution: false,
      },
      configurationHash: canonicalSha256({ connectors, assignments: assignments.rows }),
    };
  }
}
