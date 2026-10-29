#!/usr/bin/env node
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const language = process.argv.includes("--python") ? "python" : "typescript";
const targetArg = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
if (!targetArg) throw new Error("Usage: create-task-source-plugin <directory> [--typescript|--python]");
const target = resolve(targetArg);
const id = basename(target)
  .toLowerCase()
  .replaceAll(/[^a-z0-9.-]/g, "-");
if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw new Error("Target directory must produce a safe plugin id");
let templates = resolve(here, "..", "templates");
try {
  await access(templates);
} catch {
  templates = resolve(process.cwd(), "packages", "create-task-source-plugin", "templates");
}
await mkdir(target, { recursive: false });
await cp(resolve(templates, language), target, { recursive: true });
for (const name of ["plugin-manifest.json", language === "typescript" ? "package.json" : "pyproject.toml"]) {
  const path = resolve(target, name);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replaceAll("__PLUGIN_ID__", id));
}
process.stdout.write(
  `${JSON.stringify({ created: target, language, protocolVersion: "1.0", network: "disabled" })}\n`,
);
