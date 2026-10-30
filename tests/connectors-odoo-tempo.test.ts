import test from "node:test";
import assert from "node:assert/strict";
import {
  JiraConnector,
  ODOO_TASK_KEY_ROUTE,
  boundDiscussion,
  OdooConnector,
  htmlText,
  jiraCustomer,
  type ConnectorContext,
  type ScopedHttp,
} from "../packages/connectors/src/index.js";
import { assertConnectorRequest, withOdooRpcCredential } from "../packages/connectors/src/policy.js";
import {
  TempoPlanningSource,
  classifyPlannedIssue,
  resolveJiraIssues,
  collectPlanning,
} from "../packages/connectors/src/tempo.js";
import { resolveRoute, type RoutingRule } from "../packages/routing/src/index.js";
import { plannedFor, taskCustomer, taskDiscussion, taskImages } from "../packages/contracts/src/index.js";
import { renderTask } from "../apps/worker/src/live-agent.js";
import { MemorySourceImageStore, MemoryTaskRepository } from "../packages/persistence/src/index.js";
import { IngestionService } from "../apps/api/src/index.js";

const ODOO = "https://odoo.example.invalid";
const JIRA = "https://team.atlassian.net";
const TEMPO = "https://api.tempo.io";
const context: ConnectorContext = {
  instanceId: "00000000-0000-4000-8000-0000000000aa",
  repository: { id: "00000000-0000-4000-8000-000000000002", baseSha: "a".repeat(40) },
  fetchedAt: "2026-10-29T08:00:00.000Z",
};
type Request = { method: string; url: string; body?: unknown };

const odooTask = (key: string, id = 7) => ({
  id,
  name: `Task ${key}`,
  description: "<p>Fix the <b>invoice</b> report &amp; totals</p><ul><li>one</li><li>two</li></ul>",
  write_date: "2026-10-28 10:00:00",
  project_id: [3, "Customer project"],
  date_deadline: false,
  project_key_display: key,
});

