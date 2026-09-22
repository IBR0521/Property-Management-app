/* The screens a property manager uses to pay owners and contractors.

   The engine underneath is tested in payouts.test.js. This is about the
   things only the screens decide: who is allowed to release money, that a
   draft cannot become a payment by accident, that the file the bank gets is
   served as a file, and that a blocked contractor is *visible* rather than
   silently missing — a manager who cannot see the excluded invoice assumes
   it was overlooked and pays it another way. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { postMoney } from "../server/lib/ledger.js";
import { savePayeeAccount } from "../server/lib/payouts.js";

const ROUTING = "021000021";
const PAYEE_ROUTING = "011401533";

let app, world, staff;

const page = async (path) => {
  const { res, body } = await staff.text(path);
  return { status: res.status, body, res };
};
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

async function companyBank() {
  const { seal } = await import("../server/lib/crypto.js");
  await run(
    `UPDATE company SET ach_company_id = ?, ach_routing_number = ?, ach_account_enc = ?,
            ach_account_last4 = ?, ach_bank_name = ? WHERE id = ?`,
    "1234567890", ROUTING, seal("000123456789"), "6789", "JPMORGAN CHASE", world.companyId);
}

async function creditOwner(cents) {
  await postMoney({
    companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
    date: "2026-09-15", kind: "rent_payment", amountCents: cents,
    memo: "Rent", source: "manual", postedBy: "test",
  });
}

async function compliantVendor(name) {
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
    invoice_no: invoiceNo, invoice_date: "2026-09-20", due_date: "2026-10-05",
    amount_cents: amountCents, tax_cents: 0, status: "approved",
    approved_by: "test", approved_at: stamp(), created_at: stamp(),
  });
  return invoiceId;
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Payout Co", staffRoles: ["admin", "leasing", "accountant"] });
  await companyBank();
  staff = client(app.origin);
  const res = await staff.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* --- who can release money -------------------------------------------------- */

describe("who can get to it", () => {
  test("an admin can", async () => {
    const res = await page("/app/payouts");
    assert.equal(res.status, 200);
    assert.match(res.body, /Payments out/);
  });

  test("an accountant can, because this is the books", async () => {
    const other = client(app.origin);
    await other.signIn(world.staff.accountant.email, f.PASSWORD);
    const { res } = await other.text("/app/payouts");
    assert.equal(res.status, 200);
  });

  test("a leasing account cannot", async () => {
    const other = client(app.origin);
    await other.signIn(world.staff.leasing.email, f.PASSWORD);
    const res = await other.get("/app/payouts");
    assert.equal(res.status, 403);
  });

  test("signed out, nothing is reachable", async () => {
    const anon = client(app.origin);
    for (const path of ["/app/payouts", "/app/payouts/owners", "/app/payouts/bank"]) {
      const res = await anon.get(path);
      assert.equal(res.status, 303, path);
      assert.match(res.headers.get("location"), /sign-in/);
    }
  });

  test("the screen says plainly that the money is not ours", async () => {
    const res = await page("/app/payouts");
    assert.match(res.body, /does not pass through us/i);
    assert.match(res.body, /your bank moves the funds/i);
  });
});

/* --- owners due -------------------------------------------------------------- */

describe("owners due", () => {
  test("it shows what each is owed and how they are paid", async () => {
    await creditOwner(486775);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: PAYEE_ROUTING, accountNumber: "5512345678",
    });

    const res = await page("/app/payouts/owners");
    assert.match(res.body, /\$4,867\.75/);
    assert.match(res.body, /Bank transfer/);
    assert.match(res.body, /ending 5678/);
  });

  test("an owner with no account recorded is flagged rather than hidden", async () => {
    await creditOwner(100000);
    const res = await page("/app/payouts/owners");
    assert.match(res.body, /not set/);
  });

  test("assembling a run commits nothing and lands on the run", async () => {
    await creditOwner(486775);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: PAYEE_ROUTING, accountNumber: "5512345678",
    });

    const res = await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "ach" }, { csrfFrom: "/app/payouts/owners" });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/app\/payouts\/\w+/);

    const batch = await get("SELECT * FROM payout_batch");
    assert.equal(batch.status, "draft");
    assert.equal(
      (await all("SELECT id FROM journal WHERE source_type = 'payout_item'")).length, 0);
  });

  test("a run with nobody in it says so instead of creating an empty one", async () => {
    await creditOwner(100000);
    await savePayeeAccount({ companyId: world.companyId, ownerId: world.ownerId, method: "check" });

    const res = await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "ach" }, { csrfFrom: "/app/payouts/owners" });
    assert.match(loc(res), /No owner is due a bank transfer/i);
    assert.equal((await all("SELECT id FROM payout_batch")).length, 0);
  });
});

