/* Charging rent.

   The half of rent accounting that was missing: rent was received and never
   charged, so income was never recognised and the tenant receivable ran to
   minus thirteen thousand dollars on seeded data.

   Two things get tested hard here because they are the two that hurt.

   **It must never charge twice.** A scheduler that runs twice in a minute, or
   catches up after a week down, must not bill a tenant for the same month
   again. The guarantee is a database index rather than a check in the job,
   and the test drives it concurrently to prove the difference matters.

   **It must credit 2400 and not 2200.** 2200 is a trust liability. Crediting
   it on a charge says you are holding money nobody has given you, and the
   three-way reconciliation would then fail by exactly the arrears, for ever. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today, addDays, monthKey } from "../server/lib/dates.js";
import { prorate, occupancyIn, PRORATION_BASES } from "../server/lib/proration.js";
import { planCharges, chargeRent, runRentCharges } from "../server/lib/rentcharge.js";
import { ensureChart } from "../server/features/accounting.js";
import { postMoney, parity } from "../server/lib/ledger.js";
import { closePeriod } from "../server/lib/reports/close.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Charge Co" });
  await ensureChart(world.companyId);
});

const balanceOf = async (companyId, code) => {
  const row = await get(
    `SELECT a.normal_balance,
            COALESCE(SUM(s.debit_cents),0)::bigint AS dr,
            COALESCE(SUM(s.credit_cents),0)::bigint AS cr
       FROM account a LEFT JOIN journal_split s ON s.account_id = a.id
      WHERE a.company_id = ? AND a.code = ?
      GROUP BY a.normal_balance`, companyId, code);
  if (!row) return 0;
  return row.normal_balance === "debit" ? Number(row.dr) - Number(row.cr)
                                        : Number(row.cr) - Number(row.dr);
};

/* --- the arithmetic --------------------------------------------------------- */

describe("proration", () => {
  test("a whole period is never prorated, whatever the basis", async () => {
    /* Somebody in the property every day of the month owes the rent. Running
       it through a formula to arrive back at the same number is how a
       rounding error becomes a tenant dispute — and on a 31-day month the
       30-day basis would charge 103% of it. */
    for (const basis of Object.keys(PRORATION_BASES)) {
      for (const period of ["2026-02", "2026-04", "2026-07"]) {
        const r = prorate({ rentCents: 150000, basis, period });
        assert.equal(r.cents, 150000, `${basis} in ${period}`);
        assert.equal(r.prorated, false);
      }
    }
  });

  test("daily_actual charges by the length of the month it is in", async () => {
    /* The default, and the only basis where a day costs the same as any other
       day of the same month. */
    const july = prorate({
      rentCents: 150000, basis: "daily_actual", period: "2026-07",
      occupiedFrom: "2026-07-18",
    });
    assert.equal(july.days, 14, "the 18th to the 31st inclusive");
    assert.equal(july.daysInPeriod, 31);
    assert.equal(july.cents, Math.round(150000 * 14 / 31));
    assert.equal(july.prorated, true);
  });

  test("daily_30 charges thirtieths", async () => {
    const r = prorate({
      rentCents: 150000, basis: "daily_30", period: "2026-07",
      occupiedFrom: "2026-07-18",
    });
    assert.equal(r.cents, Math.round(150000 * 14 / 30));
    assert.match(r.explain, /14 of 30 days/);
  });

  test("full_month charges the lot and says so", async () => {
    const r = prorate({
      rentCents: 150000, basis: "full_month", period: "2026-07",
      occupiedFrom: "2026-07-28",
    });
    assert.equal(r.cents, 150000);
    assert.equal(r.prorated, false);
    assert.match(r.explain, /charged as a full month/);
  });

  test("the day count is inclusive at both ends", async () => {
    /* A tenancy running the 1st to the 30th occupies thirty days, not
       twenty-nine. Off by one here is a day's rent every single time. */
    const r = prorate({
      rentCents: 90000, basis: "daily_actual", period: "2026-09",
      occupiedFrom: "2026-09-01", occupiedTo: "2026-09-10",
    });
    assert.equal(r.days, 10);
  });

  test("February is February, including in a leap year", async () => {
    const short = prorate({
      rentCents: 140000, basis: "daily_actual", period: "2026-02",
      occupiedFrom: "2026-02-15",
    });
    assert.equal(short.daysInPeriod, 28);
    assert.equal(short.days, 14);

    const leap = prorate({
      rentCents: 140000, basis: "daily_actual", period: "2028-02",
      occupiedFrom: "2028-02-15",
    });
    assert.equal(leap.daysInPeriod, 29);
    assert.equal(leap.days, 15);
  });

  test("a period the lease does not touch is no charge, not a charge of zero", async () => {
    /* The caller has to be able to tell those apart: one is "nothing is
       owed", the other is "this lease was not here". */
    const r = prorate({
      rentCents: 90000, period: "2026-09",
      occupiedFrom: "2026-11-01",
    });
    assert.equal(r.charge, false);
    assert.equal(r.cents, 0);
  });

  test("rounding happens once, at the end", async () => {
    /* Rounding a daily rate and then multiplying loses up to thirty cents a
       month — small, wrong, and exactly the sort of thing a tenant notices
       and nobody can explain. */
    const r = prorate({
      rentCents: 100000, basis: "daily_actual", period: "2026-09",
      occupiedFrom: "2026-09-08",
    });
    assert.equal(r.cents, Math.round(100000 * 23 / 30));
    assert.notEqual(r.cents, Math.round(100000 / 30) * 23);
  });

  test("keys back early beats the lease's end date", async () => {
    /* The tenancy ended when the keys came back, not when the paper said it
       would. */
    const w = occupancyIn(
      { start_date: "2026-01-01", end_date: "2026-09-30", moveout_date: "2026-09-12" },
      "2026-09");
    assert.equal(w.to, "2026-09-12");
    assert.equal(w.endsMidPeriod, true);
  });
});

