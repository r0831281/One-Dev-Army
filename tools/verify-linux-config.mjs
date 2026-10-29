import { Buffer } from "node:buffer";

import { setup, CommandVault, EncryptedFileVault } from "../dist/packages/cli/src/index.js";

const root = "/tmp/oda-linux-matrix";
const first = await setup({ root, repositoryPath: "/work", startServices: false });
const second = await setup({ root, repositoryPath: "/work", startServices: false, setupId: first.setupId });
if (first.setupId !== second.setupId) throw new Error("Linux setup resume changed setup identity");
const vault = new EncryptedFileVault("/tmp/oda-linux-vault", Buffer.from("linux-passphrase"));
const ref = "vault://oda/linux/test";
await vault.put(ref, Buffer.from("secret"));
if (Buffer.from(await vault.get(ref)).toString() !== "secret")
  throw new Error("Linux vault round trip failed");
let nativeKeyringFailure = false;
try {
  await new CommandVault("linux").get("vault://oda/linux/missing");
} catch {
  nativeKeyringFailure = true;
}
if (!nativeKeyringFailure) throw new Error("Missing Linux keyring unexpectedly returned a secret");
console.log(
  JSON.stringify({
    platform: process.platform,
    setupResume: "passed",
    argon2idVault: "passed",
    nativeKeyringFailure: "passed",
  }),
);
