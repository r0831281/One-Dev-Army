import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const PLUGIN_PROTOCOL_VERSION = "1.0" as const;

export interface CommunityPluginManifest {
  schemaVersion: "1.0";
  id: string;
  version: string;
  protocolRange: "^1.0.0";
  displayName: string;
  runtime: "stdio-container";
  image: string;
  capabilities: Array<"task:read" | "task:status" | "task:comment">;
  httpOrigins: string[];
  configSchemaRef: string;
  writeReconciliation: "marker-search";
}

export interface CommunityTaskSourcePlugin {
  getManifest(): CommunityPluginManifest | Promise<CommunityPluginManifest>;
  healthCheck(context: unknown): unknown | Promise<unknown>;
  normalizePayload(input: unknown, context: unknown): unknown | Promise<unknown>;
  fetchTask(ref: unknown, context: unknown): unknown | Promise<unknown>;
  updateStatus(input: unknown, context: unknown): unknown | Promise<unknown>;
  postComment(input: unknown, context: unknown): unknown | Promise<unknown>;
}

export interface ConformanceResult {
  protocolVersion: "1.0";
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

/** Offline public-SDK checks. Network and credentials are never used. */
export async function runPluginConformance(plugin: CommunityTaskSourcePlugin): Promise<ConformanceResult> {
  const checks: ConformanceResult["checks"] = [];
  const check = (name: string, passed: boolean, detail?: string) =>
    checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  try {
    const manifest = await plugin.getManifest();
    check("manifest-schema", manifest.schemaVersion === "1.0" && manifest.protocolRange === "^1.0.0");
    check("container-runtime", manifest.runtime === "stdio-container");
    check("digest-pinned-image", /@sha256:[a-f0-9]{64}$/.test(manifest.image));
    check(
      "bounded-capabilities",
      manifest.capabilities.every((value) => ["task:read", "task:status", "task:comment"].includes(value)),
    );
    check(
      "explicit-origins",
      manifest.httpOrigins.every((value) => /^https:\/\//.test(value)),
    );
    check("write-reconciliation", manifest.writeReconciliation === "marker-search");
    const normalized = await plugin.normalizePayload({ identifier: "FIXTURE-1" }, { fixture: true });
    check("normalize-fixture", normalized !== null && typeof normalized === "object");
    const health = await plugin.healthCheck({ fixture: true, network: "disabled" });
    check("health-fixture", health !== null && typeof health === "object");
    for (const method of ["fetchTask", "updateStatus", "postComment"] as const)
      check(`${method}-implemented`, typeof plugin[method] === "function");
  } catch (error) {
    check("unexpected-error", false, error instanceof Error ? error.message : String(error));
  }
  return { protocolVersion: PLUGIN_PROTOCOL_VERSION, passed: checks.every((item) => item.passed), checks };
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface RpcHandshake {
  protocolVersion: "1.0";
  pluginId: string;
  pluginVersion: string;
  capabilities: string[];
}

export const encodeFrame = (message: RpcRequest | RpcResponse): string => `${JSON.stringify(message)}\n`;

export function decodeFrame(line: string): RpcRequest | RpcResponse {
  if (Buffer.byteLength(line) > 1_048_576) throw new Error("RPC_FRAME_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("RPC_MALFORMED_JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (parsed as { id?: unknown }).id !== "string"
  )
    throw new Error("RPC_INVALID_ENVELOPE");
  return parsed as RpcRequest | RpcResponse;
}

export class RpcPeer {
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private closed = false;
  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const response = decodeFrame(line) as RpcResponse;
        const request = this.pending.get(response.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        if (response.error) request.reject(new Error(`RPC_${response.error.code}:${response.error.message}`));
        else request.resolve(response.result);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    input.on("end", () => this.failAll(new Error("RPC_CLOSED")));
    input.on("error", (error) => this.failAll(error));
  }
  async call<T>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.closed) throw new Error("RPC_CLOSED");
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("RPC_DEADLINE_EXCEEDED"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.output.write(encodeFrame({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  close(): void {
    this.failAll(new Error("RPC_CLOSED"));
  }
  private failAll(error: Error): void {
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}

export async function serveRpc(
  input: Readable,
  output: Writable,
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let id = "unknown";
    try {
      const request = decodeFrame(line) as RpcRequest;
      id = request.id;
      const handler = handlers[request.method];
      if (!handler) throw Object.assign(new Error("Method not found"), { code: -32601 });
      output.write(encodeFrame({ jsonrpc: "2.0", id, result: await handler(request.params) }));
    } catch (error) {
      const typed = error as Error & { code?: number };
      output.write(
        encodeFrame({ jsonrpc: "2.0", id, error: { code: typed.code ?? -32603, message: typed.message } }),
      );
    }
  }
}