/* --- posting ---------------------------------------------------------------- */

describe("the charge", () => {
  test("it debits the receivable and credits 2400, never 2200", async () => {
    /* The posting the whole plan turns on. 2200 is a trust liability, and
       crediting it here would say the company holds money nobody has given
       it — the reconciliation would fail by the arrears for ever. */
    const res = await chargeRent(world.companyId, { period: monthKey(today()) });
    assert.equal(res.charged, 1);

    assert.equal(await balanceOf(world.companyId, "1300"), res.cents);
    assert.equal(await balanceOf(world.companyId, "2400"), res.cents);
    assert.equal(await balanceOf(world.companyId, "2200"), 0, "nothing is owed until it arrives");
  });

  test("it is dated the start of the period, not the day it ran", async () => {
    /* It used to be the last day of the period, which put a charge for
       September on the 30th when the rent was due on the 1st — so an aged
       receivables report would not see it until the month was nearly over
       and would then read it as already a month late.

       A catch-up run still dates each charge inside its own period, which
       was the original point. */
    await run("UPDATE lease SET rent_due_day = ? WHERE id = ?", 1, world.leaseId);
    const res = await chargeRent(world.companyId, { period: "2026-06" });
    assert.equal(res.firstDue, "2026-06-01");

    const j = await get(
      "SELECT date, source_type, source_id FROM journal WHERE source_type = 'rent_charge'");
    assert.equal(j.date, "2026-06-01");
    assert.equal(j.source_id, `${world.leaseId}:2026-06`);
  });

  test("a lease due on the fifteenth is still posted on the first", async () => {
    /* Posted at the start of the period, due on the lease's own rent day.
       Keeping those apart is what lets a report say rent is charged and not
       yet due, which for the first two weeks of the month it is. */
    await run("UPDATE lease SET rent_due_day = ? WHERE id = ?", 15, world.leaseId);
    const res = await chargeRent(world.companyId, { period: "2026-06" });
    const j = await get("SELECT date FROM journal WHERE source_type = 'rent_charge'");
    assert.equal(j.date, "2026-06-01", "posted");
    assert.equal(res.firstDue, "2026-06-15", "due");
  });

  test("it writes nothing to the owner's ledger", async () => {
    /* `ledger_entry` is what an owner is shown and it records money that
       moved. A charge is not money that moved, and one written here would
       inflate every statement by the amount charged on top of the amount
       received. */
    await chargeRent(world.companyId, { period: monthKey(today()) });
    assert.deepEqual(await all("SELECT id FROM ledger_entry"), []);
  });

  test("the memo carries the proration, so a dispute has an answer", async () => {
    await run("UPDATE lease SET start_date = ? WHERE id = ?", "2026-06-18", world.leaseId);
    await chargeRent(world.companyId, { period: "2026-06" });

    const j = await get("SELECT memo FROM journal WHERE source_type = 'rent_charge'");
    assert.match(j.memo, /13 of 30 days/);
    assert.match(j.memo, /daily_actual/);
  });
});

