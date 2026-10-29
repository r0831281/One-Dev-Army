import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PRICING,
  anthropicFinishReason,
  anthropicModelTurn,
  anthropicUsage,
  costMicrousd,
  worstCaseMicrousd,
  type ModelTurn,
  type ModelTurnInput,
} from "../packages/providers/src/anthropic.js";
import {
  AgentFailure,
  CLARIFICATION_OUTPUT_SCHEMA,
  acceptClarification,
  acceptPlan,
  runAgent,
  type RepoReader,
} from "../apps/worker/src/live-agent.js";

type Block = Anthropic.Messages.ContentBlock;
const message = (
  content: Array<Partial<Block> & { type: string }>,
  stopReason: string,
): Anthropic.Messages.Message =>
  ({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0,
    },
  }) as unknown as Anthropic.Messages.Message;

function scripted(replies: Anthropic.Messages.Message[]): { turn: ModelTurn; inputs: ModelTurnInput[] } {
  const inputs: ModelTurnInput[] = [];
  return {
    inputs,
    turn: async (input) => {
      inputs.push(structuredClone(input));
      const reply = replies.shift();
      if (!reply) throw new Error("NO_SCRIPTED_REPLY");
      return reply;
    },
  };
}
const reader: RepoReader = {
  async read(path) {
    if (path !== "addons/sale_custom/models/sale.py") throw new Error("REPO_NOT_FOUND");
    return { untrusted: true, content: "1: class SaleOrder(models.Model):" };
  },
  async search() {
    return { untrusted: true, content: "addons/sale_custom/models/sale.py:1:class SaleOrder" };
  },
  async list() {
    return { untrusted: true, content: "addons/sale_custom/models/sale.py" };
  },
};
const calls: string[] = [];
const hooks = {
  async beforeCall(call: number) {
    calls.push(`reserve:${call}`);
  },
  async afterCall(call: number) {
    calls.push(`record:${call}`);
  },
  heartbeat() {},
};
const base = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  maxOutputTokens: 4000,
  timeoutMs: 60_000,
  maxModelCalls: 6,
  structuredOutputRepairs: 1,
  system: "SYSTEM",
  task: "UNTRUSTED TASK CONTENT\nTASK ABC-44",
  tools: ["repo.read", "repo.search"],
  reader,
  outputSchema: CLARIFICATION_OUTPUT_SCHEMA,
  hooks,
};

test("Anthropic stop reasons, usage and cost are normalised", () => {
  assert.equal(anthropicFinishReason("end_turn"), "stop");
  assert.equal(anthropicFinishReason("max_tokens"), "length");
  assert.equal(anthropicFinishReason("tool_use"), "tool");
  assert.equal(anthropicFinishReason("refusal"), "safety");
  const usage = anthropicUsage(message([], "end_turn"));
  assert.deepEqual(
    [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens],
    [1000, 200, 500, 0],
  );
  // 1000 × $4 + 200 × $20 + 500 × $0.20 per million tokens = 8100 micro-USD.
  assert.equal(costMicrousd(usage, ANTHROPIC_PRICING["claude-opus-5-5"]!), 8100);
  assert.equal(costMicrousd({ ...usage, outputTokens: null }, ANTHROPIC_PRICING["claude-opus-5-5"]!), null);
});

