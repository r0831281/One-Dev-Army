import { execFileSync, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const release = "0.1.0-phase.1";
const outputRoot = join(process.cwd(), "artifacts", "phase-1", "connectors");
await mkdir(outputRoot, { recursive: true });

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const spdxId = (value) => `SPDXRef-${value.replaceAll(/[^A-Za-z0-9.-]/g, "-")}`;
const pae = (payloadType, payload) =>
  Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const keyId = sha256(publicKey.export({ type: "spki", format: "der" }));
await writeFile(join(outputRoot, "attestation-public-key.pem"), publicPem);

const dockerfileHash = sha256(await readFile(join(process.cwd(), "infra", "connectors", "Dockerfile")));
const lockHash = sha256(await readFile(join(process.cwd(), "pnpm-lock.yaml")));
const sourceHash = createHash("sha256");
for (const path of [
  "infra/connectors/runtime.mjs",
  "packages/connectors/src/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/generated.ts",
  "packages/plugin-sdk/src/index.ts",
]) {
  sourceHash
    .update(path)
    .update("\0")
    .update(await readFile(join(process.cwd(), path)))
    .update("\0");
}
const connectorSourceHash = sourceHash.digest("hex");
const results = {};

for (const kind of ["github", "jira"]) {
  const tag = `oda-connector-${kind}:${release}`;
  run("docker", [
    "build",
    "--file",
    "infra/connectors/Dockerfile",
    "--build-arg",
    `CONNECTOR_KIND=${kind}`,
    "--tag",
    tag,
    ".",
  ]);
  const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
  const manifest = JSON.parse(
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      tag,
      "--manifest",
    ]),
  );
  if (manifest.pluginId !== `community.${kind}`) throw new Error(`${kind} manifest smoke test failed`);
  const config =
    kind === "github"
      ? ["-e", "ODA_GITHUB_OWNER=acme", "-e", "ODA_GITHUB_REPO=app"]
      : ["-e", "ODA_JIRA_ORIGIN=https://jira.invalid", "-e", "ODA_JIRA_PROJECT=APP"];
  const identifier = kind === "github" ? "acme/app#42" : "APP-42";
  const rpc = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      ...config,
      tag,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "plugin.getManifest", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: "2", method: "plugin.normalizePayload", params: { input: identifier } })}\n`,
    },
  );
  if (rpc.status !== 0) throw new Error(`${kind} RPC smoke test failed: ${rpc.stderr}`);
  const responses = rpc.stdout.trim().split(/\r?\n/).map(JSON.parse);
  if (responses[0]?.result?.pluginId !== `community.${kind}` || responses[1]?.error)
    throw new Error(`${kind} RPC smoke response was invalid`);

  const apkPackages = run("docker", ["run", "--rm", "--entrypoint", "apk", tag, "info", "-v"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*)-([0-9][A-Za-z0-9._+~-]*-r\d+)$/.exec(entry);
      return { name: match?.[1] ?? entry, version: match?.[2] ?? "NOASSERTION", kind: "apk" };
    });
  const nodePackages = JSON.parse(
    run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      tag,
      "--input-type=module",
      "-e",
      "import{readdirSync,readFileSync}from'node:fs';import{join}from'node:path';const r='/app/node_modules/.pnpm';const seen=new Map;const add=p=>{try{const j=JSON.parse(readFileSync(join(p,'package.json')));seen.set(j.name+'@'+j.version,{name:j.name,version:j.version,license:j.license??'NOASSERTION',kind:'npm'})}catch{}};for(const d of readdirSync(r)){const n=join(r,d,'node_modules');let es=[];try{es=readdirSync(n)}catch{continue}for(const e of es){if(e.startsWith('@')){for(const s of readdirSync(join(n,e)))add(join(n,e,s))}else add(join(n,e))}}console.log(JSON.stringify([...seen.values()].sort((a,b)=>a.name.localeCompare(b.name))))",
    ]),
  );
  const packages = [...apkPackages, ...nodePackages].map((pkg, index) => ({
    SPDXID: spdxId(`${pkg.kind}-${pkg.name}-${index}`),
    name: pkg.name,
    versionInfo: pkg.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: pkg.license ?? "NOASSERTION",
    supplier: pkg.kind === "npm" ? "NOASSERTION" : "Organization: Alpine Linux",
  }));
  const imagePackage = {
    SPDXID: "SPDXRef-ContainerImage",
    name: tag,
    versionInfo: imageId,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "Apache-2.0",
    checksums: [{ algorithm: "SHA256", checksumValue: imageId.slice("sha256:".length) }],
  };
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${tag}-sbom`,
    documentNamespace: `https://oda.invalid/spdx/${release}/${kind}/${imageId.slice(7)}`,
    creationInfo: { created: new Date().toISOString(), creators: ["Tool: tools/release-connectors.mjs"] },
    packages: [imagePackage, ...packages],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: imagePackage.SPDXID,
      },
      ...packages.map((pkg) => ({
        spdxElementId: imagePackage.SPDXID,
        relationshipType: "CONTAINS",
        relatedSpdxElement: pkg.SPDXID,
      })),
    ],
  };
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  const sbomName = `${kind}.spdx.json`;
  await writeFile(join(outputRoot, sbomName), sbomBytes);

  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: tag, digest: { sha256: imageId.slice(7) } }],
    predicateType: "https://oda.invalid/attestation/connector-release/v1",
    predicate: {
      release,
      connector: kind,
      sbom: { path: sbomName, sha256: sha256(sbomBytes) },
      build: {
        connectorSourceSha256: connectorSourceHash,
        dockerfileSha256: dockerfileHash,
        pnpmLockSha256: lockHash,
      },
      verification: {
        manifestSmokeTest: "passed",
        rpcNormalizeSmokeTest: "passed",
        networkDuringSmokeTest: "none",
      },
    },
  };
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify(statement));
  const signature = sign(null, pae(payloadType, payload), privateKey);
  if (!verify(null, pae(payloadType, payload), publicKey, signature))
    throw new Error(`${kind} attestation signature verification failed`);
  const envelope = {
    payloadType,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyId, sig: signature.toString("base64") }],
  };
  const attestationName = `${kind}.intoto.jsonl`;
  await writeFile(join(outputRoot, attestationName), `${JSON.stringify(envelope)}\n`);
  results[kind] = { tag, imageId, manifest, sbom: sbomName, attestation: attestationName };
}

const manifest = {
  schemaVersion: "1.0",
  release,
  generatedAt: new Date().toISOString(),
  signer: { algorithm: "Ed25519", publicKey: "attestation-public-key.pem", keyId },
  connectors: results,
  publication: "local-only",
};
await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
