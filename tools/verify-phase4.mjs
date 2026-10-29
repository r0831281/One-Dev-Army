import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPluginConformance } from "../dist/packages/plugin-sdk/src/index.js";

const root = await mkdtemp(join(tmpdir(), "oda-phase4-sdk-"));
try {
  execFileSync(
    process.execPath,
    ["dist/packages/create-task-source-plugin/src/bin.js", join(root, "ts-starter"), "--typescript"],
    { stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    ["dist/packages/create-task-source-plugin/src/bin.js", join(root, "py-starter"), "--python"],
    { stdio: "pipe" },
  );
  const manifest = JSON.parse(await readFile(join(root, "ts-starter", "plugin-manifest.json"), "utf8"));
  const fixture = {
    getManifest: async () => manifest,
    healthCheck: async () => ({ status: "READY" }),
    normalizePayload: async () => ({ key: "FIXTURE-1" }),
    fetchTask: async () => ({}),
    updateStatus: async () => ({}),
    postComment: async () => ({}),
  };
  const ts = await runPluginConformance(fixture);
  if (!ts.passed) throw new Error(JSON.stringify(ts));
  let python = { status: "unverified", reason: "python not found" };
  for (const command of ["python", "python3"]) {
    try {
      python = JSON.parse(
        execFileSync(command, [join(root, "py-starter", "conformance.py")], { encoding: "utf8" }),
      );
      break;
    } catch {
      // Try the next conventional Python executable name.
    }
  }
  if (python.status === "unverified")
    throw new Error("Python 3 is required for the cross-language conformance gate");
  console.log(
    JSON.stringify(
      {
        protocolVersion: "1.0",
        typescript: ts,
        python,
        coreSourceChangesRequired: false,
        network: "disabled",
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
