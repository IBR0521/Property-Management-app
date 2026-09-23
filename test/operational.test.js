/* The reports about property rather than about money.

   These read the operational tables, not the journal, and that changes what
   they can promise. A rent roll is not a financial statement and does not tie
   to the trial balance — it says what the portfolio is contracted to earn,
   which is a different question from what it has earned.

   Two of them carry a decision worth pinning down. Vacancy is **derived**,
   because this database keeps no history of unit status, and a unit that has
   never been let is reported as never let rather than as vacant for zero days.
   And repair spend must count a repair **once**, which is only true because a
   repair can only be costed once. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today, addDays } from "../server/lib/dates.js";
import { ensureChart, postJournal } from "../server/features/accounting.js";
import { closeOut as closeWorkOrder } from "../server/features/maintenance.js";
import { recordInvoice } from "../server/features/vendors.js";
import {
  rentRoll, vacancy, leaseExpirations, depositsHeld, repairSpend,
} from "../server/lib/reports/operational.js";

let world, staff;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Portfolio Co" });
  await ensureChart(world.companyId);
  staff = { id: world.staff.admin.id, name: "Dana" };
  await run(
    `UPDATE vendor SET gl_expires = ?, wc_expires = ?, license_expires = ? WHERE id = ?`,
    "2099-01-01", "2099-01-01", "2099-01-01", world.vendorId);
});

/* --- the rent roll ------------------------------------------------------------- */

describe("the rent roll", () => {
  test("an empty unit is on it", async () => {
    /* A rent roll listing only let units answers "what am I earning" and
       hides "what am I not", and the second is the number that pays for the
       report. */
    const empty = await f.makeUnit(world.companyId, world.propertyId,
      { label: "9", rentCents: 120000, status: "vacant" });

    const r = await rentRoll(world.companyId, { asOf: today() });
    const row = r.rows.find((x) => x.unitId === empty);

    assert.ok(row, "the empty unit is listed");
    assert.equal(row.occupied, false);
    assert.equal(row.rentCents, 0, "it earns nothing");
    assert.equal(row.vacancyLossCents, 120000, "and that is what it costs");
  });

  test("occupancy is counted on units, not on rent", async () => {
    /* Weighting by rent flatters a portfolio whose cheap units are the empty
       ones. */
    await f.makeUnit(world.companyId, world.propertyId, { label: "cheap", rentCents: 10000 });
    const r = await rentRoll(world.companyId, { asOf: today() });

    assert.equal(r.units, 2);
    assert.equal(r.occupiedUnits, 1);
    assert.equal(r.occupancyRate, 0.5);
  });

  test("it shows who was in the unit on the date asked about", async () => {
    /* A rent roll for last quarter has to show last quarter's tenant, not
       whoever is there now. */
    await run("UPDATE lease SET start_date = ?, end_date = ?, moveout_date = ?, status = ? WHERE id = ?",
      "2026-01-01", "2026-06-30", "2026-06-30", "ended", world.leaseId);

    const during = await rentRoll(world.companyId, { asOf: "2026-03-15" });
    assert.equal(during.occupiedUnits, 1, "let in March");

    const after = await rentRoll(world.companyId, { asOf: "2026-08-15" });
    assert.equal(after.occupiedUnits, 0, "empty by August");
  });

  test("a lease that has not started yet does not count as let", async () => {
    await run("UPDATE lease SET start_date = ? WHERE id = ?", addDays(today(), 30), world.leaseId);
    const r = await rentRoll(world.companyId, { asOf: today() });
    assert.equal(r.occupiedUnits, 0);
  });

  test("it can be narrowed to one property", async () => {
    const other = await f.makeProperty(world.companyId, world.ownerId, { line1: "2 Elsewhere" });
    await f.makeUnit(world.companyId, other, { label: "1" });

    const r = await rentRoll(world.companyId, { asOf: today(), propertyId: other });
    assert.equal(r.units, 1);
  });
});

