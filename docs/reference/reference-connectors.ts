/** Reference connector logic. The host supplies validated config, a scoped broker, and a write journal. */
import type {
  Json, PluginManifest, TaskSourcePlugin, PluginContext, NormalizeInput, SourceTaskRef,
  TaskContext, StatusUpdate, SourceComment, WriteReceipt, HealthResult, SourceStatus,
} from "./contracts.js";

const imageHash = "a".repeat(64); // Illustrative only; installation requires a real verified digest.
function manifest(id: string, name: string, origin: string): PluginManifest {
  return {
    schemaVersion: "1.0", id, version: "1.0.0", protocolRange: "^1.0.0", displayName: name,
    runtime: "stdio-container", image: `registry.example.org/oda/${id}@sha256:${imageHash}`,
    capabilities: ["task:read", "task:status", "task:comment"], httpOrigins: [origin],
    configSchemaRef: `plugin://${id}/config/1`, writeReconciliation: "marker-search",
  };
}
function record(value: Json | undefined): { [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("VALIDATION_FAILED");
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("VALIDATION_FAILED");
  return value;
}
function operationMarker(operationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw new Error("VALIDATION_FAILED");
  return `oda-operation:${operationId}`;
}
function contextTask(context: PluginContext, ref: SourceTaskRef, fields: {
  title: string; description: string; url: string; revision: string | null;
  labels: string[]; requester: { id: string; displayName: string } | null; pluginId: string;
}): TaskContext {
  return {
    schemaVersion: "1.0", taskId: context.taskId, revision: context.contextRevision,
    source: { instanceId: context.instanceId, externalId: ref.externalId, key: ref.key, url: fields.url, revision: fields.revision },
    repository: context.repository, title: fields.title, description: fields.description,
    acceptanceCriteria: [], attachments: [], labels: fields.labels, requester: fields.requester,
    constraints: [], provenance: { fetchedAt: context.fetchedAt, pluginId: fields.pluginId, pluginVersion: "1.0.0", payloadArtifactId: null },
  };
}

interface GitHubIssue {
  id: number; number: number; title: string; body: string | null; html_url: string; updated_at: string;
  state: "open" | "closed"; labels: Array<{ name: string }>;
  user: { id: number; login: string } | null; pull_request?: unknown;
}
interface GitHubComment { id: number; body: string; html_url: string }
export class GitHubConnector implements TaskSourcePlugin {
  constructor(private readonly config: {
    owner: string; repo: string;
    statusMap: Partial<Record<SourceStatus, { state: "open" | "closed"; label?: string }>>;
  }) {}
  private root(): string { return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`; }
  private issue(ref: SourceTaskRef): string {
    if (!/^[1-9][0-9]*$/.test(ref.externalId)) throw new Error("VALIDATION_FAILED");
    if (ref.key !== `${this.config.owner}/${this.config.repo}#${ref.externalId}`) throw new Error("POLICY_DENIED");
    return `${this.root()}/issues/${ref.externalId}`;
  }
  async getManifest(): Promise<PluginManifest> { return manifest("community.github", "GitHub Issues", "https://api.github.com"); }
  async healthCheck(c: PluginContext): Promise<HealthResult> {
    const repo = await c.http.request<{ full_name: string }>({ method: "GET", path: this.root() });
    return { healthy: true, identity: repo.full_name, capabilities: (await this.getManifest()).capabilities, warnings: [] };
  }
  async normalizePayload(input: NormalizeInput, _c: PluginContext): Promise<SourceTaskRef> {
    const prefix = `${this.config.owner}/${this.config.repo}#`;
    let identifier: string;
    if (input.kind === "identifier") identifier = input.identifier;
    else {
      const payload = record(input.payload);
      if (text(record(payload["repository"])["full_name"]) !== `${this.config.owner}/${this.config.repo}`) throw new Error("POLICY_DENIED");
      const issue = record(payload["issue"]);
      if (typeof issue["number"] !== "number" || !Number.isSafeInteger(issue["number"])) throw new Error("VALIDATION_FAILED");
      identifier = prefix + String(issue["number"]);
    }
    if (!identifier.startsWith(prefix) || !/^[1-9][0-9]*$/.test(identifier.slice(prefix.length))) throw new Error("VALIDATION_FAILED");
    return { externalId: identifier.slice(prefix.length), key: identifier };
  }
  async fetchTask(ref: SourceTaskRef, c: PluginContext): Promise<TaskContext> {
    const issue = await c.http.request<GitHubIssue>({ method: "GET", path: this.issue(ref) });
    if (issue.pull_request !== undefined) throw new Error("UNSUPPORTED_CAPABILITY");
    return contextTask(c, ref, {
      title: issue.title, description: issue.body ?? "", url: issue.html_url, revision: issue.updated_at,
      labels: issue.labels.map(label => label.name),
      requester: issue.user ? { id: String(issue.user.id), displayName: issue.user.login } : null, pluginId: "community.github",
    });
  }
  async updateStatus(input: StatusUpdate, c: PluginContext): Promise<WriteReceipt> {
    const mapped = this.config.statusMap[input.status];
    if (!mapped) throw new Error("UNSUPPORTED_STATUS");
    const current = await c.http.request<GitHubIssue>({ method: "GET", path: this.issue(input.ref) });
    const managed = new Set(Object.values(this.config.statusMap).flatMap(value => value.label ? [value.label] : []));
    const desired = [...current.labels.map(label => label.name).filter(label => !managed.has(label)), ...(mapped.label ? [mapped.label] : [])];
    const same = current.state === mapped.state && [...current.labels.map(label => label.name)].sort().join("\n") === [...desired].sort().join("\n");
    if (!same) await c.http.request<GitHubIssue>({ method: "PATCH", path: this.issue(input.ref), body: { state: mapped.state, labels: desired } });
    return { status: same ? "ALREADY_APPLIED" : "APPLIED", operationId: input.operationId, remoteId: String(current.id), url: current.html_url };
  }
  async postComment(input: SourceComment, c: PluginContext): Promise<WriteReceipt> {
    const marker = `<!-- ${operationMarker(input.operationId)} -->`;
    const path = `${this.issue(input.ref)}/comments`;
    for (let page = 1; ; page++) {
      const comments = await c.http.request<GitHubComment[]>({ method: "GET", path, query: { per_page: "100", page: String(page) } });
      const found = comments.find(comment => comment.body.includes(marker));
      if (found) return { status: "ALREADY_APPLIED", operationId: input.operationId, remoteId: String(found.id), url: found.html_url };
      if (comments.length < 100) break;
      if (page >= 100) throw new Error("WRITE_UNCERTAIN");
    }
    const created = await c.http.request<GitHubComment>({ method: "POST", path, body: { body: `${input.body}\n\n${marker}` } });
    return { status: "APPLIED", operationId: input.operationId, remoteId: String(created.id), url: created.html_url };
  }
}

interface AdfNode { type: string; text?: string; content?: AdfNode[] }
function adfText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  const children = node.content?.map(adfText).join("") ?? "";
  return (node.text ?? children) + (["paragraph", "heading", "listItem"].includes(node.type) ? "\n" : "");
}
function adfBody(body: string): Json {
  return { type: "doc", version: 1, content: body.split("\n").map(line => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) };
}
interface JiraIssue {
  id: string; key: string;
  fields: { summary: string; description: AdfNode | null; labels: string[]; updated: string;
    project: { key: string }; status: { id: string }; reporter: { accountId: string; displayName: string } | null };
}
interface JiraComment { id: string; body: AdfNode }
export class JiraConnector implements TaskSourcePlugin {
  constructor(private readonly config: {
    origin: string; projectKey: string;
    statusMap: Partial<Record<SourceStatus, { transitionId: string; targetStatusId: string }>>;
  }) {}
  private issue(ref: SourceTaskRef): string {
    if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(ref.key) || !ref.key.startsWith(`${this.config.projectKey}-`)) throw new Error("POLICY_DENIED");
    return `/rest/api/3/issue/${encodeURIComponent(ref.key)}`;
  }
  async getManifest(): Promise<PluginManifest> { return manifest("community.jira", "Jira Cloud", this.config.origin); }
  async healthCheck(c: PluginContext): Promise<HealthResult> {
    const user = await c.http.request<{ accountId: string }>({ method: "GET", path: "/rest/api/3/myself" });
    return { healthy: true, identity: user.accountId, capabilities: (await this.getManifest()).capabilities, warnings: [] };
  }
  async normalizePayload(input: NormalizeInput, _c: PluginContext): Promise<SourceTaskRef> {
    const key = input.kind === "identifier" ? input.identifier : text(record(record(input.payload)["issue"])["key"]);
    const ref = { externalId: key, key };
    this.issue(ref);
    return ref;
  }
  async fetchTask(ref: SourceTaskRef, c: PluginContext): Promise<TaskContext> {
    const issue = await c.http.request<JiraIssue>({ method: "GET", path: this.issue(ref), query: { fields: "summary,description,labels,updated,project,status,reporter" } });
    if (issue.fields.project.key !== this.config.projectKey) throw new Error("POLICY_DENIED");
    return contextTask(c, { externalId: issue.id, key: issue.key }, {
      title: issue.fields.summary, description: adfText(issue.fields.description).trim(),
      url: `${this.config.origin}/browse/${encodeURIComponent(issue.key)}`, revision: issue.fields.updated,
      labels: issue.fields.labels, requester: issue.fields.reporter ? { id: issue.fields.reporter.accountId, displayName: issue.fields.reporter.displayName } : null,
      pluginId: "community.jira",
    });
  }
  async updateStatus(input: StatusUpdate, c: PluginContext): Promise<WriteReceipt> {
    const target = this.config.statusMap[input.status];
    if (!target) throw new Error("UNSUPPORTED_STATUS");
    const issue = await c.http.request<JiraIssue>({ method: "GET", path: this.issue(input.ref), query: { fields: "status" } });
    if (issue.fields.status.id === target.targetStatusId) return { status: "ALREADY_APPLIED", operationId: input.operationId, remoteId: issue.id, url: null };
    const available = await c.http.request<{ transitions: Array<{ id: string; to: { id: string } }> }>({ method: "GET", path: `${this.issue(input.ref)}/transitions` });
    if (!available.transitions.some(item => item.id === target.transitionId && item.to.id === target.targetStatusId)) throw new Error("UNSUPPORTED_STATUS");
    await c.http.request<unknown>({ method: "POST", path: `${this.issue(input.ref)}/transitions`, body: { transition: { id: target.transitionId } } });
    return { status: "APPLIED", operationId: input.operationId, remoteId: issue.id, url: null };
  }
  async postComment(input: SourceComment, c: PluginContext): Promise<WriteReceipt> {
    const marker = `[${operationMarker(input.operationId)}]`;
    const path = `${this.issue(input.ref)}/comment`;
    for (let startAt = 0; ; ) {
      const page = await c.http.request<{ comments: JiraComment[]; startAt: number; maxResults: number; total: number }>({ method: "GET", path, query: { startAt: String(startAt), maxResults: "100" } });
      const found = page.comments.find(comment => adfText(comment.body).includes(marker));
      if (found) return { status: "ALREADY_APPLIED", operationId: input.operationId, remoteId: found.id, url: null };
      startAt = page.startAt + page.comments.length;
      if (startAt >= page.total) break;
      if (page.comments.length === 0 || startAt >= 10000) throw new Error("WRITE_UNCERTAIN");
    }
    const created = await c.http.request<JiraComment>({ method: "POST", path, body: { body: adfBody(`${input.body}\n\n${marker}`) } });
    return { status: "APPLIED", operationId: input.operationId, remoteId: created.id, url: null };
  }
}

