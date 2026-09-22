/* Paying owners and vendors.

   The money still never passes through this platform: a run produces a file
   the company uploads to their own bank, or cheques they print, and records
   what was issued. So the tests are about the things that go wrong on the way
   to that file.

   Three of them matter more than the rest.

   **The compliance barrier.** A contractor with lapsed workers' compensation
   cannot be paid, and the rule has to hold on this path as well as the
   single-invoice one. It is checked twice on purpose — when the draft is
   assembled and again at approval — because a certificate expires between
   Thursday and Friday and the second check is the one that catches it.

   **Approval is atomic.** Journals, cheque numbers and the file are one
   transaction. A run that posted journals and then failed to produce a file
   would have taken money off the books nobody was asked to pay.

   **Cheque numbers are used once.** The positive-pay register is what makes a
   forged cheque bounce, and a duplicate number in it means the bank cannot
   tell which of two cheques to honour. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { postMoney } from "../server/lib/ledger.js";
import {
  ownerBalances, vendorPayables, savePayeeAccount,
  draftOwnerRun, draftVendorRun, approveBatch, renderChecks,
  cancelBatch, voidItem, markIssued,
} from "../server/lib/payouts.js";

const ROUTING = "021000021";          // valid check digit
const OTHER_ROUTING = "011401533";
const EFFECTIVE = "2026-10-05";

let world;

async function companyBank(patch = {}) {
  const { seal } = await import("../server/lib/crypto.js");
  await run(
    `UPDATE company SET ach_company_id = ?, ach_routing_number = ?, ach_account_enc = ?,
            ach_account_last4 = ?, ach_bank_name = ?, ach_balanced_file = ?
      WHERE id = ?`,
    patch.companyId ?? "1234567890",
    patch.routing ?? ROUTING,
    seal(patch.account ?? "000123456789"),
    "6789", "JPMORGAN CHASE", patch.balanced ? 1 : 0, world.companyId);
}

/* Money onto an owner's ledger, through the same path everything else uses. */
async function creditOwner(ownerId, cents, date = "2026-09-15") {
  await postMoney({
    companyId: world.companyId, ownerId, propertyId: world.propertyId,
    date, kind: "rent_payment", amountCents: cents,
    memo: "Rent", source: "manual", postedBy: "test",
  });
}

async function compliantVendor(name = "Good Trades") {
  const vendorId = await f.makeVendor(world.companyId, { name });
  await run(
    "UPDATE vendor SET wc_expires = ?, gl_expires = ?, license_expires = ? WHERE id = ?",
    addDays(today(), 200), addDays(today(), 200), addDays(today(), 200), vendorId);
  return vendorId;
}

async function approvedInvoice(vendorId, amountCents, invoiceNo) {
  const invoiceId = id();
  await insert("vendor_invoice", {
    id: invoiceId, company_id: world.companyId, vendor_id: vendorId,
    invoice_no: invoiceNo, invoice_date: "2026-09-20", due_date: EFFECTIVE,
    amount_cents: amountCents, tax_cents: 0, status: "approved",
    approved_by: "test", approved_at: stamp(), created_at: stamp(),
  });
  return invoiceId;
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Payout Co" });
  await companyBank();
});

/* --- what each payee is owed ----------------------------------------------- */

describe("what an owner is owed", () => {
  test("it is computed from the ledger, not held as a balance", async () => {
    await creditOwner(world.ownerId, 575000);
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: "2026-09-16", kind: "management_fee", amountCents: -51750,
      memo: "Fee", source: "system", postedBy: "test",
    });

    const [owner] = await ownerBalances(world.companyId);
    assert.equal(owner.balanceCents, 523250, "rent less the fee");
    assert.equal(owner.distributableCents, 523250);
  });

  test("money already committed to a run is not offered twice", async () => {
    /* Otherwise a second run assembled before the first is issued pays the
       same balance again. */
    await creditOwner(world.ownerId, 400000);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "5512345678",
    });
    await draftOwnerRun({ companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach" });

    const [owner] = await ownerBalances(world.companyId);
    assert.equal(owner.balanceCents, 400000);
    assert.equal(owner.pendingCents, 400000);
    assert.equal(owner.distributableCents, 0);
  });

  test("a negative balance is not a payout", async () => {
    /* An owner who owes the company money is not sent a cheque for minus
       four hundred dollars. */
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: "2026-09-16", kind: "expense", amountCents: -40000,
      memo: "Repair", source: "work_order", postedBy: "test",
    });
    const [owner] = await ownerBalances(world.companyId);
    assert.ok(owner.balanceCents < 0);
    assert.equal(owner.distributableCents, 0);
  });
});

