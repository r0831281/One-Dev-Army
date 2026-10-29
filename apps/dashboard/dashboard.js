import { mountWorkspaceControls } from "./workspace-controls.js";
import { mountEnvironmentSettings, renderAnalysePanel } from "./environments.js";
import { $, stored, remember, preferences, state, auth, node } from "./core.js";
import { startGateParticles, stopGateParticles } from "./particles.js";
import { createDemo } from "./demo.js";
import { createSettings, settingsState } from "./settings.js";
import { createTelemetry } from "./telemetry.js";
mountWorkspaceControls();
{
  const dialog = document.getElementById("settings-dialog");
  if (dialog)
    mountEnvironmentSettings(dialog.querySelector(".settings-scroll") || dialog, {
      request: (...args) => request(...args),
      errorLabel: (error) => analyseErrorLabel(error),
    });
}
let telemetry = null;
const demo = createDemo({
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
});
const settings = createSettings({
  request,
  renderWork,
  renderVisitSummary,
  renderConfiguration,
  load,
  readLive,
});
const previousVisit = stored("oda-last-visit", null);
let visitDismissed = false;
let executionUpdatedAt = 0;
let eventCursor = null;
let eventEpoch = null;
let liveRefreshing = false;
function connection(label, kind) {
  $("connection").textContent = label;
  $("connection").className = `status ${kind}`;
  state.online = kind === "online";
  $("banner").hidden = state.online;
  if ($("activity-connection")) {
    $("activity-connection").textContent = state.fixtureMode
      ? "Demo"
      : state.online
        ? "Connected"
        : "Offline";
    $("activity-connection").className = `status ${state.online ? "online" : "offline"}`;
  }
  renderGate();
}
async function request(path, options = {}) {
  try {
    const response = await fetch(path, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.error?.message || response.statusText), { code: body.error?.code });
    if (!state.online) connection("Connected", "online");
    return body;
  } catch (error) {
    if (error instanceof TypeError) connection("Offline", "offline");
    throw error;
  }
}
const ANALYSE_ERRORS = {
  LIVE_AGENTS_NOT_CONFIGURED:
    "assign Anthropic profiles to the context-reviewer and planner roles in Settings → Agent profiles.",
  PROFILE_REVISION_CONFLICT:
    "an assigned agent profile changed while starting. Reload the page and try again.",
  PROVIDER_UNAVAILABLE: "the assigned profile's credential is not set in the API process.",
  IDEMPOTENCY_CONFLICT: "a previous start attempt is still recorded. Reload the page and try again.",
  ENVIRONMENT_NOT_FOUND: "that work environment no longer exists. Rescan environments in Settings.",
  ENVIRONMENT_BRANCH_NOT_FOUND: "that branch does not exist in the environment's checkout.",
  DATABASE_NOT_IN_ENVIRONMENT: "that database does not belong to the chosen environment.",
  CONFIRMATION_REQUIRED: "type the database name exactly to confirm.",
  BACKUP_PATH_DENIED: "backups must be inside the downloads folder or the environment folder.",
  RESTORE_ALREADY_RUNNING: "a restore is already running for this environment.",
  DATABASE_IN_USE: "the database has open connections; stop Odoo or close sessions first.",
  DATABASE_NOT_SCRATCH: "only codex_, claude_ or oda_ scratch copies can be deleted here.",
};
function analyseErrorLabel(error) {
  const label = ANALYSE_ERRORS[error.code];
  return label ? `${label} (${error.code})` : error.message;
}
function selected() {
  const direct = state.runs.find((r) => r.runId === state.selected);
  if (direct) return direct;
  return state.runs.find((r) => r.manifest.taskId === state.selectedTask) || null;
}
function selectedTask() {
  return state.tasks.find((task) => task.taskId === state.selectedTask) || null;
}
function taskForRun(run) {
  return state.tasks.find((task) => task.taskId === run.manifest.taskId) || null;
}
function assessmentFor(task = selectedTask(), run = selected()) {
  if (task?.contextAssessment) return task.contextAssessment;
  if (run && !String(run.projection.state).includes("CONTEXT"))
    return {
      status: "ACCEPTED",
      agent: "Acceptance agent",
      contextRevision: run.manifest.contextRevision || task?.revision || 1,
      acceptedAt: run.projection.updatedAt,
    };
  return null;
}
function runStateInfo(run) {
  if (!run) return { label: "Ready to start", kind: "ready" };
  const stateValue = run.projection.state;
  if (stateValue === "AWAITING_PLAN") return { label: "Needs your feedback", kind: "attention" };
  if (stateValue === "AWAITING_CONTEXT") return { label: "Needs clarification", kind: "attention" };
  if (stateValue === "FAILED" || stateValue === "NEEDS_ATTENTION")
    return { label: "Needs attention", kind: "failed" };
  if (stateValue === "COMPLETED") return { label: "Completed", kind: "completed" };
  if (stateValue === "QUEUED") return { label: "Queued", kind: "queued" };
  return { label: stateValue.charAt(0) + stateValue.slice(1).toLowerCase(), kind: "running" };
}
function needsHumanIntervention(run) {
  return (
    Boolean(run?.projection?.currentGate?.state === "PENDING") ||
    ["AWAITING_PLAN", "AWAITING_CONTEXT", "AWAITING_FINAL", "FAILED", "NEEDS_ATTENTION"].includes(
      run?.projection?.state,
    )
  );
}
function humanActionInfo(run) {
  const value = run?.projection?.state;
  if (value === "AWAITING_PLAN") return { label: "Review plan", kind: "attention" };
  if (value === "AWAITING_CONTEXT") return { label: "Clarify context", kind: "attention" };
  if (value === "AWAITING_FINAL") return { label: "Review final gate", kind: "attention" };
  if (value === "FAILED") return { label: "Resolve failed test", kind: "failed" };
  if (value === "NEEDS_ATTENTION") return { label: "Resolve stuck execution", kind: "failed" };
  return { label: "Review decision", kind: "attention" };
}
function shortDate(value) {
  return value
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
    : "Backlog";
}
function selectInspectorTab(name, { focus = false } = {}) {
  const target = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!target) return;
  document
    .querySelectorAll(".tab")
    .forEach((candidate) => candidate.setAttribute("aria-selected", String(candidate === target)));
  renderInspector();
  if (focus) {
    $("inspector").scrollIntoView({ behavior: "smooth", block: "start" });
    $("inspector").focus({ preventScroll: true });
  }
}
function renderWork() {
  const host = $("runs");
  host.replaceChildren();
  const query = $("filter").value.trim().toLowerCase();
  const isTasks = state.workView === "tasks";
  const isAttention = state.workView === "attention";
  const attentionRuns = state.runs.filter(needsHumanIntervention);
  const attentionTasks = attentionRuns
    .map((run) => taskForRun(run))
    .filter(Boolean)
    .sort((left, right) => {
      const leftRun = state.runs.find((run) => run.manifest.taskId === left.taskId);
      const rightRun = state.runs.find((run) => run.manifest.taskId === right.taskId);
      const rank = (run) => (["FAILED", "NEEDS_ATTENTION"].includes(run?.projection?.state) ? 0 : 1);
      return rank(leftRun) - rank(rightRun);
    });
  const sourceItems = isTasks ? state.tasks : isAttention ? attentionTasks : state.runs;
  const items = sourceItems.filter((item) => {
    const task = isTasks || isAttention ? item : taskForRun(item);
    const searchable = isTasks || isAttention ? item : { run: item, task };
    if (!JSON.stringify(searchable).toLowerCase().includes(query)) return false;
    if (!isTasks || !task) return true;
    const e = taskWorkEligibility(task);
    const filter = $("work-eligibility").value;
    return (
      filter === "all" ||
      (filter === "eligible" && e?.eligible) ||
      (["deferred", "ineligible"].includes(filter) && !e?.eligible) ||
      (filter === "undated" && !task.plannedFor) ||
      (filter === "overridden" && e?.override)
    );
  });
  const eligibilityControl = $("work-eligibility").closest("label");
  if (eligibilityControl) eligibilityControl.hidden = !isTasks;
  $("run-empty").hidden = items.length > 0;
  $("run-empty").textContent = isAttention
    ? attentionTasks.length
      ? "No pending decisions match this search."
      : "Nothing needs your intervention. Automation can continue unattended."
    : isTasks
      ? "No ingested tasks match this filter."
      : "No executions match this filter.";
  $("work-group").textContent = isTasks
    ? "All assigned tasks"
    : isAttention
      ? "Waiting for your decision"
      : "Execution history";
  const noun = isAttention
    ? "need you"
    : isTasks
      ? sourceItems.length === 1
        ? "task"
        : "tasks"
      : sourceItems.length === 1
        ? "run"
        : "runs";
  $("work-count").textContent =
    items.length === sourceItems.length
      ? `${sourceItems.length} ${noun}`
      : `${items.length} of ${sourceItems.length} ${noun}`;
  $("attention-count").textContent = String(attentionTasks.length);
  $("attention-count").hidden = attentionTasks.length === 0;
  if (isTasks || isAttention) {
    for (const task of items) {
      const taskRun = state.runs.find((candidate) => candidate.manifest.taskId === task.taskId);
      const stateInfo = isAttention ? humanActionInfo(taskRun) : runStateInfo(taskRun);
      const button = node("button", "", "task-card");
      button.setAttribute("aria-current", String(task.taskId === state.selectedTask));
      button.append(
        node("strong", task.title),
        node(
          "small",
          `${task.source.key} · ${task.source.provider || "Source"}${task.customer ? ` · ${task.customer}` : ""}`,
        ),
        node(
          "small",
          `Planned ${shortDate(task.plannedFor)} · ${planningSourceLabel(task)}`,
          "task-plan-label",
        ),
        node("small", stateInfo.label, `case-status ${stateInfo.kind}`),
      );
      const eligibility = taskWorkEligibility(task);
      if (eligibility && (!taskRun || taskRun.projection.state === "QUEUED"))
        button.append(
          node(
            "small",
            eligibility.override
              ? "Manual work override"
              : eligibility.eligible
                ? "Inside work horizon"
                : eligibility.reason === "UNDATED"
                  ? "Undated · work deferred"
                  : "Outside work horizon",
            "task-plan-label",
          ),
        );
      if (taskRun?.projection.state === "QUEUED")
        button.append(node("small", waitingLabel(task, taskRun), "case-status attention"));
      button.onclick = () => {
        state.selectedTask = task.taskId;
        const run = state.runs.find((candidate) => candidate.manifest.taskId === task.taskId);
        state.selected = run?.runId || null;
        renderAll();
        if (["FAILED", "NEEDS_ATTENTION"].includes(run?.projection.state)) selectInspectorTab("tests");
        $("workspace").focus();
      };
      host.append(button);
    }
    return;
  }
  const runs = items;
  for (const run of runs) {
    const task = taskForRun(run);
    const b = node(
      "button",
      `${run.projection.state} · ${task?.source.key || run.manifest.taskId.slice(0, 8)}`,
      "run",
    );
    b.setAttribute("aria-current", String(run.runId === state.selected));
    b.append(
      node(
        "small",
        task?.title || run.manifest.repository?.id?.slice(0, 12) || "Local execution",
        "run-detail muted",
      ),
    );
    b.onclick = () => {
      state.selected = run.runId;
      state.selectedTask = run.manifest.taskId;
      renderAll();
      if (["FAILED", "NEEDS_ATTENTION"].includes(run.projection.state)) selectInspectorTab("tests");
      $("workspace").focus();
    };
    host.append(b);
  }
}

