import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import dashboardAssets from "../apps/dashboard/assets.json" with { type: "json" };

const root = join(process.cwd(), "artifacts", "phase-4"),
  sha = (value) => createHash("sha256").update(value).digest("hex");
await mkdir(root, { recursive: true });
const lock = YAML.parse(await readFile("pnpm-lock.yaml", "utf8"));
const packages = Object.keys(lock.packages ?? {}).sort();
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "one-developer-army", version: "0.4.0-phase.4" },
  },
  components: packages.map((key) => {
    const match = /^(.+)@([^(@]+)(?:\(|$)/.exec(key);
    return {
      type: "library",
      name: match?.[1] ?? key,
      version: match?.[2] ?? "unknown",
      purl: `pkg:npm/${encodeURIComponent(match?.[1] ?? key)}@${encodeURIComponent(match?.[2] ?? "unknown")}`,
    };
  }),
};
const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(join(root, "sbom.cdx.json"), sbomBytes);
const files = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "docs/releases/phase-4.md",
  "docs/reports/phase-4-completion.md",
  "docs/reports/phase-4-dependency-license.md",
  "docs/runbooks/phase-4-recovery.md",
  "apps/dashboard/index.html",
  "apps/dashboard/assets.json",
  ...Object.keys(dashboardAssets).map((path) => `apps/dashboard${path}`),
  "packages/plugin-sdk/src/index.ts",
  "packages/create-task-source-plugin/src/bin.ts",
  "infra/phase3-release-manifest.json",
];
const artifacts = [];
for (const path of files) {
  const bytes = await readFile(path);
  artifacts.push({ path, sha256: sha(bytes), size: bytes.length });
}
artifacts.push({ path: "artifacts/phase-4/sbom.cdx.json", sha256: sha(sbomBytes), size: sbomBytes.length });
const manifest = {
  schemaVersion: "1.0",
  release: "0.4.0-phase.4",
  generatedAt: new Date().toISOString(),
  localOnly: true,
  publication: false,
  migrationHead: 7,
  contractSchema: "1.0",
  eventProtocol: "1.0",
  pluginProtocol: "1.0",
  workflowVersions: [1, 2],
  workflowType: "TaskRunWorkflow",
  taskQueue: "oda-task-run-v1",
  temporal: { service: "1.28.1", sdk: "1.25.0" },
  images: JSON.parse(await readFile("infra/phase3-release-manifest.json", "utf8")).images,
  artifacts,
};
const payload = Buffer.from(JSON.stringify(manifest));
const { publicKey, privateKey } = generateKeyPairSync("ed25519"),
  pae = Buffer.concat([
    Buffer.from(
      `DSSEv1 ${Buffer.byteLength("application/vnd.oda.release+json")} application/vnd.oda.release+json ${payload.length} `,
    ),
    payload,
  ]),
  signature = sign(null, pae, privateKey);
if (!verify(null, pae, publicKey, signature)) throw new Error("release signature self-check failed");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
await writeFile(join(root, "release-public-key.pem"), publicPem);
await writeFile(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(root, "release-manifest.dsse.json"),
  `${JSON.stringify({ payloadType: "application/vnd.oda.release+json", payload: payload.toString("base64"), signatures: [{ keyid: sha(publicKey.export({ type: "spki", format: "der" })), sig: signature.toString("base64") }] }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      release: manifest.release,
      artifacts: artifacts.length,
      sbomComponents: packages.length,
      signatureVerified: true,
      publication: false,
    },
    null,
    2,
  ),
);
