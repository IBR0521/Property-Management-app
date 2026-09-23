/* Closing the books.

   The line before which nothing may post. Until this existed any journal could
   be dated anything, forever, which is fine for one company keeping its own
   records and wrong for a platform: a manager who has reconciled a month,
   filed it and sent statements against it cannot have it change underneath
   them.

   Most of these tests are about refusals, because that is what a close is. The
   two that matter most are the ones nobody would think to write: that a
   *reversal* cannot slip behind the line, because reversals do not go through
   `postJournal` and a guard in one place would have missed them entirely; and
   that closing is refused while the trust account does not reconcile, which is
   the whole point of saying a period is finished. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import {
  postJournal, reverseJournal, ensureChart, assertPeriodOpen, PeriodClosed,
} from "../server/features/accounting.js";
import {
  closePeriod, reopenPeriod, closedThroughOf, closeHistory,
  snapshotReconciliation, reconciliationsFor,
} from "../server/lib/reports/close.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Close Co" });
  await ensureChart(world.companyId);
});

/* A book that reconciles: rent in, owed to the owner, and the owner's ledger
   agreeing. Closing refuses over anything less, which is the point. */
async function soundBook({ date = today(), cents = 100000 } = {}) {
  const jid = await postJournal({
    companyId: world.companyId, date, memo: "rent received",
    splits: [
      { code: "1010", debit: cents, ownerId: world.ownerId },
      { code: "2200", credit: cents, ownerId: world.ownerId },
    ],
  });
  const { insert } = await import("../server/lib/db.js");
  const { id } = await import("../server/lib/ids.js");
  await insert("ledger_entry", {
    id: id(), company_id: world.companyId, owner_id: world.ownerId,
    date, kind: "rent_payment", amount_cents: cents, memo: "rent",
    source: "manual", journal_id: jid, created_at: stamp(),
  });
  /* A connected trust account holding exactly it, so all three legs agree. */
  const itemId = id();
  await insert("bank_item", {
    id: itemId, company_id: world.companyId, provider: "manual",
    institution_name: "Test Bank", status: "active", created_at: stamp(),
  });
  await insert("bank_account", {
    id: id(), company_id: world.companyId, item_id: itemId,
    external_id: `ext-${itemId}`, name: "Trust", mask: "0001",
    type: "depository", balance_cents: cents, is_trust: 1, active: 1,
    created_at: stamp(),
  });
  return jid;
}

/* --- nothing posts behind the line ----------------------------------------- */