function mondayForOffset() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + state.weekOffset * 7);
  return date;
}
function localDateKey(date) {
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function planningSourceLabel(task) {
  if (task.extensions?.["community.tempo.planning"]) return "from Tempo";
  if (task.extensions?.["community.jira.planning"] || task.source?.provider === "Jira") return "from Jira";
  return "unplanned";
}
function renderPlanner() {
  const host = $("week-grid");
  host.replaceChildren();
  const monday = mondayForOffset();
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  $("planner-title").textContent = state.weekOffset === 0 ? "This week" : "Weekly plan";
  const syncTime = state.planningSync?.lastCheckedAt
    ? new Date(state.planningSync.lastCheckedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "not synced yet";
  $("week-range").textContent =
    `${monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${friday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · planning sync every 30 min · last checked ${syncTime}${state.planningSync?.unlinked?.length ? ` · ${state.planningSync.unlinked.length} planned without a task key` : ""}`;
  const today = localDateKey(new Date());
  for (let index = 0; index < 5; index++) {
    const date = new Date(monday);
    date.setDate(date.getDate() + index);
    const key = localDateKey(date);
    const column = node("section", "", `day-column${key === today ? " today" : ""}`);
    const heading = node("div", "", "day-heading");
    heading.append(
      node("span", date.toLocaleDateString(undefined, { weekday: "short" })),
      node("time", date.getDate()),
    );
    column.append(heading);
    for (const task of state.tasks.filter((candidate) => candidate.plannedFor === key)) {
      const item = node(
        "button",
        `${task.source.key} · ${task.title}`,
        `planned-item${task.taskId === state.selectedTask ? " is-selected" : ""}`,
      );
      item.title = "Select task";
      item.onclick = () => {
        state.selectedTask = task.taskId;
        state.selected = state.runs.find((run) => run.manifest.taskId === task.taskId)?.runId || null;
        renderAll();
      };
      column.append(item);
    }
    if (!state.tasks.some((candidate) => candidate.plannedFor === key))
      column.append(node("span", "No planned work", "day-empty"));
    host.append(column);
  }
}
const steps = ["Context", "Plan", "Implement", "Test", "Review", "Final gate", "Report"];
function renderGraph(run = selected()) {
  const host = $("graph");
  host.replaceChildren();
  $("stage-count").textContent = "7 stages";
  const assessment = assessmentFor(selectedTask(), run);
  if (!run) {
    steps.forEach((label, index) => {
      const accepted = index === 0 && assessment?.status === "ACCEPTED";
      const item = node("li", label, `node${accepted ? " passed" : ""}`);
      item.append(node("small", accepted ? "Accepted · plannable" : "Queued", "muted"));
      host.append(item);
    });
    return;
  }
  const current = run.projection.state || "QUEUED";
  const idx =
    run.demoStage ??
    {
      QUEUED: 0,
      CONTEXT_REVIEW: 0,
      AWAITING_CONTEXT: 0,
      PLANNING: 1,
      AWAITING_PLAN: 1,
      IMPLEMENTING: 2,
      TESTING: 3,
      REVIEWING: 4,
      AWAITING_FINAL: 5,
      REPORTING: 6,
      REPORT_PENDING: 6,
      COMPLETED: 6,
      FAILED: 3,
      NEEDS_ATTENTION: 3,
    }[current] ??
    0;
  steps.forEach((label, i) => {
    const completeRun = current === "COMPLETED";
    const failed = (current === "FAILED" || current === "NEEDS_ATTENTION") && i === idx;
    const waiting = current.startsWith("AWAITING_") && i === idx;
    const li = node(
      "li",
      label,
      `node ${completeRun || i < idx ? "passed" : failed ? "failed" : waiting ? "waiting" : i === idx ? "running" : ""}`,
    );
    li.append(
      node(
        "small",
        completeRun && i === steps.length - 1
          ? "Completed"
          : failed
            ? "Failed · review details"
            : waiting
              ? "Waiting for you"
              : i === 0 && i < idx && assessment?.status === "ACCEPTED"
                ? "Accepted · plannable"
                : i < idx
                  ? "Completed"
                  : i === idx
                    ? current
                    : "Queued",
        "muted",
      ),
    );
    if (failed) {
      li.setAttribute("role", "button");
      li.title = "Open failed test evidence and recovery details";
      li.onclick = () => selectInspectorTab("tests", { focus: true });
      li.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          li.click();
        }
      };
    }
    host.append(li);
  });
}
function renderSummary(run = selected()) {
  const host = $("summary");
  host.replaceChildren();
  const task = selectedTask() || (run ? taskForRun(run) : null);
  if (!task && !run) {
    host.append(
      node("h1", "No task selected"),
      node(
        "p",
        "Connect a source or ingest a task to build your work backlog. Planning can change independently from immutable source context.",
      ),
    );
    return;
  }
  const p = run?.projection;
  const hero = node("div", "", "hero-top");
  const title = node("div", "", "hero-title");
  title.append(
    node("span", task?.source.key || "Local task", "eyebrow"),
    node("h1", task?.title || `Execution ${run.runId}`),
  );
  const meta = node("div", "", "hero-meta");
  const assessment = assessmentFor(task, run);
  meta.append(
    node("span", task?.source.provider || "Ingested source"),
    ...(task?.customer ? [node("span", `Customer ${task.customer}`)] : []),
    node("span", task?.repositoryName || run?.manifest.repository?.id || "Local repository"),
    node(
      "span",
      task?.plannedFor
        ? `Planned ${new Date(`${task.plannedFor}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`
        : "Not planned",
    ),
    ...(assessment?.status === "ACCEPTED" ? [node("span", "Context accepted for planning")] : []),
    node(
      "span",
      task?.provenance?.fetchedAt
        ? `Ingested ${new Date(task.provenance.fetchedAt).toLocaleDateString()}`
        : "Ingested task",
    ),
  );
  title.append(meta);
  hero.append(title);
  if (p) {
    const index = run.demoStage ?? 0;
    const stateInfo = runStateInfo(run);
    const progress = node("div", "", "progress-block");
    progress.append(node("strong", `${stateInfo.label} · stage ${index + 1} of 7`));
    const track = node("div", "", "progress-track");
    const fill = node("span");
    fill.style.width = `${((index + 1) / 7) * 100}%`;
    track.append(fill);
    progress.append(track);
    hero.append(progress);
  }
  host.append(hero);
  const note = node(
    "p",
    run
      ? "This execution uses pinned context and policy. Source writes, merge, publication, push, and tags remain opt-in."
      : "This task is in your backlog and has no execution yet. Its weekly plan can move without changing source provenance.",
    "policy-note",
  );
  host.append(note);
  if (
    task &&
    !state.fixtureMode &&
    (!run || ["COMPLETED", "CANCELLED", "FAILED"].includes(run.projection.state))
  ) {
    const live = settingsState.configuration?.readiness?.liveModelExecution;
    const analyse = node("div", "", "actions");
    const start = node("button", run ? "Analyse again with agents" : "Analyse with agents", "approve");
    const status = node(
      "p",
      live
        ? "Claude reviews the task and its repository (read-only), asks questions, then proposes a plan for your approval. Spend counts against your task and daily caps."
        : "Assign Anthropic profiles to the context-reviewer and planner roles in Settings to enable live analysis.",
      "muted",
    );
    start.disabled = !state.online || !live;
    const panelHost = node("div", "", "analyse-panel-host");
    start.onclick = () => {
      start.hidden = true;
      status.hidden = true;
      void renderAnalysePanel(panelHost, task, {
        request,
        errorLabel: analyseErrorLabel,
        // One key per task, previous run and choice, so a double click never starts two runs.
        idempotencyKey: (body) => {
          const intent = `oda-analyse/${task.taskId}/${run?.runId ?? "first"}/${JSON.stringify(body)}`;
          const key = localStorage.getItem(intent) || crypto.randomUUID();
          localStorage.setItem(intent, key);
          return key;
        },
        onStarted: () => load(true),
      });
    };
    analyse.append(start);
    host.append(analyse, status, panelHost);
  }
  if (run?.projection.state === "QUEUED") {
    const queued = node("div", "", "actions");
    const waiting = node("p", waitingLabel(task, run), "muted");
    const reason = document.createElement("input");
    reason.placeholder = "Cancellation reason";
    reason.setAttribute("aria-label", "Queued cancellation reason");
    reason.maxLength = 1000;
    reason.required = true;
    const cancel = node("button", "Cancel queued work", "reject");
    cancel.disabled = !state.online;
    cancel.onclick = async () => {
      if (!reason.value.trim()) {
        reason.reportValidity();
        return;
      }
      cancel.disabled = true;
      try {
        if (state.fixtureMode === "demo") {
          run.projection.state = "CANCELLED";
          run.projection.stateRevision++;
          renderAll();
        } else {
          await request(`/api/v1/runs/${run.runId}/cancel`, {
            method: "POST",
            headers: { "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({
              expectedStateRevision: run.projection.stateRevision,
              reason: reason.value.trim(),
            }),
          });
          waiting.textContent = "Cancellation requested…";
        }
      } catch (error) {
        waiting.textContent = error.message;
        cancel.disabled = false;
      }
    };
    queued.append(reason, cancel);
    host.append(waiting, queued);
  }
  const eligibility = task && taskWorkEligibility(task);
  if (eligibility) {
    const notStarted = !run || run.projection.state === "QUEUED";
    const explanation = node(
      "p",
      notStarted
        ? eligibility.override
          ? "Manual override: agent work is allowed for this task."
          : eligibility.eligible
            ? `Eligible for agent work through ${eligibility.cutoff}.`
            : `Agent work deferred: ${eligibility.reason === "UNDATED" ? "no planned date" : `planned after ${eligibility.cutoff}`}. The task remains in your backlog.`
        : "This run has already started and continues independently of the work horizon.",
      "muted",
    );
    host.append(explanation);
    if (notStarted && (!eligibility.eligible || eligibility.override)) {
      const reason = document.createElement("input");
      reason.placeholder = "Reason for starting ahead of the horizon";
      reason.setAttribute("aria-label", "Work horizon override reason");
      reason.maxLength = 1000;
      reason.classList.add("horizon-override-reason");
      reason.hidden = eligibility.override;
      const allow = node("button", eligibility.override ? "Use horizon again" : "Allow work now");
      allow.disabled = !state.online;
      allow.onclick = async () => {
        if (!eligibility.override && !reason.value.trim()) {
          reason.reportValidity();
          reason.focus();
          return;
        }
        allow.disabled = true;
        try {
          if (state.fixtureMode === "demo") {
            const overrides = new Set(state.workHorizon.overrides || []);
            if (eligibility.override) overrides.delete(task.taskId);
            else overrides.add(task.taskId);
            state.workHorizon.overrides = [...overrides];
            saveDemoHorizon();
            renderAll();
          } else {
            await request(`/api/v1/tasks/${task.taskId}/work-horizon`, {
              method: "POST",
              body: JSON.stringify({
                allowed: !eligibility.override,
                reason: eligibility.override ? "Return task to work horizon" : reason.value.trim(),
              }),
            });
            await load();
          }
        } catch (error) {
          explanation.textContent = error.message;
          allow.disabled = false;
        }
      };
      reason.required = !eligibility.override;
      const actions = node("div", "", "actions");
      actions.append(reason, allow);
      host.append(
        actions,
        node("small", "Allows queued agent work to start. Tasks without an execution remain ready.", "muted"),
      );
    }
  }
}
function waitingLabel(task, run) {
  const e = task && taskWorkEligibility(task);
  const reason =
    run?.waiting?.reason ||
    (!e?.eligible ? e?.reason : settingsState.operations?.policy.paused ? "PAUSED" : null);
  const labels = {
    PAUSED: "New work paused",
    UNDATED: "Waiting for a planned date or manual override",
    OUTSIDE_HORIZON: "Outside work horizon",
    CAPACITY: "Waiting for run capacity",
    DAILY_BUDGET: "Daily spending limit reached",
    TASK_BUDGET: "Task spending limit reached",
    UNPRICED_USAGE: "Waiting for pricing reconciliation",
    PROVIDER_UNAVAILABLE: "Provider credential unavailable",
    EXECUTION_BACKEND: "Configured model needs a live execution backend",
    EXECUTION_SERVICE: "Workflow service unavailable · retrying",
    WORKER: "Waiting for a workflow worker",
  };
  if (reason === "OUTSIDE_HORIZON" && task?.plannedFor && state.workHorizon) {
    const start = new Date(`${task.plannedFor}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - state.workHorizon.days);
    return `Outside horizon · eligible ${start.toISOString().slice(0, 10)}`;
  }
  return labels[reason] || "Queued · waiting for dispatch";
}