type OdooMessageRecord = {
  id: number;
  res_id: number;
  date: string;
  author_id: [number, string] | false;
  body: string | false;
  message_type: string;
  internal: boolean;
  attachment_ids?: number[];
};
type OdooAttachmentRecord = {
  id: number;
  res_id: number;
  name: string;
  mimetype: string;
  file_size: number;
  checksum: string;
  create_date: string;
  datas: string;
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
class OdooFixture implements ScopedHttp {
  readonly requests: Request[] = [];
  constructor(
    private readonly records: Array<ReturnType<typeof odooTask>>,
    readonly messages: OdooMessageRecord[] = [],
    readonly attachments: OdooAttachmentRecord[] = [],
  ) {}
  async request<T>(request: Request): Promise<T> {
    this.requests.push(structuredClone(request));
    const body = request.body as { params?: { service: string; args: unknown[] }; domain?: unknown[][] };
    if (request.url.endsWith("/json/2/project.task/search_read")) return this.match(body.domain!) as T;
    if (request.url.endsWith("/json/2/mail.message/search_read")) return this.chatter(body.domain!) as T;
    if (request.url.endsWith("/json/2/ir.attachment/search_read")) return this.files(body.domain!) as T;
    if (body.params?.service === "common") return { jsonrpc: "2.0", id: 1, result: 42 } as T;
    const domain = (body.params!.args[5] as unknown[][][])[0]!;
    const model = body.params!.args[3];
    const result =
      model === "mail.message"
        ? this.chatter(domain)
        : model === "ir.attachment"
          ? this.files(domain)
          : this.match(domain);
    return { jsonrpc: "2.0", id: 1, result } as T;
  }
  private match(domain: unknown[][]) {
    const [field, , value] = domain[0]!;
    return this.records.filter((record) => record[field as "project_key_display"] === value);
  }
  private files(domain: unknown[]) {
    const resId = (domain[1] as unknown[])[2];
    const byId = (domain as unknown[][]).find((clause) => clause[0] === "id");
    const rows = this.attachments.filter((a) => a.res_id === resId).sort((a, b) => b.id - a.id);
    if (byId) return rows.filter((a) => a.id === byId[2]).map((a) => ({ id: a.id, datas: a.datas }));
    return rows.map(({ datas: _datas, res_id: _resId, ...fields }) => fields);
  }
  private chatter(domain: unknown[]) {
    const resId = (domain[1] as unknown[])[2];
    const onlyInternal = domain.includes("|");
    return this.messages
      .filter((m) => m.res_id === resId && (!onlyInternal || m.internal))
      .sort((a, b) => b.id - a.id)
      .map(({ internal: _internal, res_id: _resId, ...fields }) => fields);
  }
}

test("connector policy allows only Odoo task reads and GETs on the configured origin", () => {
  const read = { jsonrpc: "2.0", method: "call", params: { service: "object", method: "execute_kw" } };
  const args = (model: string, method: string) => ["db", 1, null, model, method, [[]], {}];
  const rpc = (model: string, method: string) => ({
    ...read,
    params: { ...read.params, args: args(model, method) },
  });
  assert.doesNotThrow(() =>
    assertConnectorRequest(
      { kind: "odoo-jsonrpc", origin: ODOO },
      { method: "POST", url: `${ODOO}/jsonrpc`, body: rpc("project.task", "search_read") },
    ),
  );
  for (const [model, method] of [
    ["project.task", "write"],
    ["project.task", "unlink"],
    ["project.task", "create"],
    ["res.users", "search_read"],
  ] as const)
    assert.throws(
      () =>
        assertConnectorRequest(
          { kind: "odoo-jsonrpc", origin: ODOO },
          { method: "POST", url: `${ODOO}/jsonrpc`, body: rpc(model, method) },
        ),
      /CONNECTOR_SCOPE_DENIED/,
    );
  assert.doesNotThrow(() =>
    assertConnectorRequest(
      { kind: "odoo-json2", origin: ODOO },
      { method: "POST", url: `${ODOO}/json/2/project.task/search_read`, body: {} },
    ),
  );
  for (const url of [`${ODOO}/json/2/project.task/write`, `${ODOO}/json/2/res.partner/search_read`])
    assert.throws(
      () => assertConnectorRequest({ kind: "odoo-json2", origin: ODOO }, { method: "POST", url, body: {} }),
      /CONNECTOR_SCOPE_DENIED/,
    );
  assert.throws(
    () =>
      assertConnectorRequest(
        { kind: "odoo-json2", origin: ODOO },
        { method: "POST", url: "https://elsewhere.example.invalid/json/2/project.task/search_read" },
      ),
    /CONNECTOR_SCOPE_DENIED/,
  );
  assert.throws(
    () =>
      assertConnectorRequest(
        { kind: "get", origin: JIRA },
        { method: "POST", url: `${JIRA}/rest/api/3/issue` },
      ),
    /CONNECTOR_SCOPE_DENIED/,
  );
  const injected = withOdooRpcCredential(rpc("project.task", "search_read"), "secret") as {
    params: { args: unknown[] };
  };
  assert.equal(injected.params.args[2], "secret");
  assert.throws(
    () => withOdooRpcCredential(rpc("project.task", "write"), "secret"),
    /CONNECTOR_SCOPE_DENIED/,
  );
});

test("Odoo connector fetches by key over JSON-RPC and JSON-2 and owns the description", async () => {
  for (const apiVersion of ["jsonrpc", "json2"] as const) {
    const http = new OdooFixture([odooTask("ABC-1233"), odooTask("X-Y-62", 8)]);
    const connector = new OdooConnector(ODOO, http, {
      apiVersion,
      database: "customer",
      login: "api@example.invalid",
      keyField: "project_key_display",
    });
    assert.deepEqual(connector.normalize("X-Y-62"), { externalId: "X-Y-62", key: "X-Y-62" });
    assert.throws(() => connector.normalize("a-u-62"), /POLICY_DENIED/);
    const task = await connector.fetchTask(connector.normalize("ABC-1233"), context);
    assert.equal(task.title, "Task ABC-1233");
    assert.equal(task.description, "Fix the invoice report & totals\n\n- one\n- two");
    assert.equal(task.source.externalId, "7");
    assert.equal(task.source.url, `${ODOO}/web#id=7&model=project.task&view_type=form`);
    await connector.fetchTask(connector.normalize("X-Y-62"), context);
    if (apiVersion === "jsonrpc") {
      const logins = http.requests.filter(
        (r) => (r.body as { params: { service: string } }).params.service === "common",
      );
      assert.equal(logins.length, 1, "uid is cached after the first login");
      for (const r of http.requests)
        assert.equal(
          (r.body as { params: { args: unknown[] } }).params.args[2],
          null,
          "connector never holds the key",
        );
    }
    await assert.rejects(connector.fetchTask(connector.normalize("ABC-9"), context), /NOT_FOUND/);
  }
  const duplicate = new OdooConnector(ODOO, new OdooFixture([odooTask("ABC-1"), odooTask("ABC-1", 9)]), {
    apiVersion: "json2",
    database: "",
    login: "",
    keyField: "project_key_display",
  });
  await assert.rejects(duplicate.fetchTask(duplicate.normalize("ABC-1"), context), /AMBIGUOUS_SOURCE_KEY/);
  assert.equal(htmlText("<script>alert(1)</script>a&#39;b&#x41;<br>c"), "a'bA\nc");
});

test("HELP prefix routes to Jira while other task keys route to Odoo", () => {
  const rules: RoutingRule[] = [
    {
      id: "jira",
      revision: 1,
      enabled: true,
      priority: 100,
      matchKind: "prefix",
      pattern: "HELP-",
      pluginInstanceId: "jira",
      repositoryId: "r",
    },
    {
      id: "odoo",
      revision: 1,
      enabled: true,
      priority: 100,
      matchKind: "regex",
      pattern: ODOO_TASK_KEY_ROUTE,
      pluginInstanceId: "odoo",
      repositoryId: "r",
    },
  ];
  assert.equal(resolveRoute(rules, { kind: "identifier", value: "HELP-12" }).pluginInstanceId, "jira");
  assert.equal(resolveRoute(rules, { kind: "identifier", value: "X-Y-62" }).pluginInstanceId, "odoo");
  assert.equal(resolveRoute(rules, { kind: "identifier", value: "ABC-1233" }).pluginInstanceId, "odoo");
  assert.throws(() => resolveRoute(rules, { kind: "identifier", value: "not a key" }), /No routing rule/);
});

class TempoJiraFixture implements ScopedHttp {
  readonly urls: string[] = [];
  async request<T>(request: Request): Promise<T> {
    this.urls.push(request.url);
    const url = new URL(request.url);
    if (url.origin === TEMPO) {
      const offset = Number(url.searchParams.get("offset"));
      const plans = [
        {
          id: 1,
          planItem: { id: 101, type: "ISSUE" },
          dates: {
            values: [
              { date: "2026-10-30", timePlannedSeconds: 3600 },
              { date: "2026-10-29", timePlannedSeconds: 7200 },
            ],
          },
        },
        {
          id: 2,
          description: "ABC-1233 Fix invoice report",
          planItem: { id: 102, type: "ISSUE" },
          startDate: "2026-10-27",
          endDate: "2026-10-31",
          plannedSecondsPerDay: 1800,
        },
        { id: 3, planItem: { id: 900, type: "PROJECT" }, startDate: "2026-10-29", endDate: "2026-10-29" },
        {
          id: 4,
          description: "DEV Meeting",
          planItem: { id: 102, type: "ISSUE" },
          dates: { values: [{ date: "2026-11-02", timePlannedSeconds: 3600 }] },
        },
        {
          id: 5,
          description: "DEF-1 + DEF-2 lay-out",
          planItem: { id: 102, type: "ISSUE" },
          dates: { values: [{ date: "2026-11-03", timePlannedSeconds: 3600 }] },
        },
        {
          id: 6,
          planItem: { id: 103, type: "ISSUE" },
          dates: { values: [{ date: "2026-11-04", timePlannedSeconds: 1800 }] },
        },
      ];
      return (
        offset === 0
          ? { metadata: { count: 3, next: `${TEMPO}/4/plans/user/acc?offset=3` }, results: plans.slice(0, 3) }
          : { metadata: { count: 3 }, results: plans.slice(3) }
      ) as T;
    }
    assert.match(url.searchParams.get("jql") ?? "", /^id in \(101,102,103\)$/);
    return {
      issues: [
        { id: "101", key: "HELP-12", fields: { summary: "Customer cannot log in" } },
        { id: "102", key: "GEN-25", fields: { summary: "Odoo project task" } },
        { id: "103", key: "PLAN-6", fields: { summary: "X-Y-62 Rework" } },
      ],
    } as T;
  }
}

test("Tempo planning pages plans, keeps issue items in the window and classifies their source", async () => {
  assert.deepEqual(classifyPlannedIssue({ key: "HELP-1", summary: "x" }, "HELP-", "ABC-1 note"), ["HELP-1"]);
  assert.deepEqual(
    classifyPlannedIssue({ key: "GEN-25", summary: "Odoo task" }, "HELP-", "FRZ-973 + FRZ-975"),
    ["FRZ-973", "FRZ-975"],
  );
  assert.deepEqual(classifyPlannedIssue({ key: "PLAN-1", summary: "[X-Y-62] Rework" }, "HELP-"), ["X-Y-62"]);
  assert.deepEqual(classifyPlannedIssue({ key: "PLAN-1", summary: "PLAN-1 sync" }, "HELP-", "Weekly"), []);
  const http = new TempoJiraFixture();
  const result = await collectPlanning({
    tempo: new TempoPlanningSource(http),
    jira: http,
    jiraOrigin: JIRA,
    helpdeskPrefix: "HELP-",
    accountId: "acc",
    from: "2026-10-29",
    to: "2026-11-05",
  });
  assert.equal(result.planned, 5);
  assert.deepEqual(result.unlinked, ["GEN-25: DEV Meeting"]);
  assert.deepEqual(result.targets.map((t) => t.identifier).sort(), [
    "ABC-1233",
    "DEF-1",
    "DEF-2",
    "HELP-12",
    "X-Y-62",
  ]);
  const byId = new Map(result.targets.map((t) => [t.identifier, t.planning]));
  assert.equal(byId.get("HELP-12")?.plannedFor, "2026-10-29");
  assert.deepEqual(byId.get("HELP-12")?.dates, [
    { date: "2026-10-29", seconds: 7200 },
    { date: "2026-10-30", seconds: 3600 },
  ]);
  assert.equal(byId.get("ABC-1233")?.plannedFor, "2026-10-29", "range plans are clipped to the window");
  assert.equal(byId.get("ABC-1233")?.jiraKey, "GEN-25");
  assert.equal(byId.get("X-Y-62")?.plannedFor, "2026-11-04", "falls back to keys in the Jira summary");
  assert.equal(http.urls.filter((u) => u.startsWith(TEMPO)).length, 2);
});

test("planning sync ingests planned helpdesk and Odoo tasks with Tempo dates", async () => {
  const fixture = new TempoJiraFixture();
  const jiraHttp: ScopedHttp = {
    request: async <T>(request: Request): Promise<T> => {
      if (request.url.includes("/search/jql")) return fixture.request<T>(request);
      return {
        id: "101",
        key: "HELP-12",
        fields: {
          summary: "Customer cannot log in",
          description: null,
          labels: [],
          updated: "2026-10-28T09:00:00.000+0000",
          project: { key: "HELP" },
          reporter: null,
        },
      } as T;
    },
  };
  const ids = { jira: "00000000-0000-4000-8000-0000000000a1", odoo: "00000000-0000-4000-8000-0000000000a2" };
  const repository = new MemoryTaskRepository();
  const service = new IngestionService({
    rules: [
      {
        id: ids.jira,
        revision: 1,
        enabled: true,
        priority: 100,
        matchKind: "prefix",
        pattern: "HELP-",
        pluginInstanceId: ids.jira,
        repositoryId: context.repository.id,
      },
      {
        id: ids.odoo,
        revision: 1,
        enabled: true,
        priority: 100,
        matchKind: "regex",
        pattern: ODOO_TASK_KEY_ROUTE,
        pluginInstanceId: ids.odoo,
        repositoryId: context.repository.id,
      },
    ],
    connectors: new Map<string, JiraConnector | OdooConnector>([
      [ids.jira, new JiraConnector(JIRA, "HELP", jiraHttp)],
      [
        ids.odoo,
        new OdooConnector(ODOO, new OdooFixture([odooTask("ABC-1233")]), {
          apiVersion: "json2",
          database: "",
          login: "",
          keyField: "project_key_display",
        }),
      ],
    ]),
    connectorContexts: new Map([
      [ids.jira, { ...context, instanceId: ids.jira }],
      [ids.odoo, { ...context, instanceId: ids.odoo }],
    ]),
    repository,
    planningSources: [
      {
        connectorId: ids.jira,
        helpdeskPrefix: "HELP-",
        jira: jiraHttp,
        jiraOrigin: JIRA,
        tempo: new TempoPlanningSource(fixture),
        accountId: "acc",
      },
    ],
  });
  const status = await service.sync({ from: "2026-10-29", to: "2026-11-05" });
  assert.equal(status.ingested, 2);
  assert.deepEqual(status.unlinked, ["GEN-25: DEV Meeting"]);
  assert.deepEqual(status.failures.map((f) => `${f.identifier}:${f.code}`).sort(), [
    "DEF-1:NOT_FOUND",
    "DEF-2:NOT_FOUND",
    "X-Y-62:NOT_FOUND",
  ]);
  const tasks = new Map(repository.list().map((t) => [t.source.key, t]));
  assert.equal(tasks.get("HELP-12")?.plannedFor, "2026-10-29");
  assert.equal(tasks.get("ABC-1233")?.plannedFor, "2026-10-29");
  assert.equal(tasks.get("ABC-1233")?.description, "Fix the invoice report & totals\n\n- one\n- two");
  const again = await service.sync({ from: "2026-10-29", to: "2026-11-05" });
  assert.equal(again.ingested, 0, "an unchanged plan creates no new revision");
  assert.equal(repository.list().length, 2);
});

test("plannedFor prefers Tempo planning over the Jira due date", () => {
  assert.equal(
    plannedFor({
      extensions: {
        "community.jira.planning": { plannedFor: "2026-11-10" },
        "community.tempo.planning": { plannedFor: "2026-10-30" },
      },
    }),
    "2026-10-30",
  );
  assert.equal(plannedFor({ extensions: { "community.jira.planning": { plannedFor: "2026-02-30" } } }), null);
});

test("Jira lookup falls back to single issues when JQL rejects a hidden id", async () => {
  const calls: string[] = [];
  const jira: ScopedHttp = {
    request: async <T>(request: Request): Promise<T> => {
      calls.push(request.url);
      if (request.url.includes("/search/jql")) throw new Error("CONNECTOR_HTTP_400");
      if (request.url.includes("/issue/102")) throw new Error("CONNECTOR_HTTP_404");
      return { id: "101", key: "HELP-12", fields: { summary: "Login" } } as T;
    },
  };
  const resolved = await resolveJiraIssues(jira, JIRA, ["101", "102"]);
  assert.deepEqual([...resolved.keys()], ["101"]);
  assert.equal(calls.filter((url) => url.includes("/rest/api/3/issue/")).length, 2);
});

test("the Jira customer comes from organizations, a customer field or the Tempo account, in that order", () => {
  const names = { customfield_1: "Account", customfield_2: "Organizations", customfield_3: "Klant" };
  assert.deepEqual(
    jiraCustomer(
      { customfield_1: { id: 4, value: "Framaz Account" }, customfield_2: [{ id: "9", name: "Framaz NV" }] },
      names,
    ),
    { customer: "Framaz NV", field: "Organizations" },
  );
  assert.deepEqual(jiraCustomer({ customfield_3: { value: "Ark" } }, names), {
    customer: "Ark",
    field: "Klant",
  });
  assert.deepEqual(jiraCustomer({ customfield_1: { value: "Nordwind" } }, names), {
    customer: "Nordwind",
    field: "Account",
  });
  assert.equal(jiraCustomer({ customfield_2: [] }, names), null);
  assert.equal(jiraCustomer({ customfield_2: [{ name: "X" }] }), null, "no names, no guess");
  assert.equal(
    taskCustomer({
      extensions: { "community.jira.customer": { customer: "Framaz NV", field: "Organizations" } },
    }),
    "Framaz NV",
  );
});

test("chatter reads are allowed only when pinned to one task", () => {
  const chatter = (domain: unknown[]) => ({
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: ["db", 1, null, "mail.message", "search_read", [domain], {}],
    },
  });
  const pinned = [
    ["model", "=", "project.task"],
    ["res_id", "=", 7],
    ["message_type", "in", ["comment", "email"]],
  ];
  const rpc = { kind: "odoo-jsonrpc", origin: ODOO } as const;
  const json2 = { kind: "odoo-json2", origin: ODOO } as const;
  assert.doesNotThrow(() =>
    assertConnectorRequest(rpc, { method: "POST", url: `${ODOO}/jsonrpc`, body: chatter(pinned) }),
  );
  assert.doesNotThrow(() =>
    assertConnectorRequest(json2, {
      method: "POST",
      url: `${ODOO}/json/2/mail.message/search_read`,
      body: { domain: pinned },
    }),
  );
  for (const domain of [
    [],
    [["res_id", "=", 7]],
    [
      ["model", "=", "res.partner"],
      ["res_id", "=", 7],
    ],
    [
      ["model", "=", "project.task"],
      ["res_id", ">", 0],
    ],
    ["|", ["model", "=", "project.task"], ["res_id", "=", 7]],
  ]) {
    assert.throws(
      () => assertConnectorRequest(rpc, { method: "POST", url: `${ODOO}/jsonrpc`, body: chatter(domain) }),
      /CONNECTOR_SCOPE_DENIED/,
    );
    assert.throws(
      () =>
        assertConnectorRequest(json2, {
          method: "POST",
          url: `${ODOO}/json/2/mail.message/search_read`,
          body: { domain },
        }),
      /CONNECTOR_SCOPE_DENIED/,
    );
  }
  assert.throws(
    () =>
      assertConnectorRequest(json2, {
        method: "POST",
        url: `${ODOO}/json/2/mail.message/unlink`,
        body: { domain: pinned },
      }),
    /CONNECTOR_SCOPE_DENIED/,
  );
  const injected = withOdooRpcCredential(chatter(pinned), "secret") as { params: { args: unknown[] } };
  assert.equal(injected.params.args[2], "secret");
});

