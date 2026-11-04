import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import schema from "../../../docs/reference/schemas.json" with { type: "json" };
import type {
  ApiError,
  Clarification,
  DecisionReceipt,
  GateDecisionInput,
  Json,
  Plan,
  PluginManifest,
  RepositoryInventory,
  RunManifest,
  StepProjection,
  TaskContext,
  WorkflowProjection,
} from "./generated.js";

export * from "./generated.js";

export class ContractValidationError extends Error {
  constructor(readonly errors: ErrorObject[]) {
    super("Contract validation failed");
    this.name = "ContractValidationError";
  }
}

const require = createRequire(import.meta.url);
interface AjvLike {
  addSchema(value: unknown): void;
  getSchema(reference: string): ValidateFunction | undefined;
}
const ajvModule = require("ajv/dist/2020") as
  | { default?: new (options: object) => AjvLike }
  | (new (options: object) => AjvLike);
const formatModule = require("ajv-formats") as
  | { default?: (instance: AjvLike) => void }
  | ((instance: AjvLike) => void);
const Ajv = typeof ajvModule === "function" ? ajvModule : ajvModule.default!;
const addFormats = typeof formatModule === "function" ? formatModule : formatModule.default!;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);

function validator<T>(definition: string): (value: unknown) => T {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`) as ValidateFunction<T> | undefined;
  if (!validate) throw new Error(`Missing schema definition: ${definition}`);
  return (value: unknown): T => {
    if (!validate(value)) throw new ContractValidationError(validate.errors ?? []);
    return value as T;
  };
}

export const validateTaskContext = validator<TaskContext>("TaskContext");
export const validatePluginManifest = validator<PluginManifest>("PluginManifest");
export const validateApiError = validator<ApiError>("ApiError");
export const validateRunManifest = validator<RunManifest>("RunManifest");
export const validateRepositoryInventory = validator<RepositoryInventory>("RepositoryInventory");
export const validateClarification = validator<Clarification>("Clarification");
export const validatePlan = validator<Plan>("Plan");
export const validateWorkflowProjection = validator<WorkflowProjection>("WorkflowProjection");
export const validateStepProjection = validator<StepProjection>("StepProjection");
export const validateGateDecisionInput = validator<GateDecisionInput>("GateDecisionInput");
export const validateDecisionReceipt = validator<DecisionReceipt>("DecisionReceipt");

export function apiError(
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details: Json = {},
): ApiError {
  return validateApiError({ error: { code, message, requestId, retryable, details } });
}

/** Extension keys that carry a planned work date, in precedence order. */
export const PLANNING_EXTENSIONS = ["community.tempo.planning", "community.jira.planning"] as const;

function isCalendarDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/** Returns the customer a task is for: the Odoo partner, else the customer field found on the Jira issue. */
export function taskCustomer(context: Pick<TaskContext, "extensions">): string | null {
  for (const key of ["community.odoo.task", "community.jira.customer"]) {
    const raw = (context.extensions?.[key] as { customer?: unknown } | undefined)?.customer;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

/** Extension holding the source's comments (Jira) or chatter (Odoo), oldest first. */
export const DISCUSSION_EXTENSION = "community.source.discussion";
export interface DiscussionMessage {
  author: string | null;
  at: string;
  /** "internal" is an internal note or a Jira Service Management comment the customer cannot see. */
  kind: "comment" | "internal" | "email";
  text: string;
  /** Source ids of files attached to this message; images among them match SourceImage.sourceId. */
  attachmentIds?: string[];
}
export interface TaskDiscussion {
  messages: DiscussionMessage[];
  /** Older messages left out to bound what is sent to the model; a lower bound when the source has no count. */
  omitted: number;
  /** Set when the source could not return the discussion; the task itself was still read. */
  unavailable?: string;
}

/** Returns the discussion stored on a task context, or null when the source provided none. */
export function taskDiscussion(context: Pick<TaskContext, "extensions">): TaskDiscussion | null {
  const raw = context.extensions?.[DISCUSSION_EXTENSION] as Partial<TaskDiscussion> | undefined;
  if (!raw || !Array.isArray(raw.messages)) return null;
  return {
    messages: raw.messages.filter(
      (m): m is DiscussionMessage => typeof m?.text === "string" && typeof m.at === "string",
    ),
    omitted: typeof raw.omitted === "number" ? raw.omitted : 0,
    ...(typeof raw.unavailable === "string" ? { unavailable: raw.unavailable } : {}),
  };
}

/** Extension listing the images of a task (description, discussion or attachments) whose bytes are stored by sha. */
export const SOURCE_IMAGES_EXTENSION = "community.source.images";
/** Media types the model accepts as image input. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export interface SourceImage {
  /** Stable source identity, for example the Odoo attachment id with its checksum, used to skip re-downloads. */
  ref: string;
  /** Source attachment id, for example "odoo:1234", matched by DiscussionMessage.attachmentIds. */
  sourceId: string;
  /** sha256 of the stored bytes; the worker loads the image by this hash. */
  sha256: string;
  name: string;
  mediaType: ImageMediaType;
  sizeBytes: number;
  origin: "description" | "discussion" | "attachment";
  /** For discussion images: when the message carrying it was posted. */
  messageAt?: string | null;
}
export interface TaskImages {
  images: SourceImage[];
  /** Images the task refers to that were not included, with the reason (too large, unreadable, over the cap). */
  missing: Array<{ name: string; reason: string }>;
  /** Set when the source refused the image listing; the task itself was still read. */
  unavailable?: string;
}

/** Returns the images stored on a task context, or null when the source provided none. */
export function taskImages(context: Pick<TaskContext, "extensions">): TaskImages | null {
  const raw = context.extensions?.[SOURCE_IMAGES_EXTENSION] as Partial<TaskImages> | undefined;
  if (!raw || !Array.isArray(raw.images)) return null;
  return {
    images: raw.images.filter(
      (i): i is SourceImage =>
        typeof i?.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(i.sha256) &&
        (IMAGE_MEDIA_TYPES as readonly string[]).includes(i.mediaType),
    ),
    missing: Array.isArray(raw.missing) ? raw.missing.filter((m) => typeof m?.name === "string") : [],
    ...(typeof raw.unavailable === "string" ? { unavailable: raw.unavailable } : {}),
  };
}

/** Returns the planned date of a task context, preferring Tempo planning over the Jira due date. */
export function plannedFor(context: Pick<TaskContext, "extensions">): string | null {
  for (const key of PLANNING_EXTENSIONS) {
    const raw = (context.extensions?.[key] as { plannedFor?: unknown } | undefined)?.plannedFor;
    if (isCalendarDate(raw)) return raw;
  }
  return null;
}
