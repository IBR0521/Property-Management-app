/* Correcting journals posted under the old rules.

   Two postings were wrong for as long as this application has had books: rent
   received credited the receivable instead of the owner, and an owner's repair
   was booked as the manager's own expense.

   The tests that matter most here are the ones about restraint. A correction
   runner that is slightly too eager is far worse than one that misses
   something — it rewrites journals that were already right, on a live
   database, in a table that cannot be edited afterwards. So the matching is
   asserted from both directions: it finds every shape it should, and it
   leaves alone every shape it should not, including the corrections it has
   already posted itself. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { postJournal, ensureChart, reverseJournal } from "../server/features/accounting.js";
import { plan, commit, describe as describePlan, correctionDateFor } from "../server/lib/correct.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";
import { closePeriod } from "../server/lib/reports/close.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Legacy Co" });
  await ensureChart(world.companyId);
});

const RENT = 1371000, REPAIR = 27350, FEE = 75915;

const balanceOf = async (code, companyId = world.companyId) => {
  const row = await get(
    `SELECT a.normal_balance,
            COALESCE(SUM(s.debit_cents),0)::bigint AS dr,
            COALESCE(SUM(s.credit_cents),0)::bigint AS cr
       FROM account a LEFT JOIN journal_split s ON s.account_id = a.id
      WHERE a.company_id = ? AND a.code = ? GROUP BY a.normal_balance`, companyId, code);
  if (!row) return 0;
  return row.normal_balance === "debit" ? Number(row.dr) - Number(row.cr)
                                        : Number(row.cr) - Number(row.dr);
};

async function ledger({ kind, cents, journalId, date, companyId = world.companyId, ownerId }) {
  await insert("ledger_entry", {
    id: id(), company_id: companyId, owner_id: ownerId || world.ownerId,
    property_id: world.propertyId, date, kind, amount_cents: cents,
    memo: kind, source: "manual", journal_id: journalId, created_at: stamp(),
  });
}

/* The books exactly as the old rules left them. */
async function legacyBooks({ companyId = world.companyId, ownerId = world.ownerId } = {}) {
  const post = (date, memo, splits) =>
    postJournal({ companyId, date, memo, source: "rent", splits });

  const rent = await post("2026-08-05", "rent received", [
    { code: "1010", debit: RENT, ownerId, propertyId: world.propertyId },
    { code: "1300", credit: RENT, ownerId, propertyId: world.propertyId },
  ]);
  await ledger({ kind: "rent_payment", cents: RENT, journalId: rent, date: "2026-08-05", companyId, ownerId });

  const repair = await post("2026-08-12", "owner repair", [
    { code: "5000", debit: REPAIR, ownerId, propertyId: world.propertyId },
    { code: "1010", credit: REPAIR, ownerId, propertyId: world.propertyId },
  ]);
  await ledger({ kind: "expense", cents: -REPAIR, journalId: repair, date: "2026-08-12", companyId, ownerId });

  const fee = await post("2026-08-31", "management fee", [
    { code: "2200", debit: FEE, ownerId },
    { code: "4200", credit: FEE, ownerId },
  ]);
  await ledger({ kind: "management_fee", cents: -FEE, journalId: fee, date: "2026-08-31", companyId, ownerId });

  return { rent, repair, fee };
}

/* --- it reports unless told to commit --------------------------------------- */

describe("the dry run", () => {
  test("planning writes nothing", async () => {
    /* The first thing this does on a live database cannot be undone. */
    await legacyBooks();
    const before = (await all("SELECT id FROM journal")).length;
    await plan({ companyId: world.companyId });
    assert.equal((await all("SELECT id FROM journal")).length, before);
  });

  test("committing without the confirmation is refused", async () => {
    await legacyBooks();
    for (const confirm of [undefined, "", "yes", "correct"]) {
      await assert.rejects(() => commit({ confirm, companyId: world.companyId }),
        /needs \{ confirm: 'correct-postings' \}/);
    }
    assert.equal(await balanceOf("1300"), -RENT, "and nothing moved");
  });

  test("the plan says what it would do, in words", async () => {
    await legacyBooks();
    const text = describePlan(await plan({ companyId: world.companyId }));
    assert.match(text, /Legacy Co/);
    assert.match(text, /never closed/);
    assert.match(text, /\$13,710\.00/);
    assert.match(text, /\$273\.50/);
  });

  test("a company with nothing to correct says so", async () => {
    assert.equal(describePlan(await plan({ companyId: world.companyId })).includes("Nothing to correct"), true);
  });
});

