import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { isAbsolute, resolve } from "node:path";

// Read-only views of a repository pinned to one commit. Every read goes through git object plumbing, so the
// working tree, the index and uncommitted edits are never consulted.

export interface RepoReaderOptions {
  root: string;
  baseSha: string;
}
export interface UntrustedRepoContent {
  untrusted: true;
  content: string;
}
export interface RepoReader {
  readonly baseSha: string;
  read(path: string, startLine?: number, endLine?: number): Promise<UntrustedRepoContent>;
  search(pattern: string, pathGlob?: string): Promise<UntrustedRepoContent>;
  list(dir?: string): Promise<UntrustedRepoContent>;
}

export const repoReadLimits = {
  maxFileBytes: 200 * 1024,
  maxResultBytes: 40 * 1024,
  maxSearchHits: 200,
  maxSearchLineChars: 300,
  maxSearchOutputBytes: 4 * 1024 ** 2,
  maxTreeBytes: 64 * 1024 ** 2,
  maxPatternChars: 1_000,
  commandTimeoutMs: 30_000,
} as const;

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number | null;
}
interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

const SYMLINK_MODE = "120000";

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  for (const key of ["PATH", "HOME", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function runGit(root: string, args: readonly string[], maxBytes: number): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["-C", root, "-c", "core.fsmonitor=", "-c", `core.hooksPath=${devNull}`, "--no-pager", ...args],
      { env: gitEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let collected = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, repoReadLimits.commandTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - collected;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        collected = maxBytes;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      collected += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("REPO_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error("REPO_TIMEOUT"));
      else resolvePromise({ code: truncated ? 0 : code, stdout: Buffer.concat(chunks), stderr, truncated });
    });
  });
}

// Same deny rules as resolveSandboxPath, applied to repository-relative strings instead of the filesystem.
function validateRepoPath(requested: string, allowGlob = false): string {
  if (typeof requested !== "string" || requested.includes("\0") || isAbsolute(requested))
    throw new Error("REPO_PATH_DENIED");
  if (/^[\\/]/u.test(requested) || /^[a-zA-Z]:/u.test(requested)) throw new Error("REPO_PATH_DENIED");
  if (allowGlob && requested.startsWith(":")) throw new Error("REPO_PATH_DENIED");
  const parts = requested.split(/[\\/]/u).filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.toLowerCase() === ".git"))
    throw new Error("REPO_PATH_DENIED");
  return parts.join("/");
}

function lineNumber(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("REPO_RANGE_INVALID");
  return value;
}

// Cuts text to a byte budget on a line boundary where possible and reports how many whole lines survived.
function capLines(lines: readonly string[], budget: number): { text: string; kept: number } {
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line) + 1;
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }
  if (kept === 0 && lines.length > 0) {
    const head = Buffer.from(lines[0]!).subarray(0, budget).toString("utf8").replace(/�$/u, "");
    return { text: head, kept: 0 };
  }
  return { text: lines.slice(0, kept).join("\n"), kept };
}

const wrap = (content: string): UntrustedRepoContent => ({ untrusted: true, content });

