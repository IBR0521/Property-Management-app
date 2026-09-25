/* Applying migrations, which is the one thing every other test file assumes
   has already happened correctly.

   Both cases here are faults that were live in production. Neither was
   reachable from the suite as it stood, because the suite migrates once, in a
   single process, against a database nobody else is touching — which is the
   only condition under which the old runner was correct. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { migrate, ready, resetMigrationCache, db, all, closeDb } from "../server/lib/db.js";
import { IS_TEST_DATABASE } from "../server/lib/config.js";
import { freshDatabase, truncateAll } from "./helpers/db.js";

const COUNT = readdirSync(new URL("../server/migrations", import.meta.url))
  .filter((f) => f.endsWith(".sql")).length;

/* This file rebuilds the schema from nothing, repeatedly, so it repeats the
   two-condition guard from helpers/db.js rather than assuming it. The reason
   that guard is not centralised is written down there: a destructive call
   checks for itself. */
async function emptySchema() {
  assert.ok(IS_TEST_DATABASE, "refusing to drop: this pool is not the test database");
  const [{ name }] = await db`SELECT current_database() AS name`;
  assert.match(name, /_test$|^test_/, `refusing to drop database "${name}"`);
  await db.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await db.unsafe("CREATE SCHEMA public");
  resetMigrationCache();
}

before(async () => {
  await freshDatabase();
});

/* Whatever happened above, the next file gets a complete, empty schema. */
after(async () => {
  resetMigrationCache();
  await ready();
  await truncateAll();
  await closeDb();
});

describe("several processes migrating the same database at once", () => {
  test("every caller succeeds and every migration is applied once", async () => {
    /* A deploy is not one process. It is as many concurrent instances as there
       are requests in the first second, each with a cold module cache, each
       reading the same list of pending migrations and each running it.

       Measured against the runner this replaces: six callers, one succeeded,
       five failed with `relation "deposit_return" already exists` and
       `duplicate key value violates unique constraint
       "pg_type_typname_nsp_index"`. Those five are requests that answered 500,
       and because the resolved promise was cached either way, the instances
       that lost went on failing for as long as they lived. */
    await emptySchema();

    const callers = 6;
    const settled = await Promise.allSettled(
      Array.from({ length: callers }, () => migrate()));

    const failed = settled.filter((r) => r.status === "rejected");
    assert.deepEqual(failed.map((r) => r.reason.message), [],
      "a concurrent caller must wait for the lock, not collide");

    const total = settled.reduce((n, r) => n + r.value, 0);
    assert.equal(total, COUNT,
      `${COUNT} migrations must be applied exactly once between all callers`);

    const dupes = await all(`SELECT name FROM schema_migration
      GROUP BY name HAVING count(*) > 1`);
    assert.deepEqual(dupes, [], "a migration must not be recorded twice");

    const [{ n }] = await all("SELECT count(*)::int AS n FROM schema_migration");
    assert.equal(n, COUNT);
  });
});

describe("a migration and the row that records it", () => {
  test("a failure leaves neither behind", async () => {
    /* The two used to be separate statements. Postgres wrapped the file in an
       implicit transaction, so the schema change was atomic on its own — but
       the INSERT that recorded it was not part of that, and anything between
       the two left the migration applied and unrecorded. Every run afterwards
       re-ran it and failed on "already exists", permanently.

       Provoked here from the other side: a table already standing in the way
       of the first migration. What matters is that nothing is recorded, so the
       state stays repeatable rather than becoming a database that can never
       migrate again. */
    await emptySchema();
    await db.unsafe(`CREATE TABLE company (id TEXT PRIMARY KEY)`);

    await assert.rejects(() => migrate(), /already exists/);

    const rows = await all(
      "SELECT name FROM schema_migration WHERE name LIKE '001%'");
    assert.deepEqual(rows, [],
      "a migration that failed must not be recorded as applied");
  });

  test("a failed run is not remembered once the cause is gone", async () => {
    /* ready() cached the promise whatever became of it, so one failure was
       final for the life of the process — on a serverless instance, every
       request it went on to serve, long after the cause had passed.

       The obstruction is removed between the two calls. Under the old runner
       the second call returned the same rejected promise and the schema was
       never built. */
    await emptySchema();
    await db.unsafe(`CREATE TABLE company (id TEXT PRIMARY KEY)`);

    await assert.rejects(() => ready(), /already exists/);

    await db.unsafe(`DROP TABLE company`);
    await ready();

    const [{ n }] = await all("SELECT count(*)::int AS n FROM schema_migration");
    assert.equal(n, COUNT, "the second attempt must actually run");
  });
});