test("agent loop runs read-only tools, then returns a validated clarification", async () => {
  calls.length = 0;
  const { turn, inputs } = scripted([
    message(
      [
        { type: "tool_use", id: "t1", name: "repo_search", input: { pattern: "SaleOrder", pathGlob: null } },
        {
          type: "tool_use",
          id: "t2",
          name: "repo_read",
          input: { path: "../etc/passwd", startLine: null, endLine: null },
        },
      ],
      "tool_use",
    ),
    message(
      [
        {
          type: "text",
          text: JSON.stringify({
            sufficient: false,
            questions: ["Which price list applies?"],
            proposedAssumptions: ["Use the default price list."],
            relevantPaths: ["addons/sale_custom/models/sale.py"],
          }),
        },
      ],
      "end_turn",
    ),
  ]);
  const result = await runAgent({
    ...base,
    modelTurn: turn,
    accept: (value) => acceptClarification(value, reader),
  });
  assert.equal(result.calls, 2);
  assert.deepEqual(result.output.questions, ["Which price list applies?"]);
  assert.deepEqual(calls, ["reserve:0", "record:0", "reserve:1", "record:1"]);
  assert.deepEqual(
    inputs[0]!.tools.map((tool) => tool.name),
    ["repo_read", "repo_search", "repo_list"],
  );
  const toolResults = inputs[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  assert.match(String(toolResults[0]!.content), /^UNTRUSTED REPOSITORY CONTENT/);
  assert.equal(toolResults[1]!.is_error, true, "a denied path is reported to the model, not thrown");
});

test("invalid output gets a repair turn; a second failure stops with AGENT_OUTPUT_INVALID", async () => {
  const bad = message(
    [
      {
        type: "text",
        text: JSON.stringify({
          sufficient: true,
          questions: [],
          proposedAssumptions: [],
          relevantPaths: ["missing.py"],
        }),
      },
    ],
    "end_turn",
  );
  const good = message(
    [
      {
        type: "text",
        text: JSON.stringify({ sufficient: true, questions: [], proposedAssumptions: [], relevantPaths: [] }),
      },
    ],
    "end_turn",
  );
  const repaired = scripted([bad, good]);
  const result = await runAgent({
    ...base,
    modelTurn: repaired.turn,
    accept: (value) => acceptClarification(value, reader),
  });
  assert.equal(result.output.sufficient, true);
  assert.match(String(repaired.inputs[1]!.messages.at(-1)!.content), /missing\.py/);

  const failing = scripted([bad, bad]);
  await assert.rejects(
    runAgent({ ...base, modelTurn: failing.turn, accept: (value) => acceptClarification(value, reader) }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_OUTPUT_INVALID",
  );
});

test("refusal, truncation and the call limit stop the agent with explicit codes", async () => {
  for (const [reply, code] of [
    [message([], "refusal"), "AGENT_REFUSED"],
    [message([], "max_tokens"), "AGENT_OUTPUT_TRUNCATED"],
  ] as const) {
    const { turn } = scripted([reply]);
    await assert.rejects(
      runAgent({ ...base, modelTurn: turn, accept: (value) => acceptClarification(value, reader) }),
      (error: unknown) => error instanceof AgentFailure && error.code === code,
    );
  }
  const looping = scripted(
    Array.from({ length: 2 }, () =>
      message([{ type: "tool_use", id: "t", name: "repo_list", input: { dir: null } }], "tool_use"),
    ),
  );
  await assert.rejects(
    runAgent({
      ...base,
      maxModelCalls: 2,
      modelTurn: looping.turn,
      accept: (value) => acceptClarification(value, reader),
    }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_CALL_LIMIT",
  );
});

test("plans are validated against the contract with the run's constraints", () => {
  const constraints = [
    { id: "c1", text: "Keep the API stable", origin: "human-feedback" as const, sourceRef: "gate/1" },
  ];
  const plan = acceptPlan(
    {
      title: "Fix totals",
      steps: [{ id: "step-1", title: "Patch", description: "Change compute", tests: ["Unit test"] }],
      acceptanceMapping: [],
      risks: [],
    },
    2,
    constraints,
  );
  assert.equal(plan.revision, 2);
  assert.deepEqual(plan.constraints, constraints);
  assert.throws(() => acceptPlan({ title: "No steps", steps: [], acceptanceMapping: [], risks: [] }, 1, []));
});

test("db_query is offered only with a data source and its results are labelled untrusted", async () => {
  const done = message(
    [
      {
        type: "text",
        text: JSON.stringify({ sufficient: true, questions: [], proposedAssumptions: [], relevantPaths: [] }),
      },
    ],
    "end_turn",
  );
  const withoutDb = scripted([done]);
  await runAgent({
    ...base,
    tools: ["repo.read", "repo.search", "db.query"],
    modelTurn: withoutDb.turn,
    accept: (value) => acceptClarification(value, reader),
  });
  assert.ok(!withoutDb.inputs[0]!.tools.some((tool) => tool.name === "db_query"));

  const queries: string[] = [];
  const withDb = scripted([
    message(
      [{ type: "tool_use", id: "q1", name: "db_query", input: { sql: "SELECT name FROM res_company" } }],
      "tool_use",
    ),
    done,
  ]);
  await runAgent({
    ...base,
    tools: ["repo.read", "repo.search", "db.query"],
    db: {
      async query(sql) {
        queries.push(sql);
        return { untrusted: true, content: "name\nAcme\n(1 rows)" };
      },
    },
    modelTurn: withDb.turn,
    accept: (value) => acceptClarification(value, reader),
  });
  assert.ok(withDb.inputs[0]!.tools.some((tool) => tool.name === "db_query"));
  assert.deepEqual(queries, ["SELECT name FROM res_company"]);
  const result = (withDb.inputs[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
  assert.match(String(result.content), /^UNTRUSTED DATABASE CONTENT/);
});

test("unexpected model failures are described without secrets", async () => {
  const { describeModelError } = await import("../apps/worker/src/live-activities.js");
  const api = Object.assign(new Error("400 tools.0: invalid schema\nsecond line"), {
    status: 400,
    requestID: "req_123",
  });
  assert.equal(describeModelError(api), "Anthropic API 400 (request req_123): 400 tools.0: invalid schema");
  assert.equal(
    describeModelError(new TypeError("connect postgres://oda:hunter2@127.0.0.1:5433/db failed sk-ant-abc")),
    "TypeError: connect postgres://***@127.0.0.1:5433/db failed sk-ant-***",
  );
});

test("Haiku 5.5 uses its long-prompt rate card above 100K input tokens", () => {
  const haiku = ANTHROPIC_PRICING["claude-haiku-5-5"]!;
  const base = { reasoningTokens: null, source: "reported" as const };
  // 10K in + 2K out + 50K cache read: 10000 × 0.1 + 2000 × 0.5 + 50000 × 0.01 = 2500 micro-USD.
  assert.equal(
    costMicrousd(
      { ...base, inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 },
      haiku,
    ),
    2500,
  );
  // 120K prompt: 120000 × 0.5 + 2000 × 2.5 = 65000 micro-USD.
  assert.equal(
    costMicrousd(
      { ...base, inputTokens: 120_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      haiku,
    ),
    65000,
  );
  // Worst case bills input at the cache-write rate: 60000 × 0.125 + 8000 × 0.5 = 11500.
  assert.equal(worstCaseMicrousd(haiku, 60_000, 8_000), 11500);
  assert.equal(worstCaseMicrousd(ANTHROPIC_PRICING["claude-opus-5-5"]!, 60_000, 16_000), 620000);
});

test("the transport caches the conversation and sends fallbacks only where supported", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          sent.push(params);
          return { finalMessage: async () => ({}) };
        },
      },
    },
  } as unknown as Pick<Anthropic, "beta">;
  const turn = anthropicModelTurn(client);
  const input = {
    system: "s",
    messages: [],
    tools: [],
    effort: "low" as const,
    maxTokens: 10,
    timeoutMs: 1000,
  };
  await turn({ ...input, model: "claude-sonnet-5-5" });
  await turn({ ...input, model: "claude-haiku-5-5" });
  assert.deepEqual(sent[0]!.cache_control, { type: "ephemeral" });
  assert.equal(sent[0]!.fallbacks, "default");
  assert.deepEqual(sent[1]!.cache_control, { type: "ephemeral" });
  assert.equal("fallbacks" in sent[1]!, false);
  assert.equal("betas" in sent[1]!, false);
});
