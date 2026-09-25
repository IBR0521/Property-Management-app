/* Apply pending migrations, deliberately.

   There was no way to do this. `migrate()` ran from the cron and from the
   seeder, so the only ways to bring a deployed schema up to date were to wait
   for 09:00 or to reseed — and reseeding is not something you do to a database
   with a customer's ledger in it. api/index.js now migrates on the request
   path as well, which closes the hole, but a schema change that runs inside a
   15-second request nobody is watching is still not how you want to find out
   whether it works.

   So: run this from a laptop, against whatever DATABASE_URL points at, before
   or after the deploy. It says what it is about to do and what it did.

       node --env-file=.env.production.local scripts/migrate.js
       node --env-file=.env.production.local scripts/migrate.js --dry-run

   `npm run migrate` is the same thing for an environment that already carries
   DATABASE_URL; it does not load an env file for you.

   It is safe to run twice; a migration already recorded is skipped. */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dry = process.argv.includes("--dry-run");

const { DATABASE_URL, assertConfig } = await import("../server/lib/config.js");
assertConfig({ exitOnFailure: true });

const { db, all, migrate, closeDb } = await import("../server/lib/db.js");

/* Which database, in a form that can be pasted into a message. */
const where = (() => {
  try {
    const u = new URL(DATABASE_URL);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch { return "(unparseable)"; }
})();

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "migrations");
const onDisk = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

await db.unsafe(`CREATE TABLE IF NOT EXISTS schema_migration (
  name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
const done = new Set((await all("SELECT name FROM schema_migration")).map((r) => r.name));
const pending = onDisk.filter((f) => !done.has(f));

console.log(`\n  database   ${where}`);
console.log(`  on disk    ${onDisk.length} migrations`);
console.log(`  applied    ${done.size}`);
console.log(`  pending    ${pending.length}`);

/* A migration recorded in the database that is not in this checkout means the
   deployed code is older than the schema. Worth saying out loud: it is the
   shape of a rolled-back deploy, and the next thing that happens is a query
   against a column this code does not know about. */
const unknown = [...done].filter((n) => !onDisk.includes(n)).sort();
if (unknown.length) {
  console.log(`\n  ! ${unknown.length} applied migration(s) are not in this checkout:`);
  for (const n of unknown) console.log(`      ${n}`);
  console.log(`    This database is ahead of this code. Deploying it would run`);
  console.log(`    queries against a schema newer than the queries expect.`);
}

if (!pending.length) {
  console.log(`\n  Nothing to do.\n`);
  await closeDb();
  process.exit(0);
}

for (const f of pending) console.log(`      ${f}`);

if (dry) {
  console.log(`\n  --dry-run: nothing was applied.\n`);
  await closeDb();
  process.exit(0);
}

console.log("");
try {
  const n = await migrate();
  console.log(`\n  Applied ${n}. Schema is up to date.\n`);
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n`);

  /* The one failure worth explaining, because the message points nowhere.

     Each migration now runs in a transaction that also records it, so it
     either applies and is recorded or neither. A database that predates that
     change can still be holding the older, broken state: the DDL committed and
     the bookkeeping row did not, because something died between the two
     statements. Every run since has re-run the migration and failed on
     "already exists", and will do so forever.

     Not repaired automatically. Marking a migration applied without having
     applied it is exactly the class of thing that should need a person to look
     first — so this prints the one command that fixes it and stops. */
  const DUPLICATE = new Set(["42P07", "42701", "42710", "42723", "42P06", "23505"]);
  if (DUPLICATE.has(err.code)) {
    const stuck = pending[0];
    console.error(`  That is a "already exists" error (SQLSTATE ${err.code}), which for a`);
    console.error(`  forward-only migration means ${stuck}`);
    console.error(`  was applied to this database but never recorded — a process killed`);
    console.error(`  between the schema change and the row that records it.\n`);
    console.error(`  Check that the objects it creates are really there, then record it:\n`);
    console.error(`    INSERT INTO schema_migration (name, applied_at)`);
    console.error(`    VALUES ('${stuck}', now()::text);\n`);
    console.error(`  Then run this again. Later migrations may need the same.\n`);
  }
  await closeDb();
  process.exit(1);
}
await closeDb();
