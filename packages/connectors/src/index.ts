import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DiscussionMessage,
  SourceImage,
  TaskContext,
  TaskDiscussion,
  TaskImages,
} from "../../contracts/src/index.js";
import {
  DISCUSSION_EXTENSION,
  IMAGE_MEDIA_TYPES,
  SOURCE_IMAGES_EXTENSION,
  validateTaskContext,
} from "../../contracts/src/index.js";

export interface SourceRef {
  externalId: string;
  key: string;
}
export interface ConnectorContext {
  instanceId: string;
  repository: { id: string; baseSha: string };
  fetchedAt: string;
  /** Planning known for this task from a separate planning source (Tempo), merged into the context. */
  planning?: TaskPlanning;
  /**
   * Set when the repository was chosen for this task (by key prefix) rather than by the connector.
   * Moving the pin to another repository or commit must yield a new context revision.
   */
  repositoryPinned?: boolean;
  /** Where image bytes are kept; without it the connector reads no images. */
  images?: ImageStore;
}
/** Content store for source images, keyed by a source ref that includes the image's version. */
export interface ImageStore {
  known(refs: string[]): Promise<Map<string, { sha256: string; mediaType: string; sizeBytes: number }>>;
  put(ref: string, mediaType: string, bytes: Uint8Array): Promise<string>;
}
export interface TaskPlanning {
  plannedFor: string | null;
  dates: Array<{ date: string; seconds: number }>;
  jiraKey: string;
  planIds: string[];
}
export const TEMPO_PLANNING_EXTENSION = "community.tempo.planning";
export interface ScopedHttp {
  request<T>(request: { method: string; url: string; body?: unknown }): Promise<T>;
  /** Raw bytes of a GET response, refused above maxBytes. Only GET-scoped transports offer it. */
  download?(request: { method: "GET"; url: string }, maxBytes: number): Promise<Uint8Array>;
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
  const extensions = context.planning
    ? { ...fields.extensions, [TEMPO_PLANNING_EXTENSION]: context.planning }
    : fields.extensions;
  // Context revisions are keyed by source revision, so a moved plan must yield a distinct revision.
  const tag = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  let revision = fields.sourceRevision;
  if (revision !== null && context.planning) revision = `${revision}|plan:${tag(context.planning)}`;
  if (revision !== null && context.repositoryPinned) revision = `${revision}|repo:${tag(context.repository)}`;
  // Odoo chatter does not touch write_date, so a new or edited message must change the revision itself.
  const discussion = fields.extensions?.[DISCUSSION_EXTENSION];
  const images = fields.extensions?.[SOURCE_IMAGES_EXTENSION];
  if (revision !== null && discussion)
    revision = `${revision}|talk:${tag(images ? { discussion, images } : discussion)}`;
  else if (revision !== null && images) revision = `${revision}|images:${tag(images)}`;
  return validateTaskContext({
    schemaVersion: "1.0",
    taskId: randomUUID(),
    revision: 1,
    source: {
      instanceId: context.instanceId,
      externalId: ref.externalId,
      key: ref.key,
      url: fields.url,
      revision,
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
    ...(extensions ? { extensions } : {}),
  });
}

/** Newest messages fetched per task; older ones are counted as omitted. */
const DISCUSSION_FETCH = 50;
const DISCUSSION_MESSAGE_CHARS = 4_000;
const DISCUSSION_TOTAL_CHARS = 40_000;
/**
 * Bounds a discussion before it is stored and sent to the model: keeps the newest messages within the size caps and
 * returns them oldest first.
 */
export function boundDiscussion(newestFirst: DiscussionMessage[], total: number): TaskDiscussion {
  const kept: DiscussionMessage[] = [];
  let chars = 0;
  for (const message of newestFirst) {
    const text = message.text.trim() || (message.attachmentIds?.length ? "(attachment only)" : "");
    if (!text) {
      total--;
      continue;
    }
    const clipped =
      text.length > DISCUSSION_MESSAGE_CHARS ? `${text.slice(0, DISCUSSION_MESSAGE_CHARS)}…` : text;
    if (chars + clipped.length > DISCUSSION_TOTAL_CHARS) break;
    chars += clipped.length;
    kept.push({ ...message, text: clipped });
  }
  return { messages: kept.reverse(), omitted: Math.max(0, total - kept.length) };
}
/** Errors that will not clear on the next sync: the source refuses or cannot answer the comment read. */
const PERMANENT_DISCUSSION_ERRORS = /^CONNECTOR_(HTTP_40[0134]|REMOTE_ERROR|SCOPE_DENIED)$/;
/**
 * A permanent comment-read failure keeps the task readable and tells the agents the comments are missing. Transient
 * failures are rethrown so the sync keeps the last good context instead of storing a revision without comments.
 */
function unavailableDiscussion(error: unknown): TaskDiscussion {
  const code = error instanceof Error ? error.message : "";
  if (!PERMANENT_DISCUSSION_ERRORS.test(code)) throw error;
  return { messages: [], omitted: 0, unavailable: code };
}

/** At most this many images go to the model per task; each is also bounded in bytes. */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_IMAGE_TOTAL_BYTES = 12_000_000;
const MAX_MISSING_LISTED = 20;
interface ImageCandidate {
  sourceId: string;
  /** Store key: the source id plus a version, so a changed image is fetched again. */
  ref: string;
  name: string;
  mediaType: string;
  sizeBytes: number | null;
  origin: SourceImage["origin"];
  messageAt?: string | null;
  load(): Promise<Uint8Array>;
}
const isImageType = (type: string): type is SourceImage["mediaType"] =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
/** Magic bytes, so a mislabelled attachment never reaches the model as the wrong media type. */
function sniffImage(bytes: Uint8Array): SourceImage["mediaType"] | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  return null;
}
/**
 * Picks the images to send, in priority order, downloading only those the store does not hold yet. Permanent read
 * failures become "missing" entries; transient ones are rethrown so the sync keeps the last good context.
 */