/* --- what it puts right ------------------------------------------------------ */

describe("the correction", () => {
  test("the books come out agreeing with the owner's own ledger", async () => {
    /* The whole measure of whether this worked. */
    await legacyBooks();

    const before = await trustReconciliation(world.companyId);
    assert.notEqual(before.variances.find((v) => v.key === "clients_vs_subledger").cents, 0);

    await commit({ confirm: "correct-postings", companyId: world.companyId });

    const after = await trustReconciliation(world.companyId);
    assert.equal(after.legs.clients.cents, RENT - REPAIR - FEE);
    assert.equal(after.legs.subledger.cents, RENT - REPAIR - FEE);
    assert.equal(after.variances.find((v) => v.key === "clients_vs_subledger").cents, 0);
  });

  test("the receivable returns to zero and the owner's funds appear", async () => {
    await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });

    assert.equal(await balanceOf("1300"), 0, "rent was never a receivable clearance");
    assert.equal(await balanceOf("2200"), RENT - REPAIR - FEE);
    assert.equal(await balanceOf("5000"), 0, "the owner's cost was never the manager's");
    assert.equal(await balanceOf("1010"), RENT - REPAIR, "and the cash did not move");
  });

  test("the original stays exactly where it was", async () => {
    /* The journal is append-only, so a correction sits beside the mistake
       rather than replacing it. The pair reads as what it is. */
    const { rent } = await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });

    const original = await get("SELECT * FROM journal WHERE id = ?", rent);
    assert.equal(original.memo, "rent received");
    assert.equal(original.reversed_by, null, "not reversed — reclassified alongside");
  });

  test("each correction names the journal it corrects", async () => {
    /* So "why does this journal exist" is a join rather than archaeology. */
    const { rent } = await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });

    const correction = await get(
      "SELECT * FROM journal WHERE source_type = 'posting_correction' AND source_id = ?", rent);
    assert.ok(correction);
    assert.match(correction.memo, /Correcting a posting/);
  });

  test("the two books stay in parity throughout", async () => {
    const { parity } = await import("../server/lib/ledger.js");
    await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });
    assert.equal((await parity(world.companyId)).inParity, true);
  });
});

/* --- restraint ---------------------------------------------------------------- */

describe("what it refuses to touch", () => {
  test("running it twice corrects once", async () => {
    await legacyBooks();
    const first = await commit({ confirm: "correct-postings", companyId: world.companyId });
    const second = await commit({ confirm: "correct-postings", companyId: world.companyId });

    assert.equal(first[0].posted, 2);
    assert.deepEqual(second, [], "nothing left to correct");
    assert.equal(await balanceOf("2200"), RENT - REPAIR - FEE, "and not corrected twice");
  });

  test("it does not correct its own corrections", async () => {
    /* The correction for rent is a two-split journal too. If the matching
       were loose it would find its own output and oscillate forever. */
    await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });
    assert.deepEqual(await plan({ companyId: world.companyId }), []);
  });

  test("postings made under the new rules are left alone", async () => {
    /* The test that matters most. A runner slightly too eager rewrites
       journals that were already right, on a live database, in a table that
       cannot be edited afterwards. */
    const dims = { ownerId: world.ownerId, propertyId: world.propertyId, leaseId: world.leaseId };

    await postJournal({
      companyId: world.companyId, date: "2026-09-05", memo: "rent received, new rules",
      source: "rent",
      splits: [
        { code: "1010", debit: 90000, ...dims },
        { code: "1300", credit: 90000, ...dims },
        { code: "2400", debit: 90000, ...dims },
        { code: "2200", credit: 90000, ...dims },
      ],
    });
    await postJournal({
      companyId: world.companyId, date: "2026-09-06", memo: "paid ahead, new rules",
      source: "rent",
      splits: [
        { code: "1010", debit: 50000, ...dims },
        { code: "2300", credit: 50000, ...dims },
      ],
    });
    await postJournal({
      companyId: world.companyId, date: "2026-09-07", memo: "owner repair, new rules",
      source: "maintenance",
      splits: [
        { code: "2200", debit: 10000, ...dims },
        { code: "1010", credit: 10000, ...dims },
      ],
    });

    assert.deepEqual(await plan({ companyId: world.companyId }), [],
      "nothing posted under the new rules is a candidate");
  });

  test("a bank match that looks similar is left alone", async () => {
    /* Two splits, a debit to trust cash — and a credit to owner funds rather
       than the receivable, which is correct and must stay. */
    await postJournal({
      companyId: world.companyId, date: "2026-09-08", memo: "bank deposit matched",
      source: "bank",
      splits: [
        { code: "1010", debit: 60000, ownerId: world.ownerId },
        { code: "2200", credit: 60000, ownerId: world.ownerId },
      ],
    });
    assert.deepEqual(await plan({ companyId: world.companyId }), []);
  });

  test("a vendor invoice is left alone", async () => {
    /* It debits 5000 too, and it credits the payable rather than trust cash.
       It is the manager's bill to pay and it is not this runner's business. */
    await postJournal({
      companyId: world.companyId, date: "2026-09-09", memo: "vendor invoice",
      source: "vendor",
      splits: [
        { code: "5000", debit: 42000, vendorId: world.vendorId },
        { code: "2000", credit: 42000, vendorId: world.vendorId },
      ],
    });
    assert.deepEqual(await plan({ companyId: world.companyId }), []);
  });

  test("a journal already reversed is not corrected", async () => {
    /* It has already been dealt with. Correcting it as well would post a
       third journal against a transaction that nets to nothing. */
    const { rent } = await legacyBooks();
    await reverseJournal(rent, { companyId: world.companyId, by: "test" });

    const planned = await plan({ companyId: world.companyId });
    const rentGroup = planned[0]?.groups.find((g) => g.key === "rent_payment");
    assert.equal(rentGroup, undefined, "the reversed rent journal is not a candidate");
  });

  test("one company's correction does not touch another's", async () => {
    const other = await f.makeWorld({ name: "Untouched Co" });
    await ensureChart(other.companyId);
    await legacyBooks({ companyId: other.companyId, ownerId: other.ownerId });
    await legacyBooks();

    await commit({ confirm: "correct-postings", companyId: world.companyId });

    assert.equal(await balanceOf("1300"), 0);
    assert.equal(await balanceOf("1300", other.companyId), -RENT, "left exactly as it was");
  });
});