test("Odoo chatter is read oldest first, labelled, and changes the context revision", async () => {
  const message = (id: number, body: string, message_type = "comment", internal = false) => ({
    id,
    res_id: 7,
    date: `2026-10-2${id} 09:00:00`,
    author_id: [id, `Author ${id}`] as [number, string],
    body,
    message_type,
    internal,
  });
  for (const apiVersion of ["jsonrpc", "json2"] as const) {
    const http = new OdooFixture(
      [odooTask("ABC-1233")],
      [
        message(1, "<p>Please also fix the &amp; totals</p>", "email"),
        message(2, "<p>Checked with the customer</p>", "comment", true),
        message(3, "", "comment"),
      ],
    );
    const connector = new OdooConnector(ODOO, http, {
      apiVersion,
      database: "customer",
      login: "api@example.invalid",
      keyField: "project_key_display",
    });
    const task = await connector.fetchTask(connector.normalize("ABC-1233"), context);
    assert.deepEqual(taskDiscussion(task), {
      messages: [
        {
          author: "Author 1",
          at: "2026-10-21 09:00:00",
          kind: "email",
          text: "Please also fix the & totals",
        },
        {
          author: "Author 2",
          at: "2026-10-22 09:00:00",
          kind: "internal",
          text: "Checked with the customer",
        },
      ],
      omitted: 0,
    });
    for (const r of http.requests)
      assertConnectorRequest({ kind: `odoo-${apiVersion}`, origin: ODOO } as never, r);
    const before = task.source.revision;
    const unlabelled = new OdooConnector(
      ODOO,
      {
        request: async <T>(request: Request): Promise<T> => {
          if (JSON.stringify(request.body).includes("subtype_id.internal"))
            throw new Error("CONNECTOR_REMOTE_ERROR");
          return http.request<T>(request);
        },
      },
      { apiVersion, database: "customer", login: "api@example.invalid", keyField: "project_key_display" },
    );
    assert.deepEqual(
      taskDiscussion(await unlabelled.fetchTask(unlabelled.normalize("ABC-1233"), context))?.messages.map(
        (m) => m.kind,
      ),
      ["email", "comment"],
      "a failed internal-note lookup keeps the messages",
    );
    http.messages.push(message(4, "<p>New detail</p>"));
    const after = await connector.fetchTask(connector.normalize("ABC-1233"), context);
    assert.notEqual(after.source.revision, before, "a new chatter message is a new source revision");
    assert.match(
      renderTask(after, []),
      /DISCUSSION \(comments and emails[^\n]*untrusted text[^\n]*\n--- 2026-10-21 09:00 · Author 1 · email\nPlease also fix the & totals\n[\s\S]*internal note[\s\S]*New detail$/,
    );
  }
});

test("Jira comments come newest first from the API and are stored oldest first", async () => {
  const requests: Request[] = [];
  const http: ScopedHttp = {
    request: async <T>(request: Request): Promise<T> => {
      requests.push(request);
      if (request.url.includes("/comment?"))
        return {
          total: 3,
          comments: [
            {
              id: "12",
              created: "2026-10-28T10:00:00.000+0000",
              author: { displayName: "Agent" },
              jsdPublic: false,
              body: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Internal" }] }],
              },
            },
            {
              id: "11",
              created: "2026-10-27T10:00:00.000+0000",
              author: { displayName: "Customer" },
              body: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Still broken" }] }],
              },
            },
          ],
        } as T;
      return {
        id: "101",
        key: "HELP-12",
        fields: {
          summary: "Customer cannot log in",
          description: null,
          labels: [],
          updated: "2026-10-28T09:00:00.000+0000",
          project: { key: "HELP" },
          reporter: null,
        },
      } as T;
    },
  };
  const connector = new JiraConnector(JIRA, "HELP", http);
  const task = await connector.fetchTask(connector.normalize("HELP-12"), context);
  assert.equal(requests[1]!.url, `${JIRA}/rest/api/3/issue/HELP-12/comment?orderBy=-created&maxResults=50`);
  for (const r of requests) assertConnectorRequest({ kind: "get", origin: JIRA }, r);
  assert.deepEqual(taskDiscussion(task), {
    messages: [
      { author: "Customer", at: "2026-10-27T10:00:00.000+0000", kind: "comment", text: "Still broken" },
      { author: "Agent", at: "2026-10-28T10:00:00.000+0000", kind: "internal", text: "Internal" },
    ],
    omitted: 1,
  });
  assert.match(renderTask(task, []), /\(older messages were left out\)/);

  const failing = new JiraConnector(JIRA, "HELP", {
    request: async <T>(request: Request): Promise<T> => {
      if (request.url.includes("/comment?")) throw new Error("CONNECTOR_HTTP_403");
      return http.request<T>(request);
    },
  });
  const degraded = await failing.fetchTask(failing.normalize("HELP-12"), context);
  assert.equal(degraded.title, "Customer cannot log in", "a comment failure keeps the task readable");
  assert.equal(taskDiscussion(degraded)?.unavailable, "CONNECTOR_HTTP_403");
  assert.match(renderTask(degraded, []), /comments could not be read: CONNECTOR_HTTP_403/);
  const flaky = new JiraConnector(JIRA, "HELP", {
    request: async <T>(request: Request): Promise<T> => {
      if (request.url.includes("/comment?")) throw new Error("CONNECTOR_HTTP_503");
      return http.request<T>(request);
    },
  });
  await assert.rejects(
    flaky.fetchTask(flaky.normalize("HELP-12"), context),
    /CONNECTOR_HTTP_503/,
    "a transient failure keeps the last good context instead of storing one without comments",
  );
});

