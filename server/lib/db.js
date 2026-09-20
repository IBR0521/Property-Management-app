/* SQLite access.

   node:sqlite ships with Node 22, so there is no native module to build and
   no dependency to audit. It is synchronous, which is the right shape here:
   this is a single-process app whose queries are all indexed lookups, and
   synchronous calls remove every await from the data layer. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");

mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "app.db"));

db.exec("PRAGMA foreign_keys = ON");
// WAL lets the scheduler read while a request writes.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 4000");

/* --- migrations ---------------------------------------------------------- */

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const dir = join(here, "..", "migrations");
  const applied = new Set(all("SELECT name FROM schema_migration").map((r) => r.name));
  const pending = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), "utf8");
    // Each migration is one transaction: a half-applied schema is worse than
    // a failed startup.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      run("INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)", file, new Date().toISOString());
      db.exec("COMMIT");
      console.log(`[db] applied ${file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return pending.length;
}

/* --- query helpers -------------------------------------------------------- */

export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function one(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) throw new NotFound(`no row for: ${sql.slice(0, 60)}`);
  return row;
}

/* Wraps fn in a transaction. Nested calls join the outer transaction rather
   than opening a second one, which SQLite will not allow. */
let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

/* Builds "INSERT INTO t (a,b) VALUES (?,?)" from an object, skipping
   undefined so callers can pass sparse records. */
export function insert(table, record) {
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  run(sql, ...keys.map((k) => norm(record[k])));
  return record.id;
}

export function update(table, id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  run(sql, ...keys.map((k) => norm(patch[k])), id);
}

/* node:sqlite binds null, number, string, bigint and Buffer. Booleans are the
   one thing operators' code produces constantly that it will not take. */
function norm(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export class NotFound extends Error {}
