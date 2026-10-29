import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dockerPluginArgs } from "../dist/packages/plugin-host/src/index.js";

const run = promisify(execFile);
const fixture = "oda-hostile-plugin-fixture:phase1";
await run("docker", ["build", "--pull", "--tag", fixture, "packages/plugin-host/fixtures/hostile"], {
  timeout: 180_000,
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
});
const inspected = await run("docker", ["image", "inspect", fixture, "--format", "{{.Id}}"], {
  windowsHide: true,
});
const imageId = inspected.stdout.trim();
const result = await run("docker", dockerPluginArgs({ image: imageId, memoryMb: 64, cpus: 0.25, pids: 16 }), {
  timeout: 30_000,
  windowsHide: true,
});
const evidence = JSON.parse(result.stdout.trim());
for (const property of [
  "rootReadOnly",
  "tmpWritable",
  "tmpNoExec",
  "hostHidden",
  "dockerHidden",
  "credentialsHidden",
  "nonRoot",
  "networkBlocked",
]) {
  if (evidence[property] !== true) throw new Error(`Hostile-plugin assertion failed: ${property}`);
}
if (evidence.memoryLimit !== String(64 * 1024 * 1024))
  throw new Error(`Unexpected memory limit: ${evidence.memoryLimit}`);
if (evidence.pidsLimit !== "16") throw new Error(`Unexpected PID limit: ${evidence.pidsLimit}`);
console.log(JSON.stringify({ imageId, ...evidence }, null, 2));
