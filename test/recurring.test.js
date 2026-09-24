/* Recurring charges.

   A lease has had one rent and one due day since Phase 1, which is why
   importing a portfolio from AppFolio or Buildium has always lost the pet
   rent, the parking and the storage — the importer says so before you commit,
   and until now there was nowhere to put them.

   The decisions this file holds:

   **Whose income it is decides the posting**, and getting it wrong is not a
   reporting error. The owner's charges post exactly as rent does, because
   they are the same fact: the dog lives in the owner's property.

   **Once per period, guaranteed by the database**, not by a check with a
   window in it.

   **A tenant is shown what they owe**, itemised. A balance that left these
   out would ask somebody for less than they owe and then call them behind. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { startApp, client } from "./helpers/http.js";
import { today, monthKey } from "../server/lib/dates.js";
import {
  addCharge, endCharge, chargesFor, monthlyExtrasFor,
  planRecurring, chargeRecurring, runRecurringCharges,
  CATEGORIES, ChargeRefused,
} from "../server/lib/recurring.js";
import { balanceFor } from "../server/lib/payments.js";
import { validateImport } from "../server/lib/import/validate.js";
import { commitImport } from "../server/lib/import/commit.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Recurring Co" });
  await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", world.companyId);
});

const petRent = (over = {}) => addCharge({
  companyId: world.companyId, leaseId: world.leaseId,
  label: "Pet rent", category: "pet", amountCents: 5000, payee: "owner",
  startDate: "2026-01-01", by: "test", ...over,
});

const balance = async (code) => Number((await get(
  `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
     FROM journal_split s JOIN account a ON a.id = s.account_id
    WHERE a.company_id = ? AND a.code = ?`, world.companyId, code)).c);

describe("what a charge has to say for itself", () => {
  test("a charge is created and read back", async () => {
    const c = await petRent();
    assert.equal(c.label, "Pet rent");
    assert.equal(Number(c.amount_cents), 5000);
    assert.equal(c.payee, "owner");
    assert.equal(Number(c.active), 1);
    assert.equal((await chargesFor(world.companyId, world.leaseId)).length, 1);
  });

  test("it must say whose income it is", async () => {
    await assert.rejects(() => petRent({ payee: undefined }), /whose income/i);
    await assert.rejects(() => petRent({ payee: "somebody" }), /whose income/i);
  });

  test("a charge billed to the manager is refused, in words, with the reason", async () => {
    /* Not silently, and not by posting something the reconciliation would
       catch three months later. A tenant paying one would land money in the
       trust account with nothing recording that it is the manager's. */
    await assert.rejects(() => petRent({ payee: "manager" }),
      /trust account|trust reconciliation/i);
  });

  test("it needs a label the tenant will recognise", async () => {
    await assert.rejects(() => petRent({ label: "   " }), /needs a label/i);
  });

  test("it has to be a positive amount", async () => {
    await assert.rejects(() => petRent({ amountCents: 0 }), /positive/i);
    await assert.rejects(() => petRent({ amountCents: -5000 }), /positive/i);
  });

  test("it cannot end before it starts", async () => {
    await assert.rejects(
      () => petRent({ startDate: "2026-06-01", endDate: "2026-01-01" }), /before it starts/i);
  });

  test("every category the importer maps onto is a real one", () => {
    for (const key of ["pet", "parking", "storage", "utility", "amenity", "admin", "other"]) {
      assert.ok(CATEGORIES[key], `${key} should be a category`);
    }
  });
});

describe("the posting", () => {
  test("an owner charge posts exactly as rent does", async () => {
    await petRent();
    const res = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(res.charged, 1);
    assert.equal(res.cents, 5000);

    /* Dr 1300 tenant receivable / Cr 2400 rent due to owners. Not 2200:
       crediting owner funds on a charge would say money is held that has not
       arrived, and the trust reconciliation would fail by the arrears. */
    assert.equal(await balance("1300"), 5000);
    assert.equal(await balance("2400"), -5000);
    assert.equal(await balance("2200"), 0, "nothing is held until it arrives");
  });

  test("the journal is dated the period it covers, not the day it ran", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const j = await get(
      "SELECT date, memo FROM journal WHERE source_type = 'recurring_charge'");
    assert.equal(j.date, "2026-03-01");
    assert.match(j.memo, /Pet rent 2026-03/);
  });

  test("the trust reconciliation still balances after charging", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const r = await trustReconciliation(world.companyId);
    for (const v of r.variances) {
      if (v.unavailable || v.key === "deposits_vs_leases") continue;
      assert.equal(v.cents, 0, `${v.key} should be zero, was ${v.cents}`);
    }
  });
});