/* --- vacancy ------------------------------------------------------------------- */

describe("vacancy", () => {
  test("a unit never let is not vacant for zero days", async () => {
    /* Those are very different facts and one of them is a number somebody
       would put in a board pack. */
    await f.makeUnit(world.companyId, world.propertyId, { label: "new", status: "vacant" });

    const v = await vacancy(world.companyId, { asOf: today() });
    const row = v.rows.find((r) => r.label === "new");

    assert.equal(row.neverLet, true);
    assert.equal(row.daysVacant, null, "not zero");
    assert.equal(v.neverLetUnits, 1);
  });

  test("the average ignores units that were never let", async () => {
    /* Counting them as zero would report a portfolio of empty new builds as
       turning over briskly. */
    await f.makeUnit(world.companyId, world.propertyId, { label: "new", status: "vacant" });
    const let_ = await f.makeUnit(world.companyId, world.propertyId, { label: "was let", status: "vacant" });
    await f.makeLease(world.companyId, let_, {
      startDate: "2026-01-01", endDate: addDays(today(), -40), status: "ended",
    });
    await run("UPDATE lease SET moveout_date = ? WHERE unit_id = ?", addDays(today(), -40), let_);

    const v = await vacancy(world.companyId, { asOf: today() });
    assert.equal(v.averageDaysVacant, 40, "only the one with a date");
  });

  test("days vacant runs from when the keys came back", async () => {
    /* Not from the lease's end date. The tenancy ended when they left. */
    const unit = await f.makeUnit(world.companyId, world.propertyId, { label: "early", status: "vacant" });
    await f.makeLease(world.companyId, unit, {
      startDate: "2026-01-01", endDate: addDays(today(), -10), status: "ended",
    });
    await run("UPDATE lease SET moveout_date = ? WHERE unit_id = ?", addDays(today(), -30), unit);

    const v = await vacancy(world.companyId, { asOf: today() });
    assert.equal(v.rows.find((r) => r.label === "early").daysVacant, 30);
  });

  test("it says the figure is derived", async () => {
    /* There is no history of unit status in this database, and a report that
       implied otherwise would be claiming an authority it does not have. */
    const v = await vacancy(world.companyId, { asOf: today() });
    assert.match(v.derivedFrom, /no history of unit status/);
  });
});

/* --- expirations ---------------------------------------------------------------- */

describe("lease expirations", () => {
  test("month to month is kept apart, not dropped", async () => {
    /* A lease with no end date does not expire. A portfolio that is half
       rolling is a fact about risk and belongs on the report. */
    await run("UPDATE lease SET end_date = NULL WHERE id = ?", world.leaseId);

    const e = await leaseExpirations(world.companyId, { asOf: today() });
    assert.equal(e.expiringCount, 0);
    assert.equal(e.rollingCount, 1);
  });

  test("a tenancy running past its end date is named, not shown as negative days", async () => {
    await run("UPDATE lease SET end_date = ?, status = 'active' WHERE id = ?",
      addDays(today(), -9), world.leaseId);

    const e = await leaseExpirations(world.companyId, { asOf: today() });
    assert.equal(e.overrunCount, 1);
    assert.equal(e.expiring[0].overrun, true);
  });

  test("only leases inside the horizon", async () => {
    await run("UPDATE lease SET end_date = ? WHERE id = ?", addDays(today(), 200), world.leaseId);
    assert.equal((await leaseExpirations(world.companyId, { withinDays: 120 })).expiringCount, 0);
    assert.equal((await leaseExpirations(world.companyId, { withinDays: 365 })).expiringCount, 1);
  });

  test("rent at risk is the rent of what is expiring", async () => {
    await run("UPDATE lease SET end_date = ?, rent_cents = ? WHERE id = ?",
      addDays(today(), 30), 145000, world.leaseId);
    const e = await leaseExpirations(world.companyId, { asOf: today() });
    assert.equal(e.rentAtRiskCents, 145000);
  });
});