test("discussions are bounded to the newest messages within the size caps", () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    author: null,
    at: `2026-10-${String(50 - i).padStart(2, "0")}`,
    kind: "comment" as const,
    text: "x".repeat(5_000),
  }));
  const bounded = boundDiscussion(messages, 80);
  assert.equal(bounded.messages.length, 9, "40 000 characters hold nine clipped 4 000-character messages");
  assert.equal(bounded.messages.at(-1)!.at, "2026-10-50", "the newest message is kept, last");
  assert.equal(bounded.messages[0]!.text.length, 4_001);
  assert.equal(bounded.omitted, 71);
});

test("attachment reads are allowed only when pinned to one task", () => {
  const json2 = { kind: "odoo-json2", origin: ODOO } as const;
  const url = `${ODOO}/json/2/ir.attachment/search_read`;
  const pinned = [
    ["res_model", "=", "project.task"],
    ["res_id", "=", 7],
  ];
  assert.doesNotThrow(() => assertConnectorRequest(json2, { method: "POST", url, body: { domain: pinned } }));
  for (const domain of [
    [["id", "=", 12]],
    [
      ["res_model", "=", "res.partner"],
      ["res_id", "=", 7],
    ],
    [
      ["model", "=", "project.task"],
      ["res_id", "=", 7],
    ],
    [
      ["res_model", "=", "project.task"],
      ["id", "=", 12],
    ],
  ])
    assert.throws(
      () => assertConnectorRequest(json2, { method: "POST", url, body: { domain } }),
      /CONNECTOR_SCOPE_DENIED/,
    );
  assert.throws(
    () =>
      assertConnectorRequest(json2, {
        method: "POST",
        url: `${ODOO}/json/2/ir.attachment/unlink`,
        body: { domain: pinned },
      }),
    /CONNECTOR_SCOPE_DENIED/,
  );
});