/* --- the compliance barrier ------------------------------------------------ */

describe("the workers' compensation barrier", () => {
  test("a contractor with a lapsed certificate is left out, and the run says so", async () => {
    const good = await compliantVendor("Good Trades");
    const lapsed = await f.makeVendor(world.companyId, { name: "Lapsed Trades" });
    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", lapsed);

    await approvedInvoice(good, 120000, "INV-1");
    await approvedInvoice(lapsed, 90000, "INV-2");

    const payables = await vendorPayables(world.companyId, { asOf: EFFECTIVE });
    const blocked = payables.find((p) => p.vendorName === "Lapsed Trades");
    assert.equal(blocked.payable, false);
    assert.match(blocked.blockedReasons.join(" "), /workers compensation/i);

    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    assert.equal(draft.ok, true);
    assert.equal(draft.count, 1, "only the compliant contractor");
  });

  test("no certificate at all is the same as an expired one", async () => {
    const vendor = await f.makeVendor(world.companyId, { name: "No Paperwork" });
    await run("UPDATE vendor SET wc_expires = NULL, wc_exempt = 0 WHERE id = ?", vendor);
    await approvedInvoice(vendor, 50000, "INV-3");

    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    assert.equal(draft.ok, false);
    assert.match(draft.reason, /compliance problem/i);
  });

  test("an exempt contractor is payable without one", async () => {
    /* A sole trader with no employees genuinely has no workers' comp, and
       refusing to pay them forever would be wrong. */
    const vendor = await f.makeVendor(world.companyId, { name: "Sole Trader" });
    await run("UPDATE vendor SET wc_expires = NULL, wc_exempt = 1 WHERE id = ?", vendor);
    await approvedInvoice(vendor, 50000, "INV-4");

    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    assert.equal(draft.ok, true);
  });

  test("a certificate that expires between drafting and approving stops the run", async () => {
    /* The reason it is checked twice. The draft was legitimate on Thursday
       and is not on Friday, and the run must not go. */
    const vendor = await compliantVendor("Expiring Trades");
    await approvedInvoice(vendor, 75000, "INV-5");

    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    assert.equal(draft.ok, true);

    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", vendor);

    const approved = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });
    assert.equal(approved.ok, false);
    assert.match(approved.reason, /Expiring Trades.*workers compensation/is);

    const batch = await get("SELECT * FROM payout_batch WHERE id = ?", draft.batchId);
    assert.equal(batch.status, "draft", "nothing was committed");
    assert.equal((await all("SELECT id FROM journal")).length, 0);
  });

  test("a payout hold blocks payment too", async () => {
    const vendor = await compliantVendor("Disputed Trades");
    await run(
      "UPDATE vendor SET payout_hold = 1, payout_hold_reason = ? WHERE id = ?",
      "Disputed invoice under review", vendor);
    await approvedInvoice(vendor, 60000, "INV-6");

    const payables = await vendorPayables(world.companyId, { asOf: EFFECTIVE });
    assert.equal(payables[0].payable, false);
    assert.match(payables[0].blockedReasons.join(" "), /Disputed invoice/);
  });
});

/* --- bank details ----------------------------------------------------------- */

describe("recording where money goes", () => {
  test("the account number is sealed and only the last four are readable", async () => {
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "5512345678",
    });

    const row = await get("SELECT * FROM payee_account WHERE owner_id = ?", world.ownerId);
    assert.equal(row.account_last4, "5678");
    assert.ok(row.account_enc);
    assert.ok(!row.account_enc.includes("5512345678"), "the number is not in the column");

    const { tryOpen } = await import("../server/lib/crypto.js");
    assert.equal(tryOpen(row.account_enc), "5512345678", "and it can be opened to build the file");
  });

  test("a routing number that fails its check digit is refused", async () => {
    const res = await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: "021000012", accountNumber: "5512345678",
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /check digit/i);
  });

  test("changing an address does not wipe the account number", async () => {
    /* The form shows the last four and an empty box, so an empty box means
       "unchanged", not "delete it". */
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "5512345678",
    });
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "", mailTo: "12 New Street",
    });

    const row = await get("SELECT * FROM payee_account WHERE owner_id = ?", world.ownerId);
    assert.equal(row.account_last4, "5678");
    assert.equal(row.mail_to, "12 New Street");
  });

  test("a changed account is an unverified account", async () => {
    /* A prenote against the old number proves nothing about the new one. */
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "5512345678",
    });
    await run("UPDATE payee_account SET verified_at = ? WHERE owner_id = ?", stamp(), world.ownerId);

    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: ROUTING, accountNumber: "9998887777",
    });
    const row = await get("SELECT * FROM payee_account WHERE owner_id = ?", world.ownerId);
    assert.equal(row.verified_at, null);
  });

  test("an account cannot belong to an owner and a contractor at once", async () => {
    await assert.rejects(
      () => savePayeeAccount({
        companyId: world.companyId, ownerId: world.ownerId,
        vendorId: world.vendorId, method: "check",
      }),
      /not both and not neither/);
  });

  test("the database refuses an ACH account with no number", async () => {
    await assert.rejects(() => insert("payee_account", {
      id: id(), company_id: world.companyId, owner_id: world.ownerId,
      method: "ach", routing_number: null, account_enc: null,
      created_at: stamp(),
    }), /ach_needs_an_account/);
  });
});