/* --- the compliance barrier, on screen -------------------------------------- */

describe("a held contractor", () => {
  test("is shown, with the reason, rather than quietly left out", async () => {
    /* A manager who cannot see the excluded invoice assumes it was
       overlooked and pays it another way, which is the barrier defeated. */
    const lapsed = await f.makeVendor(world.companyId, { name: "Lapsed Trades" });
    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", lapsed);
    await approvedInvoice(lapsed, 90000, "INV-1");

    const res = await page("/app/payouts/vendors");
    assert.match(res.body, /Held by a compliance problem/);
    assert.match(res.body, /Lapsed Trades/);
    assert.match(res.body, /workers compensation/i);
    assert.match(res.body, /\$900\.00/);
  });

  test("and the screen says how to fix it", async () => {
    const lapsed = await f.makeVendor(world.companyId, { name: "Lapsed Trades" });
    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", lapsed);
    await approvedInvoice(lapsed, 90000, "INV-1");

    const res = await page("/app/payouts/vendors");
    assert.match(res.body, /Fix the certificate/i);
  });

  test("it cannot be assembled into a run from the screen", async () => {
    const lapsed = await f.makeVendor(world.companyId, { name: "Lapsed Trades" });
    await run("UPDATE vendor SET wc_expires = ? WHERE id = ?", "2020-01-01", lapsed);
    await approvedInvoice(lapsed, 90000, "INV-1");

    const res = await staff.post("/app/payouts/vendors/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/vendors" });
    assert.match(loc(res), /compliance problem/i);
    assert.equal((await all("SELECT id FROM payout_batch")).length, 0);
  });
});

/* --- approving --------------------------------------------------------------- */

describe("approving a run", () => {
  async function draftChequeRun() {
    const vendor = await compliantVendor("Alpha Plumbing");
    await approvedInvoice(vendor, 120000, "A-1");
    await staff.post("/app/payouts/vendors/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/vendors" });
    return await get("SELECT * FROM payout_batch");
  }

  test("the draft screen warns before it is irreversible", async () => {
    const batch = await draftChequeRun();
    const res = await page(`/app/payouts/${batch.id}`);
    assert.match(res.body, /Nothing has been committed yet/);
    assert.match(res.body, /cannot be undone/);
    assert.match(res.body, /takes the cheque numbers/);
  });

  test("approving posts the books and assigns numbers", async () => {
    const batch = await draftChequeRun();
    const res = await staff.post(`/app/payouts/${batch.id}/approve`, {},
      { csrfFrom: `/app/payouts/${batch.id}` });
    assert.match(loc(res), /Download the file/i);

    const after = await get("SELECT * FROM payout_batch WHERE id = ?", batch.id);
    assert.equal(after.status, "approved");
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batch.id);
    assert.equal(Number(item.check_number), 1001);
    assert.ok(item.journal_id);
  });

  test("a leasing account cannot approve one", async () => {
    const batch = await draftChequeRun();
    const other = client(app.origin);
    await other.signIn(world.staff.leasing.email, f.PASSWORD);
    const res = await other.post(`/app/payouts/${batch.id}/approve`, {}, { csrf: "x" });
    assert.ok(res.status === 403 || res.status === 303, `got ${res.status}`);

    const after = await get("SELECT * FROM payout_batch WHERE id = ?", batch.id);
    assert.equal(after.status, "draft", "still a draft");
  });

  test("a run from another company is not found", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: other.companyId, kind: "owner", method: "check",
      effective_date: "2026-10-05", status: "draft", created_at: stamp(),
    });
    const res = await staff.get(`/app/payouts/${batchId}`);
    assert.equal(res.status, 404);
  });

  test("a draft can be discarded and the money comes back", async () => {
    await creditOwner(100000);
    await savePayeeAccount({ companyId: world.companyId, ownerId: world.ownerId, method: "check" });
    await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/owners" });
    const batch = await get("SELECT * FROM payout_batch");

    await staff.post(`/app/payouts/${batch.id}/cancel`, { reason: "Wrong date" },
      { csrfFrom: `/app/payouts/${batch.id}` });

    const after = await get("SELECT * FROM payout_batch WHERE id = ?", batch.id);
    assert.equal(after.status, "cancelled");
    const owners = await page("/app/payouts/owners");
    assert.match(owners.body, /\$1,000\.00/, "available again");
  });
});

/* --- the files --------------------------------------------------------------- */

