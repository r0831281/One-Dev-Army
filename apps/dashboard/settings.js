import { $, state, stored, remember, node } from "./core.js";
export const settingsState = { operations: null, configuration: null, dirty: false };
export function createSettings({
  request,
  renderWork,
  renderVisitSummary,
  renderConfiguration,
  load,
  readLive,
}) {
  function validDemoPolicy(p) {
    try {
      if (
        !p ||
        typeof p.paused !== "boolean" ||
        !Number.isInteger(p.maxConcurrentRuns) ||
        p.maxConcurrentRuns < 1 ||
        p.maxConcurrentRuns > 100 ||
        !["allow", "block"].includes(p.unpricedPolicy) ||
        typeof p.timezone !== "string" ||
        !Number.isFinite(p.reservationUsd) ||
        p.reservationUsd <= 0
      )
        return false;
      for (const value of [p.dailyLimitUsd, p.taskLimitUsd])
        if (value !== null && (!Number.isFinite(value) || value < 0)) return false;
      new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
      return true;
    } catch {
      return false;
    }
  }
  function demoPolicy() {
    const value = stored("oda-demo-operations", defaultOperations);
    return validDemoPolicy(value) ? value : { ...defaultOperations };
  }
  function validDemoProfile(p) {
    return (
      p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      p.name.trim() &&
      typeof p.model === "string" &&
      Number.isInteger(p.revision) &&
      p.revision >= 1 &&
      [
        "context-reviewer",
        "planner",
        "implementer",
        "tester",
        "reviewer",
        "reporter",
        "setup-onboarding",
      ].includes(p.role)
    );
  }
  function savedDemoConfiguration() {
    const valid = (value) =>
      value &&
      Array.isArray(value.connectors) &&
      Array.isArray(value.repositories) &&
      Array.isArray(value.roles) &&
      Array.isArray(value.profiles) &&
      value.profiles.every(validDemoProfile) &&
      value.assignments &&
      value.readiness;
    const saved = stored("oda-demo-configuration", null);
    if (valid(saved)) return saved;
    if (valid(settingsState.configuration)) return settingsState.configuration;
    const value = demoConfiguration();
    remember("oda-demo-configuration", value);
    return value;
  }
  const defaultOperations = {
    dailyLimitUsd: null,
    taskLimitUsd: null,
    reservationUsd: 0.5,
    maxConcurrentRuns: 3,
    paused: false,
    unpricedPolicy: "allow",
    timezone: "Europe/Brussels",
  };
  function profileTemplate(role = "planner", name = "New planner") {
    return {
      schemaVersion: "1.0",
      id: crypto.randomUUID(),
      name,
      revision: 1,
      role,
      provider: "fake",
      model: "fixture",
      credentialRef: null,
      providerOptions: {},
      limits: { maxInputTokens: 12000, maxOutputTokens: 4000, timeoutMs: 30000, maxModelCalls: 10 },
      tools: [],
      prompt: {
        templateId: "system-v1",
        templateRevision: 1,
        intent: "Follow the approved task and pinned constraints.",
        compiledArtifactId: null,
      },
      outputSchemaRef: "oda.agent.result.v1",
      retryPolicy: { transportAttempts: 2, structuredOutputRepairs: 1 },
      fallbackProfileIds: [],
      localOnly: true,
    };
  }
  function demoConfiguration() {
    const roles = ["context-reviewer", "planner", "implementer", "tester", "reviewer", "reporter"];
    const profiles = roles.map((r) => profileTemplate(r, r));
    return {
      connectors: [],
      repositories: [{ id: "33333333-3333-4333-8333-333333333333", name: "Demo repository" }],
      roles,
      profiles,
      assignments: Object.fromEntries(profiles.map((p) => [p.role, p.id])),
      readiness: {
        connectors: false,
        tasksSynced: true,
        agentsConfigured: true,
        executionBackend: "deterministic",
        liveModelExecution: false,
      },
    };
  }
  async function refreshOperations(fill = false) {
    try {
      if (state.fixtureMode)
        settingsState.operations = {
          policy: demoPolicy(),
          spent: 0.37,
          reserved: 0.5,
          active: 2,
          unpriced: 0,
          remaining: null,
        };
      else settingsState.operations = await readLive("/api/v1/operations");
      const s = settingsState.operations,
        p = s.policy;
      if (state.fixtureMode)
        s.remaining = p.dailyLimitUsd === null ? null : Math.max(0, p.dailyLimitUsd - s.spent - s.reserved);
      $("budget-summary").textContent =
        `$${s.spent.toFixed(3)} spent · $${s.reserved.toFixed(3)} reserved · ${s.remaining === null ? "no daily cap" : `$${s.remaining.toFixed(3)} remaining`}${s.unpriced ? ` · ${s.unpriced} unpriced` : ""}`;
      $("pause-work").textContent = p.paused ? "Resume new work" : "Pause new work";
      $("pause-work").disabled = false;
      if (fill || (!settingsState.dirty && !$("operations-form").contains(document.activeElement))) {
        $("ops-daily").value = p.dailyLimitUsd ?? "";
        $("ops-task").value = p.taskLimitUsd ?? "";
        $("ops-reservation").value = p.reservationUsd;
        $("ops-concurrency").value = p.maxConcurrentRuns;
        $("ops-unpriced").value = p.unpricedPolicy;
        $("ops-timezone").value = p.timezone;
        $("ops-paused").checked = p.paused;
      }
      renderVisitSummary();
    } catch {
      if ($("budget-summary")) $("budget-summary").textContent = "Budget telemetry unavailable";
      if ($("pause-work")) $("pause-work").disabled = true;
    }
  }
  async function saveOperations(policy) {
    if (!validDemoPolicy(policy)) throw new Error("Choose valid spending limits, concurrency, and timezone.");
    if (state.fixtureMode === "demo") remember("oda-demo-operations", policy);
    else await request("/api/v1/operations", { method: "POST", body: JSON.stringify(policy) });
    settingsState.dirty = false;
    await refreshOperations(true);
    renderWork();
  }
  if ($("pause-work"))
    $("pause-work").onclick = async () => {
      if (!settingsState.operations) return;
      $("pause-work").disabled = true;
      try {
        await saveOperations({
          ...settingsState.operations.policy,
          paused: !settingsState.operations.policy.paused,
        });
      } catch (error) {
        $("budget-summary").textContent = error.message;
        $("pause-work").disabled = false;
      }
    };
  async function settingsAction(form, statusId, action) {
    const buttons = [...form.querySelectorAll('button[type="submit"],button:not([type])')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await action();
      $(statusId).textContent = "Saved.";
    } catch (error) {
      $(statusId).textContent = error.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  $("operations-form").oninput = () => {
    settingsState.dirty = true;
  };
  $("operations-form").onsubmit = (event) => {
    event.preventDefault();
    void settingsAction(event.currentTarget, "operations-status", () =>
      saveOperations({
        dailyLimitUsd: $("ops-daily").value === "" ? null : Number($("ops-daily").value),
        taskLimitUsd: $("ops-task").value === "" ? null : Number($("ops-task").value),
        reservationUsd: Number($("ops-reservation").value),
        maxConcurrentRuns: Number($("ops-concurrency").value),
        unpricedPolicy: $("ops-unpriced").value,
        timezone: $("ops-timezone").value.trim(),
        paused: $("ops-paused").checked,
      }),
    );
  };
  async function refreshWorkspaceConfiguration() {
    try {
      settingsState.configuration = state.fixtureMode
        ? savedDemoConfiguration()
        : await readLive("/api/v1/configuration");
      const c = settingsState.configuration,
        r = c.readiness;
      $("readiness-status").textContent =
        `${r.connectors ? "✓" : "○"} Connector configured · ${r.tasksSynced ? "✓" : "○"} Tasks synced · ${r.agentsConfigured ? "✓" : "○"} Agent roles assigned. Execution backend: ${r.executionBackend}${r.liveModelExecution ? "" : " (live models are not enabled)"}${state.fixtureMode ? " · demo" : ""}.`;
      if (!$("connector-form").contains(document.activeElement))
        $("connector-repository-id").replaceChildren(...c.repositories.map((r) => new Option(r.name, r.id)));
      const list = $("connector-list");
      list.replaceChildren();
      for (const connector of c.connectors) {
        const button = node(
          "button",
          `${connector.name} · ${connector.enabled ? "enabled" : "disabled"} · ${connector.credentialPresent ? "credential present" : "credential missing"}`,
        );
        button.type = "button";
        button.onclick = () => editConnector(connector);
        list.append(button);
      }
      const fields = $("assignment-fields");
      if (!fields.contains(document.activeElement)) {
        fields.replaceChildren();
        for (const role of c.roles) {
          const label = node("label", role);
          const select = document.createElement("select");
          select.dataset.role = role;
          const latest = new Map();
          for (const p of c.profiles.filter((p) => p.role === role))
            if (!latest.has(p.id) || latest.get(p.id).revision < p.revision) latest.set(p.id, p);
          select.append(
            new Option("Unassigned", ""),
            ...[...latest.values()].map(
              (p) => new Option(`${p.name} · ${p.provider}/${p.model} · v${p.revision}`, p.id),
            ),
          );
          select.value = c.assignments[role] || "";
          label.append(select);
          fields.append(label);
        }
      }
      if (!$("profile-json").value) $("profile-json").value = JSON.stringify(profileTemplate(), null, 2);
      if ($("settings-dialog").open) void renderConfiguration($("settings-config"));
    } catch {
      if ($("readiness-status"))
        $("readiness-status").textContent =
          "Configuration unavailable. Reconnect to check workspace readiness.";
    }
  }
  function editConnector(c) {
    const mapping = {
      id: "id",
      name: "name",
      provider: "provider",
      repositoryId: "repository-id",
      baseSha: "base",
      origin: "origin",
      owner: "owner",
      repository: "repo",
      project: "project",
      credentialEnv: "credential",
    };
    for (const [key, id] of Object.entries(mapping)) $("connector-" + id).value = c[key] || "";
    $("connector-enabled").checked = c.enabled;
  }
  $("connector-new").onclick = () => {
    $("connector-form").reset();
    $("connector-id").value = "";
  };
  $("connector-provider").onchange = () => {
    $("connector-origin").value =
      $("connector-provider").value === "github"
        ? "https://api.github.com"
        : "https://your-team.atlassian.net";
  };
  $("connector-form").onsubmit = (event) => {
    event.preventDefault();
    void settingsAction(event.currentTarget, "connector-status", async () => {
      const c = {
        id: $("connector-id").value || crypto.randomUUID(),
        name: $("connector-name").value.trim(),
        provider: $("connector-provider").value,
        repositoryId: $("connector-repository-id").value,
        baseSha: $("connector-base").value.trim(),
        origin: $("connector-origin").value.trim(),
        owner: $("connector-owner").value.trim(),
        repository: $("connector-repo").value.trim(),
        project: $("connector-project").value.trim(),
        credentialEnv: $("connector-credential").value.trim(),
        enabled: $("connector-enabled").checked,
      };
      if (state.fixtureMode === "demo") {
        settingsState.configuration.connectors = settingsState.configuration.connectors.filter(
          (x) => x.id !== c.id,
        );
        settingsState.configuration.connectors.push({ ...c, credentialPresent: false, ready: false });
        remember("oda-demo-configuration", settingsState.configuration);
      } else await request("/api/v1/connectors", { method: "POST", body: JSON.stringify(c) });
      await refreshWorkspaceConfiguration();
    });
  };
  $("connector-sync").onclick = async () => {
    try {
      if (!state.fixtureMode) {
        await request("/api/v1/connectors/sync", { method: "POST", body: "{}" });
        await load(true);
      }
      $("connector-status").textContent = state.fixtureMode
        ? "Demo only · no connector network requests"
        : "Fetched tasks refreshed.";
    } catch (error) {
      $("connector-status").textContent = error.message;
    }
  };
  $("connector-fetch-form").onsubmit = (event) => {
    event.preventDefault();
    void settingsAction(event.currentTarget, "connector-status", async () => {
      if (state.fixtureMode) throw new Error("Demo only · connect a live workspace to fetch source tasks.");
      await request("/api/v1/tasks/ingest", {
        method: "POST",
        body: JSON.stringify({ identifier: $("connector-identifier").value.trim() }),
      });
      await load(true);
      await refreshWorkspaceConfiguration();
    });
  };
  $("profile-form").onsubmit = (event) => {
    event.preventDefault();
    void settingsAction(event.currentTarget, "profile-status", async () => {
      const p = JSON.parse($("profile-json").value);
      if (state.fixtureMode === "demo") {
        if (!validDemoProfile(p))
          throw new Error("Enter a valid profile name, model, role, ID, and revision.");
        settingsState.configuration.profiles.push(p);
        remember("oda-demo-configuration", settingsState.configuration);
      } else await request("/api/v1/profiles", { method: "POST", body: JSON.stringify(p) });
      await refreshWorkspaceConfiguration();
    });
  };
  $("assignment-form").onsubmit = (event) => {
    event.preventDefault();
    void settingsAction(event.currentTarget, "assignment-status", async () => {
      const assignments = Object.fromEntries(
        [...$("assignment-fields").querySelectorAll("select")]
          .filter((s) => s.value)
          .map((s) => [s.dataset.role, s.value]),
      );
      if (state.fixtureMode === "demo") {
        settingsState.configuration.assignments = assignments;
        remember("oda-demo-configuration", settingsState.configuration);
      } else await request("/api/v1/assignments", { method: "POST", body: JSON.stringify(assignments) });
      await refreshWorkspaceConfiguration();
    });
  };
  setTimeout(() => {
    void refreshOperations();
    void refreshWorkspaceConfiguration();
  }, 0);
  setInterval(() => {
    if (!document.hidden) void refreshOperations();
  }, 5000);
  setInterval(() => {
    if (!document.hidden) void refreshWorkspaceConfiguration();
  }, 30000);

  return { refreshOperations, refreshWorkspaceConfiguration };
}
