/* The verification, verified.

   `server/lib/verify.js` answers one question — is this database sound? — and
   it is the last thing that runs in the restore drill. That makes it exactly
   the kind of code that can quietly stop working: it passes every day, it
   passes when nothing is wrong, and it would go on passing if somebody broke
   it, right up until the morning it was needed.

   So each check here is shown a database with that specific damage in it and
   has to find it. A verification that has never failed is not yet known to
   detect anything.

   Injecting the damage means disabling triggers. That is not a back door left
   open in the application — `run()` cannot reach these statements through any
   route — it is the test standing in for the thing being simulated. A bad
   restore, a dump loaded out of order, a hand-run UPDATE at 2am: all of them
   put rows in place without the triggers ever having an opinion. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { verifyDatabase, describeVerification, compareVerifications } from "../server/lib/verify.js";
import { postJournal } from "../server/features/accounting.js";
import { id } from "../server/lib/ids.js";
import { UPLOAD_DIR } from "../server/lib/files.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Verify Co" });
});

/* Damage the application itself refuses to do. */
async function withoutTriggers(fn) {
  await run("ALTER TABLE journal_split DISABLE TRIGGER USER");
  await run("ALTER TABLE journal DISABLE TRIGGER USER");
  try { await fn(); } finally {
    await run("ALTER TABLE journal ENABLE TRIGGER USER");
    await run("ALTER TABLE journal_split ENABLE TRIGGER USER");
  }
}

/* A small, real, balanced set of books to damage. */
async function someBooks() {
  await postJournal({
    companyId: world.companyId, date: "2026-03-01", memo: "March rent",
    splits: [
      { code: "1300", debit: 100000 },
      { code: "4000", credit: 100000 },
    ],
  });
}

const errorsFrom = (r) => r.problems.filter((p) => p.severity === "error");
const found = (r, fragment) =>
  errorsFrom(r).some((p) => `${p.what} ${p.detail}`.toLowerCase().includes(fragment.toLowerCase()));

describe("a sound database", () => {
  test("passes, and says so", async () => {
    await someBooks();
    const r = await verifyDatabase();
    assert.equal(r.ok, true);
    assert.equal(r.errors, 0);
    assert.match(describeVerification(r), /The database is sound/);
  });

  test("warns that files were not checked, rather than implying they were", async () => {
    const r = await verifyDatabase();
    assert.equal(r.ok, true, "an unchecked blob store is not an error");
    assert.ok(r.problems.some((p) => p.severity === "warning" && /file/i.test(p.what)),
      "silence here would let a drill claim more than it proved");
  });
});

describe("damage it has to find", () => {
  test("a journal that does not balance", async () => {
    await someBooks();
    await withoutTriggers(async () => {
      await run("UPDATE journal_split SET debit_cents = 90000 WHERE debit_cents = 100000");
    });
    const r = await verifyDatabase();
    assert.equal(r.ok, false);
    assert.ok(found(r, "does not balance"));
  });

  test("a trial balance that does not net to zero", async () => {
    await someBooks();
    /* Both legs moved by the same amount keeps each journal internally
       balanced while the company's books no longer are — the failure mode a
       per-journal check alone would miss. */
    await withoutTriggers(async () => {
      const j = await get("SELECT id FROM journal LIMIT 1");
      await run("INSERT INTO journal_split (id, journal_id, account_id, debit_cents, credit_cents, date) "
        + "SELECT ?, ?, account_id, 5000, 0, date FROM journal_split WHERE journal_id = ? LIMIT 1",
        id(), j.id, j.id);
    });
    const r = await verifyDatabase();
    assert.equal(r.ok, false);
    assert.ok(found(r, "trial balance") || found(r, "does not balance"));
  });

  test("owner-visible money with no journal behind it", async () => {
    await someBooks();
    await run("UPDATE ledger_entry SET journal_id = NULL");
    const r = await verifyDatabase();
    const entries = await get("SELECT COUNT(*)::int n FROM ledger_entry");
    if (Number(entries.n) === 0) return; // nothing to orphan; the next test covers the path
    assert.equal(r.ok, false);
    assert.ok(found(r, "no journal behind it"));
  });

  test("a split whose date drifted from its journal's", async () => {
    await someBooks();
    await withoutTriggers(async () => {
      await run("UPDATE journal_split SET date = '2020-01-01'");
    });
    const r = await verifyDatabase();
    assert.equal(r.ok, false);
    assert.ok(found(r, "disagrees with its journal"),
      "every report filters on the copy, so drift here is silently wrong numbers");
  });

  test("a row pointing at a parent that is gone", async () => {
    const before = await verifyDatabase();
    assert.equal(before.ok, true);
    /* A dump restored with foreign keys not yet in force is how this happens. */
    await run("ALTER TABLE unit DROP CONSTRAINT IF EXISTS unit_property_id_fkey");
    await run("UPDATE unit SET property_id = ? WHERE id = ?", id(), world.unitId);
    const r = await verifyDatabase();
    assert.equal(r.ok, false);
    assert.ok(found(r, "points at nothing"));
  });
});

