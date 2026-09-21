/* A database the suite owns completely.

   Every run drops the public schema and rebuilds it from the migrations. That
   is slower than truncating tables and it is the right trade: a suite that
   inherits yesterday's schema passes against a shape production does not have,
   which is the single most expensive kind of green build.

   config.js refuses to start if TEST_DATABASE_URL is missing or equal to
   DATABASE_URL, so there is no path from here to a real database. */
import { db, ready, resetMigrationCache, closeDb, run, all, get } from "../../server/lib/db.js";

let prepared = null;

export async function freshDatabase() {
  if (prepared) return prepared;
  prepared = (async () => {
    /* CASCADE takes the extensions with it, which is why pgcrypto is created
       by the migration runner rather than by a migration — it has to come back
       every time this runs. */
    await db.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db.unsafe("CREATE SCHEMA public");
    resetMigrationCache();
    await ready();
    return true;
  })();
  return prepared;
}

/* Between test files, not between runs: keeps the schema, empties the data.
   Ordered by dependency is unnecessary — one TRUNCATE ... CASCADE over every
   table is atomic and does not care. */
export async function truncateAll() {
  const rows = await all(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migration'`);
  if (!rows.length) return;
  const list = rows.map((r) => `public."${r.tablename}"`).join(", ");
  await db.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export { db, run, all, get, closeDb };
