import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { startDashboardPreview } from "./dashboard-preview.mjs";

const server = await startDashboardPreview();
const address = server.address();
if (!address || typeof address === "string") throw new Error("dashboard server did not bind");
const executable =
  process.env.ODA_CHROMIUM_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const started = Date.now();
const browser = await puppeteer.launch({
  executablePath: executable,
  headless: true,
  args: ["--no-first-run", "--disable-background-networking"],
});
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(`http://127.0.0.1:${address.port}/?fixture=performance&diagnostic=1`, {
    waitUntil: "networkidle0",
  });
  await page.waitForFunction(() => window.__ODA_PHASE4_METRICS__?.bounded === true);
  const metrics = await page.evaluate(() => window.__ODA_PHASE4_METRICS__);
  const accessibility = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll("button")].every((button) => button.textContent.trim().length > 0),
    stepList: document.querySelector("#graph")?.getAttribute("aria-label"),
    terminal: document.querySelector("#terminal")?.getAttribute("role"),
    focusableNodes: [...document.querySelectorAll("#graph .node")].filter((node) => node.tabIndex === 0)
      .length,
  }));
  if (
    metrics.nodes !== 100 ||
    metrics.terminalBuffered !== 10000 ||
    metrics.terminalDomLines > 60 ||
    !metrics.reducedMotion ||
    accessibility.focusableNodes !== 0
  )
    throw new Error(`dashboard acceptance failed: ${JSON.stringify({ metrics, accessibility })}`);
  const uxPage = await browser.newPage();
  await uxPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await uxPage.goto(`http://127.0.0.1:${address.port}/?fixture=demo`, { waitUntil: "networkidle0" });
  const decisionDiscovery = await uxPage.evaluate(() => {
    const actions = document.querySelector("#decision .decision-actions")?.getBoundingClientRect();
    return {
      visible: Boolean(actions && actions.top >= 0 && actions.bottom <= globalThis.innerHeight),
      top: actions?.top,
      bottom: actions?.bottom,
      viewportHeight: globalThis.innerHeight,
    };
  });
  if (!decisionDiscovery.visible)
    throw new Error(`decision discovery failed: ${JSON.stringify(decisionDiscovery)}`);

  await uxPage.click('[data-work-view="tasks"]');
  await uxPage.select("#work-eligibility", "overridden");
  await uxPage.click('[data-work-view="attention"]');
  const filteredAttention = await uxPage.evaluate(() => ({
    cards: document.querySelectorAll("#runs .task-card").length,
    empty: document.querySelector("#run-empty")?.hidden,
    eligibilityHidden: document.querySelector("#work-eligibility")?.closest("label")?.hidden,
  }));
  if (filteredAttention.cards !== 2 || !filteredAttention.empty || !filteredAttention.eligibilityHidden)
    throw new Error(`filtered attention failed: ${JSON.stringify(filteredAttention)}`);

  await uxPage.click('[data-work-view="runs"]');
  await uxPage.type("#filter", "Confirm rollout");
  const executionSearch = await uxPage.evaluate(() => ({
    cards: document.querySelectorAll("#runs .run").length,
    text: document.querySelector("#runs .run")?.textContent,
  }));
  if (executionSearch.cards !== 1 || !executionSearch.text?.includes("OPS-87"))
    throw new Error(`execution search failed: ${JSON.stringify(executionSearch)}`);

  await uxPage.click('[data-work-view="tasks"]');
  await uxPage.select("#work-eligibility", "all");
  await uxPage.$eval("#filter", (input) => {
    input.value = "   ";
    input.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  });
  if ((await uxPage.$$("#runs .task-card")).length !== 6)
    throw new Error("whitespace-only search did not behave like an empty search");
  await uxPage.select("#work-eligibility", "deferred");
  const filteredCount = await uxPage.evaluate(() => ({
    cards: document.querySelectorAll("#runs .task-card").length,
    count: document.querySelector("#work-count")?.textContent,
  }));
  if (filteredCount.cards !== 1 || filteredCount.count !== "1 of 6 tasks")
    throw new Error(`filtered count failed: ${JSON.stringify(filteredCount)}`);

  await uxPage.select("#work-eligibility", "all");
  await uxPage.evaluate(() => {
    document.querySelectorAll("#runs .task-card").forEach((card) => {
      if (card.textContent.includes("DOC-31")) card.click();
    });
  });
  await uxPage.type('[aria-label="Work horizon override reason"]', "Browser verification");
  await uxPage.evaluate(() => {
    [...document.querySelectorAll("#summary button")]
      .find((button) => button.textContent === "Allow work now")
      ?.click();
  });
  await uxPage.waitForFunction(() =>
    document.querySelector("#summary")?.textContent.includes("Manual override"),
  );
  await uxPage.evaluate(() => {
    document.querySelectorAll("#runs .task-card").forEach((card) => {
      if (card.textContent.includes("OPS-87")) card.click();
    });
  });
  await uxPage.click(".decision-action.approve");
  await uxPage.waitForSelector(".decision-handoff:not(.changes)");
  await uxPage.reload({ waitUntil: "networkidle0" });
  const persistedDecision = await uxPage.evaluate(() => ({
    state: document.querySelector("#summary .progress-block strong")?.textContent,
    handoff: document.querySelector("#decision h2")?.textContent,
  }));
  if (!persistedDecision.state?.includes("Implementing") || persistedDecision.handoff !== "Plan approved")
    throw new Error(`demo decision persistence failed: ${JSON.stringify(persistedDecision)}`);

  await Promise.all([uxPage.waitForNavigation({ waitUntil: "networkidle0" }), uxPage.click("#demo-reset")]);
  const resetState = await uxPage.evaluate(() => ({
    selectedView: document.querySelector('.work-tab[aria-selected="true"]')?.dataset.workView,
    eligibility: document.querySelector("#work-eligibility")?.value,
    decision: document.querySelector("#decision h2")?.textContent,
  }));
  await uxPage.click('[data-work-view="tasks"]');
  await uxPage.evaluate(() => {
    document.querySelectorAll("#runs .task-card").forEach((card) => {
      if (card.textContent.includes("DOC-31")) card.click();
    });
  });
  resetState.overrideCleared = await uxPage.$eval("#summary", (summary) =>
    summary.textContent.includes("no planned date"),
  );
  if (
    resetState.selectedView !== "attention" ||
    resetState.eligibility !== "all" ||
    resetState.decision !== "Plan ready for your review" ||
    !resetState.overrideCleared
  )
    throw new Error(`demo reset failed: ${JSON.stringify(resetState)}`);
  await uxPage.click('[data-work-view="attention"]');

  await uxPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const mobileLayout = await uxPage.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    dock: globalThis.getComputedStyle(document.querySelector(".mobile-dock")).display,
  }));
  if (mobileLayout.overflow || mobileLayout.dock !== "grid")
    throw new Error(`mobile layout failed: ${JSON.stringify(mobileLayout)}`);
  await uxPage.close();

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}/?fixture=demo`, { waitUntil: "networkidle0" });
  const attentionQueue = await page.evaluate(() => ({
    selectedView: document.querySelector('.work-tab[aria-selected="true"]')?.dataset.workView,
    count: document.querySelector("#attention-count")?.textContent,
    tasks: [...document.querySelectorAll("#runs .task-card")].map((card) => card.textContent),
  }));
  if (
    attentionQueue.selectedView !== "attention" ||
    attentionQueue.count !== "2" ||
    attentionQueue.tasks.length !== 2 ||
    !attentionQueue.tasks.some((text) => text.includes("OPS-87")) ||
    !attentionQueue.tasks.some((text) => text.includes("WEB-204"))
  )
    throw new Error(`attention queue failed: ${JSON.stringify(attentionQueue)}`);
  await page.click(".alternative-item");
  const alternativeSelection = await page.evaluate(() => ({
    selected: document.querySelector(".alternative-item")?.getAttribute("aria-pressed"),
    action: document.querySelector(".decision-action.approve strong")?.textContent,
    consequence: document.querySelector(".decision-action.approve small")?.textContent,
  }));
  if (
    alternativeSelection.selected !== "true" ||
    alternativeSelection.action !== "Use selected alternative" ||
    !alternativeSelection.consequence?.includes("sealed revision")
  )
    throw new Error(`alternative selection failed: ${JSON.stringify(alternativeSelection)}`);
  await page.click(".decision-action.reject");
  const feedbackEditor = await page.evaluate(() => ({
    visible: !document.querySelector(".feedback-editor")?.hidden,
    mainActionsHidden: document.querySelector(".decision-actions")?.hidden,
    submitDisabled: document.querySelector(".feedback-submit")?.disabled,
  }));
  if (!feedbackEditor.visible || !feedbackEditor.mainActionsHidden || !feedbackEditor.submitDisabled)
    throw new Error(`feedback editor failed: ${JSON.stringify(feedbackEditor)}`);
  const validationDirectory = join(process.cwd(), ".validation");
  await mkdir(validationDirectory, { recursive: true });
  const feedbackScreenshot = join(validationDirectory, "phase4-feedback-editor-demo.png");
  await page.evaluate(() => {
    document.querySelector(".workspace")?.setAttribute("style", "overflow: visible; height: auto");
    document.querySelector(".shell")?.setAttribute("style", "height: auto");
  });
  const feedbackElement = await page.$(".feedback-editor");
  if (!feedbackElement) throw new Error("feedback editor was not available for screenshot");
  await feedbackElement.screenshot({ path: feedbackScreenshot });
  await page.type(".feedback-editor textarea", "Defer notifications until the rollout schedule is revised.");
  await page.click(".feedback-submit");
  await page.waitForSelector(".decision-handoff.changes");
  const decisionHandoff = await page.evaluate(() => ({
    title: document.querySelector(".decision-handoff h2")?.textContent,
    destination: document.querySelector(".handoff-destination")?.textContent,
    provenance: document.querySelector(".handoff-copy p")?.textContent,
    attentionCount: document.querySelector("#attention-count")?.textContent,
  }));
  if (
    decisionHandoff.title !== "Changes requested" ||
    decisionHandoff.destination !== "Returned to Planning" ||
    !decisionHandoff.provenance?.includes("preserved as provenance") ||
    decisionHandoff.attentionCount !== "1"
  )
    throw new Error(`decision handoff failed: ${JSON.stringify(decisionHandoff)}`);
  const handoffScreenshot = join(validationDirectory, "phase4-decision-handoff-demo.png");
  const handoffElement = await page.$(".decision-handoff");
  if (!handoffElement) throw new Error("decision handoff was not available for screenshot");
  await handoffElement.screenshot({ path: handoffScreenshot });
  await page.goto(`http://127.0.0.1:${address.port}/?fixture=demo`, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    [...document.querySelectorAll(".task-card")]
      .find((button) => button.textContent.includes("WEB-204"))
      ?.click();
  });
  await page.waitForSelector(".recovery-card");
  const failedRecovery = await page.evaluate(() => ({
    recoveryHeading: document.querySelector(".recovery-card h2")?.textContent,
    selectedTab: document.querySelector('.tab[aria-selected="true"]')?.dataset.tab,
    evidenceHeading: document.querySelector(".failure-summary h3")?.textContent,
    retryEnabled: !document.querySelector(".recovery-actions .approve")?.disabled,
    implementationEnabled: !document.querySelector(".recovery-actions .reject")?.disabled,
  }));
  if (
    failedRecovery.recoveryHeading !== "Checkout callback integration" ||
    failedRecovery.selectedTab !== "tests" ||
    failedRecovery.evidenceHeading !== "Checkout callback integration" ||
    !failedRecovery.retryEnabled ||
    !failedRecovery.implementationEnabled
  )
    throw new Error(`failed recovery failed: ${JSON.stringify(failedRecovery)}`);
  const recoveryScreenshot = join(validationDirectory, "phase4-recovery-demo.png");
  await page.screenshot({ path: recoveryScreenshot, fullPage: true });
  await page.click(".recovery-actions .approve");
  const retryRecovery = await page.evaluate(() => ({
    state: document.querySelector("#summary .progress-block strong")?.textContent,
    preserved: document.querySelector(".failure-summary .eyebrow")?.textContent,
    recovery: document.querySelector(".recovery-status")?.textContent,
  }));
  if (
    !retryRecovery.state?.includes("Testing") ||
    retryRecovery.preserved !== "PRESERVED FAILURE EVIDENCE" ||
    !retryRecovery.recovery?.includes("Retrying failed test")
  )
    throw new Error(`retry recovery failed: ${JSON.stringify(retryRecovery)}`);
  console.log(
    JSON.stringify(
      {
        browser: await browser.version(),
        referenceMachine: { platform: process.platform, arch: process.arch, node: process.version },
        durationMs: Date.now() - started,
        workload: {
          eventsPerSecond: 100,
          totalEvents: metrics.eventsApplied,
          terminalLines: metrics.terminalBuffered,
          graphNodes: metrics.nodes,
        },
        memoryBound: { terminalDomLines: metrics.terminalDomLines, terminalBuffer: metrics.terminalBuffered },
        reducedMotion: metrics.reducedMotion,
        accessibility,
        interactionChecks: {
          attentionQueue,
          alternativeSelection,
          feedbackEditor,
          decisionHandoff,
          failedRecovery,
          retryRecovery,
        },
        screenshots: { feedbackScreenshot, handoffScreenshot, recoveryScreenshot },
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
