/* Database access — PostgreSQL (Supabase).

   The app previously ran on SQLite and then libSQL. Moving to Supabase meant a
   dialect change, which turned out to be far smaller than it sounds: the only
   non-portable SQL in the whole codebase was one PRAGMA, one group_concat and
   one date(x, '+N day'). Everything else is plain ANSI.

   The 700-odd `?` placeholders are NOT rewritten by hand. Postgres numbers its
   parameters, so toPg() below converts `?` to $1..$n in one place, and every
   call site is left exactly as it was written.

   Serverless note: Supabase's transaction pooler (port 6543) does not support
   prepared statements, so `prepare` is off. Without that every query fails
   under pgbouncer with a confusing "prepared statement already exists".

     DATABASE_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:6543/postgres
*/
import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL, DATABASE_CA_CERT, PG_POOL_MAX, assertConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

/* The URL comes from config.js, which decides between DATABASE_URL and
   TEST_DATABASE_URL and refuses to start if the two are the same string. This
   module used to read process.env directly and build the pool at import time,
   which meant any test that imported anything got the production pool — there
   was no seam to point it elsewhere. */
const url = DATABASE_URL;
if (!url) {
  assertConfig({ exitOnFailure: false });   // throws with the real reason
  throw new Error("No database URL is configured.");
}

/* Local Postgres does not speak TLS and does not need to. Anything else is
   assumed remote and encrypted. */
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]|^postgresql:\/\/(localhost|127\.0\.0\.1)/.test(url);

/* TLS.

   "require" encrypts the connection but does NOT verify the certificate, so it
   protects against passive eavesdropping and not against an active attacker
   who can present any certificate. Supabase's pooler is signed by their own
   CA rather than a publicly trusted one, so verify-full only works once that
   CA is supplied.

   Download it from Supabase -> Project Settings -> Database -> SSL
   Configuration and pass the contents as DATABASE_CA_CERT. With it set, the
   certificate chain and hostname are both checked. */
const CA = DATABASE_CA_CERT;
const ssl = isLocal ? false
  : CA ? { ca: CA, rejectUnauthorized: true }
  : "require";

export const VERIFIED_TLS = Boolean(CA);

export const db = postgres(url, {
  // Required by pgbouncer in transaction mode, which is what port 6543 is.
  prepare: false,
  ssl,
  /* Pages issue their queries concurrently, so a pool of one would serialise
     them again and undo the point. Four is enough for the widest page and
     leaves plenty of headroom against Supabase's 200 client limit. */
  max: PG_POOL_MAX,
  idle_timeout: 20,
  connect_timeout: 15,
  onnotice: () => {},
  /* A pool that cannot reach the database emits an error on no particular
     request, so there is nothing to await it and Node treats it as an
     unhandled rejection — which kills the process. A dropped connection is
     normal (a pooler recycling, a network blip, a laptop waking up) and must
     degrade into a failed request, not a dead server. postgres.js retries on
     its own; this only stops the rejection from being fatal. */
  onclose: () => {},
});

db.options.onclose = () => {};

/* Belt and braces for the same class of failure arriving through a path the
   driver does not own. Logged loudly, because a connection that keeps dying is
   worth knowing about, but never fatal. */
process.on("unhandledRejection", (err) => {
  const msg = err && err.message ? err.message : String(err);
  if (/CONNECT_TIMEOUT|CONNECTION_|ECONNRESET|ETIMEDOUT|terminating connection/i.test(msg)) {
    console.error(`[db] connection problem, continuing: ${msg}`);
    return;
  }
  throw err;
});

/* --- placeholder translation --------------------------------------------- */

/* `?` to $1..$n, skipping anything inside a string literal so a `?` in text is
   left alone. Postgres casts (`::`) are untouched because they contain no `?`. */
