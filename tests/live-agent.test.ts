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
  answerExcerpt,
  contextSources,
  validationReason,
  expandSource,
  renderBrief,
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
  async list(dir) {
    if (dir && !"addons/sale_custom/models/sale.py".startsWith(`${dir}/`)) throw new Error("REPO_NOT_FOUND");
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
  maxInputTokens: 50_000,
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
  const reasons: Array<[number, string]> = [];
  await assert.rejects(
    runAgent({
      ...base,
      modelTurn: failing.turn,
      hooks: { ...hooks, onRepair: async (call, reason) => void reasons.push([call, reason]) },
      accept: (value) => acceptClarification(value, reader),
    }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_OUTPUT_INVALID",
  );
  assert.deepEqual(
    reasons.map(([call]) => call),
    [0, 1],
    "both the repaired and the final rejection are reported",
  );
  assert.match(reasons[0]![1], /relevantPaths contains "missing\.py"/);
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
      steps: [{ id: "S1", title: "Patch", description: "Change compute", tests: ["Unit test"] }],
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

test("task images follow the task text as labelled image blocks", async () => {
  const { turn, inputs } = scripted([
    message(
      [
        {
          type: "text",
          text: JSON.stringify({
            sufficient: true,
            questions: [],
            proposedAssumptions: [],
            relevantPaths: [],
          }),
        },
      ],
      "end_turn",
    ),
  ]);
  await runAgent({
    ...base,
    images: [{ label: "image 1: invoice.png", mediaType: "image/png", data: "iVBORw0KGgo=" }],
    modelTurn: turn,
    accept: (value) => acceptClarification(value, reader),
  });
  assert.deepEqual(inputs[0]!.messages[0]!.content, [
    { type: "text", text: base.task },
    { type: "text", text: "image 1: invoice.png" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ]);
});

test("the context gate rejects reviews that skip a task part or guess the code state", async () => {
  const sources = ["description", "M1", "M2", "image 1"];
  const requirement = (extra: Record<string, unknown> = {}) => ({
    id: "R1",
    text: "Make the description column wider",
    sources: ["description"],
    status: "partial",
    evidence: "The column is 38% wide in sale.py",
    paths: ["addons/sale_custom/models/sale.py"],
    ...extra,
  });
  const review = (extra: Record<string, unknown> = {}) => ({
    requirements: [requirement()],
    noAction: [],
    findings: [],
    sufficient: true,
    questions: [],
    proposedAssumptions: [],
    relevantPaths: [],
    ...extra,
  });
  await assert.rejects(acceptClarification(review(), reader, sources), /Not accounted for: M1, M2, image 1/);
  const complete = review({
    requirements: [
      requirement({ sources: ["description", "image 1"] }),
      requirement({ id: "R2", text: "Round the unit price", sources: ["M1"], status: "new", paths: [] }),
    ],
    noAction: [{ source: "M2", reason: "Timer started" }],
  });
  const accepted = await acceptClarification(complete, reader, sources);
  assert.equal(accepted.requirements?.length, 2);
  await assert.rejects(
    acceptClarification(review({ noAction: [{ source: "M9", reason: "x" }] }), reader, sources),
    /Unknown sources M9/,
  );
  await assert.rejects(
    acceptClarification(
      { ...complete, requirements: [requirement({ sources: sources, status: "unverified" })] },
      reader,
      sources,
    ),
    /unverified, but the repository is available/,
  );
  await assert.rejects(
    acceptClarification(
      { ...complete, requirements: [requirement({ sources: sources, status: "implemented", paths: [] })] },
      reader,
      sources,
    ),
    /cite the files/,
  );
  const external = await acceptClarification(
    {
      ...complete,
      requirements: [
        requirement({ sources: ["description", "image 1", "M1"], status: "external", paths: [] }),
      ],
    },
    reader,
    sources,
  );
  assert.throws(
    () =>
      acceptPlan(
        {
          title: "Ops",
          steps: [{ id: "S1", title: "t", description: "d", tests: [] }],
          risks: [],
          acceptanceMapping: [],
        },
        1,
        [],
        external,
      ),
    /missing R1/,
    "an external requirement must be planned too",
  );
  await assert.rejects(
    acceptClarification({ ...complete, questions: ["Which report?"] }, reader, sources),
    /When sufficient is true, ask no questions/,
  );
  await assert.rejects(
    acceptClarification(
      { ...complete, requirements: [requirement({ sources: sources, paths: ["addons/missing.py"] })] },
      reader,
      sources,
    ),
    /R1.paths contains "addons\/missing.py"/,
  );

  // The planner must map every open requirement; an implemented one needs no mapping.
  const plan = { title: "Widen", steps: [{ id: "S1", title: "t", description: "d", tests: [] }], risks: [] };
  assert.throws(() => acceptPlan({ ...plan, acceptanceMapping: ["R1 → S1"] }, 1, [], accepted), /missing R2/);
  assert.doesNotThrow(() =>
    acceptPlan({ ...plan, acceptanceMapping: ["R1 → S1", "R2 → S1"] }, 1, [], accepted),
  );
  // Cited folders count as existing paths.
  assert.ok(
    await acceptClarification(
      { ...complete, requirements: [requirement({ sources, paths: ["addons/sale_custom/", "addons"] })] },
      reader,
      sources,
    ),
  );
  const brief = renderBrief(accepted);
  assert.match(brief, /^CONTEXT BRIEF/);
  assert.match(brief, /- R2 \[new\] Round the unit price\n  sources: M1/);
  assert.match(brief, /M2: Timer started/);
});

test("context sources list the description, each message and each image", () => {
  const context = {
    description: "Fix it",
    extensions: {
      "community.source.discussion": {
        messages: [
          { author: null, at: "2026-10-28", kind: "comment", text: "a" },
          { author: null, at: "2026-10-29", kind: "comment", text: "b" },
        ],
        omitted: 0,
      },
    },
  } as never;
  assert.deepEqual(contextSources(context, [{} as never]), ["description", "M1", "M2", "image 1"]);
});

test("plan step ids are unique and the mapping names only existing steps", () => {
  const step = (id: string) => ({ id, title: "t", description: "d", tests: [] });
  const plan = (steps: string[], acceptanceMapping: string[]) =>
    acceptPlan({ title: "P", steps: steps.map(step), acceptanceMapping, risks: [] }, 1, []);
  assert.throws(() => plan(["S1", "S1"], []), /unique/);
  assert.throws(() => plan(["step-1"], []), /look like S1/);
  assert.throws(() => plan(["S1"], ["R1 → S1, S9"]), /do not exist: S9/);
  assert.doesNotThrow(() => plan(["S1", "S2"], ["R1 → S1, S2: totals match"]));
  const brief = {
    schemaVersion: "1.0",
    sufficient: true,
    questions: [],
    proposedAssumptions: [],
    relevantPaths: [],
    requirements: [
      {
        id: "R1",
        text: "a",
        sources: ["description"],
        status: "implemented",
        evidence: "e",
        paths: ["x.py"],
      },
      { id: "R2", text: "b", sources: ["description"], status: "new", evidence: "e", paths: [] },
    ],
  } as never;
  const mapped = (acceptanceMapping: string[]) =>
    acceptPlan({ title: "P", steps: ["S1", "S2"].map(step), acceptanceMapping, risks: [] }, 1, [], brief);
  // Verifying implemented work may take several steps (a plan can be verification only).
  assert.doesNotThrow(() => mapped(["R1 → S1, S2", "R2 → S2"]));
  // Without an arrow: "R2 (label): S1 en S2", with ":" inside the label too.
  assert.doesNotThrow(() => mapped(["R2 (format: 102x152, gelijk aan S9): S1 en S2"]));
  assert.throws(() => mapped(["R2 (label): S7"]), /do not exist: S7/);
  assert.throws(() => mapped(["R2: nothing to do"]), /missing R2/, "a requirement needs at least one step");
  assert.doesNotThrow(() => mapped(["R1 → S1: check on staging", "R2 → S2"]));
  // Ids in the explanation are not part of the mapping.
  assert.doesNotThrow(() =>
    mapped(["R1 → S1", "R2 → S2: reuses R1's compute, compare with the S10 invoice"]),
  );
});

test("cancellation stops the loop and aborts the running call", async () => {
  const controller = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  await assert.rejects(
    runAgent({
      ...base,
      signal: controller.signal,
      modelTurn: async (input) => {
        seen.push(input.signal);
        controller.abort();
        throw new Error("Request was aborted.");
      },
      accept: (value) => acceptClarification(value, reader),
    }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_CANCELLED",
  );
  assert.equal(seen[0], controller.signal, "the signal reaches the transport");
  const { turn, inputs } = scripted([]);
  await assert.rejects(
    runAgent({ ...base, signal: controller.signal, modelTurn: turn, accept: async (v) => v }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_CANCELLED",
  );
  assert.equal(inputs.length, 0, "no call starts after cancellation");
});

test("a call that cannot finish before the step deadline is not started", async () => {
  const { turn, inputs } = scripted([]);
  await assert.rejects(
    runAgent({ ...base, deadline: Date.now() + 10_000, modelTurn: turn, accept: async (v) => v }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_TIME_LIMIT",
  );
  assert.equal(inputs.length, 0);
  const timed = scripted([message([{ type: "text", text: "{}" }], "end_turn")]);
  await runAgent({ ...base, deadline: Date.now() + 45_000, modelTurn: timed.turn, accept: async (v) => v });
  assert.ok(timed.inputs[0]!.timeoutMs <= 45_000, "the call timeout is cut to the time left");
});

test("the input limit trims old tool results, then fails before an oversized call", async () => {
  const big = "x".repeat(30_000);
  const bigReader: RepoReader = { ...reader, search: async () => ({ untrusted: true, content: big }) };
  const searching = () =>
    message(
      [
        {
          type: "tool_use",
          id: `t${Math.random()}`,
          name: "repo_search",
          input: { pattern: "a", pathGlob: null },
        },
      ],
      "tool_use",
    );
  const reserved: number[] = [];
  const { turn, inputs } = scripted([
    searching(),
    searching(),
    searching(),
    message([{ type: "text", text: "{}" }], "end_turn"),
  ]);
  await runAgent({
    ...base,
    reader: bigReader,
    maxInputTokens: 25_000,
    modelTurn: turn,
    hooks: { ...hooks, beforeCall: async (_call, tokens) => void reserved.push(tokens) },
    accept: async (v) => v,
  });
  assert.equal(inputs.length, 4);
  assert.ok(
    reserved.every((tokens) => tokens <= 25_000),
    "every call stays within the limit",
  );
  const last = JSON.stringify(inputs[3]!.messages);
  assert.match(last, /TRIMMED/, "older results were trimmed");
  assert.ok(last.includes(big), "the latest result is kept whole");

  const counted: number[] = [];
  await assert.rejects(
    runAgent({
      ...base,
      maxInputTokens: 1_000,
      countTokens: async () => {
        counted.push(1);
        return 5_000;
      },
      modelTurn: scripted([]).turn,
      accept: async (v) => v,
    }),
    (error: unknown) => error instanceof AgentFailure && error.code === "AGENT_INPUT_LIMIT",
  );
  assert.equal(counted.length, 1, "the exact counter is used when present");

  const fallback = scripted([message([{ type: "text", text: "{}" }], "end_turn")]);
  await runAgent({
    ...base,
    countTokens: async () => {
      throw new Error("count endpoint unavailable");
    },
    modelTurn: fallback.turn,
    accept: async (v) => v,
  });
  assert.equal(fallback.inputs.length, 1, "a failing counter falls back to the estimate");
});

test("cited sources are normalised: ranges, plurals and case", () => {
  assert.deepEqual(expandSource("images 1-3"), ["image 1", "image 2", "image 3"]);
  assert.deepEqual(expandSource("Image 2"), ["image 2"]);
  assert.deepEqual(expandSource("image 4–image 5"), ["image 4", "image 5"]);
  assert.deepEqual(expandSource("M2-M4"), ["M2", "M3", "M4"]);
  assert.deepEqual(expandSource("m7"), ["M7"]);
  assert.deepEqual(expandSource("Description"), ["description"]);
  assert.deepEqual(expandSource("images 5-2"), ["images 5-2"], "a reversed range stays as written");
  assert.deepEqual(expandSource("the invoice"), ["the invoice"]);
  assert.deepEqual(expandSource("image 4, image 5, image 6"), ["image 4", "image 5", "image 6"]);
  assert.deepEqual(expandSource("M5-M6, M11"), ["M5", "M6", "M11"]);
  assert.deepEqual(expandSource("M2 en M3"), ["M2", "M3"]);
  assert.deepEqual(expandSource("M6 (vertalingen, Recupel-lettertype)"), ["M6"]);
});

test("the context gate accepts a source range and splits ranged noAction entries", async () => {
  const sources = ["description", "M1", "image 1", "image 2", "image 3"];
  const clarification = await acceptClarification(
    {
      requirements: [
        {
          id: "R1",
          text: "Sort the values",
          sources: ["Description", "images 1-2"],
          status: "new",
          evidence: "Nothing sorts them yet.",
          paths: [],
        },
      ],
      noAction: [
        { source: "M1-M1", reason: "Thanks" },
        // A list longer than a source's 40-character limit is split before the contract check.
        { source: "Image 3, image 3, image 3, image 3, image 3", reason: "Duplicate" },
      ],
      findings: [],
      sufficient: true,
      questions: [],
      proposedAssumptions: [],
      relevantPaths: [],
    },
    reader,
    sources,
  );
  assert.deepEqual(clarification.requirements![0]!.sources, ["description", "image 1", "image 2"]);
  assert.deepEqual(
    clarification.noAction!.map((n) => n.source),
    ["M1", "image 3"],
  );
});

test("repair records keep a shortened copy of the rejected answer", () => {
  const excerpt = answerExcerpt({ acceptanceMapping: ["R4 – S2"], description: "x".repeat(500) });
  assert.match(excerpt, /"R4 – S2"/);
  assert.ok(excerpt.length < 300, "long strings are cut");
  assert.equal(answerExcerpt("not json"), "not json");
});

test("implemented or partial work must cite a file the reviewer read", async () => {
  const review = (status: string, paths: string[]) => ({
    requirements: [{ id: "R1", text: "Sort", sources: ["description"], status, evidence: "e", paths }],
    noAction: [],
    findings: [],
    sufficient: true,
    questions: [],
    proposedAssumptions: [],
    relevantPaths: [],
  });
  const sale = "addons/sale_custom/models/sale.py";
  await assert.rejects(
    acceptClarification(review("implemented", [sale]), reader, ["description"], new Set()),
    /R1 is implemented, but you did not look at the code of any of its paths/,
  );
  assert.ok(
    await acceptClarification(review("implemented", [sale]), reader, ["description"], new Set([sale])),
  );
  assert.ok(
    await acceptClarification(
      review("partial", ["addons/sale_custom/"]),
      reader,
      ["description"],
      new Set([sale]),
    ),
    "a cited folder counts when a file inside it was read",
  );
  assert.ok(await acceptClarification(review("new", []), reader, ["description"], new Set()));

  // The loop records what repo_read was asked for.
  const inspected = new Set<string>();
  const { turn } = scripted([
    message(
      [
        {
          type: "tool_use",
          id: "r",
          name: "repo_read",
          input: { path: sale, startLine: null, endLine: null },
        },
      ],
      "tool_use",
    ),
    message([{ type: "text", text: "{}" }], "end_turn"),
  ]);
  await runAgent({ ...base, inspected, modelTurn: turn, accept: async (v) => v });
  assert.deepEqual([...inspected], [sale]);

  // Files in search hits count too.
  const searched = new Set<string>();
  const search = scripted([
    message(
      [{ type: "tool_use", id: "q", name: "repo_search", input: { pattern: "SaleOrder", pathGlob: null } }],
      "tool_use",
    ),
    message([{ type: "text", text: "{}" }], "end_turn"),
  ]);
  await runAgent({ ...base, inspected: searched, modelTurn: search.turn, accept: async (v) => v });
  assert.deepEqual([...searched], [sale]);
  assert.match(
    JSON.stringify(search.inputs.at(-1)?.messages.at(-1)?.content),
    /SaleOrder/,
    "the search result reached the model",
  );
});

test("a contract rejection tells the model which field broke which rule", () => {
  const reason = validationReason(
    Object.assign(new Error("Contract validation failed"), {
      errors: [{ instancePath: "/noAction/1/source", message: "must NOT have more than 40 characters" }],
    }),
  );
  assert.equal(
    reason,
    "Contract validation failed; /noAction/1/source must NOT have more than 40 characters",
  );
  assert.equal(validationReason(new Error("Plain")), "Plain");
});

test("the context gate reports every problem at once and accepts the title as a source", async () => {
  const review = {
    requirements: [
      {
        id: "R1",
        text: "Sharper logo",
        sources: ["Title 'Logo te klein'", "M1"],
        status: "new",
        evidence: "e",
        paths: [],
      },
      { id: "R2", text: "Check PDFs", sources: ["M2"], status: "unverified", evidence: "e", paths: [] },
    ],
    noAction: [],
    findings: [],
    sufficient: true,
    questions: ["Which report?"],
    proposedAssumptions: [],
    relevantPaths: [],
  };
  const sources = ["M1", "M2", "M3"];
  await assert.rejects(acceptClarification(review, reader, sources, new Set()), (error: Error) => {
    assert.match(error.message, /^\(1\) Not accounted for: M3/);
    assert.match(error.message, /\(2\) R2 is unverified.*A request to test or verify something is new/);
    assert.match(error.message, /\(3\) When sufficient is true, ask no questions/);
    assert.doesNotMatch(error.message, /Unknown sources/, "the title is a known source");
    return true;
  });
  const fixed = await acceptClarification(
    {
      ...review,
      requirements: [review.requirements[0], { ...review.requirements[1], status: "new" }],
      noAction: [{ source: "M3", reason: "Thanks" }],
      questions: [],
    },
    reader,
    sources,
    new Set(),
  );
  assert.deepEqual(fixed.requirements![0]!.sources, ["title", "M1"]);
});
