import { createInterface } from "node:readline";

import { GitHubConnector, JiraConnector } from "./dist/packages/connectors/src/index.js";

const kind = process.env.ODA_CONNECTOR_KIND;
if (kind !== "github" && kind !== "jira") throw new Error("ODA_CONNECTOR_KIND must be github or jira");

const manifests = {
  github: {
    protocolVersion: "1.0",
    pluginId: "community.github",
    pluginVersion: "1.0.0",
    capabilities: ["task:read", "task:status", "task:comment"],
  },
  jira: {
    protocolVersion: "1.0",
    pluginId: "community.jira",
    pluginVersion: "1.0.0",
    capabilities: ["task:read", "task:status", "task:comment"],
  },
};

if (process.argv.includes("--manifest")) {
  process.stdout.write(`${JSON.stringify(manifests[kind])}\n`);
  process.exit(0);
}

let sequence = 0;
const pending = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const http = {
  request(request) {
    const id = `host-${++sequence}`;
    send({ jsonrpc: "2.0", id, method: "host.http.request", params: request });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  },
};

function connector() {
  if (kind === "github") {
    const owner = process.env.ODA_GITHUB_OWNER;
    const repo = process.env.ODA_GITHUB_REPO;
    if (!owner || !repo) throw new Error("GitHub connector configuration is incomplete");
    return new GitHubConnector(owner, repo, http);
  }
  const origin = process.env.ODA_JIRA_ORIGIN;
  const project = process.env.ODA_JIRA_PROJECT;
  if (!origin || !project) throw new Error("Jira connector configuration is incomplete");
  return new JiraConnector(origin, project, http);
}

const handlers = {
  "plugin.getManifest": () => manifests[kind],
  "plugin.healthCheck": () => ({
    status: "READY",
    pluginId: manifests[kind].pluginId,
    warnings: [],
  }),
  "plugin.normalizePayload": (params) => connector().normalize(params.input),
  "plugin.fetchTask": (params) => connector().fetchTask(params.ref, params.context),
  "plugin.updateStatus": (params) => connector().updateStatus(params.input),
  "plugin.postComment": (params) => connector().postComment(params.input),
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
    if (typeof message.method !== "string") {
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      continue;
    }
    const handler = handlers[message.method];
    if (!handler) throw Object.assign(new Error("Method not found"), { code: -32601 });
    send({ jsonrpc: "2.0", id: message.id, result: await handler(message.params ?? {}) });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message?.id ?? "unknown",
      error: { code: error.code ?? -32603, message: error.message ?? "Internal error" },
    });
  }
}