export function toPg(sql) {
  let out = "";
  let n = 0;
  let quote = null;
  let comment = null;   // "line" or "block"

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];

    /* Comments are skipped over rather than parsed, and that matters more
       than it looks. Without this, an apostrophe inside a comment — "the
       contractor's invoice" — opened a string literal that never closed, and
       every `?` after it stopped being converted. The query then failed with
       "syntax error at or near ::", which points at the wrong place
       entirely. Found by writing a commented query. */
    if (comment === "line") {
      out += c;
      if (c === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      out += c;
      if (c === "*" && next === "/") { out += next; i++; comment = null; }
      continue;
    }

    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }

    if (c === "-" && next === "-") { comment = "line"; out += c; continue; }
    if (c === "/" && next === "*") { comment = "block"; out += c; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === "?") { out += "$" + (++n); continue; }
    out += c;
  }
  return out;
}

/* --- transaction context -------------------------------------------------- */

const txStore = new AsyncLocalStorage();
const conn = () => txStore.getStore() || db;

export async function tx(fn) {
  if (txStore.getStore()) return fn();            // join the outer transaction
  return db.begin((scoped) => txStore.run(scoped, fn));
}

/* --- query helpers -------------------------------------------------------- */

async function exec(sql, params) {
  return conn().unsafe(toPg(sql), params.map(norm));
}

export async function get(sql, ...params) {
  const rows = await exec(sql, params);
  return rows[0];
}

export async function all(sql, ...params) {
  const rows = await exec(sql, params);
  // porsager returns an array-like; callers do .map/.filter/.length on it.
  return Array.from(rows);
}

export async function run(sql, ...params) {
  const rows = await exec(sql, params);
  return { changes: rows.count ?? 0 };
}

export async function one(sql, ...params) {
  const row = await get(sql, ...params);
  if (!row) {
    // The SQL used to be in this message, and the message reaches the browser.
    const err = new NotFound("Not found");
    err.query = sql.slice(0, 120);   // for the server log only
    throw err;
  }
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

/* Postgres is stricter than SQLite about types. Booleans go to the 0/1 the
   INTEGER columns expect, and undefined becomes a real NULL. */
function norm(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

/* --- migrations ----------------------------------------------------------- */

let migrated = null;
export function ready() {
  if (!migrated) migrated = migrate();
  return migrated;
}

/* For the test suite, which drops and rebuilds the schema between runs and
   would otherwise be handed the cached promise from the previous one. */
export function resetMigrationCache() {
  migrated = null;
}

/* node:test does not exit while a pool holds open sockets. */
export async function closeDb() {
  await db.end({ timeout: 5 });
}

export async function migrate() {
  /* Preconditions, not migrations.

     004 calls gen_random_bytes(), which lives in pgcrypto. Supabase
     preinstalls it, so the dependency never surfaced — until the migrations
     are run anywhere else, where 004 fails with "function does not exist".

     This cannot be a numbered migration: a migration to install it would have
     to sort before 004, and every number below that is already applied in
     production. It is an environment precondition, so it belongs here beside
     the migration table itself, and it is idempotent. */
  await db.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await db.unsafe(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const dir = join(here, "..", "migrations");
  const done = new Set((await all("SELECT name FROM schema_migration")).map((r) => r.name));
  const pending = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .filter((f) => !done.has(f));

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    // Postgres runs a whole file in one implicit transaction when sent as a
    // single simple query, so a failed migration leaves nothing behind.
    await db.unsafe(sql);
    await run("INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
    console.log(`[db] applied ${file}`);
  }

  /* A migration that adds a table would otherwise leave it exposed to the
     REST API until someone remembered. Idempotent, and only runs when the
     schema actually changed. */
  if (pending.length) await enforceRowLevelSecurity();
  return pending.length;
}

async function enforceRowLevelSecurity() {
  const unprotected = await all(
    `SELECT tablename FROM pg_tables t
      WHERE schemaname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = t.tablename
                          AND c.relrowsecurity)`);
  for (const row of unprotected) {
    await db.unsafe(`ALTER TABLE public."${row.tablename}" ENABLE ROW LEVEL SECURITY`);
  }
  if (unprotected.length) {
    console.log(`[db] row level security enabled on ${unprotected.length} table(s)`);
  }
}

export class NotFound extends Error {}