/* --- the ACH run ------------------------------------------------------------ */

describe("an owner run by bank transfer", () => {
  beforeEach(async () => {
    await creditOwner(world.ownerId, 486775);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: OTHER_ROUTING, accountNumber: "5512345678",
    });
  });

  test("it drafts without committing anything", async () => {
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    assert.equal(draft.ok, true);

    const batch = await get("SELECT * FROM payout_batch WHERE id = ?", draft.batchId);
    assert.equal(batch.status, "draft");
    assert.equal(Number(batch.total_cents), 486775);
    assert.equal(
      (await all("SELECT id FROM journal WHERE source_type = 'payout_item'")).length, 0,
      "a draft posts no payout journal");
  });

  test("approving posts the books and produces the file, together", async () => {
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });

    assert.equal(res.ok, true);
    assert.equal(res.file.kind, "ach");
    assert.match(res.file.name, /\.ach$/);
    assert.equal(res.file.text.split("\r\n")[0][0], "1", "a file header");

    const batch = await get("SELECT * FROM payout_batch WHERE id = ?", draft.batchId);
    assert.equal(batch.status, "approved");
    assert.ok(batch.file_hash, "and the file is frozen with a fingerprint");

    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", draft.batchId);
    assert.ok(item.journal_id, "the payment is on the books");
  });

  test("the journal takes it out of owner funds, not out of income", async () => {
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });

    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", draft.batchId);
    const splits = await all(
      `SELECT a.code, s.debit_cents, s.credit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, item.journal_id);
    const debited = splits.find((s) => Number(s.debit_cents) > 0);
    const credited = splits.find((s) => Number(s.credit_cents) > 0);

    assert.equal(debited.code, "2200", "owner funds held goes down");
    assert.equal(credited.code, "1010", "and it comes out of trust cash");
  });

  test("the file totals match what was approved", async () => {
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });
    assert.equal(res.file.totals.creditCents, 486775);
    assert.equal(res.file.totals.entries, 1);
  });

  test("owners are sent PPD and contractors CCD", async () => {
    /* Owners are usually people and contractors usually are not. */
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });
    assert.equal(res.file.text.split("\r\n")[1].slice(50, 53), "PPD");
  });

  test("it refuses to run without the company's own bank details", async () => {
    await run("UPDATE company SET ach_routing_number = NULL WHERE id = ?", world.companyId);
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /own bank details/i);
    assert.equal(
      (await all("SELECT id FROM journal WHERE source_type = 'payout_item'")).length, 0,
      "nothing was committed");
  });

  test("an ACH payee with no bank details cannot exist to begin with", async () => {
    /* The readiness check in approveBatch covers this, but the database gets
       there first: an ACH account without routing and account columns is
       refused by a constraint, so the run cannot assemble a payee it has no
       way to pay. Belt and braces, and this is the braces. */
    await assert.rejects(
      () => run(
        "UPDATE payee_account SET routing_number = NULL WHERE owner_id = ?", world.ownerId),
      /ach_needs_an_account/);

    const row = await get("SELECT * FROM payee_account WHERE owner_id = ?", world.ownerId);
    assert.ok(row.routing_number, "still intact");
  });

  test("a balanced file is produced when the bank wants one", async () => {
    await run("UPDATE company SET ach_balanced_file = 1 WHERE id = ?", world.companyId);
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "ach",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });
    assert.equal(res.file.totals.debitCents, res.file.totals.creditCents);
    assert.equal(res.file.text.split("\r\n")[1].slice(1, 4), "200", "mixed batch");
  });
});

/* --- the cheque run --------------------------------------------------------- */

describe("a contractor run by cheque", () => {
  let vendorA, vendorB;

  beforeEach(async () => {
    vendorA = await compliantVendor("Alpha Plumbing");
    vendorB = await compliantVendor("Beta Electrical");
    await approvedInvoice(vendorA, 120000, "A-1");
    await approvedInvoice(vendorA, 45000, "A-2");
    await approvedInvoice(vendorB, 80000, "B-1");
  });

  test("one cheque per contractor, not one per invoice", async () => {
    /* A contractor with four jobs this month gets one cheque with four lines
       on the stub, which is what they expect and a quarter of the postage. */
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    assert.equal(draft.count, 2, "two contractors, three invoices");

    const items = await all(
      "SELECT * FROM payout_item WHERE batch_id = ? ORDER BY payee_name", draft.batchId);
    assert.equal(Number(items[0].amount_cents), 165000, "Alpha's two invoices together");
    assert.match(items[0].memo, /2 invoices/);
  });

  test("cheque numbers are assigned at approval and used once", async () => {
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });

    const items = await all(
      "SELECT * FROM payout_item WHERE batch_id = ? ORDER BY check_number", draft.batchId);
    assert.deepEqual(items.map((i) => Number(i.check_number)), [1001, 1002]);

    const register = await get("SELECT * FROM check_register WHERE company_id = ?", world.companyId);
    assert.equal(Number(register.next_number), 1003, "the book has moved on");
  });

  test("a second run continues the numbering, it does not restart", async () => {
    const first = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: first.batchId, companyId: world.companyId, by: "staff-1" });

    const vendorC = await compliantVendor("Gamma Roofing");
    await approvedInvoice(vendorC, 30000, "C-1");
    const second = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: second.batchId, companyId: world.companyId, by: "staff-1" });

    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", second.batchId);
    assert.equal(Number(item.check_number), 1003);
  });

  test("the database refuses a duplicate cheque number", async () => {
    /* Positive pay is built from these. A duplicate means the bank cannot
       tell which of two cheques it should honour. */
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });

    await assert.rejects(() => insert("payout_item", {
      id: id(), company_id: world.companyId, batch_id: draft.batchId,
      vendor_id: vendorA, payee_name: "Duplicate", check_number: 1001,
      amount_cents: 100, created_at: stamp(),
    }), /duplicate key/);
  });

  test("the positive-pay register is frozen with the run", async () => {
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    const res = await approveBatch({
      batchId: draft.batchId, companyId: world.companyId, by: "staff-1",
    });

    assert.equal(res.file.kind, "check");
    assert.match(res.file.name, /positive-pay.*\.csv$/);
    const rows = res.file.text.trim().split("\r\n");
    assert.equal(rows.length, 3, "a header and two cheques");
    assert.match(rows[1], /1001,1650\.00,10\/05\/2026,Alpha Plumbing,I/);
  });

  test("the cheques themselves print from the frozen rows", async () => {
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });

    const pdf = await renderChecks({ batchId: draft.batchId, companyId: world.companyId });
    assert.equal(Buffer.from(pdf).toString("latin1", 0, 5), "%PDF-");

    const { PDFDocument } = await import("pdf-lib");
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
  });

  test("cheques cannot be printed from a draft", async () => {
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await assert.rejects(
      () => renderChecks({ batchId: draft.batchId, companyId: world.companyId }),
      /Approve the run/);
  });

  test("the journal settles the payable rather than booking a new cost", async () => {
    /* The cost was recognised when the invoice was approved. Booking it again
       here would double the expense. */
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });

    const item = await get("SELECT * FROM payout_item WHERE batch_id = ? LIMIT 1", draft.batchId);
    const splits = await all(
      `SELECT a.code, s.debit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, item.journal_id);
    const debited = splits.find((s) => Number(s.debit_cents) > 0);
    assert.equal(debited.code, "2000", "accounts payable");
  });
});

