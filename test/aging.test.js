/* Aged receivables, and what "current" means.

   The decision this file exists to pin down: **rent is billed in advance, so
   aging runs from the due date, not the charge date.** A commercial invoice is
   raised after the work is done; rent for October is charged before October
   happens. Aging from the charge would put every tenant a day overdue on the
   day their rent falls due.

   And **grace is a fee-waiver window, not a change to when money is owed.** An
   accountant ages from the due date regardless; a manager must not chase
   somebody on day three of a five-day grace. Those are two questions of one
   report, so grace is a flag on the row rather than a sixth bucket — the
   accounting view stays correct and the operational view is one column away. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today, addDays } from "../server/lib/dates.js";
import { ensureChart, postJournal } from "../server/features/accounting.js";
import { chargeRent } from "../server/lib/rentcharge.js";
import { postMoney } from "../server/lib/ledger.js";
import { agedReceivables, agingTiesToLedger, BUCKETS } from "../server/lib/reports/receivable.js";

let world;
const RENT = 100000;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Aging Co" });
  await ensureChart(world.companyId);
  await run(
    "UPDATE lease SET rent_cents = ?, rent_due_day = ?, grace_days = ?, start_date = ? WHERE id = ?",
    RENT, 1, 5, "2026-01-01", world.leaseId);
});

const charge = (period) => chargeRent(world.companyId, { period });

const pay = (cents, date) => postMoney({
  companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
  unitId: world.unitId, leaseId: world.leaseId, date,
  kind: "rent_payment", amountCents: cents, memo: "rent", source: "manual", postedBy: "test",
});

const aged = (asOf) => agedReceivables(world.companyId, { asOf });

/* --- what current means -------------------------------------------------------- */

describe("current", () => {
  test("rent charged and not yet due is current, not overdue", async () => {
    /* The decision. A charge is posted at the start of the period and falls
       due on the lease's own rent day, so rent due on the fifteenth is
       genuinely current for the first two weeks — and a report that could
       not say so would be hiding money that is going to arrive. */
    await run("UPDATE lease SET rent_due_day = ? WHERE id = ?", 15, world.leaseId);
    await charge("2026-06");
    const r = await aged("2026-06-05");

    assert.equal(r.totals.current, RENT);
    assert.equal(r.overdueCents, 0);
  });

  test("on the day it is due it is still current", async () => {
    /* Due today is not late today. An off-by-one here puts every tenant in
       the country a day behind on the first of every month. */
    await charge("2026-06");
    const r = await aged("2026-06-01");
    assert.equal(r.totals.current, RENT);
    assert.equal(r.overdueCents, 0);
  });

  test("the day after, it ages", async () => {
    await charge("2026-06");
    const r = await aged("2026-06-02");
    assert.equal(r.totals.current, 0);
    assert.equal(r.totals.d1_30, RENT);
  });

  test("it ages from the due date, not from when it was charged", async () => {
    /* A lease due on the fifteenth is not overdue on the second, however
       early the charge was raised. */
    await run("UPDATE lease SET rent_due_day = ? WHERE id = ?", 15, world.leaseId);
    await charge("2026-06");

    assert.equal((await aged("2026-06-10")).overdueCents, 0, "not due until the fifteenth");
    assert.equal((await aged("2026-06-16")).overdueCents, RENT);
  });
});

/* --- the buckets ---------------------------------------------------------------- */

describe("the buckets", () => {
  test("they are the five an accountant expects", async () => {
    /* Conventional on purpose. A report that invents its own buckets is one
       nobody can compare against last year's. */
    assert.deepEqual(BUCKETS.map((b) => b.key),
      ["current", "d1_30", "d31_60", "d61_90", "d90_plus"]);
  });

  test("the boundaries fall where they say they do", async () => {
    await charge("2026-06");
    const due = "2026-06-01";

    for (const [days, bucket] of [[30, "d1_30"], [31, "d31_60"], [60, "d31_60"],
                                  [61, "d61_90"], [90, "d61_90"], [91, "d90_plus"]]) {
      const r = await aged(addDays(due, days));
      assert.equal(r.totals[bucket], RENT, `${days} days should be ${bucket}`);
    }
  });

  test("months land in their own buckets", async () => {
    await charge("2026-06");
    await charge("2026-07");
    await charge("2026-08");

    const r = await aged("2026-08-15");
    assert.equal(r.totals.d1_30, RENT, "August");
    assert.equal(r.totals.d31_60, RENT, "July");
    assert.equal(r.totals.d61_90, RENT, "June");
    assert.equal(r.owedCents, RENT * 3);
  });
});

/* --- grace ----------------------------------------------------------------------- */

describe("grace", () => {
  test("it is a flag, not a bucket", async () => {
    /* Rent due on the first with five days' grace is owed from the first —
       what grace buys is that no late fee attaches until the sixth. The
       accounting is unmoved; the manager is told not to chase yet. */
    await charge("2026-06");
    const r = await aged("2026-06-03");

    assert.equal(r.totals.d1_30, RENT, "owed, and aging");
    assert.equal(r.rows[0].inGrace, true, "and not yet anybody's problem");
    assert.equal(r.inGraceCents, RENT);
  });

  test("once grace has run out it is not in grace", async () => {
    await charge("2026-06");
    const r = await aged("2026-06-07");
    assert.equal(r.rows[0].inGrace, false);
    assert.equal(r.inGraceCents, 0);
  });

  test("grace runs from the oldest unpaid charge", async () => {
    /* Two months behind and inside this month's grace is still two months
       behind. */
    await charge("2026-06");
    await charge("2026-07");
    const r = await aged("2026-07-03");
    assert.equal(r.rows[0].inGrace, false, "June's grace expired long ago");
  });

  test("a lease with no grace is chaseable the day after", async () => {
    await run("UPDATE lease SET grace_days = 0 WHERE id = ?", world.leaseId);
    await charge("2026-06");
    assert.equal((await aged("2026-06-02")).rows[0].inGrace, false);
  });
});

