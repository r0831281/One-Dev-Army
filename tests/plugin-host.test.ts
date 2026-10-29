import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dockerPluginArgs, HttpBroker, PluginHost, redact } from "../packages/plugin-host/src/index.js";
import { decodeFrame, encodeFrame } from "../packages/plugin-sdk/src/index.js";

test("RPC framing preserves escaped newlines and rejects malformed frames", () => {
  const encoded = encodeFrame({ jsonrpc: "2.0", id: "1", method: "echo", params: { text: "a\nb" } });
  assert.equal(encoded.split("\n").length, 2);
  assert.deepEqual((decodeFrame(encoded.trim()) as { params: unknown }).params, { text: "a\nb" });
  assert.throws(() => decodeFrame("not json"), /RPC_MALFORMED_JSON/);
});

test("plugin host validates handshake, times out, and enforces restart limit", async () => {
  const host = new PluginHost({
    command: process.execPath,
    args: [join(process.cwd(), "packages/plugin-host/fixtures/test-plugin.mjs")],
    expectedPluginId: "oda.test",
    maxRestarts: 1,
  });
  assert.equal((await host.start()).pluginId, "oda.test");
  assert.deepEqual(await host.call("echo", { value: 1 }), { echoed: { value: 1 } });
  await assert.rejects(host.call("hang", {}, 20), /RPC_DEADLINE_EXCEEDED/);
  await assert.rejects(host.call("crash", {}, 100), /RPC_CLOSED/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await host.call("echo", { after: "restart" }), { echoed: { after: "restart" } });
  await assert.rejects(host.call("crash", {}, 100), /RPC_CLOSED/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(host.call("echo", {}), /PLUGIN_RESTART_LIMIT/);
  await host.stop();
});

test("container wrapper and broker deny filesystem/network privilege expansion", async () => {
  const publicResolver = async () => ["93.184.216.34"];
  const args = dockerPluginArgs({ image: `example.invalid/plugin@sha256:${"a".repeat(64)}` });
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--user=65532:65532"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.equal(
    args.some((arg) => arg.includes("docker.sock")),
    false,
  );
  const broker = new HttpBroker(
    {
      origins: ["https://api.example.test"],
      pathPrefixes: ["/repos/acme/app/issues"],
      methods: ["GET"],
      credential: "secret-token",
      requestsPerMinute: 1,
    },
    async () =>
      new Response(JSON.stringify({ token: "leaked", value: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    publicResolver,
  );
  assert.deepEqual(
    await broker.request({ method: "GET", url: "https://api.example.test/repos/acme/app/issues/1" }),
    { token: "[REDACTED]", value: 1 },
  );
  await assert.rejects(
    broker.request({ method: "GET", url: "https://api.example.test/user" }),
    /BROKER_SCOPE_DENIED/,
  );
  await assert.rejects(
    broker.request({ method: "GET", url: "http://169.254.169.254/latest/meta-data" }),
    /BROKER_SCOPE_DENIED/,
  );
  assert.equal(
    (redact({ authorization: "Bearer abc", nested: { apiKey: "xyz" } }) as { authorization: string })
      .authorization,
    "[REDACTED]",
  );
});

test("broker handles auth expiry, rate limits, and transport timeout", async () => {
  const expired = new HttpBroker(
    {
      origins: ["https://x.test"],
      pathPrefixes: ["/"],
      methods: ["GET"],
      credential: null,
      expiresAt: Date.now() - 1,
    },
    fetch,
    async () => ["93.184.216.34"],
  );
  await assert.rejects(expired.request({ method: "GET", url: "https://x.test/" }), /BROKER_AUTH_EXPIRED/);
  const limited = new HttpBroker(
    {
      origins: ["https://x.test"],
      pathPrefixes: ["/"],
      methods: ["GET"],
      credential: null,
      requestsPerMinute: 0,
    },
    fetch,
    async () => ["93.184.216.34"],
  );
  await assert.rejects(limited.request({ method: "GET", url: "https://x.test/" }), /BROKER_RATE_LIMITED/);
  const hanging = new HttpBroker(
    { origins: ["https://x.test"], pathPrefixes: ["/"], methods: ["GET"], credential: null },
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      ),
    async () => ["93.184.216.34"],
  );
  await assert.rejects(hanging.request({ method: "GET", url: "https://x.test/" }, 10), /BROKER_TIMEOUT/);
  const rebinding = new HttpBroker(
    { origins: ["https://allowed.test"], pathPrefixes: ["/api"], methods: ["GET"], credential: null },
    async () => new Response("{}", { status: 200 }),
    async () => ["127.0.0.1"],
  );
  await assert.rejects(
    rebinding.request({ method: "GET", url: "https://allowed.test/api" }),
    /BROKER_PRIVATE_ADDRESS_DENIED/,
  );
});
