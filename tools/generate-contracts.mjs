import { compile } from "json-schema-to-typescript";
import { readFile, writeFile } from "node:fs/promises";

const schemaUrl = new URL("../docs/reference/schemas.json", import.meta.url);
const outputUrl = new URL("../packages/contracts/src/generated.ts", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
const generated = await compile(schema, "ODAReferenceContracts", {
  bannerComment:
    "// Generated from docs/reference/schemas.json by tools/generate-contracts.mjs. Do not edit by hand.",
  unreachableDefinitions: true,
  style: { singleQuote: false, printWidth: 110 },
});
const output = `${generated.trim()}\n\nexport type Json = null | boolean | number | string | Json[] | { [key: string]: Json };\n`;

if (process.argv.includes("--write")) {
  await writeFile(outputUrl, output, "utf8");
  console.log("Generated packages/contracts/src/generated.ts");
} else {
  const current = await readFile(outputUrl, "utf8");
  if (current.replaceAll("\r\n", "\n") !== output) {
    throw new Error("Generated contracts are stale. Run: pnpm generate:contracts");
  }
  console.log("Generated contract drift check passed");
}
