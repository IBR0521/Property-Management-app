/* The seed actually runs.

   Nothing exercised this file, and it rotted quietly through two phases. Three
   columns went NOT NULL in migrations — `company.slug`, `unit.report_token`,
   `lease.pay_token` — and the seed populated none of them, so `npm run seed`
   died on its first insert. That was discovered by running it against a real
   database, which is the worst place to discover it.

   It had also drifted in a quieter way: twenty ledger entries and no journals,
   $12,677 of owner-visible money with nothing behind it, and an accounting
   screen reporting a discrepancy on a fresh install.

   So this runs the real script as a child process, the way a person does, and
   then checks the shape of what it produced. It is slower than the rest of the
   suite and it is the only test here that would have caught any of the above.
*/
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { parity, unpostedEntries } from "../server/lib/ledger.js";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;

let output = "";

before(async () => {
  await freshDatabase();
  await truncateAll();
  try {
    const res = await run(
      process.execPath, ["--env-file=.env.test", "server/seed.js"],
      /* Generous, because this runs last in a suite that has had the database
         busy for an hour and a half. It took twenty seconds on its own and
         failed on a two-minute limit inside the full run, which reported as
         a suite that did not pass and said nothing about why. */
      { cwd: ROOT, timeout: 300_000 });
    output = res.stdout;
  } catch (err) {
    /* The reason, not just the failure. A `before` that throws marks the
       whole file as not passing, and the useful part — what the child said
       before it died — is on the error rather than in the report. */
    throw new Error(
      `the seed did not run: ${err.message}\n`
      + `--- its output ---\n${err.stdout || "(none)"}\n`
      + `--- its errors ---\n${err.stderr || "(none)"}`);
  }
});
after(async () => { await truncateAll(); await closeDb(); });

describe("npm run seed", () => {
  test("it completes, which is not a given", () => {
    /* If the child had exited non-zero, `before` would have thrown and every
       test below would report as failed. This asserts the happy path is
       actually the path that ran. */
    assert.match(output, /Seeded Leafridge Property Management/);
  });

  test("every NOT NULL column with no default is populated", async () => {
    /* The general form of the bug, rather than the three instances of it.
       Anything added later that the seed forgets fails here. */
    const missing = await all(`
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.is_nullable = 'NO' AND c.column_default IS NULL`);

    const holes = [];
    for (const { table_name, column_name } of missing) {
      const row = await get(
        `SELECT COUNT(*)::int AS n FROM public."${table_name}" WHERE "${column_name}" IS NULL`);
      if (Number(row.n) > 0) holes.push(`${table_name}.${column_name}`);
    }
    assert.deepEqual(holes, [], "columns the database requires and the seed left empty");
  });

  test("the company has a slug, because its public pages are addressed by it", async () => {
    const company = await get("SELECT * FROM company");
    assert.ok(company.slug, "/c/:slug is how a tenant reaches the report page");
    assert.match(company.slug, /^[a-z0-9-]+$/);
  });

  test("every unit has a QR token", async () => {
    /* A unit without one is a unit nobody can report a problem from, which is
       the whole product. */
    const units = await all("SELECT id, report_token FROM unit");
    assert.ok(units.length >= 8);
    for (const u of units) {
      assert.ok(u.report_token, `unit ${u.id} has no sticker`);
      assert.ok(u.report_token.length >= 8);
    }
  });

  test("every lease can take a payment", async () => {
    const leases = await all("SELECT id, pay_token FROM lease");
    for (const l of leases) assert.ok(l.pay_token, `lease ${l.id} has no pay token`);
  });

  test("the two books agree", async () => {
    const company = await get("SELECT id FROM company");
    const p = await parity(company.id);
    if (!p.inParity) {
      const orphans = await unpostedEntries(company.id);
      assert.fail(
        `${p.unposted} entries totalling ${(p.unpostedCents / 100).toFixed(2)} have no journal `
        + `behind them, e.g. ${orphans.slice(0, 3).map((e) => e.memo).join("; ")}`);
    }
    assert.ok(p.entries > 0, "a seed with no money in it proves nothing");
  });

  test("the journal balances", async () => {
    const row = await get(
      `SELECT COALESCE(SUM(debit_cents), 0)::bigint AS d,
              COALESCE(SUM(credit_cents), 0)::bigint AS c FROM journal_split`);
    assert.equal(Number(row.d), Number(row.c));
    assert.ok(Number(row.d) > 0);
  });

  test("rent is in trust cash, not the company's own", async () => {
    const row = await get(
      `SELECT COALESCE(SUM(s.debit_cents) - SUM(s.credit_cents), 0)::bigint AS c
         FROM journal_split s JOIN account a ON a.id = s.account_id
        WHERE a.code = '1010'`);
    assert.ok(Number(row.c) > 0, "client money is distinguishable from the company's");
  });

  test("it produces something to look at in every feature", async () => {
    /* The point of the seed: a fresh install where each screen has real work
       on it rather than an empty state. */
    for (const [table, least] of [
      ["owner", 3], ["property", 5], ["unit", 8], ["lease", 7],
      ["vendor", 7], ["work_order", 4], ["delinquency", 1], ["obligation", 1],
    ]) {
      const row = await get(`SELECT COUNT(*)::int AS n FROM public."${table}"`);
      assert.ok(Number(row.n) >= least, `${table} has ${row.n}, expected at least ${least}`);
    }
  });

  test("the password is generated, not written in the file", async () => {
    /* A fixed password in a seed script is a published password the moment
       the repository is public, and this one was used on a live database. */
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../server/seed.js", import.meta.url), "utf8"));
    assert.match(src, /randomBytes\(\d+\)\.toString\("base64url"\)/);

    const printed = output.match(/dana@leafridgepm\.test\s+(\S+)/);
    assert.ok(printed, "the password is printed once so it can be written down");
    assert.ok(!src.includes(printed[1]), "and it is not in the source");
  });

  test("a second run refuses rather than duplicating the portfolio", async () => {
    const res = await run(
      process.execPath, ["--env-file=.env.test", "server/seed.js"],
      { cwd: ROOT, timeout: 120_000 });
    assert.match(res.stdout, /Already seeded/);
    const row = await get("SELECT COUNT(*)::int AS n FROM company");
    assert.equal(Number(row.n), 1);
  });
});
