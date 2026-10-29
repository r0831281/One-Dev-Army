import { createHash } from "node:crypto";
import { anthropicFinishReason } from "./anthropic.js";

export type ProviderKind = "fake" | "ollama" | "openai" | "anthropic" | "gemini" | "openrouter" | "bedrock";
export interface ProviderCapabilities {
  provider: ProviderKind;
  streaming: boolean;
  nativeTools: boolean;
  jsonSchema: boolean;
  temperature: boolean;
  reasoningControls: string[];
  cacheAccounting: boolean;
  imageInput: boolean;
  local: boolean;
}
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  source: "reported" | "estimated" | "unknown";
}
export interface GenerateRequest {
  operationId: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  outputSchema?: Record<string, unknown>;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  maxOutputTokens: number;
}
export interface GenerateResult {
  operationId: string;
  provider: ProviderKind;
  model: string;
  resolvedProvider: string | null;
  content: unknown;
  finishReason: "stop" | "length" | "tool" | "safety" | "unknown";
  usage: NormalizedUsage;
  responseHash: string;
}
export interface ProviderAdapter {
  describeCapabilities(): Promise<ProviderCapabilities>;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult>;
  cancel(operationId: string): Promise<void>;
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export class FakeProviderAdapter implements ProviderAdapter {
  private readonly active = new Map<string, AbortController>();
  readonly calls: GenerateRequest[] = [];
  constructor(private readonly responses: unknown[] = [{ ok: true }]) {}
  async describeCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider: "fake",
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
      temperature: true,
      reasoningControls: ["low", "medium", "high"],
      cacheAccounting: true,
      imageInput: false,
      local: true,
    };
  }
  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    if (this.calls.some((call) => call.operationId === request.operationId))
      throw new Error("DUPLICATE_PROVIDER_OPERATION");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    this.active.set(request.operationId, controller);
    try {
      this.calls.push(structuredClone(request));
      if (controller.signal.aborted) throw new Error("PROVIDER_CANCELLED");
      const content = structuredClone(this.responses[this.calls.length - 1] ?? this.responses.at(-1));
      const usage: NormalizedUsage = {
        inputTokens: request.messages.reduce(
          (sum, message) => sum + Math.ceil(message.content.length / 4),
          0,
        ),
        outputTokens: Math.ceil(JSON.stringify(content).length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        source: "estimated",
      };
      const result = {
        operationId: request.operationId,
        provider: "fake" as const,
        model: request.model,
        resolvedProvider: null,
        content,
        finishReason: "stop" as const,
        usage,
      };
      return { ...result, responseHash: sha(result) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.active.delete(request.operationId);
    }
  }
  async cancel(operationId: string): Promise<void> {
    this.active.get(operationId)?.abort("cancelled");
  }
}

