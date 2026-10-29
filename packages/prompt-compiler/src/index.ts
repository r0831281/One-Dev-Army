import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_COMPILER_VERSION = "1.0.0";
export const SYSTEM_TEMPLATE_REVISION = 1;

export type AgentRole =
  | "context-reviewer"
  | "planner"
  | "implementer"
  | "tester"
  | "reviewer"
  | "reporter"
  | "setup-onboarding";

export interface SoulSpec {
  identity: string;
  objective: string;
  domainPractices: string[];
  workingStyle: string[];
  toolGuidance: string[];
  outputSchemaRef: string;
}

export interface AgentProfile {
  schemaVersion: "1.0";
  id: string;
  name: string;
  revision: number;
  role: AgentRole;
  provider: "fake" | "ollama" | "openai" | "anthropic" | "gemini" | "openrouter" | "bedrock";
  model: string;
  credentialRef: string | null;
  providerOptions: {
    temperature?: number | null;
    reasoningEffort?: "low" | "medium" | "high" | null;
    jsonSchema?: boolean;
  };
  limits: { maxInputTokens: number; maxOutputTokens: number; timeoutMs: number; maxModelCalls: number };
  tools: string[];
  prompt: { templateId: "system-v1"; templateRevision: 1; intent: string; compiledArtifactId: string | null };
  outputSchemaRef: string;
  retryPolicy: { transportAttempts: number; structuredOutputRepairs: number };
  fallbackProfileIds: string[];
  localOnly: boolean;
}

const roleTools: Record<AgentRole, ReadonlySet<string>> = {
  "context-reviewer": new Set(["repo.read", "repo.search"]),
  planner: new Set(["repo.read", "repo.search"]),
  implementer: new Set(["repo.read", "repo.search", "sandbox.write", "sandbox.exec"]),
  tester: new Set(["repo.read", "sandbox.exec"]),
  reviewer: new Set(["repo.read", "repo.search", "sandbox.exec"]),
  reporter: new Set(["artifact.read"]),
  "setup-onboarding": new Set(["setup.probe", "setup.propose"]),
};

export function validateProfile(profile: AgentProfile): AgentProfile {
  if (profile.schemaVersion !== "1.0" || profile.revision < 1) throw new Error("INVALID_PROFILE");
  if (!profile.id || !profile.name || !profile.model || profile.name.length > 120)
    throw new Error("INVALID_PROFILE");
  if (profile.prompt.templateId !== "system-v1" || profile.prompt.templateRevision !== 1)
    throw new Error("UNSUPPORTED_TEMPLATE");
  if (profile.outputSchemaRef !== profile.prompt.intent && profile.outputSchemaRef.length === 0)
    throw new Error("INVALID_PROFILE");
  if (profile.localOnly && profile.provider !== "fake" && profile.provider !== "ollama")
    throw new Error("LOCAL_ONLY_PROVIDER_DENIED");
  const allowed = roleTools[profile.role];
  if (
    new Set(profile.tools).size !== profile.tools.length ||
    profile.tools.some((tool) => !allowed.has(tool))
  )
    throw new Error("CAPABILITY_DENIED");
  const { limits, retryPolicy } = profile;
  if (
    limits.maxInputTokens < 1 ||
    limits.maxOutputTokens < 1 ||
    limits.timeoutMs < 100 ||
    limits.maxModelCalls < 1 ||
    retryPolicy.transportAttempts < 0 ||
    retryPolicy.structuredOutputRepairs < 0
  )
    throw new Error("INVALID_PROFILE");
  return structuredClone(profile);
}

export interface CompileInput {
  profile: AgentProfile;
  soul: SoulSpec;
  baseSha: string;
  approvedPlanHash: string | null;
  constraints: string[];
  effectiveTools: string[];
  remainingLimits: Record<string, number>;
  schemaHash: string;
  policyHash: string;
  taskContent: string;
}

export interface PromptArtifact {
  schemaVersion: "1.0";
  compilerVersion: string;
  templateRevision: number;
  profile: { id: string; revision: number; role: AgentRole; provider: string; model: string };
  soul: SoulSpec;
  validation: { effectiveTools: string[]; rejectedTools: string[] };
  messages: Array<{ role: "system" | "user"; content: string }>;
  schemaHash: string;
  policyHash: string;
  promptHash: string;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export const hashPromptValue = (value: unknown): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");

function validateSoul(soul: SoulSpec, outputSchemaRef: string): SoulSpec {
  if (!soul.identity.trim() || !soul.objective.trim() || soul.outputSchemaRef !== outputSchemaRef)
    throw new Error("INVALID_SOUL_SPEC");
  if ([...soul.domainPractices, ...soul.workingStyle, ...soul.toolGuidance].some((v) => v.length > 2_000))
    throw new Error("INVALID_SOUL_SPEC");
  const forbidden = /credential|secret|disable.{0,20}gate|ignore.{0,20}(policy|instruction)/iu;
  if (soul.toolGuidance.some((guidance) => forbidden.test(guidance))) throw new Error("SOUL_POLICY_DENIED");
  return structuredClone(soul);
}

export async function compilePrompt(input: CompileInput): Promise<PromptArtifact> {
  const profile = validateProfile(input.profile);
  const soul = validateSoul(input.soul, profile.outputSchemaRef);
  const effectiveTools = [...new Set(input.effectiveTools)]
    .filter((tool) => profile.tools.includes(tool))
    .sort();
  const rejectedTools = [...new Set(input.effectiveTools)]
    .filter((tool) => !profile.tools.includes(tool))
    .sort();
  const installedTemplate = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "system-v1.txt");
  const sourceTemplate = join(process.cwd(), "packages", "prompt-compiler", "templates", "system-v1.txt");
  const template = normalizeText(
    await readFile(installedTemplate, "utf8").catch(() => readFile(sourceTemplate, "utf8")),
  );
  const values: Record<string, string> = {
    role_identity: normalizeText(soul.identity),
    objective: normalizeText(soul.objective),
    base_sha: input.baseSha,
    approved_plan_hash_or_none: input.approvedPlanHash ?? "none",
    constraint_ledger: canonical(input.constraints.map(normalizeText)),
    effective_tool_policy: canonical(effectiveTools),
    remaining_limits: canonical(input.remainingLimits),
    output_schema_ref: soul.outputSchemaRef,
  };
  const system = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`TEMPLATE_VALUE_MISSING:${key}`);
    return value;
  });
  const unsigned = {
    schemaVersion: "1.0" as const,
    compilerVersion: PROMPT_COMPILER_VERSION,
    templateRevision: SYSTEM_TEMPLATE_REVISION,
    profile: {
      id: profile.id,
      revision: profile.revision,
      role: profile.role,
      provider: profile.provider,
      model: profile.model,
    },
    soul,
    validation: { effectiveTools, rejectedTools },
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: `UNTRUSTED TASK CONTENT\n${normalizeText(input.taskContent)}` },
    ],
    schemaHash: input.schemaHash,
    policyHash: input.policyHash,
  };
  return { ...unsigned, promptHash: hashPromptValue(unsigned) };
}