describe("once per period, and the database is the guarantee", () => {
  test("a second run charges nothing", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const second = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(second.charged, 0);
    assert.equal(second.skipped, 1);
    assert.equal(await balance("1300"), 5000);
  });

  test("two overlapping runs produce one charge", async () => {
    await petRent();
    /* Both pass the `already` check before either posts, which is the window
       a check-then-insert leaves open. The unique index closes it. */
    await Promise.allSettled([
      chargeRecurring(world.companyId, { period: "2026-03" }),
      chargeRecurring(world.companyId, { period: "2026-03" }),
    ]);
    const n = await get(
      "SELECT COUNT(*)::int c FROM journal WHERE source_type = 'recurring_charge'");
    assert.equal(Number(n.c), 1, "one charge, however many ticks overlap");
  });

  test("two charges on one lease are both billed, and are different journals", async () => {
    await petRent();
    await petRent({ label: "Parking", category: "parking", amountCents: 7500 });
    const res = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(res.charged, 2);
    assert.equal(res.cents, 12500);
    assert.equal(await balance("1300"), 12500);
  });
});

describe("when a charge applies", () => {
  test("not before it starts", async () => {
    await petRent({ startDate: "2026-06-01" });
    const res = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(res.charged, 0);
  });

  test("not after it ends", async () => {
    await petRent({ endDate: "2026-02-28" });
    const res = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(res.charged, 0);
  });

  test("ending a charge stops the next one and keeps the last", async () => {
    const c = await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    await endCharge({ companyId: world.companyId, chargeId: c.id, endDate: "2026-03-31" });

    const res = await chargeRecurring(world.companyId, { period: "2026-04" });
    assert.equal(res.charged, 0, "April is not billed");
    assert.equal(await balance("1300"), 5000, "March is not unbilled");

    const still = await chargesFor(world.companyId, world.leaseId, { includeEnded: true });
    assert.equal(still.length, 1, "the record stays — it is what the tenant was asked to pay");
  });
});

describe("what the tenant is shown", () => {
  test("the balance is rent plus what else is on the lease", async () => {
    await petRent();
    await petRent({ label: "Parking", category: "parking", amountCents: 7500 });
    const b = await balanceFor(world.leaseId, "2026-03");

    assert.equal(b.rentCents, 100000);
    assert.equal(b.extrasCents, 12500);
    assert.equal(b.dueCents, 112500, "a balance that left these out would ask for too little");
  });

  test("and it is itemised, not one number", async () => {
    await petRent();
    await petRent({ label: "Parking", category: "parking", amountCents: 7500 });
    const b = await balanceFor(world.leaseId, "2026-03");
    const labels = b.extras.map((e) => e.label).sort();
    assert.deepEqual(labels, ["Parking", "Pet rent"],
      "a tenant who cannot see what the $75 is will ring and ask");
  });

  test("a lease with nothing extra is unchanged", async () => {
    const b = await balanceFor(world.leaseId, "2026-03");
    assert.equal(b.extrasCents, 0);
    assert.deepEqual(b.extras, []);
    assert.equal(b.dueCents, 100000);
  });
});

describe("the plan, which is what the run will do", () => {
  test("it says what would be charged without charging it", async () => {
    await petRent();
    const plan = await planRecurring(world.companyId, { period: "2026-03" });
    assert.equal(plan.toCharge, 1);
    assert.equal(plan.totalCents, 5000);
    assert.equal(await balance("1300"), 0, "asking is not doing");
  });

  test("and marks what has already been billed", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const plan = await planRecurring(world.companyId, { period: "2026-03" });
    assert.equal(plan.alreadyCharged, 1);
    assert.equal(plan.toCharge, 0);
    assert.equal(plan.totalCents, 0);
  });
});

