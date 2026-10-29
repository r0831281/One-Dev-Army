// Agent profiles as plain settings: pick a model, effort and limits per role; revisions are created for you.
import { node } from "./core.js";

/** Models the live analysis can run on, cheapest first. Prices are USD per million input / output tokens. */
const MODELS = [
  ["claude-haiku-5-5", "Claude Haiku 5.5 · cheapest · $0.10 / $0.50"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 · balanced · $2 / $10"],
  ["claude-opus-5-5", "Claude Opus 5.5 · most capable · $4 / $20"],
];
const EFFORTS = [
  ["low", "Low · quick, fewest tokens"],
  ["medium", "Medium · good default"],
  ["high", "High · more thorough"],
  ["xhigh", "Extra high · for hard tasks"],
  ["max", "Max · most thorough, most expensive"],
];
const OUTPUT_LIMITS = [4000, 8000, 16000, 32000];
/** Roles that run on a real model today, with what they do and a sensible starting configuration. */
const LIVE_ROLES = {
  "context-reviewer": {
    title: "Context reviewer",
    purpose: "Reads the task and the code, then asks questions or proposes assumptions.",
    defaults: { name: "Claude context reviewer", model: "claude-haiku-5-5", effort: "medium", calls: 15 },
  },
  planner: {
    title: "Planner",
    purpose: "Writes the step-by-step plan you approve.",
    defaults: { name: "Claude planner", model: "claude-sonnet-5-5", effort: "medium", calls: 20 },
  },
};
const ROLE_TITLES = {
  implementer: "Implementer",
  tester: "Tester",
  reviewer: "Reviewer",
  reporter: "Reporter",
};

const latestRevisions = (profiles) => {
  const latest = new Map();
  for (const p of profiles)
    if (!latest.has(p.id) || latest.get(p.id).revision < p.revision) latest.set(p.id, p);
  return latest;
};
const modelLabel = (model) => MODELS.find(([id]) => id === model)?.[1].split(" · ")[0] ?? model;
const select = (choices, value) => {
  const control = document.createElement("select");
  for (const [optionValue, text] of choices) control.append(new Option(text, optionValue));
  control.value = value;
  return control;
};
const labelled = (text, control, hint) => {
  const label = node("label", text);
  label.append(control);
  if (hint) label.append(node("small", hint, "muted"));
  return label;
};

/** A Claude profile for a live role, either the next revision of `base` or a new profile. */
function claudeProfile(role, base, values) {
  const defaults = LIVE_ROLES[role].defaults;
  return {
    schemaVersion: "1.0",
    id: base?.id ?? crypto.randomUUID(),
    name: base?.name ?? defaults.name,
    revision: base ? base.revision + 1 : 1,
    role,
    provider: "anthropic",
    model: values.model,
    credentialRef:
      base?.provider === "anthropic" && base.credentialRef ? base.credentialRef : "env:ANTHROPIC_API_KEY",
    providerOptions: {
      ...(base?.provider === "anthropic" ? base.providerOptions : {}),
      reasoningEffort: values.effort,
    },
    limits: {
      maxInputTokens: base?.limits?.maxInputTokens ?? 60000,
      maxOutputTokens: values.maxOutputTokens,
      timeoutMs: base?.limits?.timeoutMs ?? 600000,
      maxModelCalls: values.maxModelCalls,
    },
    tools: ["repo.read", "repo.search", ...(values.dataQueries ? ["db.query"] : [])],
    prompt: base?.prompt ?? {
      templateId: "system-v1",
      templateRevision: 1,
      intent: "Analyse and plan Odoo customer tasks.",
      compiledArtifactId: null,
    },
    outputSchemaRef: base?.outputSchemaRef ?? "oda.agent.result.v1",
    retryPolicy: base?.retryPolicy ?? { transportAttempts: 2, structuredOutputRepairs: 2 },
    fallbackProfileIds: base?.fallbackProfileIds ?? [],
    localOnly: false,
  };
}

/**
 * Renders the agent profile settings into `host`. `save(profile, assignments?)` stores a profile and, when given,
 * the full role assignment map; it refreshes the configuration afterwards.
 */
export function renderProfiles(host, configuration, { save, advanced }) {
  host.replaceChildren();
  const latest = latestRevisions(configuration.profiles || []);
  const assignments = configuration.assignments || {};
  host.append(
    node(
      "p",
      "Choose the model and limits for each agent. Saving keeps a history: analyses that already started keep the settings they began with.",
      "muted",
    ),
  );
  const grid = node("div", "", "config-grid");
  for (const [role, info] of Object.entries(LIVE_ROLES)) {
    const current = latest.get(assignments[role]);
    const live = current?.provider === "anthropic";
    const card = node("section", "", "panel profile-card");
    card.append(node("h3", info.title), node("p", info.purpose, "muted"));
    card.append(
      node(
        "p",
        live
          ? `${modelLabel(current.model)} · effort ${current.providerOptions?.reasoningEffort ?? "high"} · up to ${current.limits.maxOutputTokens.toLocaleString()} output tokens · ${current.limits.maxModelCalls} calls${current.tools.includes("db.query") ? " · may query the database" : ""}`
          : current
            ? `Simulated (${current.provider}). Set up Claude to run this role live.`
            : "Not set up yet.",
        live ? "" : "attention",
      ),
    );
    if (live) card.append(node("small", `Revision ${current.revision}`, "muted"));
    const open = node("button", live ? "Change settings" : "Set up with Claude");
    open.type = "button";
    open.onclick = () => {
      open.hidden = true;
      card.append(editor(role, live ? current : null, () => (open.hidden = false)));
    };
    card.append(open);
    grid.append(card);
  }
  host.append(grid);

  const others = Object.entries(ROLE_TITLES).map(([role, title]) => {
    const profile = latest.get(assignments[role]);
    return `${title}: ${profile ? `${profile.name} (${profile.provider})` : "not assigned"}`;
  });
  host.append(
    node("h4", "Not live yet"),
    node(
      "p",
      `Implementation, testing, review and reporting still run as a simulation. ${others.join(" · ")}`,
      "muted",
    ),
  );
  if (advanced?.length) {
    const details = document.createElement("details");
    details.append(node("summary", "Advanced: edit profile JSON or assign roles by hand"));
    details.append(...advanced);
    host.append(details);
  }

  function editor(role, base, onClose) {
    const defaults = LIVE_ROLES[role].defaults;
    const form = node("form", "", "settings-form profile-editor");
    const model = select(MODELS, base?.model ?? defaults.model);
    const effort = select(EFFORTS, base?.providerOptions?.reasoningEffort ?? defaults.effort);
    const output = select(
      OUTPUT_LIMITS.map((value) => [String(value), `${value.toLocaleString()} tokens`]),
      String(base?.limits?.maxOutputTokens ?? 8000),
    );
    const calls = Object.assign(document.createElement("input"), {
      type: "number",
      min: 1,
      max: 50,
      required: true,
      value: String(base?.limits?.maxModelCalls ?? defaults.calls),
    });
    const data = Object.assign(document.createElement("input"), {
      type: "checkbox",
      checked: base ? base.tools.includes("db.query") : true,
    });
    const status = node("p", "", "settings-status");
    const submit = node("button", "Save", "settings-primary-action");
    submit.type = "submit";
    const cancel = node("button", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => {
      form.remove();
      onClose();
    };
    form.append(
      labelled("Model", model, "Price per million input / output tokens."),
      labelled("Thinking effort", effort, "Higher effort is more thorough and uses more tokens."),
      labelled("Longest answer", output, "Caps one reply; the agent stops if it needs more."),
      labelled("Most model calls per step", calls, "Each file read or search is one call."),
      labelled(
        "Allow database queries",
        data,
        "Only used when you tick data access when starting an analysis.",
      ),
      status,
      submit,
      cancel,
    );
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "Saving…";
      const profile = claudeProfile(role, base, {
        model: model.value,
        effort: effort.value,
        maxOutputTokens: Number(output.value),
        maxModelCalls: Number(calls.value),
        dataQueries: data.checked,
      });
      try {
        // A new profile also takes over the role; a new revision of the assigned profile needs no reassignment.
        await save(profile, base ? undefined : { ...assignments, [role]: profile.id });
      } catch (error) {
        status.textContent = `Not saved: ${error.message}`;
        submit.disabled = false;
      }
    };
    return form;
  }
}