describe("the files the bank gets", () => {
  async function approvedAchRun() {
    await creditOwner(486775);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: PAYEE_ROUTING, accountNumber: "5512345678",
    });
    await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "ach" }, { csrfFrom: "/app/payouts/owners" });
    const batch = await get("SELECT * FROM payout_batch");
    await staff.post(`/app/payouts/${batch.id}/approve`, {}, { csrfFrom: `/app/payouts/${batch.id}` });
    return batch;
  }

  test("the ACH file downloads as a file, not as a page", async () => {
    /* Opened in a browser it is a wall of digits somebody will copy and
       paste, and every space in it matters. */
    const batch = await approvedAchRun();
    const res = await staff.get(`/app/payouts/${batch.id}/file`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename=".*\.ach"/);
    assert.match(res.headers.get("content-type"), /text\/plain/);

    const body = await res.text();
    assert.equal(body.split("\r\n")[0].length, 94, "records are 94 characters");
    assert.equal(body.split("\r\n")[0][0], "1", "a file header");
  });

  test("it cannot be downloaded before the run is approved", async () => {
    await creditOwner(100000);
    await savePayeeAccount({ companyId: world.companyId, ownerId: world.ownerId, method: "check" });
    await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/owners" });
    const batch = await get("SELECT * FROM payout_batch");

    const res = await staff.get(`/app/payouts/${batch.id}/file`);
    assert.equal(res.status, 400);
  });

  test("another company's file is not served", async () => {
    const batch = await approvedAchRun();
    const other = await f.makeWorld({ name: "Other Co" });
    const otherStaff = client(app.origin);
    await otherStaff.signIn(other.staff.admin.email, f.PASSWORD);

    const res = await otherStaff.get(`/app/payouts/${batch.id}/file`);
    assert.equal(res.status, 404);
  });

  test("cheques come back as a PDF", async () => {
    const vendor = await compliantVendor("Alpha Plumbing");
    await approvedInvoice(vendor, 120000, "A-1");
    await staff.post("/app/payouts/vendors/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/vendors" });
    const batch = await get("SELECT * FROM payout_batch");
    await staff.post(`/app/payouts/${batch.id}/approve`, {}, { csrfFrom: `/app/payouts/${batch.id}` });

    const res = await staff.get(`/app/payouts/${batch.id}/checks`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/pdf/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.toString("latin1", 0, 5), "%PDF-");
  });

  test("the alignment sheet prints without a run, because it is for before one", async () => {
    const res = await staff.get("/app/payouts/alignment");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/pdf/);
  });
});

/* --- bank details ------------------------------------------------------------ */

