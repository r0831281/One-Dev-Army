import pg from "pg";

// Read-only queries against a restored customer database. A query must be a single SELECT/WITH statement and runs in
// a READ ONLY transaction that is always rolled back, so writes hidden in CTEs or functions fail inside Postgres.
// Results are capped and rendered as compact TSV. Connect with a role that has no write privileges as well: the
// transaction guard does not stop side effects of extensions such as dblink.

export interface DbConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
export interface DbQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields?: { name: string }[] }>;
  end?(): Promise<void>;
}
export interface DbReaderOptions {
  // Stand-in for tests; the reader never ends an injected client.
  client?: DbQueryable;
}
export interface UntrustedDbContent {
  untrusted: true;
  content: string;
}
export interface DbReader {
  query(sql: string): Promise<UntrustedDbContent>;
  close(): Promise<void>;
}

export const dbReadLimits = {
  maxRows: 100,
  maxCellChars: 500,
  maxResultBytes: 40 * 1024,
  maxSqlChars: 20_000,
  statementTimeout: "5s",
  idleInTransactionTimeout: "10s",
  connectTimeoutMs: 10_000,
} as const;

const TRUNCATION_MARKER = "… [output truncated at 40 KB]";

// Replaces comments, string literals, dollar-quoted bodies and quoted identifiers with spaces of the same length, so
// offsets in the result still point into the original text. Throws on unterminated constructs.
export function maskSql(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) throw new Error("DB_QUERY_DENIED");
      blank(i, j);
      i = j;
    } else if (ch === "'" || ch === '"') {
      // E'' strings honour backslash escapes; everything else only doubles the quote.
      const escapes = ch === "'" && /[eE]/u.test(sql[i - 1] ?? "") && !/[\w$]/u.test(sql[i - 2] ?? "");
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("DB_QUERY_DENIED");
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      blank(i, j + 1);
      i = j + 1;
    } else if (ch === "$" && !/[\w$]/u.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(i))?.[0];
      if (tag === undefined) {
        i++;
        continue;
      }
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error("DB_QUERY_DENIED");
      blank(i, end + tag.length);
      i = end + tag.length;
    } else i++;
  }
  return out.join("");
}

// Returns the statement without its optional trailing semicolon, or throws DB_QUERY_DENIED.
export function guardSql(sql: string): string {
  if (
    typeof sql !== "string" ||
    sql.length === 0 ||
    sql.length > dbReadLimits.maxSqlChars ||
    sql.includes("\0")
  )
    throw new Error("DB_QUERY_DENIED");
  const masked = maskSql(sql);
  const first = masked.indexOf(";");
  let body = sql;
  if (first !== -1) {
    if (masked.slice(first + 1).trim() !== "") throw new Error("DB_QUERY_DENIED");
    body = sql.slice(0, first);
  }
  const maskedBody = masked.slice(0, body.length);
  const keyword = /^\s*\(*\s*([A-Za-z]+)/u.exec(maskedBody)?.[1]?.toUpperCase();
  if (keyword !== "SELECT" && keyword !== "WITH") throw new Error("DB_QUERY_DENIED");
  // Balanced parentheses keep the statement inside the row-limiting wrapper.
  let depth = 0;
  for (const ch of maskedBody) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) throw new Error("DB_QUERY_DENIED");
  }
  if (depth !== 0) throw new Error("DB_QUERY_DENIED");
  return body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sanitizeDbMessage(message: string, password: string): string {
  let text = message;
  if (password.length > 0) {
    for (const variant of new Set([password, encodeURIComponent(password)]))
      text = text.replace(new RegExp(escapeRegExp(variant), "gu"), "[redacted]");
  }
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[redacted]")
    .replace(/\b(password|passwd|pwd)\s*[=:]\s*(?:'[^']*'|"[^"]*"|\S+)/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

const UNAVAILABLE_SYSCALL = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);

function classify(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (code === "57014") return "DB_QUERY_TIMEOUT";
    if (code === "25006" || code === "42501") return "DB_QUERY_DENIED";
    if (UNAVAILABLE_SYSCALL.has(code) || /^(08|28|3D|53|57P)/u.test(code)) return "DB_UNAVAILABLE";
  }
  const message = error instanceof Error ? error.message : "";
  if (/timeout|terminated|Connection terminated/iu.test(message) && !/statement/iu.test(message))
    return "DB_UNAVAILABLE";
  return "DB_QUERY_FAILED";
}

function renderCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "NULL";
  else if (value instanceof Date) text = Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  else if (value instanceof Uint8Array) text = `\\x${Buffer.from(value).toString("hex")}`;
  else if (typeof value === "object") text = JSON.stringify(value) ?? String(value);
  else text = String(value);
  text = text.replace(/\\/gu, "\\\\").replace(/\t/gu, "\\t").replace(/\r/gu, "\\r").replace(/\n/gu, "\\n");
  return text.length > dbReadLimits.maxCellChars ? `${text.slice(0, dbReadLimits.maxCellChars)}…` : text;
}

export function renderRows(columns: string[], rows: Record<string, unknown>[], moreRows: boolean): string {
  const lines = [columns.map(renderCell).join("\t")];
  let bytes = Buffer.byteLength(lines[0]!) + 1;
  let shown = 0;
  let cut = false;
  for (const row of rows.slice(0, dbReadLimits.maxRows)) {
    const line = columns.map((column) => renderCell(row[column])).join("\t");
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > dbReadLimits.maxResultBytes - 256) {
      cut = true;
      break;
    }
    lines.push(line);
    bytes += size;
    shown++;
  }
  if (cut) lines.push(TRUNCATION_MARKER);
  lines.push(`(${shown} ${shown === 1 ? "row" : "rows"}${moreRows || cut ? ", truncated" : ""})`);
  return lines.join("\n");
}

export function createDbReader(connection: DbConnection, options: DbReaderOptions = {}): DbReader {
  const injected = options.client;
  let client: pg.Client | null = null;
  let connecting: Promise<DbQueryable> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const fail = (error: unknown): Error => {
    if (error instanceof Error && /^DB_[A-Z_]+(?::|$)/u.test(error.message)) return error;
    const code = classify(error);
    const raw = error instanceof Error ? error.message : "";
    const detail = sanitizeDbMessage(raw, connection.password);
    return new Error(detail === "" ? code : `${code}: ${detail}`);
  };

  const discard = () => {
    const stale = client;
    client = null;
    connecting = null;
    if (stale) void stale.end().catch(() => undefined);
  };

  const acquire = (): Promise<DbQueryable> => {
    if (injected) return Promise.resolve(injected);
    if (closed) return Promise.reject(new Error("DB_UNAVAILABLE"));
    if (!connecting) {
      const next = new pg.Client({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password,
        database: connection.database,
        connectionTimeoutMillis: dbReadLimits.connectTimeoutMs,
        application_name: "oda-db-read",
      });
      // An idle connection dropped by the server must not crash the worker; the next query reconnects.
      next.on("error", () => {
        if (client === next) discard();
      });
      client = next;
      connecting = next.connect().then(
        () => next,
        (error: unknown) => {
          if (client === next) discard();
          throw error;
        },
      );
    }
    return connecting;
  };

  const run = async (sql: string): Promise<UntrustedDbContent> => {
    const body = guardSql(sql);
    let db: DbQueryable;
    try {
      db = await acquire();
    } catch (error) {
      const failure = fail(error);
      throw new Error(failure.message.replace(/^DB_[A-Z_]+/u, "DB_UNAVAILABLE"));
    }
    let began = false;
    try {
      await db.query("BEGIN READ ONLY");
      began = true;
      await db.query(`SET LOCAL statement_timeout = '${dbReadLimits.statementTimeout}'`);
      await db.query(
        `SET LOCAL idle_in_transaction_session_timeout = '${dbReadLimits.idleInTransactionTimeout}'`,
      );
      const result = await db.query(`SELECT * FROM (\n${body}\n) AS oda_q LIMIT ${dbReadLimits.maxRows + 1}`);
      const columns = result.fields?.map((field) => field.name) ?? Object.keys(result.rows[0] ?? {});
      // Rows are keyed by column name, so a repeated name would silently show the last value under every copy.
      const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
      if (duplicate !== undefined)
        throw new Error(
          `DB_QUERY_FAILED: duplicate column name ${JSON.stringify(duplicate)}; alias the columns`,
        );
      return {
        untrusted: true,
        content: renderRows(columns, result.rows, result.rows.length > dbReadLimits.maxRows),
      };
    } catch (error) {
      throw fail(error);
    } finally {
      if (began) {
        try {
          await db.query("ROLLBACK");
        } catch {
          // A connection that cannot roll back is not reused.
          if (!injected) discard();
        }
      } else if (!injected) discard();
    }
  };

  return {
    query(sql) {
      const result = queue.then(() => run(sql));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      closed = true;
      await queue;
      const stale = client;
      client = null;
      connecting = null;
      if (stale) await stale.end().catch(() => undefined);
    },
  };
}
