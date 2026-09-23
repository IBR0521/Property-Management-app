/* The working lists, as reports.

   The registry's own loops already check that these run, lay out, export and
   name a real capability. What they cannot check is whether the figures mean
   anything, which is what this file is for.

   One decision needs holding above the others: a work order carries two money
   columns and they answer different questions. `recorded` is what somebody
   typed when they closed the job; `invoiced` is what the contractor billed.
   Since the one-cost-per-repair fix those are allowed to differ, and the cost
   total follows the same rule the books do — the invoice where there is one. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today, addDays } from "../server/lib/dates.js";
import { ensureChart } from "../server/features/accounting.js";
import { closeOut } from "../server/features/maintenance.js";
import { recordInvoice } from "../server/features/vendors.js";
import { postMoney } from "../server/lib/ledger.js";
import { ownerList, unitList, workOrderList, vendorList } from "../server/lib/reports/lists.js";
import { reportsFor, reportDefinition } from "../server/lib/reports/index.js";

let world, staff;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Lists Co" });
  await ensureChart(world.companyId);
  staff = { id: world.staff.admin.id, name: "Dana" };
  await run(
    "UPDATE vendor SET gl_expires = ?, wc_expires = ?, license_expires = ? WHERE id = ?",
    "2099-01-01", "2099-01-01", "2099-01-01", world.vendorId);
});

/* --- owners -------------------------------------------------------------- */

describe("the owner list", () => {
  test("the balance is what the owner's own ledger says", async () => {
    /* Positive towards them, the same sign their statement shows. Flipping
       it here would make one screen disagree with the document they were
       sent. */
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: today(), kind: "rent_payment", amountCents: 145000, memo: "rent",
      source: "manual", postedBy: "t",
    });
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: today(), kind: "management_fee", amountCents: -14500, memo: "fee",
      source: "manual", postedBy: "t",
    });

    const r = await ownerList(world.companyId);
    const owner = r.rows.find((o) => o.ownerId === world.ownerId);
    assert.equal(owner.balanceCents, 145000 - 14500);
    assert.equal(r.balanceCents, owner.balanceCents);
  });

  test("an owner with nothing is still listed", async () => {
    /* A list of owners that hid the quiet ones would not be a list of
       owners. */
    const quiet = await f.makeOwner(world.companyId, { name: "Nobody Yet" });
    const r = await ownerList(world.companyId);
    const row = r.rows.find((o) => o.ownerId === quiet);

    assert.ok(row);
    assert.equal(row.properties, 0);
    assert.equal(row.balanceCents, 0);
  });

  test("properties and units are counted without multiplying each other", async () => {
    /* Two joins onto one row is how a two-property owner gains four
       properties. */
    const second = await f.makeProperty(world.companyId, world.ownerId, { line1: "2 Second St" });
    await f.makeUnit(world.companyId, second, { label: "A" });
    await f.makeUnit(world.companyId, second, { label: "B" });

    const r = await ownerList(world.companyId);
    const owner = r.rows.find((o) => o.ownerId === world.ownerId);
    assert.equal(owner.properties, 2);
    assert.equal(owner.units, 3, "one on the first property and two on the second");
  });
});

/* --- units --------------------------------------------------------------- */

describe("the unit list", () => {
  test("an empty unit is on it, with no rent and no tenant", async () => {
    await f.makeUnit(world.companyId, world.propertyId, { label: "empty", status: "vacant" });

    const r = await unitList(world.companyId);
    const row = r.rows.find((u) => u.label === "empty");

    assert.equal(row.rentCents, null, "not zero — there is no lease to have a rent");
    assert.equal(row.tenants, null);
    assert.equal(row.status, "vacant");
  });

  test("a let unit carries its tenant and its rent", async () => {
    const r = await unitList(world.companyId);
    const row = r.rows.find((u) => u.unitId === world.unitId);
    assert.ok(row.rentCents > 0);
    assert.ok(row.tenants, "the lease has a tenant on it");
  });

  test("the rent total counts only what is let", async () => {
    await f.makeUnit(world.companyId, world.propertyId, { label: "empty", rentCents: 999999, status: "vacant" });
    const r = await unitList(world.companyId);
    const let_ = r.rows.find((u) => u.unitId === world.unitId);
    assert.equal(r.rentCents, let_.rentCents);
  });

  test("it can be narrowed to one property", async () => {
    const other = await f.makeProperty(world.companyId, world.ownerId, { line1: "9 Elsewhere" });
    await f.makeUnit(world.companyId, other, { label: "1" });

    const r = await unitList(world.companyId, { propertyId: other });
    assert.equal(r.units, 1);
  });
});

/* --- work orders ---------------------------------------------------------- */