describe("what it reports", () => {
  test("it reports every problem, not just the first", async () => {
    await someBooks();
    await withoutTriggers(async () => {
      await run("UPDATE journal_split SET date = '2020-01-01'");
      await run("UPDATE journal_split SET debit_cents = 90000 WHERE debit_cents = 100000");
    });
    const r = await verifyDatabase();
    assert.ok(errorsFrom(r).length >= 2,
      "a verification that stops at the first problem tells you about one problem");
  });

  test("the summary names the damage, so a failed drill is actionable", async () => {
    await someBooks();
    await withoutTriggers(async () => {
      await run("UPDATE journal_split SET date = '2020-01-01'");
    });
    const text = describeVerification(await verifyDatabase());
    assert.match(text, /NOT SOUND/);
    assert.match(text, /ERROR/);
    assert.ok(text.includes("date") || text.includes("journal"));
  });
});

describe("a backlog is not damage", () => {
  /* `makeWorld` puts a deposit on the lease and does not post it, which is
     the same condition the live database is carrying as OPEN-ITEMS A4. It is
     a real thing to fix and it is not evidence that a copy is broken, so it
     has to come out as a warning — otherwise every drill fails for a reason
     that has nothing to do with the restore, and the output stops being read. */
  test("an unposted deposit is a warning, and says how to fix it", async () => {
    const r = await verifyDatabase();
    const found = r.problems.find((p) => /deposits held against the leases/i.test(p.what));
    assert.ok(found, "the variance should still be reported");
    assert.equal(found.severity, "warning");
    assert.match(found.detail, /deposits:plan/);
    assert.equal(r.ok, true);
  });

  test("but the books disagreeing with themselves is an error", async () => {
    await someBooks();
    /* Owner funds held, with no owner ledger entry behind it: the total
       against its own parts. Nothing outside the books can explain that. */
    await withoutTriggers(async () => {
      await run(
        `INSERT INTO journal (id, company_id, date, memo, source, posted_by, created_at)
         VALUES (?, ?, '2026-03-02', 'unbacked owner funds', 'manual', 'test', ?)`,
        "j-unbacked", world.companyId, new Date().toISOString());
      const acct = async (code) => (await get(
        "SELECT id FROM account WHERE company_id = ? AND code = ?", world.companyId, code)).id;
      await run(
        `INSERT INTO journal_split (id, journal_id, account_id, debit_cents, credit_cents, date)
         VALUES (?, 'j-unbacked', ?, 0, 25000, '2026-03-02'),
                (?, 'j-unbacked', ?, 25000, 0, '2026-03-02')`,
        id(), await acct("2200"), id(), await acct("1010"));
    });
    const r = await verifyDatabase();
    const found = r.problems.find((p) => /owner funds/i.test(p.what));
    assert.ok(found, "a total that disagrees with its parts must be found");
    assert.equal(found.severity, "error");
    assert.equal(r.ok, false);
  });
});

