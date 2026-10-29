import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  createDbReader,
  dbReadLimits,
  guardSql,
  sanitizeDbMessage,
  type DbQueryable,
} from "../packages/sandboxes/src/index.js";

const connection = {
  host: "127.0.0.1",
  port: 1,
  user: "reader",
  password: "s3cret-pw",
  database: "restored",
};

async function fixture() {
  const db = new PGlite();
  const statements: string[] = [];
  const client: DbQueryable = {
    async query(text, values) {
      statements.push(text);
      const result = await db.query<Record<string, unknown>>(text, values ?? []);
      return { rows: result.rows, fields: result.fields };
    },
  };
  await db.exec(`
    CREATE TABLE t(id integer PRIMARY KEY, name text, note text);
    INSERT INTO t VALUES (1, 'alpha', 'tab\there'), (2, 'beta', NULL);
    CREATE TABLE many AS SELECT g AS n FROM generate_series(1, 250) AS g;
  `);
  const reader = createDbReader(connection, { client });
  return { db, reader, statements };
}

async function count(db: PGlite): Promise<number> {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM t")).rows[0]!.n;
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: Error) => error.message.split(":")[0] === code);
}

test("SELECT renders compact TSV with a header and row count", async () => {
  const { db, reader, statements } = await fixture();
  try {
    const result = await reader.query("SELECT id, name, note FROM t ORDER BY id");
    assert.equal(result.untrusted, true);
    assert.equal(result.content, "id\tname\tnote\n1\talpha\ttab\\there\n2\tbeta\tNULL\n(2 rows)");
    assert.deepEqual(statements.slice(0, 3), [
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5s'",
      "SET LOCAL idle_in_transaction_session_timeout = '10s'",
    ]);
    assert.match(statements[3]!, /^SELECT \* FROM \(\n[\s\S]*\n\) AS oda_q LIMIT 101$/u);
    assert.equal(statements[4], "ROLLBACK");
    const withQuery = await reader.query("with x as (select 7 as v) select v from x;");
    assert.equal(withQuery.content, "v\n7\n(1 row)");
    await assert.rejects(
      reader.query("SELECT 1 AS a, 2 AS a"),
      /^Error: DB_QUERY_FAILED: duplicate column name "a"/u,
    );
    assert.equal(statements.at(-1), "ROLLBACK");
  } finally {
    await reader.close();
    await db.close();
  }
});

test("rows are capped at 100 and cells at 500 characters", async () => {
  const { db, reader } = await fixture();
  try {
    const rows = await reader.query("SELECT n FROM many ORDER BY n");
    const lines = rows.content.split("\n");
    assert.equal(lines.length, 1 + dbReadLimits.maxRows + 1);
    assert.equal(lines.at(-2), "100");
    assert.equal(lines.at(-1), "(100 rows, truncated)");

    const cell = await reader.query("SELECT repeat('x', 2000) AS big");
    const value = cell.content.split("\n")[1]!;
    assert.equal(value, `${"x".repeat(dbReadLimits.maxCellChars)}…`);

    const wide = await reader.query("SELECT n, repeat('y', 600) AS a, repeat('z', 600) AS b FROM many");
    assert.ok(Buffer.byteLength(wide.content) <= dbReadLimits.maxResultBytes);
    assert.match(wide.content, /\[output truncated at 40 KB\]\n\(\d+ rows, truncated\)$/u);
  } finally {
    await reader.close();
    await db.close();
  }
});

test("statements other than SELECT/WITH are denied before reaching the database", async () => {
  const { db, reader, statements } = await fixture();
  try {
    for (const sql of [
      "INSERT INTO t VALUES (3, 'gamma', NULL)",
      "UPDATE t SET name = 'x'",
      "DELETE FROM t",
      "DROP TABLE t",
      "CREATE TABLE u(id int)",
      "SELECT 1; DELETE FROM t",
      "SELECT 1;;",
      "/* SELECT */ DELETE FROM t",
      "-- SELECT\nDELETE FROM t",
      "SELECT 1) AS a, (SELECT 2",
      "SELECT 'unterminated",
      "",
    ])
      await rejectsWith(reader.query(sql), "DB_QUERY_DENIED");
    assert.equal(statements.length, 0);
    assert.equal(await count(db), 2);
  } finally {
    await reader.close();
    await db.close();
  }
});

test("comments and quoted semicolons are handled", async () => {
  const { db, reader } = await fixture();
  try {
    assert.equal(
      (await reader.query("SELECT ';' AS s, 'it''s; fine' AS q -- trailing ; comment")).content,
      "s\tq\n;\tit's; fine\n(1 row)",
    );
    assert.equal(
      (
        await reader.query(
          '/* lead; */ SELECT $tag$a;b$tag$ AS d, "semi;col" FROM (SELECT 1 AS "semi;col") s; -- done',
        )
      ).content,
      "d\tsemi;col\na;b\t1\n(1 row)",
    );
    assert.equal((await reader.query("SELECT E'x\\';y' AS e")).content, "e\nx';y\n(1 row)");
    assert.equal(guardSql("SELECT 1; -- end"), "SELECT 1");
    assert.throws(() => guardSql("SELECT 1 /* ; */ ; SELECT 2"), /DB_QUERY_DENIED/u);
  } finally {
    await reader.close();
    await db.close();
  }
});

test("data-modifying CTEs fail and leave the table intact; ROLLBACK follows every error", async () => {
  const { db, reader, statements } = await fixture();
  try {
    await assert.rejects(
      reader.query("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"),
      /^Error: DB_QUERY_/u,
    );
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(await count(db), 2);

    // Without the wrapper the read-only transaction is what stops the write.
    await db.query("BEGIN READ ONLY");
    await assert.rejects(
      db.query("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"),
      /read-only transaction/u,
    );
    await db.query("ROLLBACK");
    await rejectsWith(reader.query("SELECT * FROM t FOR UPDATE"), "DB_QUERY_DENIED");
    assert.equal(statements.at(-1), "ROLLBACK");

    statements.length = 0;
    await rejectsWith(reader.query("SELECT * FROM missing_table"), "DB_QUERY_FAILED");
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(await count(db), 2);

    // The connection is clean again after the failures.
    assert.equal((await reader.query("SELECT count(*) AS n FROM t")).content, "n\n2\n(1 row)");
  } finally {
    await reader.close();
    await db.close();
  }
});

test("error messages never leak the password or connection strings", async () => {
  const cleaned = sanitizeDbMessage(
    'password authentication failed for "reader" (s3cret-pw) postgres://reader:s3cret-pw@host/db password=hunter2',
    "s3cret-pw",
  );
  assert.doesNotMatch(cleaned, /s3cret-pw|hunter2|postgres:\/\//u);

  const reader = createDbReader({ ...connection, port: 9 });
  try {
    await assert.rejects(reader.query("SELECT 1"), (error: Error) => {
      assert.match(error.message, /^DB_UNAVAILABLE/u);
      assert.doesNotMatch(error.message, /s3cret-pw/u);
      return true;
    });
  } finally {
    await reader.close();
  }
});
