import test from "node:test";
import assert from "node:assert/strict";
import {
  JiraConnector,
  ODOO_TASK_KEY_ROUTE,
  OdooConnector,
  htmlText,
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
import { plannedFor } from "../packages/contracts/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";
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

class OdooFixture implements ScopedHttp {
  readonly requests: Request[] = [];
  constructor(private readonly records: Array<ReturnType<typeof odooTask>>) {}
  async request<T>(request: Request): Promise<T> {
    this.requests.push(structuredClone(request));
    const body = request.body as { params?: { service: string; args: unknown[] }; domain?: unknown[][] };
    if (request.url.endsWith("/json/2/project.task/search_read")) return this.match(body.domain!) as T;
    if (body.params?.service === "common") return { jsonrpc: "2.0", id: 1, result: 42 } as T;
    const domain = (body.params!.args[5] as unknown[][][])[0]!;
    return { jsonrpc: "2.0", id: 1, result: this.match(domain) } as T;
  }
  private match(domain: unknown[][]) {
    const [field, , value] = domain[0]!;
    return this.records.filter((record) => record[field as "project_key_display"] === value);
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