export async function collectImages(
  candidates: ImageCandidate[],
  store: ImageStore,
  missing: TaskImages["missing"] = [],
): Promise<TaskImages> {
  const images: SourceImage[] = [];
  const skip = (name: string, reason: string) => missing.push({ name, reason });
  const eligible: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.sourceId)) continue;
    seen.add(candidate.sourceId);
    if (!isImageType(candidate.mediaType))
      skip(candidate.name, `${candidate.mediaType || "unknown type"}, only images are sent`);
    else if ((candidate.sizeBytes ?? 0) > MAX_IMAGE_BYTES) skip(candidate.name, "too large");
    else if (eligible.length >= MAX_IMAGES) skip(candidate.name, `over the ${MAX_IMAGES}-image limit`);
    else eligible.push(candidate);
  }
  let known: Awaited<ReturnType<ImageStore["known"]>>;
  try {
    known = await store.known(eligible.map((c) => c.ref));
  } catch {
    return { images: [], missing: [], unavailable: "IMAGE_STORE_FAILED" };
  }
  let total = 0;
  for (const candidate of eligible) {
    const stored = known.get(candidate.ref);
    let sha = stored?.sha256;
    let size = stored?.sizeBytes ?? 0;
    let mediaType = (stored?.mediaType ?? candidate.mediaType) as SourceImage["mediaType"];
    if (!sha) {
      let bytes: Uint8Array;
      try {
        bytes = await candidate.load();
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (!PERMANENT_DISCUSSION_ERRORS.test(code) && code !== "IMAGE_TOO_LARGE" && code !== "NOT_FOUND")
          throw error;
        skip(candidate.name, code === "IMAGE_TOO_LARGE" ? "too large" : `could not be read (${code})`);
        continue;
      }
      const sniffed = sniffImage(bytes);
      if (!sniffed) {
        skip(candidate.name, "not a readable image");
        continue;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        skip(candidate.name, "too large");
        continue;
      }
      mediaType = sniffed;
      size = bytes.byteLength;
      try {
        sha = await store.put(candidate.ref, mediaType, bytes);
      } catch {
        return { images: [], missing: [], unavailable: "IMAGE_STORE_FAILED" };
      }
    }
    if (total + size > MAX_IMAGE_TOTAL_BYTES) {
      skip(candidate.name, "over the total image size limit");
      continue;
    }
    total += size;
    images.push({
      ref: candidate.ref,
      sourceId: candidate.sourceId,
      sha256: sha,
      name: candidate.name.slice(0, 200),
      mediaType,
      sizeBytes: size,
      origin: candidate.origin,
      ...(candidate.messageAt !== undefined ? { messageAt: candidate.messageAt } : {}),
    });
  }
  return { images, missing: missing.slice(0, MAX_MISSING_LISTED) };
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
    attachment?: JiraAttachment[];
  };
}
interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
}
/** Field names that hold the customer, most specific first: JSM organizations, a custom customer field, Tempo account. */
const JIRA_CUSTOMER_FIELDS = [
  /^organi[sz]ations?$/i,
  /^(customer|klant|client)( name)?$/i,
  /^(tempo )?account$/i,
];
function jiraFieldLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value.map(jiraFieldLabel).find(Boolean) ?? null;
  if (value && typeof value === "object") {
    const record = value as { name?: unknown; value?: unknown; displayName?: unknown };
    return jiraFieldLabel(record.name ?? record.value ?? record.displayName ?? null);
  }
  return null;
}
export function jiraCustomer(
  fields: Record<string, unknown>,
  names: Record<string, string> = {},
): { customer: string; field: string } | null {
  for (const pattern of JIRA_CUSTOMER_FIELDS)
    for (const [id, name] of Object.entries(names)) {
      if (!pattern.test(name.trim())) continue;
      const customer = jiraFieldLabel(fields[id]);
      if (customer) return { customer, field: name };
    }
  return null;
}
interface JiraComment {
  id: string;
  body: unknown;
  created?: string;
  author?: { displayName?: string } | null;
  jsdPublic?: boolean;
}
function adfText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown[]; type?: unknown };
  const own = typeof node.text === "string" ? node.text : node.type === "media" ? "[image]" : "";
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
    const issue = await this.http.request<JiraIssue & { names?: Record<string, string> }>({
      method: "GET",
      url: `${this.origin}/rest/api/3/issue/${encodeURIComponent(ref.key)}?expand=names`,
    });
    if (issue.fields.project.key !== this.projectKey) throw new Error("POLICY_DENIED");
    const customer = jiraCustomer(issue.fields, issue.names);
    const discussion = await this.discussion(issue.key);
    const images = await this.images(issue, context.images);
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
        // The customer is derived, not edited, so it is part of the revision key like Tempo planning.
        sourceRevision: customer
          ? `${issue.fields.updated}|customer:${createHash("sha256").update(JSON.stringify(customer)).digest("hex").slice(0, 16)}`
          : issue.fields.updated,
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
          ...(customer ? { "community.jira.customer": customer } : {}),
          [DISCUSSION_EXTENSION]: discussion,
          ...(images ? { [SOURCE_IMAGES_EXTENSION]: images } : {}),
        },
      },
    );
  }
  /** Attachments of the issue, newest first; those shown in the description (by file name) come first. */
  private async images(issue: JiraIssue, store: ImageStore | undefined): Promise<TaskImages | null> {
    const download = this.http.download?.bind(this.http);
    if (!store || !download) return null;
    const inDescription = new Set<string>();
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const node = value as { type?: unknown; attrs?: { alt?: unknown }; content?: unknown[] };
      if (node.type === "media" && typeof node.attrs?.alt === "string") inDescription.add(node.attrs.alt);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(issue.fields.description);
    const attachments = (Array.isArray(issue.fields.attachment) ? issue.fields.attachment : [])
      .filter((a) => typeof a?.id === "string" && /^\d+$/.test(a.id))
      .sort((a, b) => b.created.localeCompare(a.created));
    const candidate = (a: JiraAttachment): ImageCandidate => ({
      sourceId: `jira:${a.id}`,
      // Jira attachment content never changes; a new upload gets a new id.
      ref: `jira:${a.id}`,
      name: a.filename,
      mediaType: a.mimeType,
      sizeBytes: a.size,
      origin: inDescription.has(a.filename) ? "description" : "attachment",
      load: () =>
        download(
          { method: "GET", url: `${this.origin}/rest/api/3/attachment/content/${a.id}?redirect=false` },
          MAX_IMAGE_BYTES,
        ),
    });
    return collectImages(
      [
        ...attachments.filter((a) => inDescription.has(a.filename)).map(candidate),
        ...attachments.filter((a) => !inDescription.has(a.filename)).map(candidate),
      ],
      store,
    );
  }
  private async discussion(key: string): Promise<TaskDiscussion> {
    try {
      const page = await this.http.request<{ comments?: JiraComment[]; total?: number }>({
        method: "GET",
        url: `${this.issueUrl({ externalId: key, key })}/comment?orderBy=-created&maxResults=${DISCUSSION_FETCH}`,
      });
      const comments = Array.isArray(page.comments) ? page.comments : [];
      return boundDiscussion(
        comments.map((comment) => ({
          author: comment.author?.displayName ?? null,
          at: comment.created ?? "",
          kind: comment.jsdPublic === false ? "internal" : "comment",
          text: adfText(comment.body),
        })),
        Math.max(comments.length, typeof page.total === "number" ? page.total : 0),
      );
    } catch (error) {
      return unavailableDiscussion(error);
    }
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

/** Odoo task keys such as `X-Y-62` or `ABC-1233`: a project code of one or more segments and a number. */
export const ODOO_TASK_KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[1-9]\d*$/;
/** RE2-safe routing pattern accepting the same keys (routing rejects nested repetition). */
export const ODOO_TASK_KEY_ROUTE = "^[A-Z][A-Z0-9-]*-[1-9][0-9]*$";

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Converts Odoo HTML fields to plain text without interpreting or executing any markup. */
export function htmlText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "[image]")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|tr|blockquote|pre|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return HTML_ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface OdooOptions {
  apiVersion: "json2" | "jsonrpc";
  database: string;
  /** Login of the API user; only the JSON-RPC protocol needs it. */
  login: string;
  keyField: string;
}
interface OdooTask {
  id: number;
  name: string;
  description: string | false;
  write_date: string;
  project_id: [number, string] | false;
  partner_id?: [number, string] | false;
  date_deadline: string | false;
  [field: string]: unknown;
}
interface OdooMessage {
  id: number;
  date: string;
  author_id: [number, string] | false;
  body: string | false;
  message_type: string;
  attachment_ids?: number[];
}
interface OdooAttachment {
  id: number;
  name: string;
  mimetype: string;
  file_size: number;
  checksum: string | false;
  create_date: string;
}
interface JsonRpcReply<T> {
  result?: T;
  error?: { data?: { name?: unknown } };
}
export class OdooConnector implements TaskConnector {
  private uid: number | null = null;
  constructor(
    private readonly origin: string,
    private readonly http: ScopedHttp,
    private readonly options: OdooOptions,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(options.keyField)) throw new Error("INVALID_CONNECTOR_SCOPE");
  }
  normalize(input: string | Record<string, unknown>): SourceRef {
    const key = typeof input === "string" ? input : input.key;
    if (typeof key !== "string" || key.length > 200 || !ODOO_TASK_KEY.test(key))
      throw new Error("POLICY_DENIED");
    return { externalId: key, key };
  }
  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    // The password position stays null: the scoped transport injects the API key.
    const reply = await this.http.request<JsonRpcReply<T>>({
      method: "POST",
      url: `${this.origin}/jsonrpc`,
      body: { jsonrpc: "2.0", method: "call", id: 1, params: { service, method, args } },
    });
    if (reply.error || reply.result === undefined) {
      const name = String(reply.error?.data?.name ?? "");
      throw new Error(
        /AccessDenied|AccessError/.test(name) ? "CONNECTOR_HTTP_403" : "CONNECTOR_REMOTE_ERROR",
      );
    }
    return reply.result;
  }
  private async searchRead<T>(
    model: "project.task" | "mail.message" | "ir.attachment",
    domain: unknown[][],
    options: { fields: string[]; limit: number; order?: string },
  ): Promise<T[]> {
    if (this.options.apiVersion === "json2")
      return this.http.request<T[]>({
        method: "POST",
        url: `${this.origin}/json/2/${model}/search_read`,
        body: { domain, ...options },
      });
    this.uid ??= await this.rpc<number | false>("common", "login", [
      this.options.database,
      this.options.login,
      null,
    ]).then((uid) => {
      if (typeof uid !== "number") throw new Error("CONNECTOR_HTTP_401");
      return uid;
    });
    return this.rpc<T[]>("object", "execute_kw", [
      this.options.database,
      this.uid,
      null,
      model,
      "search_read",
      [domain],
      options,
    ]);
  }
  private searchTasks(key: string): Promise<OdooTask[]> {
    return this.searchRead<OdooTask>("project.task", [[this.options.keyField, "=", key]], {
      fields: [
        "id",
        "name",
        "description",
        "write_date",
        "project_id",
        "date_deadline",
        "partner_id",
        this.options.keyField,
      ],
      limit: 2,
    });
  }
  /** Chatter messages and emails on the task; tracking and system notifications are left out. */
  private async discussion(taskId: number): Promise<TaskDiscussion> {
    try {
      const domain = [
        ["model", "=", "project.task"],
        ["res_id", "=", taskId],
        ["message_type", "in", ["comment", "email"]],
      ];
      const messages = await this.searchRead<OdooMessage>("mail.message", domain, {
        fields: ["id", "date", "author_id", "body", "message_type", "attachment_ids"],
        order: "id desc",
        limit: DISCUSSION_FETCH + 1,
      });
      const shown = messages.slice(0, DISCUSSION_FETCH);
      // Logged notes are internal through their subtype; is_internal only marks explicitly hidden messages. The
      // labels are a refinement, so a failed lookup keeps the messages with their plain comment/email labels.
      const internal = new Set<number>();
      if (shown.length)
        try {
          for (const { id } of await this.searchRead<{ id: number }>(
            "mail.message",
            [
              ...domain,
              ["id", "in", shown.map((m) => m.id)],
              "|",
              ["is_internal", "=", true],
              ["subtype_id.internal", "=", true],
            ] as unknown[][],
            { fields: ["id"], limit: DISCUSSION_FETCH },
          ))
            internal.add(id);
        } catch {
          internal.clear();
        }
      return boundDiscussion(
        shown.map((message) => ({
          author: message.author_id ? message.author_id[1] : null,
          at: message.date,
          kind: internal.has(message.id)
            ? "internal"
            : message.message_type === "email"
              ? "email"
              : "comment",
          text: htmlText(message.body),
          ...(message.attachment_ids?.length
            ? { attachmentIds: message.attachment_ids.map((id) => `odoo:${id}`) }
            : {}),
        })),
        // One extra row only says that more exist; the exact count would need another call, so omitted is a floor.
        shown.length + (messages.length > DISCUSSION_FETCH ? 1 : 0),
      );
    } catch (error) {
      return unavailableDiscussion(error);
    }
  }
  /**
   * Images of the task: those embedded in the description first, then those attached to chatter messages (newest
   * first), then other image attachments. Only attachments linked to this task are read.
   */
  private async images(
    task: OdooTask,
    discussion: TaskDiscussion,
    store: ImageStore | undefined,
  ): Promise<TaskImages | null> {
    if (!store) return null;
    const pinned = [
      ["res_model", "=", "project.task"],
      ["res_id", "=", task.id],
    ];
    const missing: TaskImages["missing"] = [];
    const candidates: ImageCandidate[] = [];
    const html = typeof task.description === "string" ? task.description : "";
    // Pasted images can stay inline as data URIs; they need no request.
    let inline = 0;
    for (const match of html.matchAll(
      /src\s*=\s*["']data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)["']/gi,
    )) {
      const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      candidates.push({
        sourceId: `data:${digest}`,
        ref: `data:${digest}`,
        name: `description image ${++inline}`,
        mediaType: match[1]!.toLowerCase(),
        sizeBytes: bytes.byteLength,
        origin: "description",
        load: async () => bytes,
      });
    }
    const embedded = [...html.matchAll(/\/web\/(?:image|content)\/(\d+)/g)].map((m) => Number(m[1]));
    let listed: OdooAttachment[];
    try {
      listed = await this.searchRead<OdooAttachment>(
        "ir.attachment",
        // Non-image files are listed too, so the agents learn that a PDF or spreadsheet exists but was not sent.
        pinned,
        {
          fields: ["id", "name", "mimetype", "file_size", "checksum", "create_date"],
          order: "id desc",
          limit: 50,
        },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!PERMANENT_DISCUSSION_ERRORS.test(code)) throw error;
      return { images: [], missing: [], unavailable: code };
    }
    const byId = new Map(listed.map((a) => [a.id, a]));
    const postedAt = new Map<number, string>();
    for (const message of discussion.messages)
      for (const id of message.attachmentIds ?? [])
        postedAt.set(Number(id.slice("odoo:".length)), message.at);
    const candidate = (a: OdooAttachment, origin: SourceImage["origin"]): ImageCandidate => ({
      sourceId: `odoo:${a.id}`,
      ref: `odoo:${a.id}:${a.checksum || a.create_date}`,
      name: a.name,
      mediaType: a.mimetype,
      sizeBytes: a.file_size,
      origin,
      ...(origin === "discussion" ? { messageAt: postedAt.get(a.id) ?? null } : {}),
      load: async () => {
        const [row] = await this.searchRead<{ datas: string | false }>(
          "ir.attachment",
          [...pinned, ["id", "=", a.id]],
          { fields: ["datas"], limit: 1 },
        );
        if (!row?.datas) throw new Error("NOT_FOUND");
        if (row.datas.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new Error("IMAGE_TOO_LARGE");
        return Buffer.from(row.datas, "base64");
      },
    });
    for (const id of embedded) {
      const found = byId.get(id);
      if (found) candidates.push(candidate(found, "description"));
      else missing.push({ name: `description image ${id}`, reason: "not linked to this task" });
    }
    for (const a of listed) if (postedAt.has(a.id)) candidates.push(candidate(a, "discussion"));
    for (const a of listed) candidates.push(candidate(a, "attachment"));
    return collectImages(candidates, store, missing);
  }
  async fetchTask(ref: SourceRef, context: ConnectorContext): Promise<TaskContext> {
    const key = this.normalize(ref.key).key;
    const tasks = await this.searchTasks(key);
    if (tasks.length === 0) throw new Error("NOT_FOUND");
    if (tasks.length > 1) throw new Error("AMBIGUOUS_SOURCE_KEY");
    const task = tasks[0]!;
    if (task[this.options.keyField] !== key) throw new Error("POLICY_DENIED");
    const discussion = await this.discussion(task.id);
    const images = await this.images(task, discussion, context.images);
    return base(
      context,
      { externalId: String(task.id), key },
      {
        title: task.name.slice(0, 500),
        description: htmlText(task.description).slice(0, 200_000),
        url: `${this.origin}/web#id=${task.id}&model=project.task&view_type=form`,
        sourceRevision: task.write_date,
        labels: [],
        requester: null,
        acceptanceCriteria: [],
        attachments: [],
        pluginId: "community.odoo",
        extensions: {
          "community.odoo.task": {
            id: task.id,
            project: task.project_id ? task.project_id[1] : null,
            deadline: task.date_deadline || null,
            customer: task.partner_id ? task.partner_id[1] : null,
          },
          [DISCUSSION_EXTENSION]: discussion,
          ...(images ? { [SOURCE_IMAGES_EXTENSION]: images } : {}),
        },
      },
    );
  }
  async updateStatus(_input: StatusUpdate): Promise<WriteReceipt> {
    throw new Error("UNSUPPORTED_CAPABILITY");
  }
  async postComment(_input: SourceComment): Promise<WriteReceipt> {
    throw new Error("UNSUPPORTED_CAPABILITY");
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