/* --- the date ------------------------------------------------------------------ */

describe("where the correction lands", () => {
  test("a company that never closed gets its history corrected in place", async () => {
    await legacyBooks();
    await commit({ confirm: "correct-postings", companyId: world.companyId });

    const correction = await get(
      "SELECT date FROM journal WHERE source_type = 'posting_correction' ORDER BY date LIMIT 1");
    assert.equal(correction.date, "2026-08-05", "the date of the posting it corrects");
  });

  test("a closed period pushes the correction to the first open day", async () => {
    /* A posting landing behind a filed trust reconciliation does not fix it.
       It makes a document that was signed as true retroactively false. */
    await legacyBooks();
    await closePeriod(world.companyId, {
      through: "2026-08-31", by: "Dana", force: true, note: "filed",
    });

    const planned = await plan({ companyId: world.companyId });
    /* Two, not three: the management fee was always posted correctly and is
       not a candidate. Worth asserting the number rather than "some", because
       a runner that found three here would be finding one it should not. */
    assert.equal(planned[0].movedOutOfPeriod, 2, "both candidates are behind the line");
    assert.match(describePlan(planned), /land in a later period/);

    await commit({ confirm: "correct-postings", companyId: world.companyId });
    const corrections = await all(
      "SELECT date, memo FROM journal WHERE source_type = 'posting_correction'");
    for (const c of corrections) {
      assert.equal(c.date, "2026-09-01", "the first open day");
      assert.match(c.memo, /belongs to/, "and it says which period it belongs to");
    }
  });

  test("the books still come out right when the correction is moved", async () => {
    /* The period a correction lands in changes what a monthly report says.
       It must not change what the books total. */
    await legacyBooks();
    await closePeriod(world.companyId, {
      through: "2026-08-31", by: "Dana", force: true, note: "filed",
    });
    await commit({ confirm: "correct-postings", companyId: world.companyId });

    assert.equal(await balanceOf("1300"), 0);
    assert.equal(await balanceOf("2200"), RENT - REPAIR - FEE);
  });

  test("the date rule itself", async () => {
    assert.equal(correctionDateFor("2026-08-05", null), "2026-08-05");
    assert.equal(correctionDateFor("2026-08-05", "2026-08-31"), "2026-09-01");
    assert.equal(correctionDateFor("2026-09-15", "2026-08-31"), "2026-09-15",
      "already open, so left where it is");
    assert.equal(correctionDateFor("2026-08-05", "2026-08-05"), "2026-08-06",
      "closed through includes the day named");
  });

  test("a close date in the future does not push corrections into the future", async () => {
    /* Being a day late is better than posting into next month. */
    assert.equal(correctionDateFor("2026-01-01", addDays(today(), 60)), today());
  });
});