export class FakeConnector implements TaskSourcePlugin {
  private readonly receipts = new Map<string, WriteReceipt>();
  private readonly statuses = new Map<string, SourceStatus>();
  readonly comments: SourceComment[] = [];
  constructor(private readonly tasks: Map<string, TaskContext>, private readonly fail?: (method: string) => void) {}
  async getManifest(): Promise<PluginManifest> { return { ...manifest("oda.fake", "Fake Source", "https://fake.invalid"), httpOrigins: [] }; }
  async healthCheck(_c: PluginContext): Promise<HealthResult> { return { healthy: true, identity: "fake", capabilities: (await this.getManifest()).capabilities, warnings: [] }; }
  async normalizePayload(input: NormalizeInput, _c: PluginContext): Promise<SourceTaskRef> {
    const key = input.kind === "identifier" ? input.identifier : text(record(input.payload)["key"]);
    return { externalId: key, key };
  }
  async fetchTask(ref: SourceTaskRef, _c: PluginContext): Promise<TaskContext> {
    this.fail?.("fetchTask");
    const task = this.tasks.get(ref.externalId);
    if (!task) throw new Error("NOT_FOUND");
    return structuredClone(task);
  }
  async updateStatus(input: StatusUpdate, _c: PluginContext): Promise<WriteReceipt> {
    this.fail?.("updateStatus");
    const previous = this.receipts.get(input.operationId);
    if (previous) return { ...previous, status: "ALREADY_APPLIED" };
    this.statuses.set(input.ref.externalId, input.status);
    const receipt: WriteReceipt = { status: "APPLIED", operationId: input.operationId, remoteId: input.ref.externalId, url: null };
    this.receipts.set(input.operationId, receipt);
    return receipt;
  }
  async postComment(input: SourceComment, _c: PluginContext): Promise<WriteReceipt> {
    this.fail?.("postComment");
    const previous = this.receipts.get(input.operationId);
    if (previous) return { ...previous, status: "ALREADY_APPLIED" };
    this.comments.push(structuredClone(input));
    const receipt: WriteReceipt = { status: "APPLIED", operationId: input.operationId, remoteId: String(this.comments.length), url: null };
    this.receipts.set(input.operationId, receipt);
    return receipt;
  }
}
