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
import { today, addDays, stamp } from "../server/lib/dates.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { ensureChart } from "../server/features/accounting.js";
import { closeOut } from "../server/features/maintenance.js";
import { recordInvoice } from "../server/features/vendors.js";
import { postMoney } from "../server/lib/ledger.js";
import {
  ownerList, unitList, workOrderList, vendorList,
  payoutList, bankLineList, leaseDocumentList,
} from "../server/lib/reports/lists.js";
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

/* --- the three that had no export at all ---------------------------------- */

describe("payments out", () => {
  let cheque = 0;

  async function run_(status, items) {
    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: world.companyId, kind: "owner", method: "check",
      effective_date: today(), status, reference: "RUN-1",
      total_cents: items.reduce((n, i) => n + i.amount_cents, 0),
      item_count: items.length, created_by: "test", created_at: stamp(),
    });
    for (const item of items) {
      /* A unique index on (company_id, check_number): two cheques cannot
         share a number, which is the bank's rule as much as this one's. */
      cheque += 1;
      await insert("payout_item", {
        id: id(), company_id: world.companyId, batch_id: batchId,
        owner_id: world.ownerId, payee_name: "Test Owner",
        check_number: String(1000 + cheque), created_at: stamp(), ...item,
      });
    }
    return batchId;
  }

  test("a voided payment is listed and not counted", async () => {
    /* It never left, so it is not in the total. It stays in the rows because
       somebody removing a payment from a run is worth being able to see. */
    await run_("issued", [
      { amount_cents: 50000 },
      { amount_cents: 30000, voided_at: stamp(), void_reason: "reissued" },
    ]);

    const r = await payoutList(world.companyId, { from: null, to: today() });
    assert.equal(r.payments, 2, "both are listed");
    assert.equal(r.amountCents, 50000, "only one left");
    assert.equal(r.voided, 1);
  });

  test("a cancelled run is not counted either", async () => {
    await run_("cancelled", [{ amount_cents: 40000 }]);
    const r = await payoutList(world.companyId, { from: null, to: today() });
    assert.equal(r.amountCents, 0);
  });

  test("it carries a cheque number and never an account number", async () => {
    /* A payments export lives in a downloads folder. */
    await run_("issued", [{ amount_cents: 50000, routing_number: "021000021", account_last4: "6789" }]);
    const r = await payoutList(world.companyId, { from: null, to: today() });

    assert.match(r.rows[0].identifier, /^#\d+$/);
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes("021000021"), "no routing number leaves this function");
  });

  test("an ACH payment shows the last four and nothing more", async () => {
    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: world.companyId, kind: "vendor", method: "ach",
      effective_date: today(), status: "issued", total_cents: 20000, item_count: 1,
      created_by: "test", created_at: stamp(),
    });
    await insert("payout_item", {
      id: id(), company_id: world.companyId, batch_id: batchId,
      vendor_id: world.vendorId, payee_name: "A Contractor",
      routing_number: "021000021", account_last4: "6789",
      amount_cents: 20000, created_at: stamp(),
    });

    const r = await payoutList(world.companyId, { from: null, to: today() });
    assert.equal(r.rows[0].identifier, "•••6789");
    assert.ok(!JSON.stringify(r).includes("021000021"));
  });
});

describe("bank lines", () => {
  async function account() {
    const itemId = id();
    await insert("bank_item", {
      id: itemId, company_id: world.companyId, provider: "manual",
      institution_name: "Test Bank", status: "active", created_at: stamp(),
    });
    const accountId = id();
    await insert("bank_account", {
      id: accountId, company_id: world.companyId, item_id: itemId,
      external_id: `ext-${accountId}`, name: "Trust checking", mask: "4417",
      type: "depository", balance_cents: 0, is_trust: 1, active: 1, created_at: stamp(),
    });
    return accountId;
  }

  async function line(accountId, { amount, state = "unmatched", name = "DEPOSIT" }) {
    const txnId = id();
    await insert("bank_txn", {
      id: txnId, company_id: world.companyId, bank_account_id: accountId,
      external_id: `x-${txnId}`, posted_date: today(), amount_cents: amount,
      name_raw: name, pending: 0, state, created_at: stamp(),
    });
    return txnId;
  }

  test("an unmatched line is the point, not an omission", async () => {
    /* This report is opened when the reconciliation does not balance. */
    const a = await account();
    await line(a, { amount: 50000 });
    await line(a, { amount: -12000, name: "FEE" });

    const r = await bankLineList(world.companyId, { from: null, to: today() });
    assert.equal(r.unmatched, 2);
    assert.equal(r.unmatchedCents, 50000 - 12000);
  });

  test("a match is described in words, not as a column name", async () => {
    const a = await account();
    const txnId = await line(a, { amount: 50000, state: "matched" });
    await insert("bank_match", {
      id: id(), company_id: world.companyId, bank_txn_id: txnId,
      target_type: "payout_batch", target_id: "whatever",
      amount_cents: 50000, matched_by: "test", matched_at: stamp(),
    });

    const r = await bankLineList(world.companyId, { from: null, to: today() });
    assert.equal(r.rows[0].matchedTo, "A payment run");
    assert.equal(r.unmatched, 0);
  });

  test("every target the database allows has a label", async () => {
    /* A value the CHECK constraint permits must never render as a raw
       column name in front of a customer. */
    const a = await account();
    const targets = ["ledger_entry", "vendor_invoice", "journal", "delinquency",
                     "stripe_payout", "payout_batch"];
    for (const target of targets) {
      const txnId = await line(a, { amount: 1000, state: "matched" });
      await insert("bank_match", {
        id: id(), company_id: world.companyId, bank_txn_id: txnId,
        target_type: target, target_id: "x", amount_cents: 1000,
        matched_by: "test", matched_at: stamp(),
      });
    }

    const r = await bankLineList(world.companyId, { from: null, to: today() });
    for (const row of r.rows) {
      assert.ok(row.matchedTo, "every matched line has a label");
      assert.ok(!row.matchedTo.includes("_"), `${row.matchedTo} is a column name`);
    }
  });

  test("a pending line says pending rather than unmatched", async () => {
    const a = await account();
    const txnId = id();
    await insert("bank_txn", {
      id: txnId, company_id: world.companyId, bank_account_id: a,
      external_id: `p-${txnId}`, posted_date: today(), amount_cents: 5000,
      name_raw: "PENDING CARD", pending: 1, state: "unmatched", created_at: stamp(),
    });

    const r = await bankLineList(world.companyId, { from: null, to: today() });
    assert.equal(r.rows[0].state, "pending");
  });
});