function taskWorkEligibility(task) {
  const settings = state.workHorizon;
  if (!settings) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (key) => parts.find((p) => p.type === key).value;
  const end = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + settings.days);
  const cutoff = end.toISOString().slice(0, 10);
  const planned = task.plannedFor;
  const override = settings.overrides?.includes(task.taskId) || false;
  return {
    eligible: override || Boolean(planned && planned <= cutoff),
    override,
    cutoff,
    reason: !planned ? "UNDATED" : planned > cutoff ? "OUTSIDE_HORIZON" : "WITHIN_HORIZON",
  };
}
function renderHorizon() {
  const settings = state.workHorizon;
  $("horizon-mode").textContent = settings
    ? `${settings.days} days ahead${state.fixtureMode ? " · demo" : ""}`
    : "Not connected";
  for (const id of ["horizon-save", "horizon-days", "horizon-timezone"])
    $(id).disabled = !settings || !state.online;
  if (settings && !$("horizon-form").contains(document.activeElement)) {
    $("horizon-days").value = settings.days;
    $("horizon-timezone").value = settings.timezone;
  }
}
function saveDemoHorizon() {
  localStorage.setItem("oda-demo-work-horizon", JSON.stringify(state.workHorizon));
}
$("horizon-form").onsubmit = async (event) => {
  event.preventDefault();
  const settings = { days: Number($("horizon-days").value), timezone: $("horizon-timezone").value.trim() };
  try {
    if (!Number.isInteger(settings.days) || settings.days < 0 || settings.days > 365)
      throw new Error("Choose 0–365 days ahead.");
    new Intl.DateTimeFormat("en", { timeZone: settings.timezone }).format();
    $("horizon-save").disabled = true;
    if (state.fixtureMode === "demo") {
      state.workHorizon = { ...state.workHorizon, ...settings };
      saveDemoHorizon();
    } else {
      await request("/api/v1/work-horizon", { method: "POST", body: JSON.stringify(settings) });
      await load();
    }
    $("horizon-status").textContent = "Saved. Queued starts will use this horizon; running work continues.";
    renderAll();
  } catch (error) {
    $("horizon-status").textContent = error.message;
  } finally {
    $("horizon-save").disabled = !state.online;
  }
};
function draftKey(g) {
  return `oda-feedback/${g.id}/${g.version}`;
}
function failureFor(run) {
  return run?.failure || run?.lastFailure || null;
}
function formatHash(value) {
  return value ? `${value.slice(0, 12)}…` : "Unavailable";
}
function recoverDemoRun(run, target) {
  if (state.fixtureMode !== "demo") return;
  run.lastFailure = run.failure || run.lastFailure;
  run.failure = null;
  run.projection.state = target === "retry" ? "TESTING" : "IMPLEMENTING";
  run.demoStage = target === "retry" ? 3 : 2;
  run.projection.updatedAt = new Date().toISOString();
  run.recovery = {
    action: target === "retry" ? "Retrying failed test" : "Returned for implementation fix",
    requestedAt: new Date().toISOString(),
  };
  demo.saveSession();
  renderAll();
  selectInspectorTab("tests");
}
function renderRecoveryCard(host, run) {
  const failure = failureFor(run);
  host.hidden = false;
  const card = node("section", "", "recovery-card");
  const header = node("div", "", "recovery-heading");
  header.append(
    node("span", "RECOVERY NEEDED · TEST FAILED", "eyebrow"),
    node("h2", failure?.check || "A test blocked this execution"),
    node(
      "p",
      failure?.message || "Open the test evidence below before choosing how the workflow should recover.",
      "recovery-message",
    ),
  );
  const evidence = node("dl", "", "failure-evidence-grid");
  for (const [label, value] of [
    ["Command", failure?.command || "Unavailable"],
    ["Attempt", failure?.attempt || "Unavailable"],
    ["Candidate", formatHash(failure?.candidateHash)],
    ["Evidence", formatHash(failure?.evidenceHash)],
  ]) {
    const field = node("div");
    field.append(node("dt", label), node("dd", value));
    evidence.append(field);
  }
  const openDetails = node("button", "View test details", "secondary-action");
  openDetails.onclick = () => selectInspectorTab("tests", { focus: true });
  const retry = node("button", "Retry failed test", "approve");
  const implement = node("button", "Send back for implementation fix", "reject");
  const canRecover = state.fixtureMode === "demo" && Boolean(failure);
  retry.disabled = implement.disabled = !canRecover;
  retry.onclick = () => recoverDemoRun(run, "retry");
  implement.onclick = () => recoverDemoRun(run, "implement");
  const actions = node("div", "", "recovery-actions");
  actions.append(openDetails, retry, implement);
  card.append(
    header,
    evidence,
    node(
      "p",
      "The candidate and evidence remain preserved whichever recovery path you choose. No source write or merge is performed by these controls.",
      "recovery-note",
    ),
    actions,
  );
  host.append(card);
}
function recordDecisionHandoff(run, decision, reason) {
  state.decisionHandoffs[run.runId] = { decision, reason, recordedAt: new Date().toISOString() };
  if (state.fixtureMode === "demo") demo.saveSession();
}
function renderDecisionHandoff(host, run, handoff) {
  host.hidden = false;
  const changes = handoff.decision === "REJECT";
  const card = node("section", "", `decision-handoff${changes ? " changes" : ""}`);
  const icon = node("span", changes ? "↶" : "✓", "handoff-icon");
  icon.setAttribute("aria-hidden", "true");
  const copy = node("div", "", "handoff-copy");
  copy.append(
    node("h2", changes ? "Changes requested" : "Plan approved"),
    node("strong", changes ? "Returned to Planning" : "Sent to Implementation", "handoff-destination"),
    node(
      "p",
      changes
        ? "Your feedback is preserved as provenance for the next planning revision."
        : "Your approval is recorded against this plan version. The workflow can continue under its pinned policy.",
    ),
    node("small", handoff.reason || `Recorded ${new Date(handoff.recordedAt).toLocaleTimeString()}`),
  );
  const dismiss = node("button", "Dismiss");
  dismiss.onclick = () => {
    delete state.decisionHandoffs[run.runId];
    if (state.fixtureMode === "demo") demo.saveSession();
    renderGate();
  };
  card.append(icon, copy, dismiss);
  host.append(card);
}
function renderGate(run = selected()) {
  const host = $("decision");
  if (stopGateParticles) stopGateParticles();
  host.replaceChildren();
  const gate = run?.projection?.currentGate;
  if (!gate && ["FAILED", "NEEDS_ATTENTION"].includes(run?.projection?.state)) {
    renderRecoveryCard(host, run);
    return;
  }
  if (!gate || gate.state !== "PENDING") {
    const handoff = state.decisionHandoffs[run?.runId];
    if (handoff) {
      renderDecisionHandoff(host, run, handoff);
      return;
    }
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (renderLiveGate(host, run, gate)) return;
  if (gate.kind === "RECOVERY" && gate.proposal?.reason === "QA repair budget exhausted") {
    const proposal = gate.proposal;
    const card = node("section", "", "recovery-card");
    card.append(
      node("span", "YOUR DECISION · QA REPAIR BUDGET EXHAUSTED", "eyebrow"),
      node("h2", "Allow one additional repair?"),
      node("p", proposal.failure?.summary || "QA remains unsuccessful."),
      node(
        "p",
        `${proposal.repairsUsed} / ${proposal.repairsLimit} repairs used. Approving adds one repair and returns to planning for your approval. Rejecting cancels the run.`,
      ),
      node(
        "p",
        `Candidate: ${proposal.candidateHash} · Test evidence: ${proposal.testArtifactHash}`,
        "muted",
      ),
    );
    const reason = document.createElement("textarea");
    reason.setAttribute("aria-label", "Reason for rejecting recovery");
    reason.placeholder = "Reason for cancelling this run";
    reason.maxLength = 8000;
    reason.value = localStorage.getItem(draftKey(gate)) || "";
    const approve = node("button", "Allow one repair and replan", "approve");
    const reject = node("button", "Reject recovery and cancel run", "reject");
    approve.disabled = !state.online || state.busy;
    reject.disabled = approve.disabled || !reason.value.trim();
    reason.oninput = () => {
      localStorage.setItem(draftKey(gate), reason.value);
      reject.disabled = !state.online || state.busy || !reason.value.trim();
    };
    approve.onclick = () => decide(run, "APPROVE");
    reject.onclick = () => decide(run, "REJECT", reason.value);
    const actions = node("div", "", "recovery-actions");
    actions.append(approve, reject);
    card.append(reason, actions);
    host.append(card);
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "gate-particles";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const heading = node("div", "", "decision-heading");
  heading.append(
    node("span", "YOUR DECISION · DEVELOPMENT PAUSED", "eyebrow"),
    node("h2", "Plan ready for your review"),
    node(
      "p",
      "Answer one question to let the workflow continue. Nothing changes in Jira or source control until you approve.",
      "gate-intro",
    ),
    node("p", `Plan version ${gate.version} · evidence ${gate.artifactHash.slice(0, 12)}…`, "muted"),
  );
  host.append(heading);
  const proposalValue = gate.proposal || {};
  const decisionGrid = node("div", "", "decision-grid");
  const main = node("div", "", "decision-main");
  const question = node("section", "", "decision-question");
  question.append(
    node("span", "YOUR DECISION", "eyebrow"),
    node("h3", "Approve the recommended alert plan?"),
  );
  const planOptions = [];
  let selectedChoice = { kind: "recommended", label: "Recommended plan" };
  const recommendedPlan = node("button", "", "decision-block recommendation plan-option");
  recommendedPlan.type = "button";
  recommendedPlan.setAttribute("aria-pressed", "true");
  recommendedPlan.append(
    node("strong", "Recommended plan"),
    node(
      "p",
      [proposalValue.summary, proposalValue.recommendation].filter(Boolean).join(" ") ||
        "Proceed with the prepared plan.",
    ),
    node("span", "Selected", "option-state"),
  );
  planOptions.push({ element: recommendedPlan, choice: selectedChoice });
  const rationale = node("section", "", "decision-block");
  rationale.append(
    node("strong", "Why this plan"),
    node("p", proposalValue.rationale || "This balances useful alerts with operational noise."),
  );
  main.append(question, recommendedPlan, rationale);
  if (Array.isArray(proposalValue.alternatives) && proposalValue.alternatives.length) {
    const alternatives = node("section", "", "alternatives");
    alternatives.append(node("strong", "Other actions considered"));
    const list = node("div", "", "alternative-list");
    for (const alternative of proposalValue.alternatives) {
      const item = node("button", "", "alternative-item plan-option");
      item.type = "button";
      item.setAttribute("aria-pressed", "false");
      item.append(
        node("b", alternative.label || "Alternative"),
        node("small", alternative.tradeoff || "No trade-off recorded."),
        node("span", "Select this option", "option-state"),
      );
      planOptions.push({
        element: item,
        choice: {
          kind: "alternative",
          label: alternative.label || "Alternative",
          tradeoff: alternative.tradeoff || "No trade-off recorded.",
        },
      });
      list.append(item);
    }
    alternatives.append(list);
    main.append(alternatives);
  }
  const contextPanel = node("aside", "", "decision-context");
  contextPanel.append(
    node("strong", "Estimated execution cost"),
    node("p", proposalValue.estimatedCost || "Unavailable", "cost-value"),
    node("strong", "If approved"),
    node("p", "Implementation starts in a local sandbox under the pinned policy."),
    node("strong", "If changes are requested"),
    node("p", "The planner revises this plan using your feedback; development stays paused."),
  );
  decisionGrid.append(main, contextPanel);
  const area = document.createElement("textarea");
  area.setAttribute("aria-label", "Reason for rejection (required)");
  area.placeholder = "Example: alert immediately for missing price data, but group repeated notifications.";
  area.maxLength = 8000;
  area.value = localStorage.getItem(draftKey(gate)) || "";
  const editor = node("div", "", "feedback-editor");
  editor.hidden = true;
  const editorHeading = node("div", "", "feedback-editor-heading");
  editorHeading.append(
    node("span", "REVISION REQUEST", "eyebrow"),
    node("label", "Tell the planning agent what needs to change"),
    node(
      "small",
      "Be specific about the outcome or constraint. Your message is preserved as provenance on the next plan revision.",
    ),
  );
  const count = node("span", `${area.value.length} / ${area.maxLength}`, "feedback-count");
  area.oninput = () => {
    localStorage.setItem(draftKey(gate), area.value);
    count.textContent = `${area.value.length} / ${area.maxLength}`;
    submit.disabled = !area.value.trim();
  };
  editor.append(editorHeading, area, count);
  const actions = node("div", "", "decision-actions"),
    approve = node("button", "", "approve decision-action"),
    reject = node("button", "", "reject decision-action");
  approve.append(node("strong", "Approve plan"), node("small", "Continue to implementation"));
  reject.append(node("strong", "Request changes"), node("small", "Return to planning with guidance"));
  approve.disabled = reject.disabled = !state.online || state.busy;
  const updateSelection = (entry) => {
    selectedChoice = entry.choice;
    for (const option of planOptions) {
      const selectedOption = option === entry;
      option.element.setAttribute("aria-pressed", String(selectedOption));
      option.element.querySelector(".option-state").textContent = selectedOption
        ? "Selected"
        : option.choice.kind === "recommended"
          ? "Select recommended plan"
          : "Select this option";
    }
    approve.replaceChildren(
      node("strong", selectedChoice.kind === "recommended" ? "Approve plan" : "Use selected alternative"),
      node(
        "small",
        selectedChoice.kind === "recommended"
          ? "Continue to implementation"
          : "Return to planning for a sealed revision",
      ),
    );
    question.querySelector("h3").textContent =
      selectedChoice.kind === "recommended"
        ? "Approve the recommended alert plan?"
        : `Use “${selectedChoice.label}” instead?`;
  };
  for (const entry of planOptions) entry.element.onclick = () => updateSelection(entry);
  approve.onclick = () =>
    selectedChoice.kind === "recommended"
      ? decide(run, "APPROVE")
      : decide(
          run,
          "REJECT",
          `Selected alternative: ${selectedChoice.label}. Trade-off: ${selectedChoice.tradeoff}`,
        );
  reject.onclick = () => {
    editor.hidden = false;
    actions.hidden = true;
    area.focus();
  };
  const submit = node("button", "Send changes to planner", "reject feedback-submit");
  submit.disabled = !area.value.trim();
  submit.onclick = () => decide(run, "REJECT", area.value);
  const cancel = node("button", "Cancel", "secondary-action");
  const closeEditor = () => {
    editor.hidden = true;
    actions.hidden = false;
    reject.focus();
  };
  cancel.onclick = closeEditor;
  area.onkeydown = (event) => {
    if (event.key === "Escape") closeEditor();
  };
  const editorActions = node("div", "", "feedback-actions");
  editorActions.append(cancel, submit);
  editor.append(editorActions);
  actions.append(approve, reject);
  host.append(actions, editor, decisionGrid);
  requestAnimationFrame(() => startGateParticles(canvas));
}
/** Gates of live analysis runs (workflow v3): real questions, real plans and agent failures. */
function renderLiveGate(host, run, gate) {
  if (run?.manifest?.workflowVersion !== 3) return false;
  const proposal = gate.proposal || {};
  const card = node("section", "", "recovery-card live-gate");
  const list = (title, items, ordered = false) => {
    if (!Array.isArray(items) || !items.length) return null;
    const block = node("div", "", "decision-block");
    const listNode = document.createElement(ordered ? "ol" : "ul");
    for (const item of items) listNode.append(node("li", item));
    block.append(node("strong", title), listNode);
    return block;
  };
  const feedback = document.createElement("textarea");
  feedback.maxLength = 8000;
  feedback.value = localStorage.getItem(draftKey(gate)) || "";
  const primary = node("button", "", "approve");
  const secondary = node("button", "", "reject");
  const sync = () => {
    localStorage.setItem(draftKey(gate), feedback.value);
    primary.disabled = !state.online || state.busy;
    secondary.disabled = primary.disabled || !feedback.value.trim();
  };
  feedback.oninput = sync;
  if (gate.kind === "CLARIFICATION") {
    card.append(
      node("span", "YOUR INPUT · CONTEXT REVIEW", "eyebrow"),
      node("h2", "The context reviewer has questions"),
      node(
        "p",
        "Answer the questions to have the task reviewed again, or accept the proposed assumptions to continue to planning.",
      ),
    );
    for (const block of [
      list("Questions", proposal.questions, true),
      list("Proposed assumptions", proposal.proposedAssumptions),
      list("Relevant files", proposal.relevantPaths),
    ])
      if (block) card.append(block);
    feedback.placeholder = "Your answers to the questions";
    feedback.setAttribute("aria-label", "Answers to the context reviewer");
    primary.textContent = "Accept assumptions and plan";
    secondary.textContent = "Send answers and review again";
  } else if (gate.kind === "PLAN_APPROVAL") {
    card.append(
      node("span", `YOUR DECISION · PLAN REVISION ${gate.version}`, "eyebrow"),
      node("h2", proposal.title || "Plan ready for your review"),
    );
    const steps = node("div", "", "decision-block");
    steps.append(node("strong", "Steps"));
    const ordered = document.createElement("ol");
    for (const step of proposal.steps || []) {
      const item = node("li", "");
      item.append(node("b", step.title), node("p", step.description));
      const checks = list("Checks", step.tests);
      if (checks) item.append(checks);
      ordered.append(item);
    }
    steps.append(ordered);
    card.append(steps);
    for (const block of [
      list("Acceptance mapping", proposal.acceptanceMapping),
      list("Risks", proposal.risks),
    ])
      if (block) card.append(block);
    card.append(
      node(
        "p",
        "Approving records the plan. Implementation by agents is not enabled yet; you implement from this plan.",
        "muted",
      ),
    );
    feedback.placeholder = "What should the planner change?";
    feedback.setAttribute("aria-label", "Plan change request");
    primary.textContent = "Approve plan";
    secondary.textContent = "Request changes";
  } else if (gate.kind === "RECOVERY") {
    card.append(
      node("span", "YOUR DECISION · AGENT STOPPED", "eyebrow"),
      node("h2", proposal.reason || "An agent step needs attention"),
      node("p", proposal.detail || ""),
      node(
        "p",
        proposal.code === "TASK_BUDGET_EXHAUSTED" || proposal.code === "DAILY_BUDGET_EXHAUSTED"
          ? "The spending cap was reached. Raise it in Settings before retrying."
          : "Retrying runs the step again and may spend more.",
        "muted",
      ),
    );
    feedback.placeholder = "Reason for cancelling this run";
    feedback.setAttribute("aria-label", "Reason for cancelling the run");
    primary.textContent = "Retry step";
    secondary.textContent = "Cancel run";
  } else return false;
  primary.onclick = () => decide(run, "APPROVE");
  secondary.onclick = () => decide(run, "REJECT", feedback.value);
  sync();
  const actions = node("div", "", "recovery-actions");
  actions.append(primary, secondary);
  card.append(feedback, actions);
  host.append(card);
  return true;
}
async function decide(run, decision, reason = "") {
  const gate = run.projection.currentGate;
  if (decision === "REJECT" && !reason.trim()) return alert("Enter a rejection reason.");
  if (state.fixtureMode === "demo") {
    recordDecisionHandoff(run, decision, reason);
    localStorage.removeItem(draftKey(gate));
    run.projection.currentGate = null;
    run.projection.state = decision === "APPROVE" ? "IMPLEMENTING" : "PLANNING";
    run.demoStage = decision === "APPROVE" ? 2 : 1;
    run.projection.updatedAt = new Date().toISOString();
    demo.saveSession();
    renderAll();
    const confirmation = $("decision").querySelector(".decision-handoff h2");
    if (confirmation) {
      confirmation.tabIndex = -1;
      confirmation.focus({ preventScroll: true });
    }
    return;
  }
  state.busy = true;
  connection("Confirming your decision…", "stale");
  const intentKey = `oda-intent/${gate.id}/${gate.version}/${decision}`;
  const key = localStorage.getItem(intentKey) || crypto.randomUUID();
  localStorage.setItem(intentKey, key);
  const payload = {
    protocolVersion: "1.0",
    runId: run.runId,
    workflowId: run.workflowId,
    gateId: gate.id,
    expectedGateVersion: gate.version,
    decision,
    idempotencyKey: key,
    ...(decision === "REJECT" ? { reason } : {}),
  };
  try {
    await request(`/api/v1/runs/${run.runId}/gates/${gate.id}/decisions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    recordDecisionHandoff(run, decision, reason);
    localStorage.removeItem(draftKey(gate));
    localStorage.removeItem(intentKey);
    await load();
  } catch (error) {
    if (error.code === "GATE_VERSION_CONFLICT") {
      connection("Stale gate — feedback retained", "stale");
      await load();
    } else {
      connection("Decision pending — reconciling", "stale");
      const receipt = await request(`/api/v1/decisions/by-key/${key}`).catch(() => null);
      if (receipt?.status === "RECORDED") {
        recordDecisionHandoff(run, decision, reason);
        await load();
      }
    }
  } finally {
    state.busy = false;
    renderGate();
  }
}
const panels = {
  plan: "Plan revisions and provenance appear here.",
  diff: "Exact candidate-bound diff. Expired artifacts are labelled and never reconstructed from logs.",
  tests: "Patch-bound test evidence and failures appear here.",
  review: "Static findings and reviewer evidence appear here.",
};
function renderInspector() {
  const tab = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || "plan",
    host = $("inspector");
  host.replaceChildren();
  const task = selectedTask();
  const run = selected();
  if (tab === "plan" && task) {
    const grid = node("div", "", "inspector-grid");
    const detail = node("section");
    const assessment = assessmentFor(task, selected());
    if (assessment?.status === "ACCEPTED") {
      const banner = node("div", "", "assessment-banner");
      banner.append(node("span", "✓", "assessment-mark"));
      const copy = node("div");
      copy.append(
        node("strong", "Accepted for planning"),
        node(
          "small",
          `${assessment.agent} · context revision ${assessment.contextRevision} · ${new Date(assessment.acceptedAt).toLocaleString()}`,
        ),
      );
      banner.append(copy);
      detail.append(banner);
    }
    detail.append(
      node("h3", "Task context"),
      node("p", task.description || "No description supplied.", "muted"),
    );
    const list = node("ul", "", "check-list");
    for (const criterion of task.acceptanceCriteria || []) list.append(node("li", criterion));
    detail.append(list);
    const planning = node("aside", "", "mini-stat");
    planning.append(
      node("span", "Planning", "eyebrow"),
      node("b", task.plannedFor ? shortDate(task.plannedFor) : "Backlog"),
      node("p", `Source context revision ${task.planningRevision || 0} · read-only`, "muted"),
    );
    grid.append(detail, planning);
    host.append(grid);
    return;
  }
  if (tab === "tests" && failureFor(run)) {
    const failure = failureFor(run);
    const header = node("div", "", "failure-summary");
    header.append(
      node("span", run?.failure ? "FAILED CHECK" : "PRESERVED FAILURE EVIDENCE", "eyebrow"),
      node("h3", failure.check || "Failed test"),
      node("p", failure.message || "No failure message was recorded."),
    );
    if (run?.recovery) {
      header.append(
        node(
          "p",
          `${run.recovery.action} · requested ${new Date(run.recovery.requestedAt).toLocaleString()}`,
          "recovery-status",
        ),
      );
    }
    const evidence = node("dl", "", "failure-evidence-grid inspector-evidence");
    for (const [label, value] of [
      ["Command", failure.command || "Unavailable"],
      ["Attempt", failure.attempt || "Unavailable"],
      ["Occurred", failure.occurredAt ? new Date(failure.occurredAt).toLocaleString() : "Unavailable"],
      ["Candidate hash", failure.candidateHash || "Unavailable"],
      ["Evidence hash", failure.evidenceHash || "Unavailable"],
    ]) {
      const field = node("div");
      field.append(node("dt", label), node("dd", value));
      evidence.append(field);
    }
    const logSection = node("section", "", "failure-log-section");
    logSection.append(node("strong", "Failure log excerpt"));
    const log = node("pre", (failure.log || ["No log excerpt recorded."]).join("\n"), "failure-log");
    logSection.append(log);
    host.append(header, evidence, logSection);
    return;
  }
  host.append(node("p", panels[tab] || panels.plan));
}
async function renderConfiguration(host) {
  host.replaceChildren();
  host.append(node("p", "Loading configured agent profiles…", "muted"));
  let profiles;
  try {
    if (settingsState.configuration) profiles = settingsState.configuration.profiles;
    else if (state.fixtureMode === "demo")
      profiles = [
        { name: "Planner", provider: "Provider A", model: "Fast", revision: 1 },
        { name: "Builder", provider: "Provider A", model: "Reasoning", revision: 1 },
        { name: "Reviewer", provider: "Provider B", model: "Reasoning", revision: 1 },
      ];
    else {
      const response = await fetch("/api/v1/profiles", {
        headers: auth(),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error("Profiles unavailable");
      profiles = (await response.json()).items;
      if (!Array.isArray(profiles)) throw new Error("Profiles unavailable");
    }
  } catch {
    host.replaceChildren(
      node(
        "p",
        "Agent profile information is unavailable. Reconnect to load workspace configuration.",
        "muted",
      ),
    );
    return;
  }
  host.replaceChildren(
    node(
      "p",
      state.fixtureMode ? "Demo agent profiles · synthetic" : "Configured agent profiles · read-only",
      "muted",
    ),
  );
  if (!profiles.length)
    host.append(node("p", "No agent profiles are configured in this workspace.", "muted"));
  const grid = node("div", "", "config-grid");
  const latestProfiles = new Map();
  for (const p of profiles) {
    const key = p.id || p.name;
    if (!latestProfiles.has(key) || latestProfiles.get(key).revision < p.revision) latestProfiles.set(key, p);
  }
  for (const profile of latestProfiles.values()) {
    const card = node("section", "", "panel");
    card.append(
      node("h3", profile.name),
      node("p", `${profile.provider} / ${profile.model} · revision ${profile.revision}`, "muted"),
    );
    const edit = node("button", "Edit next revision");
    edit.type = "button";
    edit.disabled = !profile.id;
    edit.onclick = () => {
      $("profile-json").value = JSON.stringify({ ...profile, revision: profile.revision + 1 }, null, 2);
      $("profile-json").focus();
    };
    card.append(edit);
    grid.append(card);
  }
  host.append(grid);
}
function appendTerminal(line) {
  state.terminal.push(
    String(line)
      .replaceAll(/\x1b\][^\x07]*(?:\x07|$)/g, "[blocked control]")
      .replaceAll(/(token|secret|password)=[^\s]+/gi, "$1=[REDACTED]"),
  );
  if (state.terminal.length > 10000) state.terminal.splice(0, state.terminal.length - 10000);
  renderTerminal();
}
function renderTerminal() {
  const host = $("terminal"),
    visible = state.terminal.slice(-60);
  host.replaceChildren(...visible.map((line) => node("div", line, "terminal-line")));
  state.renderedLines = visible.length;
  host.scrollTop = host.scrollHeight;
}
function sample(cpu, ram) {
  state.samples.push({ cpu, ram });
  if (state.samples.length > 60) state.samples.shift();
  $("cpu-label").textContent = cpu == null ? "unavailable" : `${cpu}%`;
  $("ram-label").textContent = ram == null ? "unavailable" : `${ram}%`;
  $("cpu").style.width = `${cpu ?? 0}%`;
  $("ram").style.width = `${ram ?? 0}%`;
  if (state.lowPower || document.hidden) return;
  const svg = $("spark"),
    points = state.samples.map((s, i) => `${i * 5},${40 - (s.cpu ?? 0) * 0.4}`).join(" ");
  svg.replaceChildren();
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", points);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#65d8ed");
  svg.append(poly);
}
function applyEvent(event) {
  state.events++;
  const critical = /gate|state|decision/.test(event.type || "");
  if (critical) state.critical++;
  const now = performance.now();
  if (!critical && state.lowPower && now - state.lastNoncritical < 1000) return;
  if (!critical && now - state.lastNoncritical < 100) return;
  state.lastNoncritical = now;
  if (event.type === "terminal") appendTerminal(event.text);
  if (event.type === "sample") sample(event.cpu, event.ram);
}
function renderAll() {
  renderHorizon();
  renderWork();
  renderPlanner();
  renderSummary();
  renderGate();
  renderGraph();
  renderInspector();
  if (state.fixtureMode === "demo") demo.renderDemoActivity();
}
async function load(background = false) {
  const gateKey = JSON.stringify(selected()?.projection.currentGate ?? null);
  const [tasksBody, runsBody] = await Promise.all([request("/api/v1/tasks"), request("/api/v1/runs")]);
  state.tasks = tasksBody.items || [];
  state.planningSync = tasksBody.sync || null;
  state.workHorizon = tasksBody.workHorizon || null;
  state.runs = runsBody.items || [];
  if (!state.selectedTask && state.tasks[0]) state.selectedTask = state.tasks[0].taskId;
  if (!state.selected && state.runs[0]) state.selected = state.runs[0].runId;
  executionUpdatedAt = Date.now();
  if (!background) renderAll();
  else {
    renderHorizon();
    renderWork();
    renderPlanner();
    renderGraph();
    if (!$("summary").contains(document.activeElement)) renderSummary();
    if (gateKey !== JSON.stringify(selected()?.projection.currentGate ?? null)) renderGate();
    if (!$("inspector").contains(document.activeElement)) renderInspector();
  }
  renderVisitSummary();
  updateFreshness();
}
$("connect").onclick = () => {
  if (state.fixtureMode) {
    renderAll();
    telemetry?.refresh();
    return;
  }
  load().catch((e) => {
    $("run-empty").textContent = e.message;
  });
};
$("filter").oninput = renderWork;
$("filter").value = preferences.search || "";
$("filter").addEventListener("input", () => {
  preferences.search = $("filter").value;
  remember("oda-dashboard-preferences", preferences);
});
$("work-eligibility").value = preferences.eligibility || "all";
$("work-eligibility").onchange = () => {
  preferences.eligibility = $("work-eligibility").value;
  remember("oda-dashboard-preferences", preferences);
  renderWork();
};
document.querySelectorAll(".work-tab").forEach(
  (button) =>
    (button.onclick = () => {
      state.workView = button.dataset.workView;
      preferences.workView = state.workView;
      remember("oda-dashboard-preferences", preferences);
      document
        .querySelectorAll(".work-tab")
        .forEach((candidate) => candidate.setAttribute("aria-selected", String(candidate === button)));
      renderWork();
    }),
);
$("demo-reset").onclick = () => {
  demo.resetSession();
  const retained = {
    lowPower: preferences.lowPower === true,
    terminalOpen: preferences.terminalOpen === true,
  };
  for (const key of Object.keys(preferences)) delete preferences[key];
  Object.assign(preferences, retained);
  remember("oda-dashboard-preferences", preferences);
  location.replace("?fixture=demo");
};
$("week-prev").onclick = () => {
  state.weekOffset--;
  renderPlanner();
};
$("week-next").onclick = () => {
  state.weekOffset++;
  renderPlanner();
};
$("week-today").onclick = () => {
  state.weekOffset = 0;
  renderPlanner();
};
$("power").onclick = () => {
  state.lowPower = !state.lowPower;
  document.body.classList.toggle("low-power", state.lowPower);
  $("power").setAttribute("aria-pressed", String(state.lowPower));
  $("power").textContent = `Low-power mode: ${state.lowPower ? "on" : "off"}`;
  $("power").title = state.lowPower ? "Low-power mode on" : "Toggle low-power mode";
  renderGate();
  preferences.lowPower = state.lowPower;
  remember("oda-dashboard-preferences", preferences);
};
$("settings-open").onclick = () => {
  renderHorizon();
  renderConfiguration($("settings-config"));
  $("settings-dialog").showModal();
  void settings.refreshWorkspaceConfiguration();
  void settings.refreshOperations(true);
};
if ($("readiness-settings")) $("readiness-settings").onclick = () => $("settings-open").click();
$("settings-close").onclick = () => $("settings-dialog").close();
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => selectInspectorTab(b.dataset.tab)));
document.querySelectorAll("[data-mobile-view]").forEach(
  (button) =>
    (button.onclick = () => {
      const view = button.dataset.mobileView;
      document.body.classList.toggle("mobile-activity", view === "activity");
      document.body.classList.toggle("mobile-runs", view === "runs");
      document
        .querySelectorAll("[data-mobile-view]")
        .forEach((candidate) => candidate.setAttribute("aria-current", String(candidate === button)));
    }),
);
addEventListener("offline", () => {
  if (!state.fixtureMode) connection("Offline", "offline");
});
addEventListener("online", () => {
  if (!state.fixtureMode) load().catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderAll();
});
const fixtureParams = new URLSearchParams(location.search);
const fixtureMode = fixtureParams.get("fixture");
if (fixtureMode === "performance" && fixtureParams.get("diagnostic") !== "1") {
  location.replace("?fixture=demo");
} else {
  renderAll();
  if (fixtureMode === "performance" || fixtureMode === "demo") demo.fixture(fixtureMode);
}
setInterval(() => {
  if (!state.fixtureMode) load(true).catch(() => {});
}, 15000);
document
  .querySelectorAll(".work-tab")
  .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.workView === state.workView)));
document.body.classList.toggle("low-power", state.lowPower);
$("power").setAttribute("aria-pressed", String(state.lowPower));
$("power").textContent = `Low-power mode: ${state.lowPower ? "on" : "off"}`;
if ($("terminal-disclosure")) {
  $("terminal-disclosure").open = preferences.terminalOpen === true;
  $("terminal-disclosure").ontoggle = () => {
    preferences.terminalOpen = $("terminal-disclosure").open;
    remember("oda-dashboard-preferences", preferences);
  };
}

async function readLive(path) {
  const response = await fetch(path, { headers: auth(), signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
async function pollExecution() {
  if (state.fixtureMode || document.hidden || liveRefreshing) return;
  liveRefreshing = true;
  try {
    if (eventCursor === null) {
      const snapshot = await readLive("/api/v1/snapshot");
      eventCursor = snapshot.snapshotCursor;
      eventEpoch = snapshot.journalEpoch;
      await load(true);
    } else {
      const batch = await readLive(`/api/v1/events/history?after=${eventCursor}&limit=500`);
      if (batch.resync || batch.journalEpoch !== eventEpoch) {
        eventCursor = null;
        return;
      }
      for (const event of batch.events || []) {
        if (event.type === "terminal") appendTerminal(event.payload?.text || "");
        if (event.type === "sample") sample(event.payload?.cpu, event.payload?.ram);
      }
      if (batch.events?.length) {
        await load(true);
        eventCursor = batch.events.at(-1).seq;
      }
    }
    $("activity-connection").textContent = "Live · 2s";
    $("activity-connection").className = "status online";
  } catch {
    $("activity-connection").textContent = "Updates unavailable";
    $("activity-connection").className = "status stale";
  } finally {
    liveRefreshing = false;
    updateFreshness();
  }
}
function updateFreshness() {
  const age = (value) =>
    value
      ? `${Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))}s ago`
      : "not checked";
  $("execution-freshness").textContent = `Execution: ${age(executionUpdatedAt)}`;
  $("connector-freshness").textContent =
    `Connectors: ${age(state.planningSync?.lastCheckedAt)}${state.planningSync?.failed ? ` · ${state.planningSync.failed} failed` : ""}`;
  $("telemetry-freshness").textContent = `Telemetry: ${age(telemetry?.lastSuccess)}`;
}
function renderVisitSummary() {
  if (!previousVisit || visitDismissed || state.fixtureMode) return;
  const changed = state.runs.filter((r) => new Date(r.projection.updatedAt).getTime() > previousVisit.at);
  const completed = changed.filter((r) => r.projection.state === "COMPLETED").length;
  const failed = changed.filter((r) => ["FAILED", "NEEDS_ATTENTION"].includes(r.projection.state)).length;
  const approvals = state.runs.filter(needsHumanIntervention).length;
  const sameDay =
    settingsState.operations &&
    previousVisit.day ===
      new Date().toLocaleDateString("en-CA", { timeZone: settingsState.operations.policy.timezone });
  const spend = settingsState.operations
    ? sameDay
      ? ` · $${Math.max(0, settingsState.operations.spent - (previousVisit.spent || 0)).toFixed(3)} known spend since visit`
      : ` · $${settingsState.operations.spent.toFixed(3)} known spend today`
    : "";
  $("since-visit").hidden = false;
  $("since-summary").textContent =
    `${completed} completed · ${failed} need recovery · ${approvals} need your decision${spend}`;
}
if ($("since-dismiss"))
  $("since-dismiss").onclick = () => {
    visitDismissed = true;
    $("since-visit").hidden = true;
  };
addEventListener("pagehide", () => {
  if (!state.fixtureMode)
    remember("oda-last-visit", {
      at: Date.now(),
      spent: settingsState.operations?.spent || 0,
      day: new Date().toLocaleDateString("en-CA", {
        timeZone: settingsState.operations?.policy.timezone || "Europe/Brussels",
      }),
    });
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void pollExecution();
    void settings.refreshOperations();
  }
});
setInterval(() => void pollExecution(), 2000);
setTimeout(() => void pollExecution(), 0);

telemetry = createTelemetry({ updateFreshness, renderAll, demoTelemetry: demo.demoTelemetry });
updateFreshness();