/* --- payments --------------------------------------------------------------------- */

describe("how payments are applied", () => {
  test("oldest first", async () => {
    /* Nothing records which month a payment was for and the tenant did not
       say. Oldest first is the convention, and the only rule that does not
       require guessing intent. */
    await charge("2026-06");
    await charge("2026-07");
    await pay(RENT, "2026-07-02");

    const r = await aged("2026-07-15");
    assert.equal(r.totals.d31_60, 0, "June is settled");
    assert.equal(r.totals.d1_30, RENT, "July is what is left");
  });

  test("a part payment leaves the rest on the oldest charge", async () => {
    await charge("2026-06");
    await charge("2026-07");
    await pay(40000, "2026-07-02");

    const r = await aged("2026-07-15");
    assert.equal(r.owedCents, RENT * 2 - 40000);
    assert.equal(r.totals.d31_60, RENT - 40000, "June, part paid");
    assert.equal(r.totals.d1_30, RENT, "July, untouched");
  });

  test("paying everything empties the report", async () => {
    /* A lease owing nothing and holding nothing is not a row. A report full
       of zeroes is one nobody reads. */
    await charge("2026-06");
    await pay(RENT, "2026-06-01");
    const r = await aged("2026-06-15");
    assert.deepEqual(r.rows, []);
    assert.equal(r.owedCents, 0);
  });
});

/* --- credits ----------------------------------------------------------------------- */

describe("a tenant in credit", () => {
  test("it is a credit, never a negative bucket", async () => {
    /* Somebody paid up and holding a balance is not "minus thirty days
       late". It is a different fact and belongs in its own column. */
    await pay(RENT, "2026-05-20");
    const r = await aged("2026-05-25");

    assert.equal(r.prepaidCents, RENT);
    assert.equal(r.owedCents, 0);
    for (const b of BUCKETS) assert.ok(r.totals[b.key] >= 0, `${b.key} went negative`);
  });

  test("the credit is drawn down when the next charge lands", async () => {
    await pay(RENT, "2026-05-20");
    await charge("2026-06");

    const r = await aged("2026-06-15");
    assert.equal(r.prepaidCents, 0, "spent on June");
    assert.equal(r.owedCents, 0, "and June is settled");
    assert.deepEqual(r.rows, []);
  });

  test("a lease can owe nothing and still appear, if it holds a credit", async () => {
    await pay(30000, "2026-05-20");
    const r = await aged("2026-05-25");
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].netCents, -30000, "net of the credit, they are ahead");
  });
});

/* --- it must agree with the book ---------------------------------------------------- */

describe("tying to the ledger", () => {
  test("the aged total is the receivable control account", async () => {
    /* If these disagree, one of them is wrong and the report is the one
       somebody will act on. */
    await charge("2026-06");
    await charge("2026-07");
    await pay(40000, "2026-07-02");

    const tie = await agingTiesToLedger(world.companyId, { asOf: "2026-07-15" });
    assert.equal(tie.differenceCents, 0);
    assert.equal(tie.agedCents, tie.controlCents);
  });

  test("it still ties while a tenant is in credit", async () => {
    await pay(RENT * 2, "2026-05-20");
    await charge("2026-06");
    const tie = await agingTiesToLedger(world.companyId, { asOf: "2026-06-15" });
    assert.equal(tie.differenceCents, 0);
  });
});

/* --- as at ---------------------------------------------------------------------------- */

describe("as at a date", () => {
  test("a charge raised later is not counted", async () => {
    await charge("2026-06");
    await charge("2026-07");
    const r = await aged("2026-06-15");
    assert.equal(r.owedCents, RENT, "July had not been charged yet");
  });

  test("a payment made later is not counted", async () => {
    /* Otherwise a report run for last month would show arrears that this
       month's payment had already cleared. */
    await charge("2026-06");
    await pay(RENT, "2026-07-10");

    assert.equal((await aged("2026-06-30")).owedCents, RENT, "unpaid at the end of June");
    assert.equal((await aged("2026-07-31")).owedCents, 0, "and paid by the end of July");
  });
});

/* --- charges that are not rent --------------------------------------------------------- */

describe("a charge with no period", () => {
  test("it ages from the day it was raised", async () => {
    /* A late fee or something entered by hand has no month behind it, so the
       day it was posted is the only honest answer. */
    await postJournal({
      companyId: world.companyId, date: "2026-06-10", memo: "Late fee",
      source: "late_fee",
      splits: [
        { code: "1300", debit: 5000, leaseId: world.leaseId, ownerId: world.ownerId },
        { code: "4100", credit: 5000, leaseId: world.leaseId, ownerId: world.ownerId },
      ],
    });

    assert.equal((await aged("2026-06-10")).totals.current, 5000, "raised today, not yet late");
    assert.equal((await aged("2026-06-20")).totals.d1_30, 5000);
  });
});
