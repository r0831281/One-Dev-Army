import Anthropic from "@anthropic-ai/sdk";
import type { GenerateResult, NormalizedUsage } from "./index.js";

/** One model turn of an agent loop. Injected so tests and replays never reach the network. */
export interface ModelTurnInput {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  /** JSON schema the final answer must follow (structured outputs). */
  outputSchema?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}
export type ModelTurn = (input: ModelTurnInput) => Promise<Anthropic.Messages.Message>;

/** Real transport: one streamed Messages API call per turn, with refusal fallback enabled. */
export function anthropicModelTurn(client: Pick<Anthropic, "beta">): ModelTurn {
  return async (input) => {
    const stream = client.beta.messages.stream(
      {
        model: input.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: input.messages as Anthropic.Beta.BetaMessageParam[],
        tools: input.tools as Anthropic.Beta.BetaTool[],
        thinking: { type: "adaptive" },
        output_config: {
          effort: input.effort,
          ...(input.outputSchema ? { format: { type: "json_schema", schema: input.outputSchema } } : {}),
        },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { timeout: input.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) },
    );
    return (await stream.finalMessage()) as unknown as Anthropic.Messages.Message;
  };
}

export function anthropicFinishReason(stopReason: string | null | undefined): GenerateResult["finishReason"] {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
    case "pause_turn":
      return "tool";
    case "refusal":
      return "safety";
    default:
      return "unknown";
  }
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function anthropicUsage(message: Pick<Anthropic.Messages.Message, "usage">): NormalizedUsage {
  const usage = message.usage as unknown as Record<string, unknown> | undefined;
  return {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
    cacheReadTokens: count(usage?.cache_read_input_tokens),
    cacheWriteTokens: count(usage?.cache_creation_input_tokens),
    reasoningTokens: null,
    source: usage ? "reported" : "unknown",
  };
}

/** Per-million-token prices in USD, versioned by snapshot id so recorded costs stay reproducible. */
export interface ModelPricing {
  snapshotId: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5-5": {
    snapshotId: "anthropic-2026-10-06-claude-opus-5-5",
    model: "claude-opus-5-5",
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
  "claude-sonnet-5-5": {
    snapshotId: "anthropic-2026-10-06-claude-sonnet-5-5",
    model: "claude-sonnet-5-5",
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
};

/** Cost in micro-USD; null when any counted category is unknown. */
export function costMicrousd(usage: NormalizedUsage, pricing: ModelPricing): number | null {
  const parts: Array<[number | null, number]> = [
    [usage.inputTokens, pricing.inputPerMTok],
    [usage.outputTokens, pricing.outputPerMTok],
    [usage.cacheReadTokens ?? 0, pricing.cacheReadPerMTok],
    [usage.cacheWriteTokens ?? 0, pricing.cacheWritePerMTok],
  ];
  if (parts.some(([tokens]) => tokens === null)) return null;
  // tokens × USD/MTok equals micro-USD exactly.
  return Math.ceil(parts.reduce((sum, [tokens, price]) => sum + (tokens as number) * price, 0));
}