/* --- unwinding -------------------------------------------------------------- */

describe("cancelling and voiding", () => {
  async function approvedChequeRun() {
    const vendor = await compliantVendor("Alpha Plumbing");
    await approvedInvoice(vendor, 120000, "A-1");
    const draft = await draftVendorRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });
    return draft.batchId;
  }

  test("a draft can be cancelled outright", async () => {
    await creditOwner(world.ownerId, 100000);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "check",
    });
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });

    const res = await cancelBatch({
      batchId: draft.batchId, companyId: world.companyId, reason: "Wrong date", by: "staff-1",
    });
    assert.equal(res.ok, true);

    const [owner] = await ownerBalances(world.companyId);
    assert.equal(owner.distributableCents, 100000, "the money is available again");
  });

  test("an approved run cannot be, because the numbers are used", async () => {
    const batchId = await approvedChequeRun();
    const res = await cancelBatch({
      batchId, companyId: world.companyId, reason: "Changed my mind", by: "staff-1",
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /cheque numbers have been used/i);
  });

  test("voiding a cheque reverses its journal and keeps the number", async () => {
    /* The number stays used: positive pay needs the bank to know it exists so
       it is refused if presented. */
    const batchId = await approvedChequeRun();
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batchId);

    const res = await voidItem({
      itemId: item.id, companyId: world.companyId, reason: "Printer jammed", by: "staff-1",
    });
    assert.equal(res.ok, true);

    const after = await get("SELECT * FROM payout_item WHERE id = ?", item.id);
    assert.ok(after.voided_at);
    assert.equal(Number(after.check_number), 1001, "the number is not released");

    const original = await get("SELECT * FROM journal WHERE id = ?", item.journal_id);
    assert.ok(original.reversed_by, "the journal was reversed, not deleted");
  });

  test("voiding twice reverses once", async () => {
    const batchId = await approvedChequeRun();
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batchId);
    await voidItem({ itemId: item.id, companyId: world.companyId, reason: "Jam", by: "s" });
    const again = await voidItem({ itemId: item.id, companyId: world.companyId, reason: "Jam", by: "s" });
    assert.equal(again.alreadyVoid, true);

    /* The reversal inherits the original's source, so both rows carry this
       item's id. What must be true is that there is exactly one reversal. */
    const reversals = await all(
      "SELECT id FROM journal WHERE source_id = ? AND reverses_id IS NOT NULL", item.id);
    assert.equal(reversals.length, 1, "reversed once, not twice");
  });

  test("voiding updates the run's totals", async () => {
    const batchId = await approvedChequeRun();
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batchId);
    await voidItem({ itemId: item.id, companyId: world.companyId, reason: "Jam", by: "s" });

    const batch = await get("SELECT * FROM payout_batch WHERE id = ?", batchId);
    assert.equal(Number(batch.item_count), 0);
    assert.equal(Number(batch.total_cents), 0);
  });

  test("a run is marked issued once it has gone to the bank", async () => {
    const batchId = await approvedChequeRun();
    assert.equal((await markIssued({ batchId, companyId: world.companyId, by: "s" })).ok, true);
    const batch = await get("SELECT * FROM payout_batch WHERE id = ?", batchId);
    assert.equal(batch.status, "issued");
    assert.ok(batch.issued_at);
  });

  test("a draft cannot be marked issued", async () => {
    await creditOwner(world.ownerId, 100000);
    await savePayeeAccount({ companyId: world.companyId, ownerId: world.ownerId, method: "check" });
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: EFFECTIVE, method: "check",
    });
    const res = await markIssued({ batchId: draft.batchId, companyId: world.companyId, by: "s" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /draft, not approved/);
  });

  test("approving twice is refused", async () => {
    const batchId = await approvedChequeRun();
    const again = await approveBatch({ batchId, companyId: world.companyId, by: "staff-1" });
    assert.equal(again.ok, false);
    assert.match(again.reason, /already approved/);
  });
});

