import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SandboxPolicy {
  image: string;
  cpus: number;
  memoryBytes: number;
  pids: number;
  scratchBytes: number;
  commandTimeoutMs: number;
  lifetimeMs: number;
  maxOutputBytes: number;
  network: "none";
}
export const defaultSandboxPolicy: SandboxPolicy = {
  image: "oda-sandbox@sha256:unpublished-local-image",
  cpus: 2,
  memoryBytes: 2 * 1024 ** 3,
  pids: 256,
  scratchBytes: 4 * 1024 ** 3,
  commandTimeoutMs: 10 * 60_000,
  lifetimeMs: 30 * 60_000,
  maxOutputBytes: 10 * 1024 ** 2,
  network: "none",
};

export interface CapabilityReport {
  backend: "docker" | "e2b";
  nonRoot: boolean;
  readOnlyRoot: boolean;
  dropCapabilities: boolean;
  noNewPrivileges: boolean;
  networkIsolation: boolean;
  processLimit: boolean;
  memoryLimit: boolean;
  cpuLimit: boolean;
  diskLimit: boolean;
  timeout: boolean;
  opaqueArtifacts: boolean;
}

export function requireCapabilities(report: CapabilityReport): void {
  for (const [key, supported] of Object.entries(report)) {
    if (key !== "backend" && supported !== true) throw new Error(`UNSUPPORTED_CAPABILITY:${key}`);
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveSandboxPath(
  root: string,
  requested: string,
  allowMissingLeaf = false,
): Promise<string> {
  if (!requested || requested.includes("\0") || isAbsolute(requested)) throw new Error("SANDBOX_PATH_DENIED");
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, requested);
  if (!within(rootResolved, target) || target.includes(`${sep}.git${sep}`) || target.endsWith(`${sep}.git`))
    throw new Error("SANDBOX_PATH_DENIED");
  const relativeParts = relative(rootResolved, target).split(sep).filter(Boolean);
  let cursor = rootResolved;
  for (let index = 0; index < relativeParts.length; index += 1) {
    cursor = resolve(cursor, relativeParts[index]!);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("SANDBOX_SYMLINK_ESCAPE");
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === relativeParts.length - 1 &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return target;
      throw error;
    }
  }
  return target;
}

export function validateExecutable(executable: string, args: readonly string[]): void {
  if (!executable || executable.includes("\0") || /^(sudo|su|doas|docker|podman|nerdctl)$/i.test(executable))
    throw new Error("SANDBOX_COMMAND_DENIED");
  if (
    args.some(
      (arg) => arg.includes("\0") || /docker\.sock|169\.254\.169\.254|metadata\.google\.internal/i.test(arg),
    )
  )
    throw new Error("SANDBOX_ARGUMENT_DENIED");
}

