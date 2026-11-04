import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

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
  /** Commits up to the pinned commit, newest first, optionally only those touching one path. */
  history(path?: string, limit?: number): Promise<UntrustedRepoContent>;
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
  /** Nested submodules deeper than this are listed as unavailable. */
  maxSubmoduleDepth: 3,
  /** Submodules searched at the same time. */
  submoduleSearchConcurrency: 4,
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
const GITLINK_TYPE = "commit";

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

/**
 * Maps a search glob of the parent repository onto a submodule at `sub`: the part below the submodule, the same glob
 * when it starts with a wildcard, no restriction when the glob covers the whole submodule, or null to skip it.
 */
function submoduleGlob(glob: string, sub: string): string | null {
  if (glob === "" || glob === sub) return "";
  if (glob.startsWith(`${sub}/`)) return glob.slice(sub.length + 1);
  const literal = glob.slice(0, glob.search(/[*?[]/u) < 0 ? glob.length : glob.search(/[*?[]/u));
  if (literal === "") return glob;
  return `${sub}/`.startsWith(literal) ? "" : null;
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the input order in the result. */
async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** A reader plus the raw listing and search results the parent repository merges for its submodules. */
interface ReaderParts {
  reader: RepoReader;
  /** Readable files under `dir` (normalized), and submodules below it that cannot be read. */
  files(dir: string): Promise<{ files: string[]; unavailable: string[] }>;
  /** Search hits as "path:line: text", and whether more exist than were returned. */
  grep(pattern: string, glob: string): Promise<{ hits: string[]; more: boolean }>;
}

export async function createRepoReader(options: RepoReaderOptions): Promise<RepoReader> {
  return (await openReader(options.root, options.baseSha, 0)).reader;
}

async function openReader(rootOption: string, baseSha: string, depth: number): Promise<ReaderParts> {
  if (typeof baseSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseSha))
    throw new Error("REPO_SHA_INVALID");
  if (typeof rootOption !== "string" || rootOption === "" || rootOption.includes("\0"))
    throw new Error("REPO_UNAVAILABLE");
  const root = resolve(rootOption);
  const prefix = await runGit(root, ["rev-parse", "--show-prefix"], 4_096);
  // A non-empty prefix means root is a subdirectory of some other repository; refuse rather than read its parent.
  // This also refuses a submodule that is not checked out: git then answers for the parent repository.
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

  // Submodules are read from their own repository at the commit this tree pins, through git objects only. A
  // submodule that is not checked out, misses that commit or is nested too deep stays unavailable.
  const children = new Map<string, Promise<ReaderParts | null>>();
  const child = (path: string, entry: TreeEntry): Promise<ReaderParts | null> => {
    let pending = children.get(path);
    if (!pending) {
      const childRoot = resolve(root, path);
      pending =
        depth >= repoReadLimits.maxSubmoduleDepth || !childRoot.startsWith(`${root}${sep}`)
          ? Promise.resolve(null)
          : openReader(childRoot, entry.oid, depth + 1).catch(() => null);
      children.set(path, pending);
    }
    return pending;
  };
  const submodules = async () => [...(await tree())].filter(([, entry]) => entry.type === GITLINK_TYPE);
  /** The submodule that contains `path` (or is `path`), with the rest of the path inside it. */
  const route = async (path: string) => {
    const entries = await tree();
    for (let cut = path.length; cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
      const entry = entries.get(path.slice(0, cut));
      if (entry?.type === GITLINK_TYPE) return { sub: path.slice(0, cut), entry, rest: path.slice(cut + 1) };
    }
    return null;
  };
  const enter = async (path: string) => {
    const routed = await route(path);
    if (!routed) return null;
    const parts = await child(routed.sub, routed.entry);
    if (!parts) throw new Error("REPO_SUBMODULE_UNAVAILABLE");
    return { ...routed, parts };
  };

  async function files(dir: string): Promise<{ files: string[]; unavailable: string[] }> {
    const inside = dir === "" ? null : await enter(dir);
    if (inside) {
      const nested = await inside.parts.files(inside.rest);
      return {
        files: nested.files.map((file) => `${inside.sub}/${file}`),
        unavailable: nested.unavailable.map((path) => `${inside.sub}/${path}`),
      };
    }
    const entries = await tree();
    if (dir !== "" && entries.get(dir)?.type !== "tree") throw new Error("REPO_NOT_FOUND");
    const prefix = dir === "" ? "" : `${dir}/`;
    const found = [...entries]
      .filter(([path, entry]) => path.startsWith(prefix) && isReadableBlob(entry))
      .map(([path]) => path);
    const unavailable: string[] = [];
    for (const [path, entry] of await submodules()) {
      if (!path.startsWith(prefix)) continue;
      const parts = await child(path, entry);
      if (!parts) {
        unavailable.push(path);
        continue;
      }
      const nested = await parts.files("");
      found.push(...nested.files.map((file) => `${path}/${file}`));
      unavailable.push(...nested.unavailable.map((sub) => `${path}/${sub}`));
    }
    return { files: found.sort(), unavailable: unavailable.sort() };
  }

  async function grep(pattern: string, glob: string): Promise<{ hits: string[]; more: boolean }> {
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
    const hits: string[] = [];
    let more = false;
    if (result.code !== 0 && result.code !== 1) {
      if (/regex|regcomp|unmatched|invalid|brace|parenthes|bracket/iu.test(result.stderr))
        throw new Error("REPO_PATTERN_INVALID");
      throw new Error("REPO_SEARCH_FAILED");
    }
    if (result.code === 0) {
      const records = result.stdout.toString("utf8").split("\n");
      // A record cut off by the byte cap has no trailing newline; drop it rather than report a partial hit.
      if (result.truncated || records.at(-1) === "") records.pop();
      more = result.truncated;
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
    }
    const targets = (await submodules()).flatMap(([path, entry]) => {
      const nestedGlob = submoduleGlob(glob, path);
      return nestedGlob === null ? [] : [{ path, entry, glob: nestedGlob }];
    });
    const nested = await mapLimited(targets, repoReadLimits.submoduleSearchConcurrency, async (target) => {
      const parts = await child(target.path, target.entry);
      // A submodule that cannot be searched does not fail the search of the others.
      return parts ? parts.grep(pattern, target.glob).catch(() => null) : null;
    });
    nested.forEach((found, index) => {
      if (!found) return;
      more ||= found.more;
      for (const hit of found.hits) {
        if (hits.length === repoReadLimits.maxSearchHits) {
          more = true;
          return;
        }
        hits.push(`${targets[index]!.path}/${hit}`);
      }
    });
    return { hits, more };
  }

  const reader: RepoReader = {
    baseSha,

    async read(path, startLine, endLine) {
      const normalized = validateRepoPath(path);
      if (normalized === "") throw new Error("REPO_PATH_DENIED");
      const inside = await enter(normalized);
      if (inside) {
        // The submodule itself is a directory, not a file.
        if (inside.rest === "") throw new Error("REPO_NOT_FOUND");
        return inside.parts.reader.read(inside.rest, startLine, endLine);
      }
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
      const { hits, more } = await grep(pattern, glob);
      if (hits.length === 0) return wrap("[NO MATCHES]");
      const { text, kept } = capLines(hits, repoReadLimits.maxResultBytes - 512);
      const notes: string[] = [];
      if (kept < hits.length || more)
        notes.push(
          `[TRUNCATED: showing ${kept} matches${more ? `; more than ${hits.length} exist` : ` of ${hits.length}`}; narrow the pattern or pathGlob]`,
        );
      return wrap([text, ...notes].join("\n"));
    },

    async history(path, limit = 20) {
      const normalized = path === undefined || path === "" ? "" : validateRepoPath(path);
      // Inside a submodule, its own commits up to the commit this tree pins.
      const inside = normalized === "" ? null : await enter(normalized);
      if (inside) return inside.parts.reader.history(inside.rest || undefined, limit);
      const count = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
      const result = await runGit(
        root,
        [
          "log",
          "--no-color",
          "--no-decorate",
          `--max-count=${count}`,
          "--date=iso-strict",
          "--format=%h %cd %an: %s",
          baseSha,
          "--",
          ...(normalized ? [normalized] : []),
        ],
        repoReadLimits.maxResultBytes,
      );
      if (result.code !== 0) throw new Error("REPO_UNAVAILABLE");
      const text = result.stdout.toString("utf8").trim();
      return wrap(text || "[NO COMMITS]");
    },

    async list(dir) {
      const normalized = dir === undefined ? "" : validateRepoPath(dir);
      const found = await files(normalized);
      const lines = [
        ...found.files,
        ...found.unavailable.map((path) => `${path}/ [SUBMODULE NOT AVAILABLE]`),
      ];
      if (lines.length === 0) return wrap("[EMPTY]");
      const { text, kept } = capLines(lines, repoReadLimits.maxResultBytes - 512);
      const notes =
        kept < lines.length
          ? [`[TRUNCATED: showing ${kept} of ${lines.length} files; pass a narrower dir]`]
          : [];
      return wrap([text, ...notes].join("\n"));
    },
  };
  return { reader, files, grep };
}
