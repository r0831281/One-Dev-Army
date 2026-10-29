import { $, state, node } from "./core.js";

const DEMO_SESSION_KEY = "oda-demo-session-v1";

export function createDemo({
  selected,
  renderTerminal,
  mondayForOffset,
  localDateKey,
  connection,
  sample,
  renderAll,
  renderWork,
  renderPlanner,
  renderSummary,
  applyEvent,
}) {
  let telemetryDemo = null;
  function savedSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(DEMO_SESSION_KEY) || "null");
      return value?.version === 1 ? value : null;
    } catch {
      return null;
    }
  }
  function saveSession() {
    if (state.fixtureMode !== "demo") return;
    try {
      sessionStorage.setItem(
        DEMO_SESSION_KEY,
        JSON.stringify({
          version: 1,
          selectedTask: state.selectedTask,
          selected: state.selected,
          decisionHandoffs: state.decisionHandoffs,
          runs: state.runs.map((run) => ({
            runId: run.runId,
            projection: run.projection,
            demoStage: run.demoStage,
            failure: run.failure ?? null,
            lastFailure: run.lastFailure ?? null,
            recovery: run.recovery ?? null,
          })),
        }),
      );
    } catch {}
  }
  function restoreSession() {
    const saved = savedSession();
    if (!saved) return;
    for (const snapshot of Array.isArray(saved.runs) ? saved.runs : []) {
      const run = state.runs.find((candidate) => candidate.runId === snapshot?.runId);
      if (!run || !snapshot.projection || typeof snapshot.projection.state !== "string") continue;
      run.projection = snapshot.projection;
      if (Number.isInteger(snapshot.demoStage)) run.demoStage = snapshot.demoStage;
      run.failure = snapshot.failure ?? null;
      run.lastFailure = snapshot.lastFailure ?? null;
      run.recovery = snapshot.recovery ?? null;
    }
    if (saved.decisionHandoffs && typeof saved.decisionHandoffs === "object")
      state.decisionHandoffs = saved.decisionHandoffs;
    if (state.tasks.some((task) => task.taskId === saved.selectedTask))
      state.selectedTask = saved.selectedTask;
    if (state.runs.some((run) => run.runId === saved.selected)) state.selected = saved.selected;
  }
  function resetSession() {
    try {
      sessionStorage.removeItem(DEMO_SESSION_KEY);
      for (const key of ["oda-demo-work-horizon", "oda-demo-operations", "oda-demo-configuration"])
        localStorage.removeItem(key);
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith("oda-feedback/") || key?.startsWith("oda-intent/")) localStorage.removeItem(key);
      }
    } catch {}
  }
  function renderDemoActivity() {
    const run = selected();
    const stateValue = run?.projection.state || "READY";
    const activityByState = {
      AWAITING_PLAN: {
        lines: [
          "[context] task context accepted as plannable",
          "[planner] rollout plan revision 1 sealed",
          "[gate] waiting for developer feedback",
        ],
        timeline: [
          ["Context accepted", "09:14", false],
          ["Plan prepared", "09:18", false],
          ["Waiting for your feedback", "now", true],
        ],
      },
      TESTING: {
        lines: [
          "[sandbox] candidate image started",
          "[test] invoice rendering suite: 18 passed",
          "[test] professional-customer VAT cases running",
        ],
        timeline: [
          ["Context accepted", "09:14", false],
          ["Implementation sealed", "10:02", false],
          ["Tests running", "now", true],
        ],
      },
      FAILED: {
        lines: [
          "[test] checkout callback reproduction failed",
          "[recovery] candidate preserved for inspection",
          "[run] needs developer attention",
        ],
        timeline: [
          ["Implementation sealed", "11:06", false],
          ["Test failed", "11:14", true],
        ],
      },
      QUEUED: {
        lines: ["[queue] task accepted", "[queue] waiting for an available local sandbox"],
        timeline: [["Queued", "now", true]],
      },
      COMPLETED: {
        lines: ["[review] no blocking findings", "[report] completion report sealed", "[run] completed"],
        timeline: [
          ["Review passed", "Mon 15:22", false],
          ["Completed", "Mon 15:24", false],
        ],
      },
      READY: {
        lines: ["[task] context accepted; no execution has started"],
        timeline: [["Ready to start", "Jira backlog", false]],
      },
    };
    const activity = activityByState[stateValue] || activityByState.READY;
    state.terminal = activity.lines;
    renderTerminal();
    const timeline = $("timeline");
    timeline.replaceChildren();
    for (const [label, time, active] of activity.timeline) {
      const item = node("li", label, `timeline-item${active ? " active" : ""}`);
      item.append(node("small", time));
      timeline.append(item);
    }
  }

  function fixture(mode) {
    state.fixtureMode = mode;
    $("connect").textContent = "Refresh demo";
    try {
      state.workHorizon = JSON.parse(localStorage.getItem("oda-demo-work-horizon") || "null") || {
        days: 7,
        timezone: "Europe/Brussels",
        overrides: [],
      };
      if (
        !Number.isInteger(state.workHorizon.days) ||
        state.workHorizon.days < 0 ||
        state.workHorizon.days > 365 ||
        typeof state.workHorizon.timezone !== "string" ||
        !Array.isArray(state.workHorizon.overrides)
      )
        throw new Error("Invalid saved demo horizon");
      new Intl.DateTimeFormat("en", { timeZone: state.workHorizon.timezone }).format();
    } catch {
      state.workHorizon = { days: 7, timezone: "Europe/Brussels", overrides: [] };
    }
    $("demo-reset").hidden = false;
    $("demo-reset").textContent = mode === "performance" ? "Back to task demo" : "Reset demo";
    state.planningSync = {
      intervalMinutes: 30,
      lastCheckedAt: new Date().toISOString(),
      checked: 6,
      updated: 1,
      failed: 0,
    };
    const base = mondayForOffset();
    const dateAt = (offset) => {
      const date = new Date(base);
      date.setDate(date.getDate() + offset);
      return localDateKey(date);
    };
    state.tasks = [
      {
        taskId: "10000000-0000-4000-8000-000000000001",
        title: "Geen btw nummer in adres",
        description:
          "Wij zijn op onze facturen geen btw nummer bij de ontvanger terwijl zij wel een proffesionele klant zijn.",
        source: { key: "ESERV-13355", externalId: "13355", url: "#", provider: "Jira" },
        repositoryName: "e-service",
        customer: "Tegel",
        acceptanceCriteria: [
          "Toon het btw-nummer bij de ontvanger op facturen voor professionele klanten wanneer het beschikbaar is.",
          "Behoud de bestaande factuuropmaak voor particuliere klanten.",
        ],
        provenance: { fetchedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
        plannedFor: dateAt(2),
        planningRevision: 3,
        planningUpdatedAt: new Date(Date.now() - 86400000).toISOString(),
        contextAssessment: {
          status: "ACCEPTED",
          agent: "Acceptance agent",
          contextRevision: 4,
          acceptedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
        },
      },
      {
        taskId: "10000000-0000-4000-8000-000000000002",
        title: "Confirm rollout plan for usage alerts",
        description:
          "The planning agent has prepared a rollout plan and needs confirmation on the alert thresholds before implementation.",
        source: { key: "OPS-87", externalId: "87", url: "#", provider: "Jira" },
        repositoryName: "one-developer-army",
        acceptanceCriteria: ["Flag missing prices", "Link immutable usage evidence"],
        provenance: { fetchedAt: new Date(Date.now() - 86400000).toISOString() },
        plannedFor: dateAt(4),
        planningRevision: 1,
        planningUpdatedAt: new Date().toISOString(),
        contextAssessment: {
          status: "ACCEPTED",
          agent: "Acceptance agent",
          contextRevision: 2,
          acceptedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        },
      },
      {
        taskId: "10000000-0000-4000-8000-000000000003",
        title: "Document sandbox recovery drill",
        description: "Capture operator recovery steps and the exact evidence produced by the drill.",
        source: { key: "DOC-31", externalId: "31", url: "#", provider: "Jira" },
        repositoryName: "one-developer-army",
        acceptanceCriteria: ["Record exact commands", "Include known limitations"],
        provenance: { fetchedAt: new Date().toISOString() },
        plannedFor: null,
        planningRevision: 0,
        planningUpdatedAt: null,
        contextAssessment: null,
      },
      {
        taskId: "10000000-0000-4000-8000-000000000004",
        title: "Fix intermittent checkout timeout",
        description: "The test suite found a non-deterministic timeout in the checkout callback flow.",
        source: { key: "WEB-204", externalId: "204", url: "#", provider: "Jira" },
        repositoryName: "storefront",
        acceptanceCriteria: ["Reproduce the timeout", "Keep callback retries idempotent"],
        provenance: { fetchedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
        plannedFor: dateAt(1),
        planningRevision: 5,
        planningUpdatedAt: new Date().toISOString(),
        contextAssessment: {
          status: "ACCEPTED",
          agent: "Acceptance agent",
          contextRevision: 5,
          acceptedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        },
      },
      {
        taskId: "10000000-0000-4000-8000-000000000005",
        title: "Add invoice export audit fields",
        description: "Add the requested audit columns to the accounting export.",
        source: { key: "FIN-49", externalId: "49", url: "#", provider: "Jira" },
        repositoryName: "billing-service",
        acceptanceCriteria: ["Export actor and timestamp", "Preserve the existing CSV contract"],
        provenance: { fetchedAt: new Date(Date.now() - 86400000).toISOString() },
        plannedFor: dateAt(3),
        planningRevision: 2,
        planningUpdatedAt: new Date().toISOString(),
        contextAssessment: {
          status: "ACCEPTED",
          agent: "Acceptance agent",
          contextRevision: 2,
          acceptedAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        },
      },
      {
        taskId: "10000000-0000-4000-8000-000000000006",
        title: "Correct customer address formatting",
        description: "Normalize the printed address layout for international invoices.",
        source: { key: "BILL-118", externalId: "118", url: "#", provider: "Jira" },
        repositoryName: "billing-service",
        acceptanceCriteria: ["International address snapshot passes", "No domestic invoice regression"],
        provenance: { fetchedAt: new Date(Date.now() - 5 * 86400000).toISOString() },
        plannedFor: dateAt(0),
        planningRevision: 4,
        planningUpdatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        contextAssessment: {
          status: "ACCEPTED",
          agent: "Acceptance agent",
          contextRevision: 4,
          acceptedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
        },
      },
    ];
    const makeRun = (suffix, taskId, stateValue, demoStage, currentGate = null) => ({
      runId: `phase4-${suffix}`,
      workflowId: `task/${taskId}/run/phase4-${suffix}`,
      manifest: { taskId, contextRevision: 2, repository: { id: "fixture-repository" } },
      demoStage,
      projection: {
        state: stateValue,
        stateRevision: 42,
        updatedAt: new Date().toISOString(),
        currentGate,
      },
    });
    const feedbackGate = {
      id: "30000000-0000-4000-8000-000000000002",
      version: 1,
      kind: "PLAN_APPROVAL",
      state: "PENDING",
      artifactHash: "a".repeat(64),
      proposal: {
        summary: "Roll out alerts in report-only mode before enabling notifications.",
        needsYourInput:
          "Should unpriced calls alert immediately, or only after three consecutive occurrences?",
        recommendation: "Then enable notifications after three consecutive unpriced calls.",
        rationale:
          "Report-only mode validates the signal first; the three-occurrence threshold prevents one-off provider gaps from paging you.",
        alternatives: [
          {
            label: "Alert immediately",
            tradeoff: "Fastest visibility, but a single transient pricing gap can create noise.",
          },
          {
            label: "Send a daily digest",
            tradeoff: "Lowest interruption, but genuine reconciliation failures may be noticed later.",
          },
          {
            label: "Keep report-only mode",
            tradeoff: "No notifications; requires someone to check the report manually.",
          },
        ],
        estimatedCost: "USD 0.42",
      },
    };
    state.runs = [
      makeRun("testing", "10000000-0000-4000-8000-000000000001", "TESTING", 3),
      makeRun("feedback", "10000000-0000-4000-8000-000000000002", "AWAITING_PLAN", 1, feedbackGate),
      makeRun("failed", "10000000-0000-4000-8000-000000000004", "FAILED", 3),
      makeRun("queued", "10000000-0000-4000-8000-000000000005", "QUEUED", 0),
      makeRun("completed", "10000000-0000-4000-8000-000000000006", "COMPLETED", 6),
    ];
    state.runs.find((run) => run.runId === "phase4-failed").failure = {
      check: "Checkout callback integration",
      command: "pnpm test -- checkout-callback",
      message: "Timed out waiting for the idempotent callback acknowledgement after 5000 ms.",
      attempt: "2 of 3",
      occurredAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
      candidateHash: "c".repeat(64),
      evidenceHash: "b".repeat(64),
      log: [
        "FAIL checkout callback remains idempotent after a delayed provider response",
        "expected callback acknowledgement within 5000 ms",
        "received duplicate callback after timeout at +5218 ms",
        "candidate preserved; no source write, merge, or publication performed",
      ],
    };
    state.selectedTask = "10000000-0000-4000-8000-000000000002";
    state.selected = "phase4-feedback";
    restoreSession();
    connection("Fixture mode", "online");
    if (mode === "demo") {
      $("tokens").textContent = "18,420";
      $("cost").textContent = "USD 0.37";
      $("active").textContent = "2";
      sample(34, 48);
      renderAll();
      return;
    }
    $("banner").hidden = false;
    $("banner").textContent =
      "Performance test mode — this is a synthetic 100-step browser workload, not a real task or a screen you need to operate.";
    $("stage-count").textContent = "100 synthetic steps";
    const host = $("graph");
    host.replaceChildren(
      ...Array.from({ length: 100 }, (_, i) => {
        const n = node("li", `Step ${i + 1}`, `node ${i === 51 ? "running" : i < 51 ? "passed" : ""}`);
        return n;
      }),
    );
    for (let i = 0; i < 10000; i++) state.terminal.push(`line ${i + 1} safe fixture output`);
    renderTerminal();
    for (let tick = 0; tick < 300; tick++)
      for (let i = 0; i < 10; i++)
        applyEvent({
          type: i === 0 && tick % 50 === 0 ? "gate.heartbeat" : "sample",
          cpu: (tick + i) % 100,
          ram: 40,
        });
    renderWork();
    renderPlanner();
    renderSummary();
    const summary = $("summary");
    summary.replaceChildren(
      node("span", "DIAGNOSTIC ONLY", "eyebrow"),
      node("h1", "Dashboard rendering stress test"),
      node(
        "p",
        "Used by automated verification to prove the graph and terminal stay responsive under load. Return to the demo to work with normal tasks.",
        "muted",
      ),
    );
    window.__ODA_PHASE4_METRICS__ = {
      nodes: host.children.length,
      terminalBuffered: state.terminal.length,
      terminalDomLines: state.renderedLines,
      eventsApplied: state.events,
      criticalApplied: state.critical,
      bounded: state.terminal.length <= 10000 && state.renderedLines <= 60,
      lowPower: state.lowPower,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  }

  function demoTelemetry() {
    const now = Math.floor(Date.now() / 10000) * 10;
    if (!telemetryDemo)
      telemetryDemo = Array.from({ length: 30 }, (_, i) => ({
        time: now - (29 - i) * 10,
        input: Math.round(140 + (Math.sin(i * 0.65) + 1) * 150),
        output: Math.round(60 + (Math.cos(i * 0.45) + 1) * 65),
        completed: i % 3 === 0 ? 1 : 0,
        spend: 0.002 + (Math.sin(i * 0.65) + 1) * 0.002,
        unpriced: 0,
        unknown_tokens: 0,
      }));
    while (telemetryDemo.at(-1).time < now) {
      telemetryDemo.push({
        time: telemetryDemo.at(-1).time + 10,
        input: 0,
        output: 0,
        completed: 0,
        spend: 0,
        unpriced: 0,
        unknown_tokens: 0,
      });
      telemetryDemo.shift();
    }
    const last = telemetryDemo.at(-1);
    last.input += 30 + Math.round(Math.random() * 120);
    last.output += 15 + Math.round(Math.random() * 45);
    last.spend += 0.0006;
    if (Math.random() > 0.55) last.completed++;
    return {
      observedAt: new Date().toISOString(),
      buckets: structuredClone(telemetryDemo),
      contributions: telemetryDemo.flatMap((b) => {
        const agents = [
          {
            agentId: "agent:planner",
            agentName: "Planner",
            provider: "Provider A",
            model: "Fast",
            share: 0.22,
            costShare: 0.1,
          },
          {
            agentId: "agent:builder",
            agentName: "Builder",
            provider: "Provider A",
            model: "Reasoning",
            share: 0.5,
            costShare: 0.65,
          },
          {
            agentId: "agent:reviewer",
            agentName: "Reviewer",
            provider: "Provider B",
            model: "Reasoning",
            share: 0.28,
            costShare: 0.25,
          },
        ];
        const used = { input: 0, output: 0 };
        return agents.map((agent, i) => {
          const input = i === 2 ? b.input - used.input : Math.floor(b.input * agent.share);
          const output = i === 2 ? b.output - used.output : Math.floor(b.output * agent.share);
          used.input += input;
          used.output += output;
          return {
            ...agent,
            time: b.time,
            input,
            output,
            spend: b.spend * agent.costShare,
            unpriced: 0,
            unknown_tokens: 0,
            taskId: state.tasks[i]?.taskId,
            runId: state.runs.find((r) => r.manifest.taskId === state.tasks[i]?.taskId)?.runId,
            stepId: `demo-step-${i}`,
            stepKey: agent.agentName.toLowerCase(),
            stepIteration: i === 1 ? 2 : 1,
            stepCompleted: i !== 1,
            attempts: 1,
          };
        });
      }),
      active: 2,
      queued: 1,
    };
  }

  return { fixture, renderDemoActivity, demoTelemetry, saveSession, resetSession };
}