describe("the run across every company", () => {
  test("one company's charges do not stop another's", async () => {
    await petRent();
    const other = await f.makeWorld({ name: "Other Recurring Co" });
    await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", other.companyId);
    await addCharge({
      companyId: other.companyId, leaseId: other.leaseId, label: "Storage",
      category: "storage", amountCents: 3000, payee: "owner",
      startDate: "2026-01-01", by: "test",
    });
    const res = await runRecurringCharges({ period: "2026-03" });
    assert.equal(res.recurringCharged, 2);
    assert.equal(res.recurringChargedCents, 8000);
  });
});

/* Aging, for a charge that is not rent.

   Aged receivables works out when a charge fell due from its source: a rent
   charge carries `<leaseId>:<period>` and falls due on the lease's rent day.
   A recurring charge carries `<chargeId>:<period>` and falls due on the same
   day, because it sits beside the rent on the same lease.

   Without that it would age from the day it was raised — the first of the
   month — and a tenant whose rent is due on the fifteenth would read as a
   fortnight late on their pet rent while being current on their rent. */
describe("a recurring charge ages from the day it is due", () => {
  test("not from the day it was raised", async () => {
    const { agedReceivables } = await import("../server/lib/reports/receivable.js");
    await run("UPDATE lease SET rent_due_day = 15 WHERE id = ?", world.leaseId);
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });

    /* The 10th: raised on the 1st, but not due until the 15th. */
    const r = await agedReceivables(world.companyId, { asOf: "2026-03-10" });
    const row = r.rows.find((x) => x.leaseId === world.leaseId);
    assert.ok(row, "the charge should appear");
    assert.equal(row.buckets.current, 5000, "not yet due is current, not overdue");
    assert.equal(row.overdueCents, 0);
  });

  test("and is overdue once its due date has passed", async () => {
    const { agedReceivables } = await import("../server/lib/reports/receivable.js");
    await run("UPDATE lease SET rent_due_day = 15 WHERE id = ?", world.leaseId);
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });

    const r = await agedReceivables(world.companyId, { asOf: "2026-04-20" });
    const row = r.rows.find((x) => x.leaseId === world.leaseId);
    assert.equal(row.buckets.current, 0);
    assert.equal(row.overdueCents, 5000);
    assert.equal(row.open[0].due, "2026-03-15", "due with the rent, not on the 1st");
  });
});

describe("a payment settles rent and the extras together", () => {
  test("because both are the owner's money on the same receivable", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const { chargeRent } = await import("../server/lib/rentcharge.js");
    await chargeRent(world.companyId, { period: "2026-03" });
    assert.equal(await balance("1300"), 105000, "rent plus the pet rent");

    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId, date: "2026-03-05",
      kind: "rent_payment", amountCents: 105000, memo: "Rent and pet rent",
      source: "manual", postedBy: "test",
    });

    assert.equal(await balance("1300"), 0, "the whole receivable is settled");
    assert.equal(await balance("2200"), -105000, "and all of it is the owner's");
    assert.equal(await balance("2300"), 0, "none of it is prepaid — it was all owed");
  });

  test("the trust reconciliation balances across charge, bill and payment", async () => {
    await petRent();
    await chargeRecurring(world.companyId, { period: "2026-03" });
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId, date: "2026-03-05",
      kind: "rent_payment", amountCents: 5000, memo: "Pet rent",
      source: "manual", postedBy: "test",
    });
    const r = await trustReconciliation(world.companyId);
    for (const v of r.variances) {
      if (v.unavailable || v.key === "deposits_vs_leases") continue;
      assert.equal(v.cents, 0, `${v.key} should be zero, was ${v.cents}`);
    }
  });
});

/* The screen.

   Added on the home's own page, because that is where somebody is when they
   find out the tenant has a dog. */
