import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { URL } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { RpcPeer, type RpcHandshake } from "../../plugin-sdk/src/index.js";

export interface ContainerSpec {
  image: string;
  readOnly?: boolean;
  memoryMb?: number;
  cpus?: number;
  pids?: number;
}
export function dockerPluginArgs(spec: ContainerSpec): string[] {
  if (!/@sha256:[a-f0-9]{64}$/.test(spec.image) && !/^sha256:[a-f0-9]{64}$/.test(spec.image))
    throw new Error("PLUGIN_IMAGE_MUST_BE_DIGEST_PINNED");
  return [
    "run",
    "--rm",
    "--interactive",
    "--network=none",
    "--read-only",
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory=${spec.memoryMb ?? 256}m`,
    `--cpus=${spec.cpus ?? 0.5}`,
    `--pids-limit=${spec.pids ?? 64}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    spec.image,
  ];
}

export interface HostOptions {
  command: string;
  args: string[];
  expectedPluginId: string;
  maxConcurrency?: number;
  maxRestarts?: number;
  failureThreshold?: number;
  resetMs?: number;
}
export class PluginHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private peer: RpcPeer | null = null;
  private active = 0;
  private restarts = 0;
  private failures = 0;
  private openedAt = 0;
  constructor(private readonly options: HostOptions) {}
  async start(): Promise<RpcHandshake> {
    if (
      this.failures >= (this.options.failureThreshold ?? 3) &&
      Date.now() - this.openedAt < (this.options.resetMs ?? 30_000)
    )
      throw new Error("PLUGIN_CIRCUIT_OPEN");
    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    this.child = child;
    this.peer = new RpcPeer(child.stdout, child.stdin);
    child.once("exit", () => {
      this.peer?.close();
      this.peer = null;
      this.child = null;
    });
    const hello = await this.peer.call<RpcHandshake>("handshake", { protocolVersion: "1.0" }, 5_000);
    if (hello.protocolVersion !== "1.0" || hello.pluginId !== this.options.expectedPluginId) {
      await this.stop();
      throw new Error("PLUGIN_HANDSHAKE_MISMATCH");
    }
    return hello;
  }
  async call<T>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.active >= (this.options.maxConcurrency ?? 4)) throw new Error("PLUGIN_CONCURRENCY_LIMIT");
    if (!this.peer) {
      if (this.restarts >= (this.options.maxRestarts ?? 2)) throw new Error("PLUGIN_RESTART_LIMIT");
      this.restarts++;
      await this.start();
    }
    this.active++;
    try {
      const value = await this.peer!.call<T>(method, params, timeoutMs);
      this.failures = 0;
      return value;
    } catch (error) {
      this.failures++;
      if (this.failures >= (this.options.failureThreshold ?? 3)) this.openedAt = Date.now();
      throw error;
    } finally {
      this.active--;
    }
  }
  async stop(): Promise<void> {
    const child = this.child;
    this.peer?.close();
    this.peer = null;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

export interface BrokerGrant {
  origins: string[];
  pathPrefixes: string[];
  methods: string[];
  credential: string | null;
  expiresAt?: number;
  requestsPerMinute?: number;
  maxResponseBytes?: number;
}
export interface BrokerRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
const SECRET_KEYS = /authorization|cookie|token|secret|api[-_]?key/i;
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[REDACTED]" : redact(item)]),
    ) as T;
  if (typeof value === "string") return value.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, "[REDACTED]") as T;
  return value;
}
export class HttpBroker {
  private readonly requests: number[] = [];
  constructor(
    private readonly grant: BrokerGrant,
    private readonly transport: typeof fetch = fetch,
    private readonly resolveAddresses: (hostname: string) => Promise<string[]> = async (hostname) =>
      (await lookup(hostname, { all: true })).map((entry) => entry.address),
  ) {}
  async request<T>(request: BrokerRequest, timeoutMs = 10_000): Promise<T> {
    if (this.grant.expiresAt && Date.now() >= this.grant.expiresAt) throw new Error("BROKER_AUTH_EXPIRED");
    const url = new URL(request.url);
    if (
      !this.grant.origins.includes(url.origin) ||
      !this.grant.pathPrefixes.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`)) ||
      !this.grant.methods.includes(request.method.toUpperCase())
    )
      throw new Error("BROKER_SCOPE_DENIED");
    if (
      Object.keys(request.headers ?? {}).some((name) => /^(host|authorization|cookie|x-api-key)$/i.test(name))
    )
      throw new Error("BROKER_FORBIDDEN_HEADER");
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolveAddresses(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress))
      throw new Error("BROKER_PRIVATE_ADDRESS_DENIED");
    const now = Date.now();
    while (this.requests[0] && this.requests[0] < now - 60_000) this.requests.shift();
    if (this.requests.length >= (this.grant.requestsPerMinute ?? 60)) throw new Error("BROKER_RATE_LIMITED");
    this.requests.push(now);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json", ...(request.headers ?? {}) };
      if (this.grant.credential) headers.authorization = `Bearer ${this.grant.credential}`;
      const response = await this.transport(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) throw new Error("BROKER_AUTH_REJECTED");
      if (response.status === 429) throw new Error("BROKER_REMOTE_RATE_LIMITED");
      if (!response.ok) throw new Error(`BROKER_HTTP_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > (this.grant.maxResponseBytes ?? 2 * 1024 * 1024))
        throw new Error("BROKER_RESPONSE_TOO_LARGE");
      return redact(JSON.parse(bytes.toString("utf8"))) as T;
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new Error("BROKER_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  )
    return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}
