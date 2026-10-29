import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { startDashboardPreview } from "./dashboard-preview.mjs";
import puppeteer from "puppeteer-core";
import { PGlite } from "@electric-sql/pglite";

// Exercise the production SQL against PostgreSQL semantics, including workspace isolation.
const db = new PGlite();
await db.exec(`CREATE TABLE workflow_runs(id text, workspace_id text, state text);
  CREATE TABLE model_usage(attempt_id text, run_id text, category text, observed_at timestamptz, input_tokens bigint, output_tokens bigint, amount_microusd bigint, step_id text, provider text DEFAULT 'provider-a', model text DEFAULT 'shared-model', usage jsonb DEFAULT '{}');
  CREATE TABLE usage_adjustments(attempt_id text, delta_microusd bigint);
  CREATE TABLE agent_steps(run_id text, state text, updated_at timestamptz, id text, step_key text);
  INSERT INTO workflow_runs VALUES ('run','workspace','TESTING'),('other','other-workspace','TESTING');
  INSERT INTO model_usage(attempt_id,run_id,category,observed_at,input_tokens,output_tokens,amount_microusd) VALUES ('a','run','model',now(),100,50,1000),('b','other','model',now(),99999,99999,99999);
  INSERT INTO usage_adjustments VALUES ('a',500);
  INSERT INTO agent_steps VALUES ('run','COMPLETED',now(),'planner-step','planner');`);