describe("the work order list", () => {
  const workOrder = async () => await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);

  test("recorded and invoiced are separate columns", async () => {
    /* They answer different questions and since the one-cost-per-repair fix
       they are allowed to differ. Showing one and calling it the cost would
       be a number that looks right. */
    await closeOut({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 20000, files: [], note: "done",
    });
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: world.workOrderId,
      invoiceNo: "INV-1", invoiceDate: today(), amountCents: 25000, taxCents: 0,
      memo: "repair", createdBy: staff.id,
    });

    const r = await workOrderList(world.companyId, { from: null, to: today() });
    const row = r.rows.find((w) => w.workOrderId === world.workOrderId);

    assert.equal(row.recordedCents, 20000, "what was typed on the job");
    assert.equal(row.invoicedCents, 25000, "what the contractor billed");
  });

  test("the cost total uses the invoice where there is one", async () => {
    /* The same rule the books follow, so the two agree. */
    await closeOut({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 20000, files: [], note: "done",
    });
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: world.workOrderId,
      invoiceNo: "INV-1", invoiceDate: today(), amountCents: 25000, taxCents: 0,
      memo: "repair", createdBy: staff.id,
    });

    const r = await workOrderList(world.companyId, { from: null, to: today() });
    assert.equal(r.costCents, 25000, "not 45000, and not 20000");
  });

  test("and the recorded figure where there is not", async () => {
    await closeOut({
      companyId: world.companyId, wo: await workOrder(), staff,
      actualCents: 18000, files: [], note: "done",
    });
    const r = await workOrderList(world.companyId, { from: null, to: today() });
    assert.equal(r.costCents, 18000);
  });

  test("a voided invoice does not count", async () => {
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: world.workOrderId,
      invoiceNo: "INV-1", invoiceDate: today(), amountCents: 25000, taxCents: 0,
      memo: "repair", createdBy: staff.id,
    });
    await run("UPDATE vendor_invoice SET status = 'void'");

    const r = await workOrderList(world.companyId, { from: null, to: today() });
    assert.equal(r.rows[0].invoicedCents, null);
  });

  test("open and emergency are counted from the real status values", async () => {
    await run("UPDATE work_order SET status = ?, severity = ? WHERE id = ?",
      "triaged", "emergency", world.workOrderId);
    const r = await workOrderList(world.companyId, { from: null, to: today() });

    assert.equal(r.open, 1);
    assert.equal(r.emergencies, 1);

    await run("UPDATE work_order SET status = 'complete' WHERE id = ?", world.workOrderId);
    assert.equal((await workOrderList(world.companyId, { from: null, to: today() })).open, 0);
  });

  test("a job raised outside the period is not on it", async () => {
    const r = await workOrderList(world.companyId, { from: "2020-01-01", to: "2020-12-31" });
    assert.equal(r.jobs, 0);
  });

  test("a job raised today is, and the end of the day is included", async () => {
    /* `created_at` is a timestamp and `to` is a date. Comparing them without
       reaching the end of the day hides everything raised after midnight,
       which is everything. */
    const r = await workOrderList(world.companyId, { from: null, to: today() });
    assert.equal(r.jobs, 1);
  });
});

/* --- contractors ----------------------------------------------------------- */

describe("the contractor list", () => {
  test("it reports the compliance verdict rather than applying it", async () => {
    /* The barrier lives in complianceState and is enforced at dispatch and
       payment. This says what it says. */
    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", world.vendorId);

    const r = await vendorList(world.companyId, { asOf: today() });
    const row = r.rows.find((v) => v.vendorId === world.vendorId);

    assert.equal(row.canBePaid, false, "lapsed workers comp blocks payment");
    assert.match(row.blocked, /[Ww]orkers compensation/);
    assert.equal(r.blockedFromPayment, 1);
  });

  test("a warning is a string, not an object", async () => {
    /* `problems` are objects with a `.text` and `warnings` are plain
       strings — two shapes in one return value, and getting it wrong yields
       a row of "undefined". */
    await run("UPDATE vendor SET gl_expires = ? WHERE id = ?", addDays(today(), 10), world.vendorId);

    const r = await vendorList(world.companyId, { asOf: today() });
    const row = r.rows.find((v) => v.vendorId === world.vendorId);

    assert.ok(row.warnings, "there should be one");
    assert.ok(!row.warnings.includes("undefined"), row.warnings);
    assert.match(row.warnings, /[Gg]eneral liability expires/);
  });

  test("an exemption is said, not left blank", async () => {
    /* Blank reads as "not on file", which is the opposite of exempt. */
    await run("UPDATE vendor SET wc_exempt = 1, wc_expires = NULL WHERE id = ?", world.vendorId);
    const r = await vendorList(world.companyId, { asOf: today() });
    assert.equal(r.rows.find((v) => v.vendorId === world.vendorId).workersCompExpires, "exempt");
  });

  test("a clear contractor is clear", async () => {
    const r = await vendorList(world.companyId, { asOf: today() });
    const row = r.rows.find((v) => v.vendorId === world.vendorId);
    assert.equal(row.canDispatch, true);
    assert.equal(row.canBePaid, true);
    assert.equal(row.blocked, null);
  });
});

/* --- who is offered them ---------------------------------------------------- */

describe("who can run them", () => {
  test("each one asks for the capability its screen does", async () => {
    /* A list should not be a way round the gate on the screen it lists. */
    assert.equal(reportDefinition("owner_list").need, "money.view");
    assert.equal(reportDefinition("unit_list").need, "property.view");
    assert.equal(reportDefinition("work_order_list").need, "maintenance.work");
    assert.equal(reportDefinition("vendor_list").need, "vendor.manage");
  });

  test("an accountant gets the contractors and not the work orders", async () => {
    /* They hold vendor.manage for the compliance and 1099 side, and no
       maintenance capability at all. */
    const offered = reportsFor({ role: "accountant", active: 1 }).map((r) => r.key);
    assert.ok(offered.includes("vendor_list"));
    assert.ok(offered.includes("owner_list"));
    assert.ok(!offered.includes("work_order_list"));
  });

  test("a leasing agent gets the units and none of the money", async () => {
    const offered = reportsFor({ role: "leasing", active: 1 }).map((r) => r.key);
    assert.ok(offered.includes("unit_list"));
    assert.ok(!offered.includes("owner_list"));
    assert.ok(!offered.includes("vendor_list"));
  });
});
