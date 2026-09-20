/* Database access.

   libSQL, which is SQLite with a network protocol. Chosen over Postgres for a
   specific reason: the dialect is identical, so the 543-line schema and every
   query in this codebase are unchanged by the move to serverless. A Postgres
   port would have meant rewriting group_concat, date(?, '+N day') and several
   hundred statements — which is exactly where a silent bug would hide.

   The same client talks to a local file and to a hosted database, so the whole
   app runs offline against data/app.db and switches to Turso by setting one
   environment variable. Nothing else changes.

     DATABASE_URL=file:data/app.db          local
     DATABASE_URL=libsql://<db>.turso.io    hosted, with DATABASE_AUTH_TOKEN

   Everything here is async, because a network database cannot be otherwise.
   Transactions are the one place that needed thought: callers write

     await tx(async () => { await insert(...); await update(...); })

   and the inner helpers have to run ON the transaction rather than on the
   pooled connection. AsyncLocalStorage carries it, so call sites never pass a
   handle around and nested tx() calls join the outer transaction instead of
   deadlocking on a second BEGIN. */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const url = process.env.DATABASE_URL || "file:data/app.db";
export const IS_REMOTE = !url.startsWith("file:");

/* A serverless filesystem is read-only and does not survive the request, so a
   file: URL there is always a misconfiguration. Saying so plainly beats the
   opaque crash it would otherwise cause on the first query. */
if (SERVERLESS && !IS_REMOTE) {
  throw new Error(
    "DATABASE_URL is not set. On a serverless host the filesystem is read-only, " +
    "so the default file:data/app.db cannot work. Set DATABASE_URL to your " +
    "libsql:// URL and DATABASE_AUTH_TOKEN to its token."
  );
}

/* The package's default entry loads a native binding so it can open local
   SQLite files. That binding is unnecessary for a remote database and is a
   common cause of cold-start failure on serverless runtimes, so remote URLs
   use the pure-HTTP client instead. */
const { createClient } = IS_REMOTE
  ? await import("@libsql/client/web")
  : await import("@libsql/client");

export const db = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

/* --- transaction context -------------------------------------------------- */

const txStore = new AsyncLocalStorage();
const conn = () => txStore.getStore() || db;

export async function tx(fn) {
  // Already inside one: join it. Opening a second would deadlock.
  if (txStore.getStore()) return fn();

  const t = await db.transaction("write");
  try {
    const out = await txStore.run(t, fn);
    await t.commit();
    return out;
  } catch (err) {
    try { await t.rollback(); } catch { /* the transaction is already dead */ }
    throw err;
  }
}

/* --- query helpers -------------------------------------------------------- */

export async function get(sql, ...params) {
  const r = await conn().execute({ sql, args: params.map(norm) });
  return r.rows[0];
}

export async function all(sql, ...params) {
  const r = await conn().execute({ sql, args: params.map(norm) });
  return r.rows;
}

export async function run(sql, ...params) {
  const r = await conn().execute({ sql, args: params.map(norm) });
  return { changes: Number(r.rowsAffected || 0) };
}

export async function one(sql, ...params) {
  const row = await get(sql, ...params);
  if (!row) throw new NotFound(`no row for: ${sql.slice(0, 60)}`);
  return row;
}

export async function insert(table, record) {
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  await run(sql, ...keys.map((k) => record[k]));
  return record.id;
}

export async function update(table, id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  await run(sql, ...keys.map((k) => patch[k]), id);
}

/* libSQL binds null, number, bigint, string and Uint8Array. Booleans are the
   one thing this codebase produces that it will not take. */
function norm(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

/* --- migrations ----------------------------------------------------------- */

/* Cached so a warm function does not re-check on every request, and so a
   cold start does not race two migrations against each other. */
let migrated = null;
export function ready() {
  if (!migrated) migrated = migrate();
  return migrated;
}

export async function migrate() {
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const dir = join(here, "..", "migrations");
  const done = new Set((await all("SELECT name FROM schema_migration")).map((r) => r.name));
  const pending = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .filter((f) => !done.has(f));

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    // executeMultiple runs the whole file; a half-applied schema is worse than
    // a failed start, and libSQL does not allow DDL inside its transactions
    // on every backend, so this is checked by the marker row instead.
    await db.executeMultiple(sql);
    await run("INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
    console.log(`[db] applied ${file}`);
  }
  return pending.length;
}

export class NotFound extends Error {}