/* --- never twice ------------------------------------------------------------ */

describe("charging twice", () => {
  test("a second run charges nothing and says so", async () => {
    const first = await chargeRent(world.companyId, { period: "2026-06" });
    const second = await chargeRent(world.companyId, { period: "2026-06" });

    assert.equal(first.charged, 1);
    assert.equal(second.charged, 0);
    assert.equal(second.skipped, 1);
    assert.equal((await all("SELECT id FROM journal WHERE source_type = 'rent_charge'")).length, 1);
  });

  test("two runs at once still charge once", async () => {
    /* The reason the guarantee is a database index and not a check in the
       job. Both of these read "not charged yet" before either writes. */
    const [a, b] = await Promise.all([
      chargeRent(world.companyId, { period: "2026-06" }),
      chargeRent(world.companyId, { period: "2026-06" }),
    ]);
    assert.equal(a.charged + b.charged, 1, "exactly one of them won");
    assert.equal((await all("SELECT id FROM journal WHERE source_type = 'rent_charge'")).length, 1);
  });

  test("the index lets a reversed charge be re-posted", async () => {
    /* Which is what makes a correction possible at all: reverse the wrong
       charge and the slot frees up for the right one. */
    const { reverseJournal } = await import("../server/features/accounting.js");
    await chargeRent(world.companyId, { period: "2026-06" });
    const original = await get("SELECT id FROM journal WHERE source_type = 'rent_charge'");

    await reverseJournal(original.id, { companyId: world.companyId, by: "test" });

    const again = await chargeRent(world.companyId, { period: "2026-06" });
    assert.equal(again.charged, 1, "the slot was freed by the reversal");
  });

  test("different months are different charges", async () => {
    await chargeRent(world.companyId, { period: "2026-06" });
    await chargeRent(world.companyId, { period: "2026-07" });
    assert.equal((await all("SELECT id FROM journal WHERE source_type = 'rent_charge'")).length, 2);
  });
});

/* --- what it will not do ---------------------------------------------------- */