export interface CommandRequest {
  operationId: string;
  executable: string;
  args: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  deadlineMs: number;
}
export interface CommandReceipt {
  schemaVersion: "1.0";
  operationId: string;
  state: "RUNNING" | "COMPLETED" | "CANCELLED" | "TIMED_OUT" | "OUTPUT_LIMIT";
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputBytes: number;
  commandHash: string;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CommandSupervisor {
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly active = new Map<string, ReturnType<typeof spawn>>();
  constructor(
    private readonly workspaceRoot: string,
    private readonly maxOutputBytes = defaultSandboxPolicy.maxOutputBytes,
  ) {}
  get(operationId: string): CommandReceipt | null {
    return structuredClone(this.receipts.get(operationId) ?? null);
  }
  async execute(request: CommandRequest, signal?: AbortSignal): Promise<CommandReceipt> {
    const commandHash = hash({
      executable: request.executable,
      args: request.args,
      workingDirectory: request.workingDirectory,
      environment: request.environment ?? {},
    });
    const previous = this.receipts.get(request.operationId);
    if (previous) {
      if (previous.commandHash !== commandHash) throw new Error("OPERATION_ID_CONFLICT");
      if (previous.state === "RUNNING") return this.waitFor(request.operationId, request.deadlineMs);
      return structuredClone(previous);
    }
    validateExecutable(request.executable, request.args);
    const startedAt = new Date().toISOString();
    const receipt: CommandReceipt = {
      schemaVersion: "1.0",
      operationId: request.operationId,
      state: "RUNNING",
      startedAt,
      completedAt: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      outputBytes: 0,
      commandHash,
    };
    this.receipts.set(request.operationId, receipt);
    let cwd: string;
    try {
      cwd = await resolveSandboxPath(this.workspaceRoot, request.workingDirectory);
    } catch (error) {
      this.receipts.delete(request.operationId);
      throw error;
    }
    const child = spawn(request.executable, request.args, {
      cwd,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", ...(request.environment ?? {}) },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.active.set(request.operationId, child);
    let forcedState: CommandReceipt["state"] | null = null;
    const append = (key: "stdout" | "stderr", chunk: Buffer): void => {
      if (forcedState === "OUTPUT_LIMIT") return;
      receipt.outputBytes += chunk.byteLength;
      if (receipt.outputBytes > this.maxOutputBytes) {
        forcedState = "OUTPUT_LIMIT";
        this.terminate(child);
        return;
      }
      receipt[key] += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const timeout = setTimeout(
      () => {
        forcedState = "TIMED_OUT";
        this.terminate(child);
      },
      Math.max(1, request.deadlineMs),
    );
    const abort = () => {
      forcedState = "CANCELLED";
      this.terminate(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    return new Promise((resolvePromise, reject) => {
      child.once("error", (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.active.delete(request.operationId);
        this.receipts.delete(request.operationId);
        reject(error);
      });
      child.once("close", (code, childSignal) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.active.delete(request.operationId);
        receipt.state = forcedState ?? "COMPLETED";
        receipt.completedAt = new Date().toISOString();
        receipt.exitCode = code;
        receipt.signal = childSignal;
        resolvePromise(structuredClone(receipt));
      });
    });
  }
  async cancel(operationId: string): Promise<CommandReceipt | null> {
    const child = this.active.get(operationId);
    if (child) this.terminate(child);
    return this.get(operationId);
  }
  private async waitFor(operationId: string, deadlineMs: number): Promise<CommandReceipt> {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      const receipt = this.receipts.get(operationId);
      if (receipt && receipt.state !== "RUNNING") return structuredClone(receipt);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error("COMMAND_RECONCILIATION_TIMEOUT");
  }
  private terminate(child: ReturnType<typeof spawn>): void {
    if (process.platform === "win32") child.kill("SIGTERM");
    else if (child.pid) process.kill(-child.pid, "SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000).unref();
  }
}

export interface EvidenceReceipt {
  kind: "test" | "review" | "static";
  candidateHash: string;
  artifactHash: string;
  passed: boolean;
  operationId: string;
}
export interface FinalGateBundle {
  candidateHash: string;
  testReceipts: EvidenceReceipt[];
  reviewReceipts: EvidenceReceipt[];
  usageArtifactHash: string;
  manifestHash: string;
  bundleHash: string;
}
export class CandidateSeal {
  private generation = 0;
  private candidateHash: string;
  private evidence: EvidenceReceipt[] = [];
  constructor(diff: string) {
    this.candidateHash = hashCanonicalDiff(diff);
  }
  mutate(diff: string): string {
    this.generation += 1;
    this.candidateHash = hashCanonicalDiff(diff);
    this.evidence = [];
    return this.candidateHash;
  }
  record(receipt: EvidenceReceipt): void {
    if (receipt.candidateHash !== this.candidateHash) throw new Error("STALE_CANDIDATE_EVIDENCE");
    if (this.evidence.some((item) => item.operationId === receipt.operationId))
      throw new Error("DUPLICATE_EVIDENCE_OPERATION");
    this.evidence.push(structuredClone(receipt));
  }
  finalGate(usageArtifactHash: string, manifestHash: string): FinalGateBundle {
    const tests = this.evidence.filter((item) => item.kind === "test" || item.kind === "static");
    const reviews = this.evidence.filter((item) => item.kind === "review");
    if (tests.length === 0 || reviews.length === 0 || [...tests, ...reviews].some((item) => !item.passed))
      throw new Error("FINAL_GATE_EVIDENCE_INCOMPLETE");
    const unsigned = {
      candidateHash: this.candidateHash,
      testReceipts: tests,
      reviewReceipts: reviews,
      usageArtifactHash,
      manifestHash,
    };
    return { ...unsigned, bundleHash: hash(unsigned) };
  }
  get revision(): number {
    return this.generation;
  }
}

export function hashCanonicalDiff(diff: string): string {
  const normalized = diff.replace(/\r\n?/g, "\n").normalize("NFC");
  if (Buffer.byteLength(normalized) > 5 * 1024 ** 2) throw new Error("PATCH_TOO_LARGE");
  const paths = [...normalized.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!);
  if (new Set(paths).size > 200) throw new Error("PATCH_FILE_LIMIT");
  for (const path of paths) {
    if (
      isAbsolute(path) ||
      path.split(/[\\/]/u).includes("..") ||
      path === ".git" ||
      path.startsWith(".git/")
    )
      throw new Error("PATCH_PATH_DENIED");
  }
  if (/^GIT binary patch$/m.test(normalized)) throw new Error("BINARY_PATCH_UNSUPPORTED");
  return createHash("sha256").update(normalized).digest("hex");
}

export function dockerCreateArguments(
  policy: SandboxPolicy,
  volumeName: string,
  name = `oda-${randomUUID()}`,
): string[] {
  if (!/^oda-[a-zA-Z0-9_.-]+$/.test(volumeName) || !policy.image.includes("@sha256:"))
    throw new Error("INVALID_DOCKER_TEMPLATE");
  return [
    "create",
    "--name",
    name,
    "--label",
    "dev.oda.managed=true",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    String(policy.cpus),
    "--memory",
    String(policy.memoryBytes),
    "--pids-limit",
    String(policy.pids),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=67108864",
    "--mount",
    `type=volume,src=${volumeName},dst=/workspace`,
    "--user",
    "10001:10001",
    "--workdir",
    "/workspace",
    policy.image,
  ];
}

export function authorizeE2B(environment: NodeJS.ProcessEnv, report: CapabilityReport): void {
  if (environment.ODA_E2B_REMOTE_DATA_CONSENT !== "I_CONSENT")
    throw new Error("REMOTE_DATA_CONSENT_REQUIRED");
  if (report.backend !== "e2b") throw new Error("E2B_CAPABILITY_REPORT_REQUIRED");
  requireCapabilities(report);
}

export interface RunnerDiscovery {
  command: string;
  args: string[];
  kind: "pnpm" | "npm" | "yarn" | "pytest" | "configured";
}
export async function discoverRunner(
  root: string,
  configured?: { command: string; args: string[] },
): Promise<RunnerDiscovery> {
  if (configured) {
    validateExecutable(configured.command, configured.args);
    return { ...structuredClone(configured), kind: "configured" };
  }
  const candidates: RunnerDiscovery[] = [];
  const exists = async (path: string): Promise<boolean> =>
    access(resolve(root, path)).then(
      () => true,
      () => false,
    );
  if (await exists("pnpm-lock.yaml")) candidates.push({ command: "pnpm", args: ["test"], kind: "pnpm" });
  if (await exists("package-lock.json")) candidates.push({ command: "npm", args: ["test"], kind: "npm" });
  if (await exists("yarn.lock")) candidates.push({ command: "yarn", args: ["test"], kind: "yarn" });
  if ((await exists("pyproject.toml")) || (await exists("pytest.ini")))
    candidates.push({ command: "python", args: ["-m", "pytest"], kind: "pytest" });
  if (candidates.length === 0) throw new Error("NO_TEST_RUNNER");
  if (candidates.length > 1) throw new Error("AMBIGUOUS_TEST_RUNNER");
  return candidates[0]!;
}

export interface SandboxRecord {
  id: string;
  runId: string;
  state: "READY" | "DESTROYED" | "LEAKED";
  expiresAt: number;
  destroyedReason: "success" | "cancellation" | "expiry" | null;
}
export class SandboxRegistry {
  private readonly records = new Map<string, SandboxRecord>();
  create(runId: string, lifetimeMs: number, now = Date.now()): SandboxRecord {
    const record: SandboxRecord = {
      id: randomUUID(),
      runId,
      state: "READY",
      expiresAt: now + lifetimeMs,
      destroyedReason: null,
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  destroy(id: string, reason: NonNullable<SandboxRecord["destroyedReason"]>): SandboxRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("SANDBOX_NOT_FOUND");
    if (record.state === "DESTROYED") return structuredClone(record);
    record.state = "DESTROYED";
    record.destroyedReason = reason;
    return structuredClone(record);
  }
  reapExpired(now = Date.now()): SandboxRecord[] {
    return [...this.records.values()]
      .filter((record) => record.state === "READY" && record.expiresAt <= now)
      .map((record) => this.destroy(record.id, "expiry"));
  }
  leakCount(): number {
    return [...this.records.values()].filter((record) => record.state === "LEAKED").length;
  }
  list(): SandboxRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

export * from "./repo-read.js";
export * from "./db-read.js";