describe("the company's own bank details", () => {
  test("a routing number that fails its check digit is refused", async () => {
    const res = await staff.post("/app/payouts/bank",
      { ach_routing_number: "021000012", ach_bank_name: "Test" },
      { csrfFrom: "/app/payouts/bank" });
    assert.match(loc(res), /check digit/i);
  });

  test("the account number is sealed and only the last four are shown", async () => {
    await staff.post("/app/payouts/bank", {
      ach_routing_number: ROUTING, ach_bank_name: "Test Bank",
      ach_account: "000987654321", ach_company_id: "1234567890",
    }, { csrfFrom: "/app/payouts/bank" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.ach_account_last4, "4321");
    assert.ok(!company.ach_account_enc.includes("987654321"));

    const res = await page("/app/payouts/bank");
    assert.ok(!res.body.includes("000987654321"), "the whole number is never rendered");
    assert.match(res.body, /ending 4321/);
  });

  test("saving with a blank account box keeps the number", async () => {
    await staff.post("/app/payouts/bank", {
      ach_routing_number: ROUTING, ach_bank_name: "First", ach_account: "000987654321",
    }, { csrfFrom: "/app/payouts/bank" });
    await staff.post("/app/payouts/bank", {
      ach_routing_number: ROUTING, ach_bank_name: "Renamed", ach_account: "",
    }, { csrfFrom: "/app/payouts/bank" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.ach_bank_name, "Renamed");
    assert.equal(company.ach_account_last4, "4321");
  });

  test("the cheque book only moves forward", async () => {
    /* Reissuing a number would collide with one already on a positive-pay
       file, and the bank would have two cheques claiming to be the same. */
    await staff.post("/app/payouts/register", { next_number: "5000" },
      { csrfFrom: "/app/payouts/bank" });
    const res = await staff.post("/app/payouts/register", { next_number: "1001" },
      { csrfFrom: "/app/payouts/bank" });

    assert.match(loc(res), /cannot go backwards/i);
    const register = await get("SELECT * FROM check_register WHERE company_id = ?", world.companyId);
    assert.equal(Number(register.next_number), 5000);
  });

  test("it can be set forward to match the stock in the printer", async () => {
    await staff.post("/app/payouts/register", { next_number: "5000" },
      { csrfFrom: "/app/payouts/bank" });
    const register = await get("SELECT * FROM check_register WHERE company_id = ?", world.companyId);
    assert.equal(Number(register.next_number), 5000);
  });

  test("a payee's account is saved without its number reaching the page", async () => {
    await staff.post("/app/payouts/payee", {
      owner_id: world.ownerId, method: "ach",
      routing_number: PAYEE_ROUTING, account_number: "5512345678",
      back: "/app/payouts/bank",
    }, { csrfFrom: "/app/payouts/bank" });

    const row = await get("SELECT * FROM payee_account WHERE owner_id = ?", world.ownerId);
    assert.equal(row.account_last4, "5678");

    const res = await page("/app/payouts/bank");
    assert.ok(!res.body.includes("5512345678"));
    assert.match(res.body, /ending 5678/);
  });
});

/* --- voiding ----------------------------------------------------------------- */

describe("voiding a cheque from the screen", () => {
  async function approvedChequeRun() {
    const vendor = await compliantVendor("Alpha Plumbing");
    await approvedInvoice(vendor, 120000, "A-1");
    await staff.post("/app/payouts/vendors/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/vendors" });
    const batch = await get("SELECT * FROM payout_batch");
    await staff.post(`/app/payouts/${batch.id}/approve`, {}, { csrfFrom: `/app/payouts/${batch.id}` });
    return batch;
  }

  test("a reason is required, because the number stays on the register", async () => {
    const batch = await approvedChequeRun();
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batch.id);

    const res = await staff.post(`/app/payouts/${batch.id}/void`,
      { item_id: item.id, reason: "x" }, { csrfFrom: `/app/payouts/${batch.id}` });
    assert.match(loc(res), /Say why/i);

    const after = await get("SELECT * FROM payout_item WHERE id = ?", item.id);
    assert.equal(after.voided_at, null);
  });

  test("voiding shows on the run with its reason, and keeps the number", async () => {
    const batch = await approvedChequeRun();
    const item = await get("SELECT * FROM payout_item WHERE batch_id = ?", batch.id);

    await staff.post(`/app/payouts/${batch.id}/void`,
      { item_id: item.id, reason: "Printer jammed" }, { csrfFrom: `/app/payouts/${batch.id}` });

    const res = await page(`/app/payouts/${batch.id}`);
    assert.match(res.body, /Void — Printer jammed/);
    assert.match(res.body, /1001/, "the number is still shown");
  });
});

/* --- a file the bank would reject ------------------------------------------ */

describe("the positive-pay account", () => {
  async function approvedChequeRun() {
    const vendor = await compliantVendor("Alpha Plumbing");
    await approvedInvoice(vendor, 120000, "A-1");
    await staff.post("/app/payouts/vendors/draft",
      { effective_date: "2026-10-05", method: "check" }, { csrfFrom: "/app/payouts/vendors" });
    const batch = await get("SELECT * FROM payout_batch");
    await staff.post(`/app/payouts/${batch.id}/approve`, {}, { csrfFrom: `/app/payouts/${batch.id}` });
    return batch;
  }

  test("a run warns when the file would go out without one", async () => {
    /* Banks reject a positive-pay file with an empty account column, and the
       rejection arrives long after the cheques are in the post. */
    const batch = await approvedChequeRun();
    const res = await page(`/app/payouts/${batch.id}`);
    assert.match(res.body, /no account number on it/i);
    assert.match(res.body, /\/app\/payouts\/bank/, "and says where to fix it");
  });

  test("and stops warning once it is set", async () => {
    await staff.post("/app/payouts/register",
      { next_number: "1001", account_number: "000123456789" },
      { csrfFrom: "/app/payouts/bank" });
    const batch = await approvedChequeRun();

    const res = await page(`/app/payouts/${batch.id}`);
    assert.ok(!/no account number on it/i.test(res.body));

    const file = await staff.get(`/app/payouts/${batch.id}/file`);
    const csv = await file.text();
    assert.match(csv, /^000123456789,1001,/m, "and the account is on every row");
  });

  test("an ACH run is not asked about it", async () => {
    await creditOwner(100000);
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "ach",
      routingNumber: PAYEE_ROUTING, accountNumber: "5512345678",
    });
    await staff.post("/app/payouts/owners/draft",
      { effective_date: "2026-10-05", method: "ach" }, { csrfFrom: "/app/payouts/owners" });
    const batch = await get("SELECT * FROM payout_batch");
    await staff.post(`/app/payouts/${batch.id}/approve`, {}, { csrfFrom: `/app/payouts/${batch.id}` });

    const res = await page(`/app/payouts/${batch.id}`);
    assert.ok(!/no account number on it/i.test(res.body), "cheque-only warning");
  });
});