/* --- deposits --------------------------------------------------------------------- */

describe("deposits held", () => {
  test("it shows what the lease says and what the books say", async () => {
    /* Two figures on purpose. On this application they are currently not the
       same — deposits are recorded on leases and posted nowhere — and a
       report showing only one of them would hide that. */
    await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", 145000, world.leaseId);

    const d = await depositsHeld(world.companyId, { asOf: today() });
    assert.equal(d.onLeaseCents, 145000);
    assert.equal(d.inBooksCents, 0);
    assert.equal(d.differenceCents, 145000);
    assert.equal(d.unpostedCount, 1);
  });

  test("once posted, the two agree and nothing is flagged", async () => {
    await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", 145000, world.leaseId);
    await postJournal({
      companyId: world.companyId, date: today(), memo: "deposit received",
      splits: [
        { code: "1010", debit: 145000, leaseId: world.leaseId },
        { code: "2100", credit: 145000, leaseId: world.leaseId },
      ],
    });

    const d = await depositsHeld(world.companyId, { asOf: today() });
    assert.equal(d.inBooksCents, 145000);
    assert.equal(d.differenceCents, 0);
    assert.equal(d.unpostedCount, 0);
  });

  test("a lease with no deposit is not a row", async () => {
    await run("UPDATE lease SET deposit_cents = 0 WHERE id = ?", world.leaseId);
    assert.deepEqual((await depositsHeld(world.companyId, { asOf: today() })).rows, []);
  });
});

/* --- repair spend ------------------------------------------------------------------ */

describe("repair spend", () => {
  const workOrder = async () => await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);

  test("a repair billed and closed out is counted once", async () => {
    /* The invariant the whole one-cost-per-repair fix exists to protect, and
       this is where it would have shown up: inflated expenses on a report by
       property, against an owner charged twice. */
    await closeWorkOrder({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 20000, files: [], note: "done",
    });
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: world.workOrderId,
      invoiceNo: "INV-1", invoiceDate: today(), amountCents: 25000, taxCents: 0,
      memo: "repair", createdBy: staff.id,
    });

    const s = await repairSpend(world.companyId, { from: null, to: today() });
    assert.equal(s.totalCents, 25000, "the invoice, once");
    assert.equal(s.lines.length, 1, "and one line, not the superseded pair as well");
    assert.equal(s.byVendor.length, 1);
  });

  test("in-house work is attributed to nobody rather than to a blank", async () => {
    await closeWorkOrder({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 18000, files: [], note: "done",
    });

    const s = await repairSpend(world.companyId, { from: null, to: today() });
    assert.equal(s.byVendor[0].key, "In house");
    assert.equal(s.byVendor[0].cents, 18000);
  });

  test("it groups by the job's category", async () => {
    await run("UPDATE work_order SET category = ? WHERE id = ?", "plumbing", world.workOrderId);
    await closeWorkOrder({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 18000, files: [], note: "done",
    });

    const s = await repairSpend(world.companyId, { from: null, to: today() });
    assert.equal(s.byCategory[0].key, "plumbing");
    assert.equal(s.byCategory[0].jobs, 1);
  });

  test("spend is reported positive", async () => {
    /* Stored negative on the owner's ledger because it is money away from
       them; a spend report full of minus signs is harder to read and easier
       to mis-total. */
    await closeWorkOrder({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 18000, files: [], note: "done",
    });
    const s = await repairSpend(world.companyId, { from: null, to: today() });
    assert.ok(s.lines.every((l) => l.cents > 0));
    assert.equal(s.totalCents, 18000);
  });

  test("the period is respected", async () => {
    await closeWorkOrder({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 18000, files: [], note: "done",
    });
    const before = await repairSpend(world.companyId,
      { from: "2020-01-01", to: "2020-12-31" });
    assert.equal(before.totalCents, 0);
  });
});