export async function createRepoReader(options: RepoReaderOptions): Promise<RepoReader> {
  const { baseSha } = options;
  if (typeof baseSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseSha))
    throw new Error("REPO_SHA_INVALID");
  if (typeof options.root !== "string" || options.root === "" || options.root.includes("\0"))
    throw new Error("REPO_UNAVAILABLE");
  const root = resolve(options.root);
  const prefix = await runGit(root, ["rev-parse", "--show-prefix"], 4_096);
  // A non-empty prefix means root is a subdirectory of some other repository; refuse rather than read its parent.
  if (prefix.code !== 0 || prefix.stdout.toString("utf8").trim() !== "") throw new Error("REPO_UNAVAILABLE");
  const exists = await runGit(root, ["cat-file", "-e", `${baseSha}^{commit}`], 0);
  if (exists.code !== 0) throw new Error("REPO_SHA_INVALID");

  let treePromise: Promise<Map<string, TreeEntry>> | null = null;
  const tree = (): Promise<Map<string, TreeEntry>> => {
    treePromise ??= (async () => {
      const result = await runGit(
        root,
        ["ls-tree", "-r", "-t", "-l", "-z", baseSha],
        repoReadLimits.maxTreeBytes,
      );
      if (result.code !== 0 || result.truncated) throw new Error("REPO_UNAVAILABLE");
      const entries = new Map<string, TreeEntry>();
      for (const record of result.stdout.toString("utf8").split("\0")) {
        const tab = record.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/u);
        if (!mode || !type || !oid) continue;
        entries.set(record.slice(tab + 1), {
          mode,
          type,
          oid,
          size: size && size !== "-" ? Number(size) : null,
        });
      }
      return entries;
    })();
    treePromise.catch(() => {
      treePromise = null;
    });
    return treePromise;
  };
  const isReadableBlob = (entry: TreeEntry | undefined): entry is TreeEntry =>
    entry !== undefined && entry.type === "blob" && entry.mode !== SYMLINK_MODE;

  return {
    baseSha,

    async read(path, startLine, endLine) {
      const normalized = validateRepoPath(path);
      if (normalized === "") throw new Error("REPO_PATH_DENIED");
      const ranged = startLine !== undefined || endLine !== undefined;
      const first = lineNumber(startLine, 1);
      const last = lineNumber(endLine, Number.MAX_SAFE_INTEGER);
      if (first > last) throw new Error("REPO_RANGE_INVALID");
      const entry = (await tree()).get(normalized);
      if (entry?.mode === SYMLINK_MODE) throw new Error("REPO_PATH_DENIED");
      if (!isReadableBlob(entry)) throw new Error("REPO_NOT_FOUND");
      const blob = await runGit(root, ["cat-file", "blob", entry.oid], repoReadLimits.maxFileBytes);
      if (blob.code !== 0) throw new Error("REPO_NOT_FOUND");
      const size = entry.size ?? blob.stdout.byteLength;
      if (blob.stdout.includes(0)) return wrap(`[BINARY FILE: ${size} bytes, not shown]`);

      const notes: string[] = [];
      let text = blob.stdout.toString("utf8");
      if (blob.truncated) {
        // Drop the partial last line so numbering never shows half a line as if it were whole.
        const cut = text.lastIndexOf("\n");
        text = cut >= 0 ? text.slice(0, cut + 1) : text;
        notes.push(
          `[TRUNCATED: file is ${size} bytes; only the first ${repoReadLimits.maxFileBytes} bytes are readable]`,
        );
      }
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const total = lines.length;
      const markerBudget = 512;

      if (!ranged) {
        const { text: shown, kept } = capLines(lines, repoReadLimits.maxResultBytes - markerBudget);
        if (kept < total)
          notes.push(
            `[TRUNCATED: showing lines 1-${kept} of ${total}; pass startLine/endLine to read further]`,
          );
        return wrap([shown, ...notes].filter((part) => part !== "").join("\n"));
      }

      if (first > total && total > 0) throw new Error("REPO_RANGE_INVALID");
      const stop = Math.min(last, total);
      const numbered = lines.slice(first - 1, stop).map((line, index) => `${first + index}\t${line}`);
      const { text: shown, kept } = capLines(numbered, repoReadLimits.maxResultBytes - markerBudget);
      if (kept < numbered.length)
        notes.push(
          `[TRUNCATED: showing lines ${first}-${first + kept - 1} of ${total}; request a later startLine to continue]`,
        );
      return wrap([shown, ...notes].filter((part) => part !== "").join("\n"));
    },

    async search(pattern, pathGlob) {
      if (
        typeof pattern !== "string" ||
        pattern === "" ||
        pattern.length > repoReadLimits.maxPatternChars ||
        /[\0\r\n]/u.test(pattern)
      )
        throw new Error("REPO_PATTERN_INVALID");
      const glob = pathGlob === undefined ? "" : validateRepoPath(pathGlob, true);
      const entries = await tree();
      const result = await runGit(
        root,
        [
          "grep",
          "-I",
          "-n",
          "--null",
          "--no-color",
          "--no-textconv",
          "-E",
          "-e",
          pattern,
          baseSha,
          "--",
          ...(glob ? [glob] : []),
        ],
        repoReadLimits.maxSearchOutputBytes,
      );
      if (result.code === 1) return wrap("[NO MATCHES]");
      if (result.code !== 0) {
        if (/regex|regcomp|unmatched|invalid|brace|parenthes|bracket/iu.test(result.stderr))
          throw new Error("REPO_PATTERN_INVALID");
        throw new Error("REPO_SEARCH_FAILED");
      }

      const records = result.stdout.toString("utf8").split("\n");
      // A record cut off by the byte cap has no trailing newline; drop it rather than report a partial hit.
      if (result.truncated || records.at(-1) === "") records.pop();
      const hits: string[] = [];
      let more = result.truncated;
      for (const record of records) {
        if (!record.startsWith(`${baseSha}:`)) continue;
        const [path, line, ...rest] = record.slice(baseSha.length + 1).split("\0");
        if (path === undefined || line === undefined || !isReadableBlob(entries.get(path))) continue;
        if (hits.length === repoReadLimits.maxSearchHits) {
          more = true;
          break;
        }
        let content = rest.join("\0");
        if (content.length > repoReadLimits.maxSearchLineChars)
          content = `${content.slice(0, repoReadLimits.maxSearchLineChars)}…`;
        hits.push(`${path}:${line}: ${content}`);
      }
      if (hits.length === 0) return wrap("[NO MATCHES]");
      const { text, kept } = capLines(hits, repoReadLimits.maxResultBytes - 512);
      const notes: string[] = [];
      if (kept < hits.length || more)
        notes.push(
          `[TRUNCATED: showing ${kept} matches${more ? `; more than ${hits.length} exist` : ` of ${hits.length}`}; narrow the pattern or pathGlob]`,
        );
      return wrap([text, ...notes].join("\n"));
    },

    async list(dir) {
      const normalized = dir === undefined ? "" : validateRepoPath(dir);
      const entries = await tree();
      if (normalized !== "" && entries.get(normalized)?.type !== "tree") throw new Error("REPO_NOT_FOUND");
      const prefix = normalized === "" ? "" : `${normalized}/`;
      const files = [...entries]
        .filter(([path, entry]) => path.startsWith(prefix) && isReadableBlob(entry))
        .map(([path]) => path)
        .sort();
      if (files.length === 0) return wrap("[EMPTY]");
      const { text, kept } = capLines(files, repoReadLimits.maxResultBytes - 512);
      const notes =
        kept < files.length
          ? [`[TRUNCATED: showing ${kept} of ${files.length} files; pass a narrower dir]`]
          : [];
      return wrap([text, ...notes].join("\n"));
    },
  };
}
