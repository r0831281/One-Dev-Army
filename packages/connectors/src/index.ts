import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TaskContext } from "../../contracts/src/index.js";
import { validateTaskContext } from "../../contracts/src/index.js";

export interface SourceRef {
  externalId: string;
  key: string;
}
export interface ConnectorContext {
  instanceId: string;
  repository: { id: string; baseSha: string };
  fetchedAt: string;
}
export interface ScopedHttp {
  request<T>(request: { method: string; url: string; body?: unknown }): Promise<T>;
}
export interface TaskConnector {
  normalize(identifierOrPayload: string | Record<string, unknown>): SourceRef;
  fetchTask(ref: SourceRef, context: ConnectorContext): Promise<TaskContext>;
  updateStatus(input: StatusUpdate): Promise<WriteReceipt>;
  postComment(input: SourceComment): Promise<WriteReceipt>;
}
export type SourceStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export interface StatusUpdate {
  ref: SourceRef;
  status: SourceStatus;
  operationId: string;
}
export interface SourceComment {
  ref: SourceRef;
  body: string;
  operationId: string;
}
export interface WriteReceipt {
  status: "APPLIED" | "ALREADY_APPLIED" | "UNCERTAIN";
  operationId: string;
  remoteId: string | null;
  url: string | null;
}
function marker(operationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw new Error("VALIDATION_FAILED");
  return `oda-operation:${operationId}`;
}

function base(
  context: ConnectorContext,
  ref: SourceRef,
  fields: Omit<
    TaskContext,
    "schemaVersion" | "taskId" | "revision" | "source" | "repository" | "constraints" | "provenance"
  > & { url: string; sourceRevision: string | null; pluginId: string },
): TaskContext {
  return validateTaskContext({
    schemaVersion: "1.0",
    taskId: randomUUID(),
    revision: 1,
    source: {
      instanceId: context.instanceId,
      externalId: ref.externalId,
      key: ref.key,
      url: fields.url,
      revision: fields.sourceRevision,
    },
    repository: context.repository,
    title: fields.title,
    description: fields.description,
    acceptanceCriteria: fields.acceptanceCriteria,
    attachments: fields.attachments,
    labels: fields.labels,
    requester: fields.requester,
    constraints: [],
    provenance: {
      fetchedAt: context.fetchedAt,
      pluginId: fields.pluginId,
      pluginVersion: "1.0.0",
      payloadArtifactId: null,
    },
    ...(fields.extensions ? { extensions: fields.extensions } : {}),
  });
}

