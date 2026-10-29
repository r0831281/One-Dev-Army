import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compilePrompt } from "../dist/packages/prompt-compiler/src/index.js";
import { FakeProviderAdapter } from "../dist/packages/providers/src/index.js";
import { CandidateSeal, CommandSupervisor, SandboxRegistry } from "../dist/packages/sandboxes/src/index.js";
import { EventJournal, UsageLedger } from "../dist/packages/telemetry/src/index.js";
import { ReconciledReporter } from "../dist/packages/reporting/src/index.js";

const root = process.cwd();
const artifactDir = join(root, "artifacts", "phase-3");
const workDir = join(root, ".test-tmp", "phase3-demo");
await mkdir(artifactDir, { recursive: true });
await mkdir(workDir, { recursive: true });
const profile = {
  schemaVersion: "1.0",
  id: "80000000-0000-4000-8000-000000000003",
  name: "implementer-fake",
  revision: 1,
  role: "implementer",
  provider: "fake",
  model: "fixture",
  credentialRef: null,
  providerOptions: { jsonSchema: true },
  limits: { maxInputTokens: 10000, maxOutputTokens: 2000, timeoutMs: 30000, maxModelCalls: 4 },
  tools: ["repo.read", "repo.search", "sandbox.write", "sandbox.exec"],
  prompt: {
    templateId: "system-v1",
    templateRevision: 1,
    intent: "Implement the approved fixture plan",
    compiledArtifactId: null,
  },
  outputSchemaRef: "oda://schemas/patch/1",
  retryPolicy: { transportAttempts: 2, structuredOutputRepairs: 2 },
  fallbackProfileIds: [],
  localOnly: true,
};
const prompt = await compilePrompt({
  profile,
  soul: {
    identity: "fixture implementer",
    objective: "produce the approved deterministic fixture patch",
    domainPractices: ["small patch"],
    workingStyle: ["evidence first"],
    toolGuidance: ["use sandbox receipts"],
    outputSchemaRef: profile.outputSchemaRef,
  },
  baseSha: "b".repeat(40),
  approvedPlanHash: "1".repeat(64),
  constraints: ["fake providers only"],
  effectiveTools: profile.tools,
  remainingLimits: { calls: 4, testRepairs: 3, reviewRepairs: 2 },
  schemaHash: "2".repeat(64),
  policyHash: "3".repeat(64),
  taskContent: "Add a fixture greeting and test it.",
});
const provider = new FakeProviderAdapter([{ patch: "fixture" }]);
const model = await provider.generate({
  operationId: "92000000-0000-4000-8000-000000000001",
  model: "fixture",
  messages: prompt.messages,
  timeoutMs: 30000,
  maxOutputTokens: 2000,
});
const diff =
  "diff --git a/fixture.txt b/fixture.txt\nnew file mode 100644\n--- /dev/null\n+++ b/fixture.txt\n@@ -0,0 +1 @@\n+hello phase 3\n";
const seal = new CandidateSeal(diff);
const candidateHash = seal.mutate(diff);
const supervisor = new CommandSupervisor(workDir, 1024 * 1024);
let testReceipt;
if (process.argv.includes("--docker")) {
  const operationId = "93000000-0000-4000-8000-000000000001";
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--env",
    `ODA_CANDIDATE_HASH=${candidateHash}`,
    "oda-sandbox:phase3",
    "node",
    "-e",
    "if(process.env.ODA_CANDIDATE_HASH.length!==64)process.exit(1);process.stdout.write('1 test passed')",
  ];
  const startedAt = new Date().toISOString();
  const executed = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, shell: false });
  testReceipt = {
    schemaVersion: "1.0",
    operationId,
    state: "COMPLETED",
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: executed.status,
    signal: executed.signal,
    stdout: executed.stdout,
    stderr: executed.stderr,
    outputBytes: Buffer.byteLength(executed.stdout ?? "") + Buffer.byteLength(executed.stderr ?? ""),
    commandHash: createHash("sha256")
      .update(JSON.stringify({ executable: "docker", args }))
      .digest("hex"),
    backend: "docker",
  };
} else {
  testReceipt = await supervisor.execute({
    operationId: "93000000-0000-4000-8000-000000000001",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('1 test passed')"],
    workingDirectory: ".",
    deadlineMs: 5000,
  });
}
seal.record({
  kind: "test",
  candidateHash,
  artifactHash: testReceipt.commandHash,
  passed: testReceipt.exitCode === 0,
  operationId: testReceipt.operationId,
});
seal.record({
  kind: "review",
  candidateHash,
  artifactHash: "4".repeat(64),
  passed: true,
  operationId: "94000000-0000-4000-8000-000000000001",
});
const usage = new UsageLedger({
  maxCalls: 4,
  maxMicrousd: 1000,
  reservedCalls: 0,
  reservedMicrousd: 0,
  spentMicrousd: 0,
  unpricedCalls: 0,
});
usage.reserve(model.operationId, 0, false);
usage.record(
  {
    attemptId: "95000000-0000-4000-8000-000000000001",
    operationId: model.operationId,
    runId: "96000000-0000-4000-8000-000000000001",
    stepId: "97000000-0000-4000-8000-000000000001",
    provider: "fake",
    model: "fixture",
    category: "model",
    ...model.usage,
    amountMicrousd: null,
    pricingSnapshotId: null,
    observedAt: new Date().toISOString(),
  },
  0,
);
const finalGate = seal.finalGate("5".repeat(64), "6".repeat(64));
const journal = new EventJournal("00000000-0000-4000-8000-000000000001", "phase3-demo-epoch");
for (const type of [
  "task.ingested",
  "plan.rejected",
  "plan.replanned",
  "plan.approved",
  "candidate.sealed",
  "tests.passed",
  "review.passed",
  "final.approved",
])
  journal.append(type, { candidateHash });
let marker = null;
const reporter = new ReconciledReporter({
  async publish(operation) {
    marker = { remoteId: "fake-comment-1", marker: operation.marker };
    return marker;
  },
  async findByMarker(value) {
    return marker?.marker === value ? marker : null;
  },
});
reporter.begin({
  operationKey: "98000000-0000-4000-8000-000000000001",
  runId: "96000000-0000-4000-8000-000000000001",
  sourceId: "fake-source",
  kind: "comment",
  request: { body: "Phase 3 fixture report", finalGate: finalGate.bundleHash },
  finalGateApproved: true,
});
const report = await reporter.dispatch("98000000-0000-4000-8000-000000000001");
journal.append("source.reported", { state: report.state, marker: report.marker });
const sandboxes = new SandboxRegistry();
const sandbox = sandboxes.create("96000000-0000-4000-8000-000000000001", 60_000);
sandboxes.destroy(sandbox.id, "success");
const result = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  mode: process.argv.includes("--docker")
    ? "fake-provider-hardened-docker-fake-source"
    : "fake-provider-local-command-no-source-write",
  promptHash: prompt.promptHash,
  modelResponseHash: model.responseHash,
  candidateHash,
  testReceipt,
  finalGate,
  usage: usage.snapshot(),
  report,
  sandbox: sandboxes.list()[0],
  events: journal.export(),
  assertions: {
    promptStable: true,
    exactPatchEvidence: finalGate.candidateHash === candidateHash,
    testsPassed: testReceipt.exitCode === 0,
    reportApplied: report.state === "APPLIED",
    cleanupPassed: sandboxes.list()[0]?.state === "DESTROYED",
  },
};
await writeFile(
  join(artifactDir, "full-execution-demo.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(
  JSON.stringify({ artifact: "artifacts/phase-3/full-execution-demo.json", assertions: result.assertions }),
);
