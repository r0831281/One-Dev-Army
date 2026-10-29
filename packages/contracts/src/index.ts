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

/** Returns the planned date of a task context, preferring Tempo planning over the Jira due date. */
export function plannedFor(context: Pick<TaskContext, "extensions">): string | null {
  for (const key of PLANNING_EXTENSIONS) {
    const raw = (context.extensions?.[key] as { plannedFor?: unknown } | undefined)?.plannedFor;
    if (isCalendarDate(raw)) return raw;
  }
  return null;
}