describe("a closed period", () => {
  beforeEach(async () => {
    await soundBook({ date: addDays(today(), -40) });
    await closePeriod(world.companyId, { through: addDays(today(), -10), by: "Dana" });
  });

  test("a journal dated inside it is refused, and the message says what to do", async () => {
    await assert.rejects(
      () => postJournal({
        companyId: world.companyId, date: addDays(today(), -20), memo: "late arrival",
        splits: [
          { code: "1010", debit: 5000, ownerId: world.ownerId },
          { code: "2200", credit: 5000, ownerId: world.ownerId },
        ],
      }),
      (err) => {
        assert.ok(err.periodClosed, "it should be identifiable as a closed period");
        assert.match(err.message, /books are closed through/);
        assert.match(err.message, /reopen the period/, "and say how to proceed");
        return true;
      });
  });

  test("a journal dated on the line itself is refused", async () => {
    /* "Closed through" includes the day named. Off by one here means a
       manager who closes the 31st finds the 31st still open. */
    await assert.rejects(
      () => postJournal({
        companyId: world.companyId, date: addDays(today(), -10), memo: "on the line",
        splits: [
          { code: "1010", debit: 5000, ownerId: world.ownerId },
          { code: "2200", credit: 5000, ownerId: world.ownerId },
        ],
      }), /closed through/);
  });

  test("a journal dated after it posts normally", async () => {
    const jid = await postJournal({
      companyId: world.companyId, date: today(), memo: "today",
      splits: [
        { code: "1010", debit: 5000, ownerId: world.ownerId },
        { code: "2200", credit: 5000, ownerId: world.ownerId },
      ],
    });
    assert.ok(jid);
  });

  test("a reversal cannot slip behind the line either", async () => {
    /* The test worth having. `reverseJournal` inserts into `journal` directly
       rather than going through `postJournal`, so a guard in one place would
       have left this open — and a back-dated reversal is precisely how
       somebody would have got round a closed period without meaning to. */
    const jid = await postJournal({
      companyId: world.companyId, date: today(), memo: "to be reversed",
      splits: [
        { code: "1010", debit: 5000, ownerId: world.ownerId },
        { code: "2200", credit: 5000, ownerId: world.ownerId },
      ],
    });

    await assert.rejects(
      () => reverseJournal(jid, {
        companyId: world.companyId, by: "Dana", date: addDays(today(), -20),
      }), /closed through/);
  });

  test("but reversing a journal that sits in a closed period is allowed", async () => {
    /* Ordinary and necessary: the error is in the closed month and the
       correction lands in an open one. Refusing this would leave a mistake
       uncorrectable. */
    const old = await get(
      "SELECT id FROM journal WHERE company_id = ? ORDER BY date LIMIT 1", world.companyId);
    const rev = await reverseJournal(old.id, {
      companyId: world.companyId, by: "Dana", date: today(),
    });
    assert.ok(rev);

    const row = await get("SELECT date FROM journal WHERE id = ?", rev);
    assert.equal(row.date, today(), "the correction is dated when it was made");
  });

  test("an open company is unaffected", async () => {
    /* The guard is per company. One tenant closing their books must not
       refuse another tenant's postings. */
    const other = await f.makeWorld({ name: "Open Co" });
    await ensureChart(other.companyId);
    const jid = await postJournal({
      companyId: other.companyId, date: addDays(today(), -20), memo: "fine here",
      splits: [
        { code: "1010", debit: 5000, ownerId: other.ownerId },
        { code: "2200", credit: 5000, ownerId: other.ownerId },
      ],
    });
    assert.ok(jid);
  });
});

describe("a company that has never closed", () => {
  test("anything may be posted at any date", async () => {
    assert.equal(await closedThroughOf(world.companyId), null);
    const jid = await postJournal({
      companyId: world.companyId, date: "2019-01-01", memo: "long ago",
      splits: [
        { code: "1010", debit: 5000, ownerId: world.ownerId },
        { code: "2200", credit: 5000, ownerId: world.ownerId },
      ],
    });
    assert.ok(jid, "never closed is a perfectly good state to be in");
  });

  test("assertPeriodOpen is a no-op", async () => {
    await assertPeriodOpen(world.companyId, "1999-01-01");
  });
});

/* --- closing ---------------------------------------------------------------- */

