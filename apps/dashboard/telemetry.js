import { $, state, preferences, remember, node, auth } from "./core.js";
export function createTelemetry({ updateFreshness, renderAll, demoTelemetry }) {
  // Telemetry uses complete, bounded snapshots: retries/reconnects cannot double-count usage.
  const telemetryMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let telemetryFrame = 0;
  let telemetryCurrent = null;
  let telemetryLastSuccess = 0;
  let telemetryRaw = null;
  let contributionGroup = preferences.contributionGroup === "model" ? "model" : "agent";
  for (const id of ["telemetry-agent", "telemetry-model"])
    if (preferences[id]) {
      $(id).append(new Option(preferences[id], preferences[id]));
      $(id).value = preferences[id];
    }
  let drilldownSelection = null;
  let drilldownTrigger = null;
  $("contribution-sort").value = preferences["contribution-sort"] || "tokens";
  document
    .querySelectorAll("[data-contribution-group]")
    .forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.contributionGroup === contributionGroup)),
    );
  const usageKeys = ["input", "output", "spend", "unpriced", "unknown_tokens"];
  const modelKey = (row) => JSON.stringify([row.provider, row.model]);
  function selectedContributions(snapshot) {
    const times = new Set(snapshot.buckets.map((b) => b.time));
    return (snapshot.contributions || []).filter(
      (row) =>
        times.has(row.time) &&
        (!$("telemetry-agent").value || row.agentId === $("telemetry-agent").value) &&
        (!$("telemetry-model").value || modelKey(row) === $("telemetry-model").value),
    );
  }
  function scopedTelemetry(snapshot) {
    if (!$("telemetry-agent").value && !$("telemetry-model").value) return snapshot;
    const buckets = snapshot.buckets.map((b) => ({
      ...b,
      ...Object.fromEntries(usageKeys.map((key) => [key, 0])),
    }));
    const byTime = new Map(buckets.map((b) => [b.time, b]));
    for (const row of selectedContributions(snapshot)) {
      const b = byTime.get(row.time);
      for (const key of usageKeys) b[key] += row[key];
    }
    return { ...snapshot, buckets };
  }
  function updateTelemetryOptions(snapshot) {
    const rows = snapshot.contributions || [];
    for (const [id, values, label] of [
      ["telemetry-agent", new Map(rows.map((r) => [r.agentId, r.agentName])), "All agents"],
      [
        "telemetry-model",
        new Map(rows.map((r) => [modelKey(r), `${r.provider} / ${r.model}`])),
        "All models",
      ],
    ]) {
      const select = $(id);
      const prior = select.value || preferences[id] || "";
      const priorLabel = select.selectedOptions[0]?.textContent;
      if (prior && !values.has(prior))
        values.set(prior, `${priorLabel.replace(/ \(no recent usage\)$/, "")} (no recent usage)`);
      select.replaceChildren(
        new Option(label, ""),
        ...[...values]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([value, name]) => new Option(name, value)),
      );
      select.value = prior;
      select.disabled = !snapshot.contributions;
    }
    updateContributionBreakdown(snapshot);
  }
  function updateContributionBreakdown(snapshot) {
    const rows = selectedContributions(snapshot);
    const groups = new Map();
    for (const row of rows) {
      const key = contributionGroup === "agent" ? row.agentId : modelKey(row);
      if (!groups.has(key))
        groups.set(key, {
          name: contributionGroup === "agent" ? row.agentName : row.model,
          identities: new Set(),
          tokens: 0,
          spend: 0,
          unpriced: 0,
          unknown: 0,
        });
      const group = groups.get(key);
      group.identities.add(contributionGroup === "agent" ? `${row.provider} / ${row.model}` : row.agentName);
      group.tokens += row.input + row.output;
      group.spend += row.spend;
      group.unpriced += row.unpriced;
      group.unknown += row.unknown_tokens;
      if (contributionGroup === "model") group.name = `${row.provider} / ${row.model}`;
    }
    const totalTokens = [...groups.values()].reduce((s, g) => s + g.tokens, 0);
    const totalCost = [...groups.values()].reduce((s, g) => s + g.spend, 0);
    const partial = rows.some((r) => r.unpriced || r.unknown_tokens);
    $("contribution-note").textContent = !snapshot.contributions
      ? "Attribution unavailable from this telemetry source"
      : !rows.length
        ? "No usage for this selection in the last 5 minutes"
        : `${partial ? "Known usage only · " : ""}Shares of selected scope · cyan tokens / amber cost`;
    $("telemetry-scope").textContent =
      `Token & spend scope: ${$("telemetry-agent").selectedOptions[0]?.textContent} · ${$("telemetry-model").selectedOptions[0]?.textContent}`;
    const host = $("contribution-rows");
    const sort = $("contribution-sort").value;
    const existing = new Map([...host.children].map((row) => [row.dataset.key, row]));
    const ordered = [...groups].sort((a, b) => b[1][sort] - a[1][sort] || a[1].name.localeCompare(b[1].name));
    for (const [key, group] of ordered) {
      let row = existing.get(key);
      if (!row) {
        row = node("div", "", "contribution-row");
        row.dataset.key = key;
        row.append(node("strong", "", "contribution-name"), node("span", "", "contribution-caption"));
        for (const metric of ["tokens", "cost"]) {
          row.append(node("div", "", `contribution-metric ${metric}`));
          const track = node("div", "", `contribution-track ${metric}`);
          track.append(node("span"));
          row.append(track);
        }
        const open = node("button", "View tasks & steps", "contribution-open");
        open.type = "button";
        open.onclick = () => {
          drilldownSelection = { key, group: contributionGroup, name: group.name };
          drilldownTrigger = open;
          renderDrilldown();
          $("telemetry-drilldown").scrollIntoView({
            block: "nearest",
            behavior: telemetryMotion.matches ? "auto" : "smooth",
          });
        };
        row.append(open);
      }
      row.querySelector(".contribution-name").textContent = group.name;
      row.querySelector(".contribution-caption").textContent = [...group.identities].join(" · ");
      const tokenShare = totalTokens ? (group.tokens / totalTokens) * 100 : 0;
      const costShare = totalCost ? (group.spend / totalCost) * 100 : 0;
      row.querySelector(".contribution-metric.tokens").textContent =
        `${group.unknown ? "≥ " : ""}${group.tokens.toLocaleString()} tokens · ${tokenShare.toFixed(0)}%`;
      row.querySelector(".contribution-metric.cost").textContent =
        `${group.unpriced ? "≥ " : ""}$${group.spend.toFixed(3)} · ${costShare.toFixed(0)}%${group.unpriced ? ` · ${group.unpriced} unpriced` : ""}`;
      row.querySelector(".contribution-track.tokens span").style.width = `${tokenShare}%`;
      row.querySelector(".contribution-track.cost span").style.width = `${costShare}%`;
      host.append(row);
      existing.delete(key);
    }
    for (const row of existing.values()) row.remove();
    if (drilldownSelection) renderDrilldown();
  }
  function renderDrilldown() {
    if (!drilldownSelection || !telemetryRaw) return;
    $("telemetry-drilldown").hidden = false;
    $("drilldown-title").textContent = drilldownSelection.name;
    const rows = selectedContributions(telemetryRaw).filter(
      (r) => (drilldownSelection.group === "agent" ? r.agentId : modelKey(r)) === drilldownSelection.key,
    );
    const groups = new Map();
    for (const r of rows) {
      const key = JSON.stringify([r.taskId, r.stepId, r.provider, r.model]);
      if (!groups.has(key)) groups.set(key, { ...r, tokens: 0, spend: 0, attempts: 0, unpriced: 0 });
      const g = groups.get(key);
      g.tokens += r.input + r.output;
      g.spend += r.spend;
      g.attempts += r.attempts ?? 0;
      g.unpriced += r.unpriced;
    }
    const host = $("drilldown-rows");
    host.replaceChildren();
    const completed = new Set(rows.filter((r) => r.stepCompleted && r.stepId).map((r) => r.stepId));
    const spend = rows.reduce((s, r) => s + r.spend, 0);
    host.append(
      node(
        "p",
        completed.size
          ? `$${(spend / completed.size).toFixed(3)} selected spend / attributed completed step · ${completed.size} completed steps`
          : "Cost per completed step unavailable: no attributed completed steps in this window.",
        "muted",
      ),
    );
    if (!rows.length) host.append(node("p", "No matching usage in the current scope."));
    for (const g of [...groups.values()].sort((a, b) => b.spend - a.spend)) {
      const task = state.tasks.find((t) => t.taskId === g.taskId);
      const section = node("section", "", "contribution-row");
      section.append(
        node("strong", task?.title || g.taskId || "Unattributed task", "contribution-name"),
        node("p", `${g.stepKey || "Unattributed step"} · ${g.provider}/${g.model}`),
        node(
          "p",
          `${g.tokens.toLocaleString()} tokens · ${g.unpriced ? "≥ " : ""}$${g.spend.toFixed(3)}${g.unpriced ? ` · ${g.unpriced} unpriced calls` : ""}`,
        ),
        node(
          "p",
          `${g.attempts || "Unknown"} recorded attempts · step iteration ${g.stepIteration ?? "unknown"} · transport retries not recorded`,
          "muted",
        ),
      );
      if (task) {
        const open = node("button", "Open task", "contribution-open");
        open.onclick = () => {
          state.selectedTask = task.taskId;
          state.selected = g.runId;
          renderAll();
          $("workspace").focus();
        };
        section.append(open);
      }
      host.append(section);
    }
  }
  if ($("drilldown-close"))
    $("drilldown-close").onclick = () => {
      drilldownSelection = null;
      $("telemetry-drilldown").hidden = true;
      if (drilldownTrigger?.isConnected) drilldownTrigger.focus({ preventScroll: true });
    };
  function changeTelemetrySelection() {
    if (!telemetryRaw) return;
    cancelAnimationFrame(telemetryFrame);
    telemetryCurrent = scopedTelemetry(telemetryRaw);
    paintTelemetry(telemetryCurrent);
    document.querySelectorAll(".velocity-lane").forEach((lane) => lane.replaceChildren());
    updateContributionBreakdown(telemetryRaw);
    for (const id of ["telemetry-agent", "telemetry-model", "contribution-sort"])
      preferences[id] = $(id).value;
    remember("oda-dashboard-preferences", preferences);
  }
  for (const id of ["telemetry-agent", "telemetry-model", "contribution-sort"])
    $(id).addEventListener("change", changeTelemetrySelection);
  document.querySelectorAll("[data-contribution-group]").forEach((button) =>
    button.addEventListener("click", () => {
      contributionGroup = button.dataset.contributionGroup;
      preferences.contributionGroup = contributionGroup;
      remember("oda-dashboard-preferences", preferences);
      $("contribution-rows").replaceChildren();
      document
        .querySelectorAll("[data-contribution-group]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      changeTelemetrySelection();
    }),
  );
  const svgNode = (tag, attrs) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  };
  function telemetryChart(id, values, secondary = null) {
    const svg = $(id);
    const max = Math.max(0.000001, ...values, ...(secondary || []));
    const points = (series) =>
      series.map((value, i) => [(i * 260) / Math.max(series.length - 1, 1), 53 - (value / max) * 46]);
    const primary = points(values);
    const path = (series) =>
      series.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    svg.replaceChildren(svgNode("path", { d: "M0 16H260 M0 35H260 M0 54H260", class: "telemetry-grid" }));
    svg.append(svgNode("path", { d: `${path(primary)} L260,58 L0,58 Z`, class: "telemetry-fill" }));
    svg.append(svgNode("path", { d: path(primary), class: "telemetry-line" }));
    if (secondary) svg.append(svgNode("path", { d: path(points(secondary)), class: "telemetry-output" }));
    const tip = primary.at(-1);
    if (tip) svg.append(svgNode("circle", { cx: tip[0], cy: tip[1], r: 2.6, class: "telemetry-tip" }));
  }
  function paintTelemetry(snapshot) {
    const buckets = snapshot.buckets;
    const recent = buckets.slice(-6);
    const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
    const input = sum(recent, "input"),
      output = sum(recent, "output");
    const unknown = sum(recent, "unknown_tokens");
    const unpriced = sum(recent, "unpriced");
    const spend = sum(recent, "spend");
    $("burn-value").textContent = `${unknown ? "≥ " : ""}${Math.round(input + output).toLocaleString()}`;
    $("burn-detail").textContent =
      `${Math.round(input).toLocaleString()} in · ${Math.round(output).toLocaleString()} out${unknown ? " · partial usage" : " · last 60s"}`;
    $("velocity-value").textContent = sum(recent, "completed").toFixed(0);
    $("velocity-detail").textContent =
      `${snapshot.active} active runs · ${snapshot.queued} queued · last 60s`;
    $("spend-value").textContent = unpriced && !spend ? "—" : `${unpriced ? "≥ " : ""}${spend.toFixed(3)}`;
    $("spend-detail").textContent = unpriced
      ? `${unpriced} unpriced calls in last 60s · known 5m $${sum(buckets, "spend").toFixed(3)}`
      : `$${sum(buckets, "spend").toFixed(3)} in last 5m · ~$${(spend * 60).toFixed(2)}/hr at this pace`;
    // Each historical point is a trailing minute, not an inflated ten-second burst.
    const rates = (key) => buckets.map((_, i) => sum(buckets.slice(Math.max(0, i - 5), i + 1), key));
    telemetryChart("burn-chart", rates("input"), rates("output"));
    telemetryChart("velocity-chart", rates("completed"));
    telemetryChart("spend-chart", rates("spend"));
  }
  function acceptTelemetry(rawSnapshot) {
    const snapshot = scopedTelemetry(rawSnapshot);
    if (
      !Array.isArray(snapshot.buckets) ||
      snapshot.buckets.length !== 30 ||
      snapshot.buckets.some((b) =>
        ["time", "input", "output", "completed", "spend", "unpriced", "unknown_tokens"].some(
          (key) => !Number.isFinite(b[key]),
        ),
      )
    )
      throw new Error("Invalid telemetry snapshot");
    telemetryLastSuccess = Date.now();
    telemetryRaw = rawSnapshot;
    const sumAll = (key) => rawSnapshot.buckets.reduce((s, b) => s + b[key], 0);
    $("tokens").textContent = Math.round(sumAll("input") + sumAll("output")).toLocaleString();
    $("cost").textContent = `USD ${sumAll("spend").toFixed(3)}`;
    $("unpriced").textContent = sumAll("unpriced");
    $("active").textContent = rawSnapshot.active;
    $("tokens").title = "Tokens recorded in the last five minutes";
    $("cost").title = "Known model cost in the last five minutes";
    updateTelemetryOptions(rawSnapshot);
    updateFreshness();
    const prior = telemetryCurrent;
    telemetryCurrent = snapshot;
    document.querySelectorAll(".telemetry-card").forEach((card) => {
      card.dataset.stale = "false";
      card.querySelector("[data-status]").textContent = state.fixtureMode ? "Demo · synthetic" : "Live · 5s";
    });
    const animate = !telemetryMotion.matches && !state.lowPower && !document.hidden;
    if (animate && prior) {
      const old = new Map(prior.buckets.map((b) => [b.time, b]));
      const completions = snapshot.buckets.reduce(
        (total, b) => total + Math.max(0, b.completed - (old.get(b.time)?.completed || 0)),
        0,
      );
      document.querySelectorAll(".velocity-lane").forEach((lane, i) => {
        if (i >= completions) return;
        const packet = node("span", "", "velocity-packet");
        packet.style.animationDelay = `${i * 0.15}s`;
        packet.addEventListener("animationend", () => packet.remove(), { once: true });
        lane.replaceChildren(packet);
      });
    }
    cancelAnimationFrame(telemetryFrame);
    if (!animate || !prior) return paintTelemetry(snapshot);
    const start = performance.now();
    const draw = (time) => {
      const progress = Math.min(1, (time - start) / 650);
      const ease = 1 - (1 - progress) ** 3;
      const buckets = snapshot.buckets.map((b, i) =>
        Object.fromEntries(
          Object.entries(b).map(([key, value]) => [
            key,
            ["input", "output", "completed", "spend"].includes(key)
              ? prior.buckets[i][key] + (value - prior.buckets[i][key]) * ease
              : value,
          ]),
        ),
      );
      paintTelemetry({ ...snapshot, buckets });
      if (progress < 1) telemetryFrame = requestAnimationFrame(draw);
    };
    telemetryFrame = requestAnimationFrame(draw);
  }
  async function refreshTelemetry() {
    if (document.hidden) return;
    try {
      if (state.fixtureMode) {
        if (state.fixtureMode === "demo") acceptTelemetry(demoTelemetry());
        return;
      }
      const response = await fetch("/api/v1/telemetry", {
        headers: auth(),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error("Telemetry unavailable");
      acceptTelemetry(await response.json());
    } catch {
      document.querySelectorAll(".telemetry-card").forEach((card) => {
        card.dataset.stale = "true";
        card.querySelector("[data-status]").textContent = telemetryLastSuccess
          ? `Stale · ${Math.round((Date.now() - telemetryLastSuccess) / 1000)}s`
          : "Unavailable";
      });
    }
  }
  telemetryMotion.addEventListener("change", () => {
    cancelAnimationFrame(telemetryFrame);
    if (telemetryCurrent) paintTelemetry(telemetryCurrent);
  });
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(telemetryFrame);
    if (!document.hidden) void refreshTelemetry();
  });
  $("power").addEventListener("click", () => {
    cancelAnimationFrame(telemetryFrame);
    if (telemetryCurrent) paintTelemetry(telemetryCurrent);
  });
  void refreshTelemetry();
  setInterval(() => void refreshTelemetry(), 5000);

  return {
    get lastSuccess() {
      return telemetryLastSuccess;
    },
    refresh: refreshTelemetry,
  };
}