describe("what it leaves alone", () => {
  test("a closed period is reported, not forced", async () => {
    /* A company that has closed the month has made a deliberate choice. The
       run says how many it could not post rather than failing. */
    await closePeriod(world.companyId, {
      through: today(), by: "Dana", force: true, note: "closing for the test",
    });

    const res = await chargeRent(world.companyId, { period: monthKey(addDays(today(), -40)) });
    assert.equal(res.charged, 0);
    assert.equal(res.closed, 1);
    assert.deepEqual(await all("SELECT id FROM journal WHERE source_type = 'rent_charge'"), []);
  });

  test("a lease that has not started is not charged", async () => {
    await run("UPDATE lease SET start_date = ? WHERE id = ?", addDays(today(), 60), world.leaseId);
    const res = await chargeRent(world.companyId, { period: monthKey(today()) });
    assert.equal(res.charged, 0);
  });

  test("a lease that ended before the period is not charged", async () => {
    await run("UPDATE lease SET status = ?, moveout_date = ? WHERE id = ?",
      "ended", "2026-01-15", world.leaseId);
    const res = await chargeRent(world.companyId, { period: "2026-06" });
    assert.equal(res.charged, 0);
  });

  test("a lease that ended inside the period is charged for the days it ran", async () => {
    /* It still owes for the time somebody lived there. */
    await run("UPDATE lease SET status = ?, moveout_date = ?, rent_cents = ? WHERE id = ?",
      "ended", "2026-06-10", 90000, world.leaseId);

    const res = await chargeRent(world.companyId, { period: "2026-06" });
    assert.equal(res.charged, 1);
    assert.equal(res.cents, Math.round(90000 * 10 / 30));
  });

  test("a lease with no rent is not charged", async () => {
    await run("UPDATE lease SET rent_cents = 0 WHERE id = ?", world.leaseId);
    assert.equal((await chargeRent(world.companyId, { period: "2026-06" })).charged, 0);
  });
});

/* --- across companies -------------------------------------------------------- */

describe("the run across every company", () => {
  test("each company is charged on its own basis", async () => {
    /* Proration is a company setting because US practice varies by state and
       by firm. */
    const other = await f.makeWorld({ name: "Thirtieths Co" });
    await ensureChart(other.companyId);
    await run("UPDATE company SET proration_basis = ? WHERE id = ?", "daily_30", other.companyId);
    for (const w of [world, other]) {
      await run("UPDATE lease SET start_date = ?, rent_cents = ? WHERE id = ?",
        "2026-07-18", 150000, w.leaseId);
    }

    await runRentCharges({ period: "2026-07" });

    assert.equal(await balanceOf(world.companyId, "1300"), Math.round(150000 * 14 / 31));
    assert.equal(await balanceOf(other.companyId, "1300"), Math.round(150000 * 14 / 30));
  });

  test("one company's broken data does not stop the others", async () => {
    const other = await f.makeWorld({ name: "Fine Co" });
    await ensureChart(other.companyId);
    await closePeriod(world.companyId, {
      through: today(), by: "Dana", force: true, note: "closed",
    });

    const res = await runRentCharges({ period: monthKey(addDays(today(), -40)) });
    assert.equal(res.rentCharged, 1, "the open company was still charged");
    assert.equal(res.rentChargesClosed, 1);
  });
});

/* --- and the effect on the reconciliation ----------------------------------- */

describe("what charging does to the trust reconciliation", () => {
  test("an unpaid charge does not make the trust account look short", async () => {
    /* The whole reason the charge credits 2400. If it credited 2200, every
       unpaid charge would push trust liabilities above trust assets and this
       report would read as a shortfall — the finding a regulator looks
       for — permanently, on a company that has done nothing wrong. */
    await chargeRent(world.companyId, { period: monthKey(today()) });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.clients.cents, 0, "nothing is owed to clients until it arrives");
    assert.equal(r.legs.book.cents, 0, "and nothing is held");

    const shortfall = r.findings.find((x) => x.title.includes("less than is owed"));
    assert.equal(shortfall, undefined, "an arrear is not a trust shortfall");
  });
});

/* --- paying before being charged -------------------------------------------- */