await db.exec(
  "ALTER TABLE workflow_runs ADD COLUMN task_id text; ALTER TABLE agent_steps ADD COLUMN logical_iteration integer DEFAULT 1",
);
const source = await readFile("apps/api/src/server.ts", "utf8");
const sql = source.match(/async telemetry\(\)[\s\S]*?pool\.query\(\s*`([\s\S]*?)`/)[1];
const result = await db.query(sql, ["workspace", Math.ceil(Date.now() / 1000)]);
assert.equal(result.rows.length, 30);
assert.equal(
  result.rows.reduce((s, row) => s + row.input, 0),
  100,
);
assert.equal(
  result.rows.reduce((s, row) => s + row.completed, 0),
  1,
);
assert.equal(
  result.rows.reduce((s, row) => s + row.spend, 0),
  0.0015,
);
const contributionSql = source.match(/const contributions = await pool\.query\(\s*`([\s\S]*?)`/)[1];
const queryContributions = () => db.query(contributionSql, ["workspace", Math.ceil(Date.now() / 1000)]);
let attributed = await queryContributions();
assert.equal(attributed.rows.length, 1);
assert.equal(attributed.rows[0].agentName, "Unattributed");
assert.equal(attributed.rows[0].input, 100);
assert.equal(attributed.rows[0].spend, 0.0015);
await db.exec("UPDATE model_usage SET step_id='planner-step' WHERE attempt_id='a'");
attributed = await queryContributions();
assert.equal(attributed.rows[0].agentId, "role:planner");
await db.exec(`UPDATE model_usage SET usage='{"agentId":"agent-1","agentName":"Agent One"}' WHERE attempt_id='a';
  INSERT INTO model_usage(attempt_id,run_id,category,observed_at,input_tokens,output_tokens,amount_microusd,provider) VALUES ('c','run','model',now(),200,100,NULL,'provider-b');`);
attributed = await queryContributions();
assert.equal(attributed.rows.length, 2);
assert(attributed.rows.some((r) => r.agentId === "agent:agent-1"));
assert.equal(attributed.rows.find((r) => r.provider === "provider-b").unpriced, 1);
await db.close();

const server = await startDashboardPreview();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath:
      process.env.ODA_CHROMIUM_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await page.setViewport({ width: 1560, height: 1100 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const rootResponse = await fetch(url, { redirect: "manual" });
  assert.equal(rootResponse.status, 302);
  assert.equal(rootResponse.headers.get("location"), "/?fixture=demo");
  await page.evaluateOnNewDocument(() => {
    if (globalThis.sessionStorage.getItem("demo-cache-checked")) return;
    globalThis.sessionStorage.setItem("demo-cache-checked", "true");
    globalThis.localStorage.setItem(
      "oda-dashboard-preferences",
      JSON.stringify("legacy invalid preferences"),
    );
    globalThis.localStorage.setItem(
      "oda-demo-work-horizon",
      JSON.stringify({ days: "invalid", timezone: "invalid" }),
    );
    globalThis.localStorage.setItem("oda-demo-operations", JSON.stringify({ paused: "invalid" }));
    globalThis.localStorage.setItem("oda-demo-configuration", JSON.stringify({ profiles: [null] }));
  });
  let demoApiRequests = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/")) demoApiRequests++;
  });
  await page.goto(`${url}/?fixture=demo`);
  assert.equal(await page.$$eval('.tab[data-tab="config"]', (nodes) => nodes.length), 0);
  assert.equal(await page.$eval("#settings-dialog", (dialog) => dialog.open), false);
  await page.click("#settings-open");
  assert.equal(await page.$eval("#settings-dialog", (dialog) => dialog.open), true, JSON.stringify(errors));
  assert.equal(await page.$eval("#horizon-days", (n) => n.value), "7");
  await page.click("#connect");
  assert.equal(demoApiRequests, 0, "refreshing the demo must not call backend APIs");
  await page.$eval("#horizon-days", (input) => {
    input.value = "0";
  });
  await page.click("#horizon-save");
  await page.waitForFunction(() =>
    document.querySelector("#horizon-status").textContent.startsWith("Saved."),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-open");
  await page.reload();
  await page.click("#settings-open");
  assert.equal(await page.$eval("#horizon-days", (input) => input.value), "0");
  await page.click("#power");
  assert.equal(await page.$eval("#power", (button) => button.getAttribute("aria-pressed")), "true");
  await page.click("#power");
  await page.$eval("#horizon-days", (input) => {
    input.value = "7";
  });
  await page.click("#horizon-save");
  await page.click("#settings-close");
  await page.click('[data-work-view="tasks"]');
  await page.evaluate(() =>
    [...document.querySelectorAll(".task-card")]
      .find((button) => button.textContent.includes("Document sandbox recovery drill"))
      .click(),
  );
  assert.match(await page.$eval("#summary", (n) => n.textContent), /no planned date/);
  await page.type('[aria-label="Work horizon override reason"]', "Urgent task for today");
  await page.evaluate(() =>
    [...document.querySelectorAll("#summary button")]
      .find((button) => button.textContent === "Allow work now")
      .click(),
  );
  await page.waitForFunction(() =>
    document.querySelector("#summary").textContent.includes("Manual override"),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll("#summary button")]
      .find((button) => button.textContent === "Use horizon again")
      .click(),
  );
  await page.waitForFunction(() =>
    document.querySelector("#summary").textContent.includes("no planned date"),
  );
  assert.deepEqual(errors, []);
  await page.waitForFunction(() => document.querySelector("#burn-value").textContent !== "—");
  const before = await page.$eval("#burn-chart .telemetry-line", (n) => n.getAttribute("d"));
  await page.waitForFunction(
    (d) => document.querySelector("#burn-chart .telemetry-line").getAttribute("d") !== d,
    {},
    before,
  );
  await page.waitForFunction(() => document.querySelectorAll(".telemetry-card svg path").length >= 10);
  assert.equal(await page.$eval("#terminal-disclosure", (n) => n.open), false);
  await page.select("#work-eligibility", "undated");
  assert.equal(await page.$$eval(".task-card", (nodes) => nodes.length), 1);
  await page.select("#work-eligibility", "all");
  await page.waitForFunction(() => document.querySelector("#budget-summary").textContent.includes("spent"));
  await page.click("#pause-work");
  await page.waitForFunction(() => document.querySelector("#pause-work").textContent === "Resume new work");
  await page.click("#pause-work");
  assert.equal(await page.$$eval("#contribution-rows .contribution-row", (rows) => rows.length), 3);
  const allBurn = await page.$eval("#burn-value", (n) => n.textContent);
  await page.select("#telemetry-agent", "agent:builder");
  assert.notEqual(await page.$eval("#burn-value", (n) => n.textContent), allBurn);
  assert.equal(await page.$$eval("#contribution-rows .contribution-row", (rows) => rows.length), 1);
  await page.select("#telemetry-model", JSON.stringify(["Provider B", "Reasoning"]));
  assert.equal(await page.$eval("#burn-value", (n) => n.textContent), "0");
  assert.match(await page.$eval("#contribution-note", (n) => n.textContent), /No usage/);
  await page.select("#telemetry-agent", "");
  assert.equal(await page.$$eval("#contribution-rows .contribution-row", (rows) => rows.length), 1);
  await page.select("#telemetry-model", "");
  await page.click('[data-contribution-group="model"]');
  assert.equal(await page.$$eval("#contribution-rows .contribution-row", (rows) => rows.length), 3);
  await page.select("#contribution-sort", "spend");
  assert.match(await page.$eval(".contribution-name", (n) => n.textContent), /Provider A \/ Reasoning/);
  await page.click(".contribution-open");
  assert.equal(await page.$eval("#telemetry-drilldown", (n) => n.hidden), false);
  assert.match(await page.$eval("#drilldown-rows", (n) => n.textContent), /transport retries not recorded/);
  await page.click("#drilldown-close");
  await mkdir(".validation", { recursive: true });
  await page.click("#settings-open");
  await page.$eval("#operations-form", (form) => (form.closest("details").open = true));
  await page.$eval("#ops-daily", (n) => (n.value = "12"));
  await page.$eval("#ops-concurrency", (n) => (n.value = "2"));
  await page.$eval("#operations-form", (form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector("#operations-status").textContent === "Saved.");
  await page.$eval("#profile-form", (form) => (form.closest("details").open = true));
  const profileId = await page.$eval("#profile-json", (n) => {
    const p = JSON.parse(n.value);
    p.name = "Browser planner";
    n.value = JSON.stringify(p);
    return p.id;
  });
  await page.$eval("#profile-form", (form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector("#profile-status").textContent === "Saved.");
  await page.select('#assignment-fields select[data-role="planner"]', profileId);
  await page.$eval("#assignment-form", (form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector("#assignment-status").textContent === "Saved.");
  await page.$eval("#settings-dialog", (dialog) => {
    dialog.querySelectorAll("details").forEach((n) => (n.open = false));
  });
  await page.screenshot({ path: ".validation/dashboard-settings.png", fullPage: true });
  await page.click("#settings-close");
  await page.$eval(".activity", (n) => (n.scrollTop = 0));
  await page.screenshot({ path: ".validation/dashboard-telemetry.png", fullPage: true });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width: 390, height: 844 });
  await page.click('[data-mobile-view="activity"]');
  assert(await page.$eval("#telemetry", (n) => n.getBoundingClientRect().width > 0));
  await page.screenshot({ path: ".validation/dashboard-telemetry-mobile.png", fullPage: true });

  let fail = false;
  let releaseSecondEvent = false,
    resync = false,
    snapshotCalls = 0;
  const now = Math.floor(Date.now() / 1000);
  const snapshot = {
    active: 2,
    queued: 1,
    observedAt: new Date().toISOString(),
    buckets: Array.from({ length: 30 }, (_, i) => ({
      time: now - (29 - i) * 10,
      input: 100,
      output: 50,
      spend: 0,
      completed: 1,
      unpriced: 1,
      unknown_tokens: 0,
    })),
  };
  await page.setRequestInterception(true);
  const liveTask = {
    taskId: "11111111-1111-4111-8111-111111111111",
    title: "Live task",
    description: "A live task",
    revision: 1,
    source: { key: "LIVE-1" },
    repository: { id: "repo" },
    acceptanceCriteria: [],
    plannedFor: "2026-10-28",
  };
  const liveGate = {
    id: "gate",
    version: 1,
    state: "PENDING",
    artifactHash: "a".repeat(64),
    proposal: { summary: "Live plan" },
  };
  const liveRun = {
    runId: "live-run",
    workflowId: "live-workflow",
    manifest: { taskId: liveTask.taskId, contextRevision: 1, repository: { id: "repo" } },
    projection: {
      state: "AWAITING_PLAN",
      stateRevision: 1,
      updatedAt: new Date().toISOString(),
      currentGate: liveGate,
    },
  };
  const policy = {
    dailyLimitUsd: 12,
    taskLimitUsd: 2,
    reservationUsd: 0.5,
    maxConcurrentRuns: 3,
    paused: false,
    unpricedPolicy: "allow",
    timezone: "Europe/Brussels",
  };
  page.on("request", (req) => {
    const parsed = new URL(req.url());
    let body;
    if (parsed.pathname === "/api/v1/snapshot") {
      snapshotCalls++;
      body = { snapshotCursor: snapshotCalls === 1 ? 0 : 2, journalEpoch: "test" };
    }
    if (parsed.pathname === "/api/v1/events/history") {
      const after = Number(parsed.searchParams.get("after"));
      body = {
        journalEpoch: "test",
        latestCursor: 2,
        resync,
        events:
          after === 0
            ? [{ seq: 1, type: "terminal", payload: { text: "event stream connected" } }]
            : after === 1 && releaseSecondEvent
              ? [{ seq: 2, type: "run.projected", payload: {} }]
              : [],
      };
      resync = false;
    }
    if (parsed.pathname === "/api/v1/tasks")
      body = {
        items: [{ ...liveTask, title: releaseSecondEvent ? "Updated live task" : "Live task" }],
        workHorizon: { days: 7, timezone: "Europe/Brussels", overrides: [] },
        sync: { lastCheckedAt: new Date().toISOString(), failed: 0 },
      };
    if (parsed.pathname === "/api/v1/runs") body = { items: [liveRun] };
    if (parsed.pathname === "/api/v1/operations")
      body = { policy, spent: 0.37, reserved: 0.5, remaining: 11.13, active: 1, unpriced: 0 };
    if (parsed.pathname === "/api/v1/configuration")
      body = {
        connectors: [],
        repositories: [],
        profiles: [],
        roles: [],
        assignments: {},
        readiness: {
          connectors: false,
          tasksSynced: true,
          agentsConfigured: false,
          executionBackend: "deterministic",
          liveModelExecution: false,
        },
      };
    if (parsed.pathname === "/api/v1/profiles") body = { items: [] };
    if (body)
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (req.url().endsWith("/api/v1/telemetry"))
      return req.respond({
        status: fail ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot),
      });
    return req.continue();
  });
  await page.evaluate(() =>
    globalThis.localStorage.setItem(
      "oda-last-visit",
      JSON.stringify({
        at: Date.now() - 60000,
        spent: 0.1,
        day: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" }),
      }),
    ),
  );
  await page.setViewport({ width: 1560, height: 1100 });
  await page.goto(`${url}/?live=1`);
  await page.waitForFunction(() => document.querySelector("#burn-value").textContent === "900");
  assert.equal(await page.$eval("#velocity-value", (n) => n.textContent), "6");
  assert.equal(await page.$eval("#spend-value", (n) => n.textContent), "—");
  assert.match(await page.$eval("#spend-detail", (n) => n.textContent), /6 unpriced/);
  await page.waitForSelector(".decision-action.reject");
  await page.click(".decision-action.reject");
  await page.type("#decision textarea", "Preserve this draft during live updates");
  await page.$eval("#decision textarea", (n) => (n.dataset.preserved = "true"));
  releaseSecondEvent = true;
  await page.waitForFunction(() =>
    document.querySelector("#summary").textContent.includes("Updated live task"),
  );
  assert.equal(await page.$eval("#decision textarea", (n) => n.dataset.preserved), "true");
  assert.equal(
    await page.$eval("#decision textarea", (n) => n.value),
    "Preserve this draft during live updates",
  );
  await page.waitForFunction(() => !document.querySelector("#since-visit").hidden);
  assert.match(await page.$eval("#since-summary", (n) => n.textContent), /1 need your decision/);
  const refreshedSnapshot = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/v1/snapshot", {
    timeout: 10000,
  });
  resync = true;
  await refreshedSnapshot;
  assert(snapshotCalls >= 2, "journal gaps must fetch another snapshot");
  fail = true;
  await page.waitForFunction(() => document.querySelector("#burn-card").dataset.stale === "true");
  assert.equal(await page.$eval("#burn-value", (n) => n.textContent), "900");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Settings, horizons, spending controls, profile assignment, drill-down, saved filters, live updates, draft preservation, event resync, mobile, reduced motion, telemetry and stale states",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