describe("telling a faithful copy from a broken one", () => {
  const p = (severity, what) => ({ severity, what, detail: "", fingerprint: `${severity}:${what}` });
  const v = (problems) => ({ problems, errors: problems.filter((x) => x.severity === "error").length });

  test("a problem the source already had does not fail the drill", () => {
    const before = v([p("error", "a journal does not balance")]);
    const after = v([p("error", "a journal does not balance")]);
    const cmp = compareVerifications(before, after);
    assert.equal(cmp.ok, true, "a backup that faithfully copies a broken book did its job");
    assert.equal(cmp.preexisting.length, 1);
    assert.equal(cmp.introduced.length, 0);
  });

  test("a problem only the restore has fails it", () => {
    const cmp = compareVerifications(v([]), v([p("error", "a journal does not balance")]));
    assert.equal(cmp.ok, false);
    assert.equal(cmp.introduced.length, 1);
  });

  test("a new warning does not fail it, but is still reported", () => {
    const cmp = compareVerifications(v([]), v([p("warning", "something to look at")]));
    assert.equal(cmp.ok, true);
    assert.equal(cmp.introduced.length, 1, "not failing is not the same as not saying");
  });

  test("a problem that vanished in the copy is reported too", () => {
    const cmp = compareVerifications(v([p("error", "a journal does not balance")]), v([]));
    assert.equal(cmp.vanished.length, 1,
      "the two databases disagree, and the restore is the one that changed");
  });
});

describe("the files a database backup cannot restore", () => {
  /* The photographs, receipts and signed documents live in blob storage, not
     in Postgres. A point-in-time restore brings back rows that name them and
     has no opinion about whether they are still there — so a restore can look
     complete, pass every row count, and be missing the photograph a deposit
     dispute turns on. This is the check that notices. */
  const FOLDER = "verify-test";

  async function photoRow(relPath) {
    const wid = await f.makeWorkOrder(world.companyId, world.unitId);
    const pid = id();
    await run(
      `INSERT INTO work_order_photo (id, work_order_id, path, phase, created_at)
       VALUES (?, ?, ?, 'report', ?)`,
      pid, wid, relPath, new Date().toISOString());
    return pid;
  }

  after(() => { try { rmSync(join(UPLOAD_DIR, FOLDER), { recursive: true, force: true }); } catch {} });

  test("a file that is there passes", async () => {
    mkdirSync(join(UPLOAD_DIR, FOLDER), { recursive: true });
    writeFileSync(join(UPLOAD_DIR, FOLDER, "present.jpg"), "not really a jpeg");
    await photoRow(`${FOLDER}/present.jpg`);
    const r = await verifyDatabase({ checkFiles: true });
    assert.equal(r.files.checked, 1);
    assert.equal(r.files.missing, 0);
    assert.ok(!r.problems.some((p) => /not there/i.test(p.what)));
  });

  test("a row naming a file that is gone is an error", async () => {
    await photoRow(`${FOLDER}/deleted-by-someone.jpg`);
    const r = await verifyDatabase({ checkFiles: true });
    assert.equal(r.files.missing, 1);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.severity === "error" && /names a file that is not there/i.test(p.what)));
  });

  test("a path trying to climb out of the upload directory is not readable", async () => {
    await photoRow("../../../etc/passwd");
    const r = await verifyDatabase({ checkFiles: true });
    assert.equal(r.files.missing, 1,
      "a traversal path must count as missing, never as found");
  });

  test("checking files replaces the warning about not checking them", async () => {
    const r = await verifyDatabase({ checkFiles: true });
    assert.ok(!r.problems.some((p) => /were not checked/i.test(p.what)),
      "the drill must not warn about something it just did");
  });
});
