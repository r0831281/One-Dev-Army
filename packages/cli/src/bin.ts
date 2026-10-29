#!/usr/bin/env node
import { applicationRoot, demo, doctor, serviceEnvironment, services, setup } from "./index.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function main(): Promise<void> {
  const command = process.argv[2] ?? "setup";
  const root = flag("--root") ?? applicationRoot();
  if (command === "demo") {
    console.log(JSON.stringify(await demo(), null, 2));
    return;
  }
  if (command === "doctor") {
    const result = await doctor(root);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.healthy ? 0 : 1;
    return;
  }
  if (["up", "stop", "status"].includes(command)) {
    console.log(
      await services(
        command as "up" | "stop" | "status",
        undefined,
        command === "up" ? await serviceEnvironment(root) : process.env,
      ),
    );
    return;
  }
  if (command === "rollback") {
    console.log(await services("stop"));
    console.log("Services stopped; data volumes, configuration, and secrets were retained.");
    return;
  }
  if (command === "setup") {
    const resume = flag("--resume");
    const result = await setup({
      root,
      repositoryPath: flag("--repository") ?? process.cwd(),
      dryRun: process.argv.includes("--dry-run"),
      startServices: !process.argv.includes("--no-start"),
      ...(resume ? { setupId: resume } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => {
  console.error(
    JSON.stringify({ error: { code: "CLI_FAILED", message: (error as Error).message, retryable: false } }),
  );
  process.exitCode = 1;
});
