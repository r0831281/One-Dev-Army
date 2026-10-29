import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRepoReader, repoReadLimits } from "../packages/sandboxes/src/index.js";

const run = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=ODA Test",
      "-c",
      "user.email=oda-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.symlinks=true",
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
      },
    },
  );
  return stdout.trim();
}

interface Fixture {
  root: string;
  first: string;
  second: string;
}

async function fixture(): Promise<Fixture> {
  await mkdir(join(process.cwd(), ".test-tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(join(process.cwd(), ".test-tmp", "oda-repo-read-")));
  await git(root, "init", "-q", "-b", "main");
  assert.equal(await git(root, "rev-parse", "--show-toplevel"), root);

  await mkdir(join(root, "addons", "sale_ext", "models"), { recursive: true });
  await writeFile(
    join(root, "addons", "sale_ext", "__manifest__.py"),
    '{"name": "Sale Ext", "version": "1.0"}\n',
  );
  await writeFile(
    join(root, "addons", "sale_ext", "models", "sale.py"),
    "class SaleOrder:\n    marker = 'commit-one'\n    def total(self):\n        return 1\n",
  );
  await writeFile(join(root, "large.txt"), `${"x".repeat(99)}\n`.repeat(3_000));
  await writeFile(
    join(root, "many.txt"),
    Array.from({ length: 250 }, (_, i) => `needle ${i}`).join("\n") + "\n",
  );
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await symlink("addons/sale_ext/models/sale.py", join(root, "link.py"));
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "one");
  const first = await git(root, "rev-parse", "HEAD");

  await writeFile(
    join(root, "addons", "sale_ext", "models", "sale.py"),
    "class SaleOrder:\n    marker = 'commit-two'\n",
  );
  await writeFile(join(root, "added_later.py"), "print('later')\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "two");
  const second = await git(root, "rev-parse", "HEAD");

  // Uncommitted working-tree edits must never be visible to the reader.
  await writeFile(
    join(root, "addons", "sale_ext", "models", "sale.py"),
    "class SaleOrder:\n    marker = 'dirty'\n",
  );
  await writeFile(join(root, "untracked.py"), "marker = 'dirty'\n");
  return { root, first, second };
}

test("repository reader serves the pinned commit, not later commits or the working tree", async () => {
  const { root, first, second } = await fixture();
  try {
    const reader = await createRepoReader({ root, baseSha: first });
    const sale = await reader.read("addons/sale_ext/models/sale.py");
    assert.equal(sale.untrusted, true);
    assert.match(sale.content, /commit-one/);
    assert.doesNotMatch(sale.content, /commit-two|dirty/);

    const range = await reader.read("addons/sale_ext/models/sale.py", 2, 3);
    assert.equal(range.content, "2\t    marker = 'commit-one'\n3\t    def total(self):");
    assert.equal((await reader.read("./addons//sale_ext/models/sale.py", 4)).content, "4\t        return 1");

    await assert.rejects(reader.read("added_later.py"), /^Error: REPO_NOT_FOUND$/);
    await assert.rejects(reader.read("untracked.py"), /^Error: REPO_NOT_FOUND$/);
    await assert.rejects(reader.read("addons"), /^Error: REPO_NOT_FOUND$/);

    const hits = await reader.search("marker = ");
    assert.equal(hits.untrusted, true);
    assert.equal(hits.content, "addons/sale_ext/models/sale.py:2:     marker = 'commit-one'");
    assert.equal((await reader.search("commit-two|dirty")).content, "[NO MATCHES]");
    assert.match((await reader.search("version", "*.py")).content, /^addons\/sale_ext\/__manifest__\.py:1: /);
    assert.equal((await reader.search("version", "addons/*.txt")).content, "[NO MATCHES]");

    const listing = await reader.list();
    assert.equal(listing.untrusted, true);
    const files = listing.content.split("\n");
    assert.ok(files.includes("addons/sale_ext/models/sale.py"));
    assert.ok(!files.includes("added_later.py"));
    assert.ok(!files.includes("untracked.py"));
    assert.ok(!files.includes("link.py"), "symlinks are not listed");
    assert.deepEqual((await reader.list("addons/sale_ext")).content.split("\n"), [
      "addons/sale_ext/__manifest__.py",
      "addons/sale_ext/models/sale.py",
    ]);
    await assert.rejects(reader.list("missing"), /^Error: REPO_NOT_FOUND$/);
    await assert.rejects(reader.list("large.txt"), /^Error: REPO_NOT_FOUND$/);

    const later = await createRepoReader({ root, baseSha: second });
    assert.match((await later.read("addons/sale_ext/models/sale.py")).content, /commit-two/);
    assert.match((await later.read("added_later.py")).content, /later/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository reader denies traversal, .git, absolute and symlink paths", async () => {
  const { root, first } = await fixture();
  try {
    const reader = await createRepoReader({ root, baseSha: first });
    for (const path of [
      "../package.json",
      "addons/../../package.json",
      "..\\package.json",
      ".git/config",
      "addons/.git/HEAD",
      ".GIT/config",
      "/etc/passwd",
      "\\etc\\passwd",
      "C:/Windows/win.ini",
      "addons\0sale.py",
      "",
      ".",
    ]) {
      await assert.rejects(reader.read(path), /^Error: REPO_PATH_DENIED$/, `read ${JSON.stringify(path)}`);
    }
    await assert.rejects(reader.read("link.py"), /^Error: REPO_PATH_DENIED$/);
    await assert.rejects(reader.list("../"), /^Error: REPO_PATH_DENIED$/);
    await assert.rejects(reader.list(".git"), /^Error: REPO_PATH_DENIED$/);
    await assert.rejects(reader.search("x", ":(top)*"), /^Error: REPO_PATH_DENIED$/);
    await assert.rejects(reader.search("x", "../*"), /^Error: REPO_PATH_DENIED$/);
    await assert.rejects(reader.search("x", "/etc/*"), /^Error: REPO_PATH_DENIED$/);
    // The symlink blob holds the target path; it must not leak through search either.
    assert.equal((await reader.search("addons/sale_ext/models")).content, "[NO MATCHES]");
    await assert.rejects(reader.search(""), /^Error: REPO_PATTERN_INVALID$/);
    await assert.rejects(reader.search("a\nb"), /^Error: REPO_PATTERN_INVALID$/);
    await assert.rejects(reader.search("("), /^Error: REPO_PATTERN_INVALID$/);
    await assert.rejects(reader.read("large.txt", 0), /^Error: REPO_RANGE_INVALID$/);
    await assert.rejects(reader.read("large.txt", 5, 4), /^Error: REPO_RANGE_INVALID$/);
    await assert.rejects(reader.read("large.txt", 1.5), /^Error: REPO_RANGE_INVALID$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository reader applies file, result and search caps", async () => {
  const { root, first } = await fixture();
  try {
    const reader = await createRepoReader({ root, baseSha: first });
    // large.txt is 300,000 bytes: 3,000 lines of 100 bytes.
    const whole = await reader.read("large.txt");
    assert.ok(Buffer.byteLength(whole.content) <= repoReadLimits.maxResultBytes);
    assert.match(
      whole.content,
      /\[TRUNCATED: file is 300000 bytes; only the first 204800 bytes are readable\]/,
    );
    assert.match(whole.content, /\[TRUNCATED: showing lines 1-\d+ of 2048; pass startLine\/endLine/);

    const tail = await reader.read("large.txt", 2040);
    assert.ok(tail.content.startsWith(`2040\t${"x".repeat(99)}`));
    assert.match(tail.content, /^2048\t/m);
    assert.doesNotMatch(tail.content, /^2049\t/m, "lines past the 200 KB window are not readable");
    await assert.rejects(reader.read("large.txt", 2049), /^Error: REPO_RANGE_INVALID$/);

    const wide = await reader.read("large.txt", 1, 2048);
    assert.ok(Buffer.byteLength(wide.content) <= repoReadLimits.maxResultBytes);
    assert.match(wide.content, /\[TRUNCATED: showing lines 1-\d+ of 2048; request a later startLine/);

    assert.equal((await reader.read("binary.bin")).content, "[BINARY FILE: 6 bytes, not shown]");
    assert.equal((await reader.search("\u0001\u0002")).content.includes("binary.bin"), false);

    const many = await reader.search("needle", "many.txt");
    const lines = many.content.split("\n");
    assert.equal(lines.filter((line) => line.startsWith("many.txt:")).length, repoReadLimits.maxSearchHits);
    assert.match(lines.at(-1)!, /^\[TRUNCATED: showing 200 matches; more than 200 exist/);
    assert.ok(Buffer.byteLength(many.content) <= repoReadLimits.maxResultBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository reader rejects malformed, unknown and non-commit SHAs", async () => {
  const { root, first } = await fixture();
  try {
    for (const baseSha of ["", "HEAD", "main", first.slice(0, 12), first.toUpperCase(), `${first}0`]) {
      await assert.rejects(createRepoReader({ root, baseSha }), /^Error: REPO_SHA_INVALID$/, baseSha);
    }
    await assert.rejects(createRepoReader({ root, baseSha: "0".repeat(40) }), /^Error: REPO_SHA_INVALID$/);
    const blob = await git(root, "rev-parse", `${first}:large.txt`);
    await assert.rejects(createRepoReader({ root, baseSha: blob }), /^Error: REPO_SHA_INVALID$/);
    await assert.rejects(
      createRepoReader({ root: join(root, "addons"), baseSha: first }),
      /^Error: REPO_UNAVAILABLE$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