describe("adding a charge from the unit page", () => {
  let app, agent;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  async function signedIn() {
    const w = await f.makeWorld({ name: "Charge Screen Co", staffRoles: ["admin"] });
    const c = client(app.origin);
    const res = await c.signIn(w.staff.admin.email, f.PASSWORD);
    assert.equal(res.signedIn, true);
    return { w, c };
  }

  test("the panel lists what is charged and what it comes to", async () => {
    const { w, c } = await signedIn();
    await addCharge({
      companyId: w.companyId, leaseId: w.leaseId, label: "Pet rent",
      category: "pet", amountCents: 5000, payee: "owner", by: "test",
    });
    await addCharge({
      companyId: w.companyId, leaseId: w.leaseId, label: "Parking",
      category: "parking", amountCents: 7500, payee: "owner", by: "test",
    });

    const { res, body } = await c.text(`/app/portfolio/u/${w.unitId}`);
    assert.equal(res.status, 200);
    assert.match(body, /Charged every month/);
    assert.match(body, /Pet rent/);
    assert.match(body, /Parking/);
    assert.match(body, /\$125\.00/, "and the total a month, which is what somebody checks");
  });

  test("a home with nothing extra says so rather than showing an empty table", async () => {
    const { w, c } = await signedIn();
    const { body } = await c.text(`/app/portfolio/u/${w.unitId}`);
    assert.match(body, /Nothing extra/);
  });

  test("the form adds one", async () => {
    const { w, c } = await signedIn();
    const res = await c.post(`/app/portfolio/u/${w.unitId}/charge`, {
      label: "Storage", category: "storage", amount: "30.00",
    }, { csrfFrom: `/app/portfolio/u/${w.unitId}` });
    assert.equal(res.status, 303);

    const rows = await chargesFor(w.companyId, w.leaseId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "Storage");
    assert.equal(Number(rows[0].amount_cents), 3000);
    assert.equal(rows[0].payee, "owner");
  });

  test("an amount that is not one is refused", async () => {
    const { w, c } = await signedIn();
    const res = await c.post(`/app/portfolio/u/${w.unitId}/charge`, {
      label: "Storage", category: "storage", amount: "nonsense",
    }, { csrfFrom: `/app/portfolio/u/${w.unitId}` });
    assert.notEqual(res.status, 303);
    assert.equal((await chargesFor(w.companyId, w.leaseId)).length, 0);
  });

  test("ending one from the screen stops it without deleting it", async () => {
    const { w, c } = await signedIn();
    const charge = await addCharge({
      companyId: w.companyId, leaseId: w.leaseId, label: "Pet rent",
      category: "pet", amountCents: 5000, payee: "owner", by: "test",
    });
    const res = await c.post(`/app/portfolio/charge/${charge.id}/end`, {},
      { csrfFrom: `/app/portfolio/u/${w.unitId}` });
    assert.equal(res.status, 303);

    assert.equal((await chargesFor(w.companyId, w.leaseId)).length, 0, "no longer billed");
    assert.equal(
      (await chargesFor(w.companyId, w.leaseId, { includeEnded: true })).length, 1,
      "but still on the record — it is what the tenant was asked to pay");
  });

  test("another company's charge cannot be ended", async () => {
    const { c } = await signedIn();
    const other = await f.makeWorld({ name: "Not Yours Co" });
    const theirs = await addCharge({
      companyId: other.companyId, leaseId: other.leaseId, label: "Pet rent",
      category: "pet", amountCents: 5000, payee: "owner", by: "test",
    });
    const res = await c.post(`/app/portfolio/charge/${theirs.id}/end`, {},
      { csrfFrom: "/app/portfolio" });
    assert.notEqual(res.status, 303);
    assert.equal(
      (await chargesFor(other.companyId, other.leaseId)).length, 1, "still active");
  });
});

/* The import, which is the reason this feature exists.

   The importer has warned about these columns since Phase 7a — pet rent,
   parking, storage — because a lease here had one rent and the money would be
   lost. It can hold them now, so the warning becomes an offer.

   Off unless asked for. Creating charges from a column heading nobody checked
   is how a tenant gets billed for a dog they do not have. */