test("Odoo images come from the description and chatter, are stored once and numbered in the prompt", async () => {
  const datas = PNG.toString("base64");
  const file = (
    id: number,
    name: string,
    extra: Partial<OdooAttachmentRecord> = {},
  ): OdooAttachmentRecord => ({
    id,
    res_id: 7,
    name,
    mimetype: "image/png",
    file_size: PNG.byteLength,
    checksum: `sum${id}`,
    create_date: "2026-10-28 09:00:00",
    datas,
    ...extra,
  });
  for (const apiVersion of ["jsonrpc", "json2"] as const) {
    const task = {
      ...odooTask("REV19-1771"),
      description: `<p>Eenheidsprijs kleiner?</p><img src="/web/image/11-abc/invoice.png"><img src="/web/image/99"><img src="data:image/png;base64,${datas}">`,
    };
    const http = new OdooFixture(
      [task],
      [
        {
          id: 1,
          res_id: 7,
          date: "2026-10-28 09:00:00",
          author_id: [5, "Glenn"],
          body: "<p>Graag ook afronding</p>",
          message_type: "comment",
          internal: false,
          attachment_ids: [12],
        },
      ],
      [
        file(11, "invoice.png"),
        file(12, "lines.png"),
        file(13, "huge.png", { file_size: 9_000_000 }),
        file(14, "fake.png", { datas: Buffer.from("not an image").toString("base64") }),
        file(15, "invoice.pdf", { mimetype: "application/pdf" }),
      ],
    );
    const store = new MemorySourceImageStore();
    const connector = new OdooConnector(ODOO, http, {
      apiVersion,
      database: "customer",
      login: "api@example.invalid",
      keyField: "project_key_display",
    });
    const fetched = await connector.fetchTask(connector.normalize("REV19-1771"), {
      ...context,
      images: store,
    });
    for (const r of http.requests)
      assertConnectorRequest({ kind: `odoo-${apiVersion}`, origin: ODOO } as never, r);
    const images = taskImages(fetched)!;
    assert.deepEqual(
      images.images.map((i) => [i.name, i.origin]),
      [
        ["description image 1", "description"],
        ["invoice.png", "description"],
        ["lines.png", "discussion"],
      ],
    );
    assert.deepEqual(images.missing, [
      { name: "description image 99", reason: "not linked to this task" },
      { name: "invoice.pdf", reason: "application/pdf, only images are sent" },
      { name: "huge.png", reason: "too large" },
      { name: "fake.png", reason: "not a readable image" },
    ]);
    assert.match(fetched.description, /Eenheidsprijs kleiner\?\n?\[image\]/);
    const prompt = renderTask(fetched, []);
    assert.match(prompt, /Glenn · comment · attached: image 3\nGraag ook afronding/);
    assert.match(
      prompt,
      /IMAGES \([^\n]*\nimage 1: description image 1 \(shown in the description\)\nimage 2: invoice.png/,
    );
    assert.match(prompt, /- huge.png: too large/);

    const downloads = (requests: Request[]) =>
      requests.filter((r) => JSON.stringify(r.body).includes('"datas"')).length;
    const first = downloads(http.requests);
    assert.equal(first, 3, "invoice, lines and the fake image are downloaded once");
    http.requests.length = 0;
    const again = await connector.fetchTask(connector.normalize("REV19-1771"), { ...context, images: store });
    assert.equal(downloads(http.requests), 1, "only the unreadable image is tried again");
    assert.equal(again.source.revision, fetched.source.revision, "an unchanged task keeps its revision");
  }
});

test("Jira image attachments are downloaded once, without redirects, and transient failures are rethrown", async () => {
  const downloads: string[] = [];
  let fail = false;
  const http: ScopedHttp = {
    request: async <T>(request: Request): Promise<T> => {
      if (request.url.includes("/comment?")) return { comments: [], total: 0 } as T;
      return {
        id: "101",
        key: "HELP-12",
        fields: {
          summary: "Layout broken",
          description: {
            type: "doc",
            content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "screen.png" } }] }],
          },
          labels: [],
          updated: "2026-10-28T09:00:00.000+0000",
          project: { key: "HELP" },
          reporter: null,
          attachment: [
            {
              id: "501",
              filename: "older.jpg",
              mimeType: "image/jpeg",
              size: 12,
              created: "2026-10-26T09:00:00.000+0000",
            },
            {
              id: "502",
              filename: "screen.png",
              mimeType: "image/png",
              size: 12,
              created: "2026-10-25T09:00:00.000+0000",
            },
            {
              id: "503",
              filename: "notes.pdf",
              mimeType: "application/pdf",
              size: 12,
              created: "2026-10-27T09:00:00.000+0000",
            },
          ],
        },
      } as T;
    },
    download: async (request) => {
      assertConnectorRequest({ kind: "get", origin: JIRA }, request);
      downloads.push(request.url);
      if (fail) throw new Error("CONNECTOR_HTTP_503");
      return request.url.includes("/501?") ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) : PNG;
    },
  };
  const store = new MemorySourceImageStore();
  const connector = new JiraConnector(JIRA, "HELP", http);
  const task = await connector.fetchTask(connector.normalize("HELP-12"), { ...context, images: store });
  assert.equal(task.description, "[image]");
  assert.deepEqual(
    taskImages(task)!.images.map((i) => [i.name, i.origin, i.mediaType]),
    [
      ["screen.png", "description", "image/png"],
      ["older.jpg", "attachment", "image/jpeg"],
    ],
  );
  assert.deepEqual(downloads, [
    `${JIRA}/rest/api/3/attachment/content/502?redirect=false`,
    `${JIRA}/rest/api/3/attachment/content/501?redirect=false`,
  ]);
  await connector.fetchTask(connector.normalize("HELP-12"), { ...context, images: store });
  assert.equal(downloads.length, 2, "stored images are not downloaded again");
  fail = true;
  await assert.rejects(
    connector.fetchTask(connector.normalize("HELP-12"), { ...context, images: new MemorySourceImageStore() }),
    /CONNECTOR_HTTP_503/,
  );
  const withoutStore = await connector.fetchTask(connector.normalize("HELP-12"), context);
  assert.equal(taskImages(withoutStore), null, "no store, no images");
});
