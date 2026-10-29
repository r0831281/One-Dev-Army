import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { relative, resolve } from "node:path";
const input = resolve(process.argv[2] ?? "artifacts/phase-3/full-execution-demo.json");
const output = resolve(process.argv[3] ?? ".validation/phase3-retained.json");
if (relative(process.cwd(), input).startsWith("..") || relative(process.cwd(), output).startsWith(".."))
  throw new Error("RETENTION_PATH_DENIED");
const value = JSON.parse(await readFile(input, "utf8"));
const cutoff = Date.now() - Number(process.env.ODA_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000);
value.events = (value.events ?? []).filter((event) => Date.parse(event.occurredAt) >= cutoff);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
console.log(JSON.stringify({ retainedEvents: value.events.length }));
