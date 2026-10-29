import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "crash") process.exit(12);
  if (request.method === "hang") continue;
  const result =
    request.method === "handshake"
      ? { protocolVersion: "1.0", pluginId: "oda.test", pluginVersion: "1.0.0", capabilities: ["task:read"] }
      : { echoed: request.params };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
