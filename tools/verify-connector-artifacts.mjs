import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), "artifacts", "phase-1", "connectors");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const publicKey = createPublicKey(await readFile(join(root, manifest.signer.publicKey), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pae = (payloadType, payload) =>
  Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);

for (const [kind, artifact] of Object.entries(manifest.connectors)) {
  const currentId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", artifact.tag], {
    encoding: "utf8",
  }).trim();
  if (currentId !== artifact.imageId) throw new Error(`${kind} local image ID does not match manifest`);
  const sbomBytes = await readFile(join(root, artifact.sbom));
  const sbom = JSON.parse(sbomBytes);
  if (sbom.spdxVersion !== "SPDX-2.3") throw new Error(`${kind} SBOM is not SPDX 2.3`);
  const envelope = JSON.parse(await readFile(join(root, artifact.attestation), "utf8"));
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signatures[0].sig, "base64");
  if (!verify(null, pae(envelope.payloadType, payload), publicKey, signature))
    throw new Error(`${kind} DSSE signature is invalid`);
  const statement = JSON.parse(payload);
  if (statement.subject[0].digest.sha256 !== artifact.imageId.slice(7))
    throw new Error(`${kind} attestation image subject is invalid`);
  if (statement.predicate.sbom.sha256 !== sha256(sbomBytes))
    throw new Error(`${kind} attestation SBOM hash is invalid`);
}

console.log(
  JSON.stringify({ release: manifest.release, connectors: Object.keys(manifest.connectors), verified: true }),
);
