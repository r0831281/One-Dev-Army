import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
const source = resolve(process.argv[2] ?? "artifacts/phase-3");
const destination = resolve(process.argv[3] ?? ".validation/phase3-export");
if (
  isAbsolute(process.argv[2] ?? "") ||
  relative(process.cwd(), source).startsWith("..") ||
  relative(process.cwd(), destination).startsWith("..")
)
  throw new Error("EXPORT_PATH_DENIED");
const names = ["full-execution-demo.json", "cost-accounting-fixtures.json", "verification.json"];
await mkdir(destination, { recursive: true });
const manifest = [];
for (const name of names) {
  const bytes = await readFile(join(source, name));
  await writeFile(join(destination, basename(name)), bytes);
  manifest.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
  join(destination, "manifest.json"),
  `${JSON.stringify({ schemaVersion: "1.0", exportedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`,
);
console.log(JSON.stringify({ destination, files: manifest.length }));
