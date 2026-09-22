/* A database the suite owns completely.

   Every run drops the public schema and rebuilds it from the migrations. That
   is slower than truncating tables and it is the right trade: a suite that
   inherits yesterday's schema passes against a shape production does not have,
   which is the single most expensive kind of green build.

   Which makes every call in this file destructive, so each one checks for
   itself that the database it is about to flatten is disposable. See
   `refuseUnlessDisposable` below for why that is not left to config.js. */
import { db, ready, resetMigrationCache, closeDb, run, all, get } from "../../server/lib/db.js";
import { IS_TEST_DATABASE } from "../../server/lib/config.js";

/* The drop guards itself.

   This used to rely on config.js refusing to hand over a production URL when
   NODE_ENV=test. That protects the case where somebody sets NODE_ENV and
   forgets TEST_DATABASE_URL. It does nothing for the opposite mistake —
   loading the production env file and *not* setting NODE_ENV — because then
   IS_TEST is false, config hands over DATABASE_URL exactly as asked, and the
   next line drops the real schema. That happened, and it cost the dataset.

   So the destructive call checks for itself rather than trusting that
   somebody upstream already did. Two independent conditions, both of which
   have to hold: the pool was built from TEST_DATABASE_URL, and the database
   it actually connected to is named like a test database on a local host. */
async function refuseUnlessDisposable(operation) {
  if (!IS_TEST_DATABASE) {
    throw new Error(
      `${operation} refused: this pool was not built from TEST_DATABASE_URL.\n` +
      `  Run the suite with NODE_ENV=test and TEST_DATABASE_URL set, e.g.\n` +
      `  NODE_ENV=test TEST_DATABASE_URL=postgresql://localhost:5432/propops_test npm test`);
  }
  const [{ name, host }] = await db`
    SELECT current_database() AS name, COALESCE(inet_server_addr()::text, 'local') AS host`;
  if (!/_test$|^test_/.test(name)) {
    throw new Error(
      `${operation} refused: connected to database "${name}", which is not named like a `
      + `throwaway. Name a test database something ending in _test.`);
  }
  return { name, host };
}

let prepared = null;

export async function freshDatabase() {
  if (prepared) return prepared;
  prepared = (async () => {
    await refuseUnlessDisposable("DROP SCHEMA");
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
  await refuseUnlessDisposable("TRUNCATE");
  const rows = await all(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migration'`);
  if (!rows.length) return;
  const list = rows.map((r) => `public."${r.tablename}"`).join(", ");
  await db.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export { db, run, all, get, closeDb };