describe("lease documents", () => {
  /* `required` is a JSON array of the party types who still have to sign —
     "who", not "whether". Reading it as a boolean makes every document
     required, which is how this report first counted three outstanding out
     of three. */
  async function document({ status = "draft", mustSign = ["tenant", "manager"], title = "Lease" } = {}) {
    const docId = id();
    await insert("lease_document", {
      id: docId, company_id: world.companyId, lease_id: world.leaseId,
      unit_id: world.unitId, title, body_md: "# Lease", body_hash: "h",
      status, token: `tok-${docId}`, required: JSON.stringify(mustSign),
      created_by: "test", created_at: stamp(),
    });
    return docId;
  }

  test("what is still owed is counted in signatures, not in documents", async () => {
    /* Two parties on a document is two signatures outstanding, and a report
       that counted documents would say one. */
    await document({ status: "out_for_signature", mustSign: ["tenant", "manager"] });
    await document({ status: "signed", mustSign: ["tenant"], title: "Addendum" });

    const r = await leaseDocumentList(world.companyId);
    assert.equal(r.documents, 2);
    assert.equal(r.signaturesOutstanding, 2, "both parties on the live one");
    assert.equal(r.documentsOutstanding, 1);
    assert.equal(r.signed, 1);
  });

  test("who must sign is named", async () => {
    await document({ mustSign: ["tenant", "guarantor"] });
    const r = await leaseDocumentList(world.companyId);
    assert.equal(r.rows[0].mustSign, "tenant, guarantor");
  });

  test("a void document is not outstanding", async () => {
    /* It was withdrawn. Chasing it would be chasing nothing. */
    await document({ status: "void" });
    assert.equal((await leaseDocumentList(world.companyId)).signaturesOutstanding, 0);
  });

  test("a document nobody has to sign is not outstanding either", async () => {
    await document({ status: "draft", mustSign: [] });
    const r = await leaseDocumentList(world.companyId);
    assert.equal(r.signaturesOutstanding, 0);
    assert.equal(r.rows[0].mustSign, "—");
  });

  test("signatures are counted and never listed", async () => {
    /* A signature block carries a typed name, an address and a browser, and
       none of that belongs in a spreadsheet somebody emails around. */
    const docId = await document({ status: "signed", mustSign: ["tenant"] });
    await insert("lease_signature", {
      id: id(), document_id: docId, party_type: "tenant",
      party_name: "Priya Anand", party_email: "priya@example.test",
      typed_name: "Priya Anand", signature_hash: "sig", document_hash: "doc",
      signed_at: stamp(), ip: "203.0.113.9",
      user_agent: "Mozilla/5.0 (iPhone)", consent_esign: 1, created_at: stamp(),
    });

    const r = await leaseDocumentList(world.companyId);
    assert.equal(r.rows[0].signatures, 1);

    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes("203.0.113.9"), "no address");
    assert.ok(!serialised.includes("Mozilla"), "no browser");
    assert.ok(!serialised.includes("priya@example.test"), "no signatory email");
  });
});

describe("the three ask for the right capability", () => {
  test("each matches the screen it lists", async () => {
    assert.equal(reportDefinition("payout_list").need, "money.view");
    assert.equal(reportDefinition("bank_line_list").need, "bank.link");
    assert.equal(reportDefinition("lease_document_list").need, "leasing.work");
  });

  test("a leasing agent gets the documents and neither of the money ones", async () => {
    const offered = reportsFor({ role: "leasing", active: 1 }).map((r) => r.key);
    assert.ok(offered.includes("lease_document_list"));
    assert.ok(!offered.includes("payout_list"));
    assert.ok(!offered.includes("bank_line_list"));
  });
});