export function normalizeUsageFixture(
  provider: ProviderKind,
  fixture: Record<string, unknown>,
): NormalizedUsage {
  const usage = (fixture.usage ?? fixture.usageMetadata ?? {}) as Record<string, unknown>;
  if (provider === "anthropic") {
    return {
      inputTokens: nonnegative(usage.input_tokens),
      outputTokens: nonnegative(usage.output_tokens),
      cacheReadTokens: nonnegative(usage.cache_read_input_tokens),
      cacheWriteTokens: nonnegative(usage.cache_creation_input_tokens),
      reasoningTokens: null,
      source: "reported",
    };
  }
  if (provider === "gemini") {
    return {
      inputTokens: nonnegative(usage.promptTokenCount),
      outputTokens: nonnegative(usage.candidatesTokenCount),
      cacheReadTokens: nonnegative(usage.cachedContentTokenCount),
      cacheWriteTokens: null,
      reasoningTokens: nonnegative(usage.thoughtsTokenCount),
      source: "reported",
    };
  }
  if (provider === "ollama") {
    return {
      inputTokens: nonnegative(fixture.prompt_eval_count),
      outputTokens: nonnegative(fixture.eval_count),
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      source: "reported",
    };
  }
  const details = (usage.output_tokens_details ?? usage.completion_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  const inputDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  return {
    inputTokens: nonnegative(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: nonnegative(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: nonnegative(inputDetails.cached_tokens),
    cacheWriteTokens: null,
    reasoningTokens: nonnegative(details.reasoning_tokens),
    source: "reported",
  };
}

const capabilities: Record<Exclude<ProviderKind, "fake">, ProviderCapabilities> = {
  ollama: {
    provider: "ollama",
    streaming: true,
    nativeTools: true,
    jsonSchema: true,
    temperature: true,
    reasoningControls: [],
    cacheAccounting: false,
    imageInput: true,
    local: true,
  },
  openai: {
    provider: "openai",
    streaming: true,
    nativeTools: true,
    jsonSchema: true,
    temperature: true,
    reasoningControls: ["low", "medium", "high"],
    cacheAccounting: true,
    imageInput: true,
    local: false,
  },
  anthropic: {
    provider: "anthropic",
    streaming: true,
    nativeTools: true,
    // Structured outputs (output_config.format); sampling parameters are rejected by current models.
    jsonSchema: true,
    temperature: false,
    reasoningControls: ["low", "medium", "high", "xhigh", "max"],
    cacheAccounting: true,
    imageInput: true,
    local: false,
  },
  gemini: {
    provider: "gemini",
    streaming: true,
    nativeTools: true,
    jsonSchema: true,
    temperature: true,
    reasoningControls: ["low", "medium", "high"],
    cacheAccounting: true,
    imageInput: true,
    local: false,
  },
  openrouter: {
    provider: "openrouter",
    streaming: true,
    nativeTools: true,
    jsonSchema: true,
    temperature: true,
    reasoningControls: ["low", "medium", "high"],
    cacheAccounting: true,
    imageInput: true,
    local: false,
  },
  bedrock: {
    provider: "bedrock",
    streaming: true,
    nativeTools: true,
    jsonSchema: false,
    temperature: true,
    reasoningControls: ["low", "medium", "high"],
    cacheAccounting: true,
    imageInput: true,
    local: false,
  },
};

export class FixtureProviderAdapter implements ProviderAdapter {
  constructor(
    readonly kind: Exclude<ProviderKind, "fake">,
    private readonly fixture: Record<string, unknown>,
  ) {}
  async describeCapabilities(): Promise<ProviderCapabilities> {
    return structuredClone(capabilities[this.kind]);
  }
  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    if (signal?.aborted) throw new Error("PROVIDER_CANCELLED");
    validateProviderRequest(capabilities[this.kind], request);
    const content = this.fixture.content ?? this.fixture.output ?? this.fixture.candidates ?? null;
    const base = {
      operationId: request.operationId,
      provider: this.kind,
      model: request.model,
      resolvedProvider: typeof this.fixture.provider === "string" ? this.fixture.provider : null,
      content,
      finishReason:
        this.kind === "anthropic" && typeof this.fixture.stop_reason === "string"
          ? anthropicFinishReason(this.fixture.stop_reason)
          : ("stop" as const),
      usage: normalizeUsageFixture(this.kind, this.fixture),
    };
    return { ...base, responseHash: sha(base) };
  }
  async cancel(_operationId: string): Promise<void> {}
}

export type ProviderTransport = (
  request: GenerateRequest,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
export class TransportProviderAdapter implements ProviderAdapter {
  constructor(
    readonly kind: Exclude<ProviderKind, "fake">,
    private readonly transport: ProviderTransport,
  ) {}
  async describeCapabilities(): Promise<ProviderCapabilities> {
    return structuredClone(capabilities[this.kind]);
  }
  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    validateProviderRequest(capabilities[this.kind], request);
    const fixture = await this.transport(structuredClone(request), signal);
    return new FixtureProviderAdapter(this.kind, fixture).generate(request, signal);
  }
  async cancel(_operationId: string): Promise<void> {}
}
export class OllamaAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("ollama", transport);
  }
}
export class OpenAIAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("openai", transport);
  }
}
export class AnthropicAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("anthropic", transport);
  }
}
export class GeminiAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("gemini", transport);
  }
}
export class OpenRouterAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("openrouter", transport);
  }
}
export class BedrockAdapter extends TransportProviderAdapter {
  constructor(transport: ProviderTransport) {
    super("bedrock", transport);
  }
}

export function validateProviderRequest(capability: ProviderCapabilities, request: GenerateRequest): void {
  if (!request.operationId || !request.model || request.timeoutMs < 100 || request.maxOutputTokens < 1)
    throw new Error("INVALID_PROVIDER_REQUEST");
  if (request.outputSchema && !capability.jsonSchema) throw new Error("UNSUPPORTED_CAPABILITY:jsonSchema");
  if (request.temperature !== undefined && !capability.temperature)
    throw new Error("UNSUPPORTED_CAPABILITY:temperature");
  if (request.reasoningEffort && !capability.reasoningControls.includes(request.reasoningEffort))
    throw new Error("UNSUPPORTED_CAPABILITY:reasoningEffort");
}

export function assertLiveProbeConsent(environment: NodeJS.ProcessEnv, maxSpendUsd: number): void {
  if (environment.ODA_ALLOW_LIVE_PROVIDER_PROBES !== "I_CONSENT" || !(maxSpendUsd > 0 && maxSpendUsd <= 1))
    throw new Error("LIVE_PROVIDER_PROBE_NOT_AUTHORIZED");
}