export class FakeConnector implements TaskConnector {
  private readonly receipts = new Map<string, WriteReceipt>();
  readonly comments: SourceComment[] = [];
  constructor(
    private readonly tasks: ReadonlyMap<string, Omit<TaskContext, "taskId" | "revision"> | TaskContext>,
  ) {}
  normalize(input: string | Record<string, unknown>): SourceRef {
    const key = typeof input === "string" ? input : input.key;
    if (typeof key !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(key))
      throw new Error("VALIDATION_FAILED");
    return { externalId: key, key };
  }
  async fetchTask(ref: SourceRef, _context: ConnectorContext): Promise<TaskContext> {
    const task = this.tasks.get(ref.externalId);
    if (!task) throw new Error("NOT_FOUND");
    return validateTaskContext({
      ...structuredClone(task),
      taskId: "taskId" in task ? task.taskId : randomUUID(),
      revision: 1,
    });
  }
  async updateStatus(input: StatusUpdate): Promise<WriteReceipt> {
    return this.write(input.operationId, input.ref.externalId);
  }
  async postComment(input: SourceComment): Promise<WriteReceipt> {
    const prior = this.receipts.get(input.operationId);
    if (prior) return { ...prior, status: "ALREADY_APPLIED" };
    this.comments.push(structuredClone(input));
    return this.write(input.operationId, String(this.comments.length));
  }
  private write(operationId: string, remoteId: string): WriteReceipt {
    const prior = this.receipts.get(operationId);
    if (prior) return { ...prior, status: "ALREADY_APPLIED" };
    const receipt: WriteReceipt = { status: "APPLIED", operationId, remoteId, url: null };
    this.receipts.set(operationId, receipt);
    return receipt;
  }
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  user: { id: number; login: string } | null;
  pull_request?: unknown;
}
interface GitHubComment {
  id: number;
  body: string;
  html_url: string;
}
export class GitHubConnector implements TaskConnector {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly http: ScopedHttp,
    private readonly origin = "https://api.github.com",
    private readonly statusMap: Partial<
      Record<SourceStatus, { state: "open" | "closed"; label?: string }>
    > = { OPEN: { state: "open" }, DONE: { state: "closed" } },
  ) {}
  normalize(input: string | Record<string, unknown>): SourceRef {
    let identifier =
      typeof input === "string"
        ? input
        : `${(input.repository as { full_name?: unknown } | undefined)?.full_name}#${(input.issue as { number?: unknown } | undefined)?.number}`;
    const prefix = `${this.owner}/${this.repo}#`;
    if (!identifier.startsWith(prefix) || !/^[1-9]\d*$/.test(identifier.slice(prefix.length)))
      throw new Error("POLICY_DENIED");
    return { externalId: identifier.slice(prefix.length), key: identifier };
  }
  async fetchTask(ref: SourceRef, context: ConnectorContext): Promise<TaskContext> {
    if (ref.key !== `${this.owner}/${this.repo}#${ref.externalId}`) throw new Error("POLICY_DENIED");
    const issue = await this.http.request<GitHubIssue>({
      method: "GET",
      url: `${this.origin}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${ref.externalId}`,
    });
    if (issue.pull_request) throw new Error("UNSUPPORTED_CAPABILITY");
    return base(context, ref, {
      title: issue.title,
      description: issue.body ?? "",
      url: issue.html_url,
      sourceRevision: issue.updated_at,
      labels: issue.labels.map((label) => label.name),
      requester: issue.user ? { id: String(issue.user.id), displayName: issue.user.login } : null,
      acceptanceCriteria: [],
      attachments: [],
      pluginId: "community.github",
    });
  }
  private issueUrl(ref: SourceRef): string {
    if (ref.key !== `${this.owner}/${this.repo}#${ref.externalId}` || !/^[1-9]\d*$/.test(ref.externalId))
      throw new Error("POLICY_DENIED");
    return `${this.origin}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${ref.externalId}`;
  }
  async updateStatus(input: StatusUpdate): Promise<WriteReceipt> {
    const mapped = this.statusMap[input.status];
    if (!mapped) throw new Error("UNSUPPORTED_STATUS");
    const current = await this.http.request<GitHubIssue>({ method: "GET", url: this.issueUrl(input.ref) });
    const managed = new Set(
      Object.values(this.statusMap).flatMap((value) => (value?.label ? [value.label] : [])),
    );
    const desired = [
      ...current.labels.map((label) => label.name).filter((label) => !managed.has(label)),
      ...(mapped.label ? [mapped.label] : []),
    ];
    const unchanged =
      current.state === mapped.state &&
      current.labels
        .map((label) => label.name)
        .sort()
        .join("\n") === [...desired].sort().join("\n");
    if (!unchanged) {
      try {
        await this.http.request({
          method: "PATCH",
          url: this.issueUrl(input.ref),
          body: { state: mapped.state, labels: desired },
        });
      } catch {
        return {
          status: "UNCERTAIN",
          operationId: input.operationId,
          remoteId: String(current.id),
          url: current.html_url,
        };
      }
    }
    return {
      status: unchanged ? "ALREADY_APPLIED" : "APPLIED",
      operationId: input.operationId,
      remoteId: String(current.id),
      url: current.html_url,
    };
  }
  async postComment(input: SourceComment): Promise<WriteReceipt> {
    const operationMarker = `<!-- ${marker(input.operationId)} -->`;
    const url = `${this.issueUrl(input.ref)}/comments`;
    for (let page = 1; page <= 100; page++) {
      const comments = await this.http.request<GitHubComment[]>({
        method: "GET",
        url: `${url}?per_page=100&page=${page}`,
      });
      const found = comments.find((comment) => comment.body.includes(operationMarker));
      if (found)
        return {
          status: "ALREADY_APPLIED",
          operationId: input.operationId,
          remoteId: String(found.id),
          url: found.html_url,
        };
      if (comments.length < 100) break;
    }
    try {
      const created = await this.http.request<GitHubComment>({
        method: "POST",
        url,
        body: { body: `${input.body}\n\n${operationMarker}` },
      });
      return {
        status: "APPLIED",
        operationId: input.operationId,
        remoteId: String(created.id),
        url: created.html_url,
      };
    } catch {
      return { status: "UNCERTAIN", operationId: input.operationId, remoteId: null, url: null };
    }
  }
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    [key: string]: unknown;
    summary: string;
    description: unknown;
    labels: string[];
    updated: string;
    project: { key: string };
    reporter: { accountId: string; displayName: string } | null;
  };
}
interface JiraComment {
  id: string;
  body: unknown;
}
function adfText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown[]; type?: unknown };
  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content) ? node.content.map(adfText).join("") : "";
  return own + children + (["paragraph", "heading", "listItem"].includes(String(node.type)) ? "\n" : "");
}
export class JiraConnector implements TaskConnector {
  constructor(
    private readonly origin: string,
    private readonly projectKey: string,
    private readonly http: ScopedHttp,
    private readonly statusMap: Partial<
      Record<SourceStatus, { transitionId: string; targetStatusId: string }>
    > = {},
    private readonly planningField = "duedate",
  ) {}
  normalize(input: string | Record<string, unknown>): SourceRef {
    const key = typeof input === "string" ? input : (input.issue as { key?: unknown } | undefined)?.key;
    if (typeof key !== "string" || !new RegExp(`^${this.projectKey}-[1-9]\\d*$`).test(key))
      throw new Error("POLICY_DENIED");
    return { externalId: key, key };
  }
  async fetchTask(ref: SourceRef, context: ConnectorContext): Promise<TaskContext> {
    const issue = await this.http.request<JiraIssue>({
      method: "GET",
      url: `${this.origin}/rest/api/3/issue/${encodeURIComponent(ref.key)}`,
    });
    if (issue.fields.project.key !== this.projectKey) throw new Error("POLICY_DENIED");
    const planningValue = issue.fields[this.planningField];
    const plannedFor =
      typeof planningValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(planningValue) ? planningValue : null;
    return base(
      context,
      { externalId: issue.id, key: issue.key },
      {
        title: issue.fields.summary,
        description: adfText(issue.fields.description).trim(),
        url: `${this.origin}/browse/${encodeURIComponent(issue.key)}`,
        sourceRevision: issue.fields.updated,
        labels: issue.fields.labels,
        requester: issue.fields.reporter
          ? { id: issue.fields.reporter.accountId, displayName: issue.fields.reporter.displayName }
          : null,
        acceptanceCriteria: [],
        attachments: [],
        pluginId: "community.jira",
        extensions: {
          "community.jira.planning": {
            plannedFor,
            field: this.planningField,
          },
        },
      },
    );
  }
  private issueUrl(ref: SourceRef): string {
    if (!new RegExp(`^${this.projectKey}-[1-9]\\d*$`).test(ref.key)) throw new Error("POLICY_DENIED");
    return `${this.origin}/rest/api/3/issue/${encodeURIComponent(ref.key)}`;
  }
  async updateStatus(input: StatusUpdate): Promise<WriteReceipt> {
    const target = this.statusMap[input.status];
    if (!target) throw new Error("UNSUPPORTED_STATUS");
    const issue = await this.http.request<
      JiraIssue & { fields: JiraIssue["fields"] & { status: { id: string } } }
    >({ method: "GET", url: `${this.issueUrl(input.ref)}?fields=status` });
    if (issue.fields.status.id === target.targetStatusId)
      return {
        status: "ALREADY_APPLIED",
        operationId: input.operationId,
        remoteId: issue.id,
        url: `${this.origin}/browse/${encodeURIComponent(input.ref.key)}`,
      };
    const transitions = await this.http.request<{ transitions: Array<{ id: string; to: { id: string } }> }>({
      method: "GET",
      url: `${this.issueUrl(input.ref)}/transitions`,
    });
    if (
      !transitions.transitions.some(
        (item) => item.id === target.transitionId && item.to.id === target.targetStatusId,
      )
    )
      throw new Error("UNSUPPORTED_STATUS");
    try {
      await this.http.request({
        method: "POST",
        url: `${this.issueUrl(input.ref)}/transitions`,
        body: { transition: { id: target.transitionId } },
      });
      return {
        status: "APPLIED",
        operationId: input.operationId,
        remoteId: issue.id,
        url: `${this.origin}/browse/${encodeURIComponent(input.ref.key)}`,
      };
    } catch {
      return { status: "UNCERTAIN", operationId: input.operationId, remoteId: issue.id, url: null };
    }
  }
  async postComment(input: SourceComment): Promise<WriteReceipt> {
    const operationMarker = `[${marker(input.operationId)}]`;
    const url = `${this.issueUrl(input.ref)}/comment`;
    for (let startAt = 0; startAt < 10_000; ) {
      const page = await this.http.request<{ comments: JiraComment[]; startAt: number; total: number }>({
        method: "GET",
        url: `${url}?startAt=${startAt}&maxResults=100`,
      });
      const found = page.comments.find((comment) => adfText(comment.body).includes(operationMarker));
      if (found)
        return { status: "ALREADY_APPLIED", operationId: input.operationId, remoteId: found.id, url: null };
      if (page.startAt + page.comments.length >= page.total) break;
      if (page.comments.length === 0)
        return { status: "UNCERTAIN", operationId: input.operationId, remoteId: null, url: null };
      startAt = page.startAt + page.comments.length;
    }
    const body = {
      type: "doc",
      version: 1,
      content: `${input.body}\n\n${operationMarker}`
        .split("\n")
        .map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })),
    };
    try {
      const created = await this.http.request<JiraComment>({ method: "POST", url, body: { body } });
      return { status: "APPLIED", operationId: input.operationId, remoteId: created.id, url: null };
    } catch {
      return { status: "UNCERTAIN", operationId: input.operationId, remoteId: null, url: null };
    }
  }
}

export function verifyWebhook(
  rawBody: Buffer,
  signature: string,
  secret: Buffer,
  timestamp: string,
  now = Date.now(),
  toleranceMs = 300_000,
): void {
  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > toleranceMs)
    throw new Error("WEBHOOK_REPLAYED_OR_EXPIRED");
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest();
  const suppliedHex = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const supplied = /^[a-f0-9]{64}$/i.test(suppliedHex) ? Buffer.from(suppliedHex, "hex") : Buffer.alloc(0);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("WEBHOOK_SIGNATURE_INVALID");
}
