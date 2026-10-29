// Add operational controls to existing dashboard layouts without replacing their styling.
export function mountWorkspaceControls() {
  const make = (tag, id, text, cls) => {
    const n = document.createElement(tag);
    if (id) n.id = id;
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const get = (id) => document.getElementById(id);
  const main = get("workspace"),
    rail = document.querySelector(".activity");
  const dialog = get("settings-dialog"),
    settingsRoot = dialog.querySelector(".settings-scroll") || dialog;
  const field = (form, id, title, type = "text", options = {}) => {
    const label = make("label", null, title);
    const input = make(type === "select" ? "select" : type === "textarea" ? "textarea" : "input", id);
    if (!["select", "textarea"].includes(type)) input.type = type;
    for (const [key, value] of Object.entries(options)) {
      if (key === "choices")
        for (const [optionValue, text] of value) input.append(new Option(text, optionValue));
      else input.setAttribute(key, String(value));
    }
    label.append(input);
    form.append(label);
    return input;
  };
  const section = (title) => {
    const detail = make("details");
    detail.append(make("summary", null, title));
    settingsRoot.append(detail);
    return detail;
  };
  const form = (parent, id, status) => {
    const f = make("form", id, null, "settings-form");
    parent.append(f);
    if (status) f.append(make("p", status, null, "settings-status"));
    return f;
  };
  const submit = (f, text) => {
    const b = make("button", null, text, "settings-primary-action");
    b.type = "submit";
    f.append(b);
  };
  if (!get("operations-form")) {
    const parent = section("Spending & execution limits"),
      f = form(parent, "operations-form", "operations-status");
    field(f, "ops-daily", "Daily workspace cap (USD, blank = unlimited)", "number", {
      min: 0,
      max: 1000000,
      step: 0.01,
    });
    field(f, "ops-task", "Per-task cap (USD, blank = unlimited)", "number", {
      min: 0,
      max: 1000000,
      step: 0.01,
    });
    field(f, "ops-reservation", "Reserve for each new run (USD)", "number", {
      min: 0.01,
      max: 1000000,
      step: 0.01,
      required: "",
      value: 0.5,
    });
    field(f, "ops-concurrency", "Maximum concurrent runs", "number", {
      min: 1,
      max: 100,
      required: "",
      value: 3,
    });
    field(f, "ops-unpriced", "Unknown prices", "select", {
      choices: [
        ["allow", "Allow and flag unpriced usage"],
        ["block", "Block unpriced calls and new work"],
      ],
    });
    field(f, "ops-timezone", "Daily reset timezone", "text", { required: "", value: "Europe/Brussels" });
    field(f, "ops-paused", "Pause new work; running work continues", "checkbox");
    f.append(
      make(
        "p",
        null,
        "Limits include known spend and reservations. Allowing unknown prices can exceed a monetary cap. Concurrency counts runs, including those waiting for approval.",
        "muted",
      ),
    );
    submit(f, "Save limits");
  }
  if (!get("connector-form")) {
    const parent = section("Task connectors");
    parent.append(
      make(
        "p",
        null,
        "Read-only GitHub and Jira Cloud fetches. Set the full Authorization header value in an environment variable on the API host; enter only its name here.",
        "muted",
      ),
      make("div", "connector-list"),
    );
    const f = form(parent, "connector-form");
    f.append(Object.assign(make("input", "connector-id"), { type: "hidden" }));
    field(f, "connector-name", "Name", "text", { required: "", maxlength: 120 });
    field(f, "connector-provider", "Provider", "select", {
      choices: [
        ["github", "GitHub"],
        ["jira", "Jira Cloud"],
      ],
    });
    field(f, "connector-repository-id", "Repository", "select", { required: "" });
    field(f, "connector-base", "Pinned repository commit SHA", "text", {
      pattern: "[a-f0-9]{40}([a-f0-9]{24})?",
      required: "",
    });
    field(f, "connector-origin", "API origin", "url", { value: "https://api.github.com", required: "" });
    field(f, "connector-owner", "GitHub owner");
    field(f, "connector-repo", "GitHub repository");
    field(f, "connector-project", "Jira project key");
    field(f, "connector-credential", "Credential environment variable", "text", {
      pattern: "[A-Z_][A-Z0-9_]*",
      required: "",
      placeholder: "ODA_GITHUB_AUTH",
    });
    field(f, "connector-enabled", "Enabled", "checkbox", { checked: "" });
    submit(f, "Save connector");
    for (const [id, text] of [
      ["connector-new", "New connector"],
      ["connector-sync", "Refresh fetched tasks"],
    ]) {
      const b = make("button", id, text);
      b.type = "button";
      f.append(b);
    }
    const fetchForm = form(parent, "connector-fetch-form", "connector-status");
    field(fetchForm, "connector-identifier", "Fetch task by identifier", "text", {
      required: "",
      placeholder: "owner/repo#123 or PROJECT-123",
    });
    submit(fetchForm, "Test & fetch task");
  }
  const profileParent = get("settings-config")?.parentElement || section("Agent profiles");
  if (!get("profile-form")) {
    const f = form(profileParent, "profile-form", "profile-status");
    field(f, "profile-json", "Profile JSON (new ID or next revision)", "textarea", {
      required: "",
      rows: 12,
      "aria-label": "Agent profile JSON",
    });
    submit(f, "Save profile revision");
  }
  if (!get("assignment-form")) {
    const f = form(profileParent, "assignment-form", "assignment-status");
    f.append(make("div", "assignment-fields"));
    submit(f, "Save role assignments");
  }
  if (!get("work-eligibility")) {
    const label = make("label", null, "Work eligibility", "run-detail");
    label.append(make("select", "work-eligibility"));
    get("filter").parentElement.after(label);
  }
  const filter = get("work-eligibility");
  for (const [value, label] of [
    ["all", "All tasks"],
    ["eligible", "Eligible"],
    ["deferred", "Deferred work"],
    ["undated", "Undated tasks"],
    ["overridden", "Manual overrides"],
  ])
    if (![...filter.options].some((o) => o.value === value)) filter.append(new Option(label, value));
  if (!get("activity-connection")) {
    const badge =
      rail.querySelector(".rail-heading .status") || make("span", null, "Waiting", "status stale");
    badge.id = "activity-connection";
    if (!badge.parentElement) rail.prepend(badge);
  }
  if (!get("readiness")) {
    const section = make("section", "readiness", null, "panel");
    section.setAttribute("aria-label", "Workspace readiness");
    const head = make("div", null, null, "section-heading");
    head.append(make("h2", null, "Workspace readiness"), make("button", "readiness-settings", "Configure"));
    section.append(
      head,
      make("p", "readiness-status", "Connect to check connector sync and agent assignments.", "muted"),
    );
    main.querySelector(".planner").before(section);
  }
  if (!get("since-visit")) {
    const section = make("section", "since-visit", null, "panel");
    section.hidden = true;
    const head = make("div", null, null, "section-heading");
    head.append(make("h2", null, "Since your last visit"), make("button", "since-dismiss", "Dismiss"));
    section.append(head, make("p", "since-summary", null, "muted"));
    get("readiness").after(section);
  }
  if (!get("budget-summary")) {
    const section = make("section", null, null, "panel");
    section.setAttribute("aria-label", "Spending controls");
    section.append(
      make("p", "budget-summary", "Budget telemetry unavailable", "muted"),
      make("button", "pause-work", "Pause new work"),
    );
    for (const [id, text] of [
      ["execution-freshness", "Execution: not connected"],
      ["connector-freshness", "Connectors: not checked"],
      ["telemetry-freshness", "Telemetry: not checked"],
    ])
      section.append(make("p", id, text, "telemetry-detail"));
    rail.querySelector(".rail-heading").after(section);
  }
  if (!get("telemetry-drilldown")) {
    const section = make("section", "telemetry-drilldown");
    section.hidden = true;
    section.setAttribute("aria-label", "Contribution task and step details");
    section.append(
      make("button", "drilldown-close", "Close details"),
      make("h3", "drilldown-title"),
      make("div", "drilldown-rows"),
    );
    get("contribution-rows").after(section);
  }
  if (!get("terminal-disclosure")) {
    const terminal = get("terminal"),
      heading = terminal.previousElementSibling;
    const details = make("details", "terminal-disclosure");
    details.append(make("summary", null, "Terminal · redacted output"));
    terminal.before(details);
    details.append(terminal);
    if (heading?.tagName === "H3") heading.remove();
  }
}