describe("a tenant who pays ahead", () => {
  async function pay(cents, date = today()) {
    return await postMoney({
      companyId: world.companyId, ownerId: world.ownerId,
      propertyId: world.propertyId, unitId: world.unitId, leaseId: world.leaseId,
      date, kind: "rent_payment", amountCents: cents, memo: "rent",
      source: "manual", postedBy: "test",
    });
  }

  test("money paid before any charge is held, not credited to the owner", async () => {
    /* The tempting shortcut is to credit owner funds and be done. That says
       the owner is owed rent for a month nobody has billed, and when the
       charge finally lands they would be credited twice. */
    await pay(90000);

    assert.equal(await balanceOf(world.companyId, "2300"), 90000, "held as prepaid rent");
    assert.equal(await balanceOf(world.companyId, "2200"), 0, "not the owner's yet");
    assert.equal(await balanceOf(world.companyId, "1300"), 0, "and no receivable was invented");
  });

  test("the trust account still reconciles while it is held", async () => {
    /* Prepaid rent is client money like any other. If it were not a trust
       liability, holding it would read as a surplus. */
    await pay(90000);
    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.book.cents, 90000);
    assert.equal(r.legs.clients.cents, 90000);
    assert.equal(r.variances.find((v) => v.key === "book_vs_clients").cents, 0);
  });

  test("the next charge is settled out of it", async () => {
    /* Without this the charge sits outstanding against somebody holding a
       receipt: AR aging shows arrears that do not exist and the delinquency
       ladder starts writing to a tenant who is paid up. */
    await run("UPDATE lease SET rent_cents = ? WHERE id = ?", 90000, world.leaseId);
    await pay(90000);

    const res = await chargeRent(world.companyId, { period: monthKey(today()) });
    assert.equal(res.charged, 1);
    assert.equal(res.applied, 90000, "the prepayment settled it");

    assert.equal(await balanceOf(world.companyId, "1300"), 0, "nothing is owed");
    assert.equal(await balanceOf(world.companyId, "2300"), 0, "and nothing is still held");
    assert.equal(await balanceOf(world.companyId, "2200"), 90000, "it is the owner's now");
  });

  test("paying three months ahead settles one month at a time", async () => {
    await run("UPDATE lease SET rent_cents = ?, start_date = ? WHERE id = ?",
      90000, "2026-01-01", world.leaseId);
    await pay(270000, "2026-06-01");

    const june = await chargeRent(world.companyId, { period: "2026-06" });
    assert.equal(june.applied, 90000);
    assert.equal(await balanceOf(world.companyId, "2300"), 180000, "two months still held");

    const july = await chargeRent(world.companyId, { period: "2026-07" });
    assert.equal(july.applied, 90000);
    assert.equal(await balanceOf(world.companyId, "2300"), 90000);
    assert.equal(await balanceOf(world.companyId, "2200"), 180000, "two months earned");
    assert.equal(await balanceOf(world.companyId, "1300"), 0);
  });

  test("a part payment against a charge leaves the rest outstanding", async () => {
    await run("UPDATE lease SET rent_cents = ? WHERE id = ?", 90000, world.leaseId);
    await chargeRent(world.companyId, { period: monthKey(today()) });
    await pay(40000);

    assert.equal(await balanceOf(world.companyId, "1300"), 50000, "still owed");
    assert.equal(await balanceOf(world.companyId, "2200"), 40000, "the owner has what arrived");
    assert.equal(await balanceOf(world.companyId, "2300"), 0, "nothing was paid ahead");
  });

  test("overpaying a charge clears it and holds the rest", async () => {
    await run("UPDATE lease SET rent_cents = ? WHERE id = ?", 90000, world.leaseId);
    await chargeRent(world.companyId, { period: monthKey(today()) });
    await pay(100000);

    assert.equal(await balanceOf(world.companyId, "1300"), 0);
    assert.equal(await balanceOf(world.companyId, "2200"), 90000, "the charged month is earned");
    assert.equal(await balanceOf(world.companyId, "2300"), 10000, "the extra is held");
  });

  test("through all of it, the two books agree", async () => {
    /* The invariant that matters more than any individual balance. */
    await run("UPDATE lease SET rent_cents = ? WHERE id = ?", 90000, world.leaseId);
    await pay(100000);
    await chargeRent(world.companyId, { period: monthKey(today()) });
    await pay(90000);

    assert.equal((await parity(world.companyId)).inParity, true);

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.variances.find((v) => v.key === "book_vs_clients").cents, 0,
      "every pound held is somebody's");
    assert.equal(r.variances.find((v) => v.key === "clients_vs_subledger").cents, 0,
      "and the control account agrees with the owner's own ledger");
  });
});
