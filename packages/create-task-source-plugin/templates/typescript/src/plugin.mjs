import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const plugin = {
  getManifest: async () => manifest,
  healthCheck: async () => ({ status: "READY", network: "broker-only" }),
  normalizePayload: async (input) => ({
    externalId: input.identifier ?? "FIXTURE-1",
    key: input.identifier ?? "FIXTURE-1",
  }),
  fetchTask: async () => {
    throw new Error("fixture only");
  },
  updateStatus: async () => {
    throw new Error("grant required");
  },
  postComment: async () => {
    throw new Error("grant required");
  },
};
if (process.argv.includes("--conformance")) {
  const required = [
    "getManifest",
    "healthCheck",
    "normalizePayload",
    "fetchTask",
    "updateStatus",
    "postComment",
  ];
  const passed =
    manifest.protocolRange === "^1.0.0" &&
    manifest.runtime === "stdio-container" &&
    required.every((name) => typeof plugin[name] === "function");
  console.log(JSON.stringify({ protocolVersion: "1.0", passed, network: "disabled" }));
  process.exitCode = passed ? 0 : 1;
}
export default plugin;
