import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolveSandboxPath, validateExecutable } from "../dist/packages/sandboxes/src/index.js";
const root = "/tmp/oda-probe";
await mkdir(`${root}/repo`, { recursive: true });
await writeFile(`${root}/repo/file`, "ok");
await mkdir("/tmp/oda-outside", { recursive: true });
await symlink("/tmp/oda-outside", `${root}/escape`);
await assert.rejects(() => resolveSandboxPath(root, "../outside"), /PATH_DENIED/);
await assert.rejects(() => resolveSandboxPath(root, "escape/file"), /SYMLINK_ESCAPE/);
assert.throws(() => validateExecutable("sudo", ["id"]), /COMMAND_DENIED/);
assert.throws(() => validateExecutable("node", ["/var/run/docker.sock"]), /ARGUMENT_DENIED/);
assert.throws(
  () => validateExecutable("wget", ["http://169.254.169.254/latest/meta-data"]),
  /ARGUMENT_DENIED/,
);
console.log(
  JSON.stringify({
    traversal: "denied",
    symlink: "denied",
    privilege: "denied",
    dockerSocket: "denied",
    metadataEndpoint: "denied",
  }),
);
