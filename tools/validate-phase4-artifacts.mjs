import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), "artifacts", "phase-4");
for (const path of [
  "release-manifest.json",
  "release-manifest.dsse.json",
  "release-public-key.pem",
  "sbom.cdx.json",
  "verification.json",
])
  await access(join(root, path));
const manifest = JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"));
if (
  manifest.release !== "0.4.0-phase.4" ||
  ![5, 7].includes(manifest.migrationHead) ||
  manifest.contractSchema !== "1.0" ||
  manifest.publication !== false
)
  throw new Error("Phase 4 manifest invariants failed");
for (const item of manifest.artifacts) {
  const bytes = await readFile(item.path);
  if (createHash("sha256").update(bytes).digest("hex") !== item.sha256 || bytes.length !== item.size)
    throw new Error(`Phase 4 artifact mismatch: ${item.path}`);
}
const envelope = JSON.parse(await readFile(join(root, "release-manifest.dsse.json"), "utf8")),
  payload = Buffer.from(envelope.payload, "base64"),
  type = envelope.payloadType,
  pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), payload]),
  key = createPublicKey(await readFile(join(root, "release-public-key.pem"), "utf8"));
if (!verify(null, pae, key, Buffer.from(envelope.signatures[0].sig, "base64")))
  throw new Error("Phase 4 signature failed");
const sbom = JSON.parse(await readFile(join(root, "sbom.cdx.json"), "utf8"));
if (sbom.bomFormat !== "CycloneDX" || sbom.components.length < 1)
  throw new Error("Phase 4 SBOM is incomplete");
const verification = JSON.parse(await readFile(join(root, "verification.json"), "utf8"));
if (verification.release !== manifest.release) throw new Error("Phase 4 verification release mismatch");
console.log(
  JSON.stringify({
    release: manifest.release,
    artifacts: manifest.artifacts.length,
    sbomComponents: sbom.components.length,
    signature: true,
  }),
);