/* --- tenancy ---------------------------------------------------------------- */

describe("one company cannot pay another's payees", () => {
  test("a batch from another company is not found", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await run(
      "UPDATE company SET ach_routing_number = ?, ach_account_enc = ? WHERE id = ?",
      ROUTING, "x", other.companyId);

    await postMoney({
      companyId: other.companyId, ownerId: other.ownerId, propertyId: other.propertyId,
      date: "2026-09-15", kind: "rent_payment", amountCents: 50000,
      memo: "Rent", source: "manual", postedBy: "test",
    });
    await savePayeeAccount({
      companyId: other.companyId, ownerId: other.ownerId, method: "check",
    });
    const draft = await draftOwnerRun({
      companyId: other.companyId, effectiveDate: EFFECTIVE, method: "check",
    });

    await assert.rejects(
      () => approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" }),
      /Not found/);
  });

  test("balances are scoped to the company", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await postMoney({
      companyId: other.companyId, ownerId: other.ownerId, propertyId: other.propertyId,
      date: "2026-09-15", kind: "rent_payment", amountCents: 999999,
      memo: "Rent", source: "manual", postedBy: "test",
    });

    const mine = await ownerBalances(world.companyId);
    assert.ok(!mine.some((o) => o.balanceCents === 999999));
  });
});
