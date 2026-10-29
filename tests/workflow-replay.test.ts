import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "@temporalio/worker";

for (const fixture of ["initial", "compatible-evolution", "phase3-execution"]) {
  test(`Temporal workflow replay remains compatible with ${fixture}`, async () => {
    const history = JSON.parse(
      await readFile(resolve(`apps/worker/fixtures/${fixture}.json`), "utf8"),
    ) as unknown;
    const workflowId =
      fixture === "phase3-execution"
        ? (
            JSON.parse(
              await readFile(resolve("apps/worker/fixtures/phase3-execution.meta.json"), "utf8"),
            ) as { workflowId: string }
          ).workflowId
        : `offline-${fixture}`;
    await Worker.runReplayHistory(
      { workflowsPath: resolve("dist/apps/worker/src/workflows.js") },
      history,
      workflowId,
    );
  });
}
