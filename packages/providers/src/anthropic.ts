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
        // The loop re-sends the whole conversation each turn; caching makes the repeated prefix 0.1x input.
        cache_control: { type: "ephemeral" },
        ...(NO_SERVER_FALLBACK.test(input.model)
          ? {}
          : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
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
  /** A second rate card for prompts longer than `aboveInputTokens` (input incl. cache reads and writes). */
  longPrompt?: { aboveInputTokens: number } & Pick<
    ModelPricing,
    "inputPerMTok" | "outputPerMTok" | "cacheReadPerMTok" | "cacheWritePerMTok"
  >;
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
  // Cache reads are 0.1x and 5-minute cache writes 1.25x the input rate of the applicable card.
  "claude-haiku-5-5": {
    snapshotId: "anthropic-2026-10-06-claude-haiku-5-5",
    model: "claude-haiku-5-5",
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    longPrompt: {
      aboveInputTokens: 100_000,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
    },
  },
};

/** Models without a server-side refusal fallback; sending `fallbacks` to them is pointless or a 400. */
const NO_SERVER_FALLBACK = /^claude-haiku-/;

/** The rate card for a prompt of this many input tokens (including cache reads and writes). */
function rateCard(pricing: ModelPricing, promptTokens: number) {
  return pricing.longPrompt && promptTokens > pricing.longPrompt.aboveInputTokens
    ? pricing.longPrompt
    : pricing;
}

/** Worst-case cost in micro-USD of one call: all input billed at the dearer of input and cache-write rates. */
export function worstCaseMicrousd(
  pricing: ModelPricing,
  maxInputTokens: number,
  maxOutputTokens: number,
): number {
  const card = rateCard(pricing, maxInputTokens);
  const inputRate = Math.max(card.inputPerMTok, card.cacheWritePerMTok);
  return Math.ceil(maxOutputTokens * card.outputPerMTok + maxInputTokens * inputRate);
}

/** Cost in micro-USD; null when any counted category is unknown. */
export function costMicrousd(usage: NormalizedUsage, pricing: ModelPricing): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const card = rateCard(
    pricing,
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
  );
  const parts: Array<[number, number]> = [
    [usage.inputTokens, card.inputPerMTok],
    [usage.outputTokens, card.outputPerMTok],
    [usage.cacheReadTokens ?? 0, card.cacheReadPerMTok],
    [usage.cacheWriteTokens ?? 0, card.cacheWritePerMTok],
  ];
  // tokens × USD/MTok equals micro-USD exactly.
  return Math.ceil(parts.reduce((sum, [tokens, price]) => sum + tokens * price, 0));
}