describe("bringing recurring charges in from an import", () => {
  const FILES = () => ({
    owner: "id,name\nO-1,Owner One\n",
    property: "id,owner id,address,city,state,zip\nP-1,O-1,1 Road,Columbus,OH,43004\n",
    unit: "id,property id,label,beds,baths\nU-1,P-1,1,2,1\n",
    tenant: "id,name,email\nT-1,Tenant One,t1@example.test\n",
    lease: "id,unit id,tenant id,start date,rent,pet rent,parking\n"
      + "L-1,U-1,T-1,2026-01-01,1450.00,50.00,75.00\n",
  });

  test("the values are read, not only the headings", async () => {
    const v = await validateImport({ companyId: world.companyId, files: FILES() });
    const lease = v.entities.lease.rows[0];
    assert.deepEqual(
      lease.data.recurring.map((r) => [r.label, r.cents]).sort(),
      [["Parking", 7500], ["Pet rent", 5000]],
      "the figures have always been thrown away with the headings");
  });

  test("and nothing is created unless it is asked for", async () => {
    const v = await validateImport({ companyId: world.companyId, files: FILES() });
    const res = await commitImport({
      companyId: world.companyId, validated: v, sourceSystem: "test", by: "test",
    });
    assert.equal(res.recurringCharges ?? 0, 0);
    const rows = await all("SELECT * FROM recurring_charge WHERE company_id = ?", world.companyId);
    assert.deepEqual(rows, [], "a column heading nobody checked must not start billing somebody");
  });

  test("asked for, they arrive on the lease with the right money and kind", async () => {
    const v = await validateImport({ companyId: world.companyId, files: FILES() });
    const res = await commitImport({
      companyId: world.companyId, validated: v, sourceSystem: "test", by: "test",
      recurringCharges: true,
    });
    assert.equal(res.recurringCharges, 2);

    const rows = await all(
      "SELECT * FROM recurring_charge WHERE company_id = ? ORDER BY label", world.companyId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].label, "Parking");
    assert.equal(Number(rows[0].amount_cents), 7500);
    assert.equal(rows[0].category, "parking");
    assert.equal(rows[0].payee, "owner");
    assert.equal(rows[1].label, "Pet rent");
    assert.equal(rows[1].category, "pet");
  });

  test("the same file twice does not bill the tenant twice", async () => {
    const opts = { companyId: world.companyId, sourceSystem: "test", by: "test",
      recurringCharges: true };
    await commitImport({ ...opts,
      validated: await validateImport({ companyId: world.companyId, files: FILES() }) });
    await commitImport({ ...opts,
      validated: await validateImport({ companyId: world.companyId, files: FILES() }) });

    const rows = await all("SELECT * FROM recurring_charge WHERE company_id = ?", world.companyId);
    assert.equal(rows.length, 2, "two charges, not four");
  });

  test("a changed amount on a second upload updates rather than duplicates", async () => {
    const opts = { companyId: world.companyId, sourceSystem: "test", by: "test",
      recurringCharges: true };
    await commitImport({ ...opts,
      validated: await validateImport({ companyId: world.companyId, files: FILES() }) });

    const raised = FILES();
    raised.lease = "id,unit id,tenant id,start date,rent,pet rent,parking\n"
      + "L-1,U-1,T-1,2026-01-01,1450.00,60.00,75.00\n";
    await commitImport({ ...opts,
      validated: await validateImport({ companyId: world.companyId, files: raised }) });

    const pet = await get(
      "SELECT amount_cents FROM recurring_charge WHERE company_id = ? AND label = 'Pet rent'",
      world.companyId);
    assert.equal(Number(pet.amount_cents), 6000);
    assert.equal(
      (await all("SELECT id FROM recurring_charge WHERE company_id = ?", world.companyId)).length,
      2);
  });

  test("an imported charge bills like any other", async () => {
    const v = await validateImport({ companyId: world.companyId, files: FILES() });
    await commitImport({ companyId: world.companyId, validated: v, sourceSystem: "test",
      by: "test", recurringCharges: true });

    const res = await chargeRecurring(world.companyId, { period: "2026-03" });
    assert.equal(res.charged, 2);
    assert.equal(res.cents, 12500, "the $125 a month the import used to lose");
  });
});