describe("closing", () => {
  test("it refuses while the trust account does not reconcile", async () => {
    /* The opinionated part, and the reason the reconciliation was built
       first. A close says "this period is finished and correct". A period
       whose client funds do not add up is not correct. */
    await postJournal({
      companyId: world.companyId, date: today(), memo: "fees against nothing",
      splits: [
        { code: "2200", debit: 5000, ownerId: world.ownerId },
        { code: "4200", credit: 5000, ownerId: world.ownerId },
      ],
    });

    await assert.rejects(
      () => closePeriod(world.companyId, { through: today(), by: "Dana" }),
      /does not reconcile/);
    assert.equal(await closedThroughOf(world.companyId), null);
  });

  test("it can be closed as an exception, and that is recorded as what it is", async () => {
    /* A manager may have a reason this application cannot see. Forcing is
       allowed and is never silent. */
    await postJournal({
      companyId: world.companyId, date: today(), memo: "fees against nothing",
      splits: [
        { code: "2200", debit: 5000, ownerId: world.ownerId },
        { code: "4200", credit: 5000, ownerId: world.ownerId },
      ],
    });

    const res = await closePeriod(world.companyId, {
      through: today(), by: "Dana", force: true, note: "known timing difference",
    });
    assert.equal(res.forced, true);

    const history = await closeHistory(world.companyId);
    assert.equal(history[0].action, "closed_as_exception");
    assert.equal(history[0].detail.forced, true);
    assert.equal(history[0].detail.note, "known timing difference");
  });

  test("the reconciliation is stored as it read on the day", async () => {
    /* A regulator asks for the reconciliation as at the period end, as it was
       produced — not for what it reconciles to now. */
    await soundBook({ date: addDays(today(), -5), cents: 100000 });
    await closePeriod(world.companyId, { through: today(), by: "Dana" });

    const saved = await reconciliationsFor(world.companyId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].balanced, 1);
    assert.equal(Number(saved[0].book_cents), 100000);
    assert.equal(saved[0].signed_by, "Dana");

    /* Post afterwards. The snapshot must not move. */
    await postJournal({
      companyId: world.companyId, date: addDays(today(), 1), memo: "next month",
      splits: [
        { code: "1010", debit: 70000, ownerId: world.ownerId },
        { code: "2200", credit: 70000, ownerId: world.ownerId },
      ],
    });

    const after = await reconciliationsFor(world.companyId);
    assert.equal(Number(after[0].book_cents), 100000,
      "a stored reconciliation is a record, not a live query");
  });

  test("a signed reconciliation is not replaced", async () => {
    await soundBook();
    await closePeriod(world.companyId, { through: today(), by: "Dana" });
    await assert.rejects(
      () => snapshotReconciliation(world.companyId, { asOf: today(), by: "Marcus" }),
      /already been signed/);
  });

  test("the future cannot be closed", async () => {
    await soundBook();
    await assert.rejects(
      () => closePeriod(world.companyId, { through: addDays(today(), 30), by: "Dana" }),
      /has not happened yet/);
  });

  test("closing only moves the line forward", async () => {
    await soundBook({ date: addDays(today(), -40) });
    await closePeriod(world.companyId, { through: addDays(today(), -10), by: "Dana" });
    await assert.rejects(
      () => closePeriod(world.companyId, { through: addDays(today(), -20), by: "Dana" }),
      /already closed through/);
  });
});

/* --- reopening --------------------------------------------------------------- */

describe("reopening", () => {
  beforeEach(async () => {
    await soundBook({ date: addDays(today(), -40) });
    await closePeriod(world.companyId, { through: addDays(today(), -10), by: "Dana" });
  });

  test("it needs a reason, and a token one will not do", async () => {
    /* The field somebody reads a year later when they are working out why a
       finished month changed. Blank makes the audit entry worthless. */
    for (const reason of [undefined, "", "   ", "oops"]) {
      await assert.rejects(
        () => reopenPeriod(world.companyId, { by: "Dana", reason }),
        /needs a reason/, String(reason));
    }
    assert.ok(await closedThroughOf(world.companyId), "and nothing moved");
  });

  test("it is written down, with who and why", async () => {
    await reopenPeriod(world.companyId, {
      by: "Dana", reason: "Vendor invoice arrived dated in the closed month",
    });

    assert.equal(await closedThroughOf(world.companyId), null);
    const history = await closeHistory(world.companyId);
    assert.equal(history[0].action, "reopened");
    assert.equal(history[0].actor, "Dana");
    assert.match(history[0].detail.reason, /Vendor invoice/);
  });

  test("afterwards the period accepts postings again", async () => {
    await reopenPeriod(world.companyId, { by: "Dana", reason: "correcting a misposting" });
    const jid = await postJournal({
      companyId: world.companyId, date: addDays(today(), -20), memo: "the correction",
      splits: [
        { code: "1010", debit: 5000, ownerId: world.ownerId },
        { code: "2200", credit: 5000, ownerId: world.ownerId },
      ],
    });
    assert.ok(jid);
  });

  test("it can move the line back rather than remove it", async () => {
    await reopenPeriod(world.companyId, {
      through: addDays(today(), -30), by: "Dana", reason: "reopening one month only",
    });
    assert.equal(await closedThroughOf(world.companyId), addDays(today(), -30));
  });

  test("it cannot move the line forward", async () => {
    await assert.rejects(
      () => reopenPeriod(world.companyId, {
        through: today(), by: "Dana", reason: "trying to close by reopening",
      }), /has to be earlier/);
  });

  test("reopening what was never closed is refused", async () => {
    const other = await f.makeWorld({ name: "Never Closed Co" });
    await assert.rejects(
      () => reopenPeriod(other.companyId, { by: "Dana", reason: "nothing to do here" }),
      /not closed/);
  });
});
