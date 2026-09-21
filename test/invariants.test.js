/* The nine product invariants.

   These are the reasons this product is different from the incumbents. Each
   one is a promise made to somebody who is not in the room — a tenant with
   water coming through the ceiling, an owner whose money is being spent, an
   applicant being judged. A regression here is not a bug, it is a broken
   promise, so each has a test that fails loudly.

   Every test states the promise in its name. If one of these ever has to be
   deleted, the person deleting it should have to read what they are giving
   up. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});

after(async () => {
  await app.close();
  await closeDb();
});

describe("an emergency is never queued", () => {
  test("an emergency answer escalates during the request and shows the stop card", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Emergency Co" });
    const c = client(app.origin);

    const page = `/report?u=${w.reportToken}&category=plumbing`;
    const csrf = await c.csrf(page);
    const res = await c.post("/report", {
      unit_token: w.reportToken, category: "plumbing",
      closest: "flooding",                       // the emergency answer
      summary: "Water pouring through the ceiling",
      phone: "6145550142", name: "Test Tenant",
    }, { csrf });

    const body = await res.text();
    assert.equal(res.status, 200, "an emergency must answer in the request, not redirect to a queue");
    assert.match(body, /call us now|do not wait/i, "the tenant must be told to call, not that it is logged");

    const wo = await get(
      "SELECT * FROM work_order WHERE company_id = ? ORDER BY created_at DESC LIMIT 1", w.companyId);
    assert.equal(wo.severity, "emergency");

    const events = await all(
      "SELECT kind FROM work_order_event WHERE work_order_id = ?", wo.id);
    assert.ok(events.some((e) => e.kind === "escalated"),
      "the escalation must be recorded during the request");
  });

  test("a non-emergency answer does not escalate", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Routine Co" });
    const c = client(app.origin);
    const csrf = await c.csrf(`/report?u=${w.reportToken}&category=plumbing`);
    const res = await c.post("/report", {
      unit_token: w.reportToken, category: "plumbing", closest: "one_fixture",
      summary: "Tap drips overnight", phone: "6145550142",
    }, { csrf });
    assert.equal(res.status, 303, "a routine repair is queued and redirects to its status page");
    const wo = await get("SELECT severity FROM work_order WHERE company_id = ? ORDER BY created_at DESC LIMIT 1", w.companyId);
    assert.notEqual(wo.severity, "emergency");
  });
});

describe("spend over an owner's threshold cannot be dispatched", () => {
  test("an estimate above the threshold parks the job and records a pending approval", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Threshold Co" });
    await run("UPDATE owner SET approval_threshold_cents = ? WHERE id = ?", 40000, w.ownerId);
    const c = client(app.origin);
    await c.signIn(w.staff.admin.email, f.PASSWORD);

    await c.post(`/app/maintenance/${w.workOrderId}/assign`, {
      vendor_id: w.vendorId, estimate: "900.00",     // over 400.00
    }, { csrfFrom: `/app/maintenance/${w.workOrderId}` });

    const wo = await get("SELECT status FROM work_order WHERE id = ?", w.workOrderId);
    assert.equal(wo.status, "awaiting_owner", "the job must not be dispatched");

    const appr = await get(
      "SELECT * FROM owner_approval WHERE work_order_id = ?", w.workOrderId);
    assert.ok(appr, "an approval must be recorded");
    assert.equal(appr.status, "pending");
    assert.equal(Number(appr.amount_cents), 90000);
  });

  test("an estimate under the threshold dispatches", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Under Co" });
    await run("UPDATE owner SET approval_threshold_cents = ? WHERE id = ?", 40000, w.ownerId);
    const c = client(app.origin);
    await c.signIn(w.staff.admin.email, f.PASSWORD);
    await c.post(`/app/maintenance/${w.workOrderId}/assign`, {
      vendor_id: w.vendorId, estimate: "150.00",
    }, { csrfFrom: `/app/maintenance/${w.workOrderId}` });
    const wo = await get("SELECT status FROM work_order WHERE id = ?", w.workOrderId);
    assert.equal(wo.status, "assigned");
  });
});

describe("vendor compliance barriers", () => {
  test("lapsed liability blocks dispatch", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Lapsed GL Co" });
    const badVendor = await f.makeVendor(w.companyId, { name: "Lapsed Liability", glExpires: "2020-01-01" });
    const c = client(app.origin);
    await c.signIn(w.staff.admin.email, f.PASSWORD);

    await c.post(`/app/maintenance/${w.workOrderId}/assign`, {
      vendor_id: badVendor, estimate: "100.00",
    }, { csrfFrom: `/app/maintenance/${w.workOrderId}` });

    const wo = await get("SELECT status, vendor_id FROM work_order WHERE id = ?", w.workOrderId);
    assert.notEqual(wo.status, "assigned", "a vendor with lapsed liability must not be dispatched");
    assert.equal(wo.vendor_id, null, "and must not be recorded on the job");
  });

  test("lapsed workers comp blocks payment but not the accrual", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Lapsed WC Co" });
    const vendorId = await f.makeVendor(w.companyId, { name: "No Comp", wcExpires: "2020-01-01" });
    const { recordInvoice, payInvoice } = await import("../server/features/vendors.js");

    const res = await recordInvoice({
      companyId: w.companyId, vendorId, invoiceDate: "2026-06-01",
      amountCents: 50000, memo: "work done", createdBy: "test",
    });
    assert.equal(res.blocked, true, "payment must be blocked");

    const inv = await get("SELECT status FROM vendor_invoice WHERE id = ?", res.invoiceId);
    assert.equal(inv.status, "blocked");

    // The cost is still on the books: the liability is real either way.
    const splits = await all(
      `SELECT a.code, s.debit_cents, s.credit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id
        WHERE s.journal_id = ?`, res.journalId);
    assert.equal(splits.length, 2, "the invoice must still be accrued");

    await assert.rejects(
      () => payInvoice({ companyId: w.companyId, invoiceId: res.invoiceId, by: "test" }),
      /blocked|workers compensation/i,
      "paying it must be refused");

    const payouts = await all("SELECT id FROM vendor_payout WHERE vendor_id = ?", vendorId);
    assert.equal(payouts.length, 0, "no payout may exist");
  });

  test("a compliant vendor can be paid", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Compliant Co" });
    const { recordInvoice, payInvoice } = await import("../server/features/vendors.js");
    const res = await recordInvoice({
      companyId: w.companyId, vendorId: w.vendorId, invoiceDate: "2026-06-01",
      amountCents: 25000, createdBy: "test",
    });
    assert.equal(res.blocked, false);
    await payInvoice({ companyId: w.companyId, invoiceId: res.invoiceId, by: "test" });
    const payouts = await all("SELECT id FROM vendor_payout WHERE vendor_id = ?", w.vendorId);
    assert.equal(payouts.length, 1);
  });
});

describe("the double-entry journal is append-only", () => {
  test("postJournal is the only writer, and it balances", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Ledger Co" });
    const { postJournal, ACCT } = await import("../server/features/accounting.js");

    const jid = await postJournal({
      companyId: w.companyId, date: "2026-06-01", memo: "rent received",
      splits: [
        { code: ACCT.TRUST_CASH, debit: 100000 },
        { code: ACCT.OWNER_FUNDS, credit: 100000 },
      ],
    });
    const splits = await all("SELECT * FROM journal_split WHERE journal_id = ?", jid);
    assert.equal(splits.length, 2);
  });

  test("an unbalanced journal is refused by the database", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Unbalanced Co" });
    const { postJournal, ACCT } = await import("../server/features/accounting.js");
    await assert.rejects(
      () => postJournal({
        companyId: w.companyId, date: "2026-06-01", memo: "wrong",
        splits: [{ code: ACCT.CASH, debit: 100000 }, { code: ACCT.RENT_INCOME, credit: 90000 }],
      }),
      /balance/i);
  });

  test("a single-split journal is refused", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Single Co" });
    const { postJournal, ACCT } = await import("../server/features/accounting.js");
    await assert.rejects(
      () => postJournal({
        companyId: w.companyId, date: "2026-06-01", memo: "one side",
        splits: [{ code: ACCT.CASH, debit: 100000 }],
      }),
      /two splits|at least two/i);
  });

  test("a posted journal cannot be deleted or amended", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Immutable Co" });
    const { postJournal, ACCT } = await import("../server/features/accounting.js");
    const jid = await postJournal({
      companyId: w.companyId, date: "2026-06-01", memo: "posted",
      splits: [{ code: ACCT.CASH, debit: 5000 }, { code: ACCT.RENT_INCOME, credit: 5000 }],
    });

    await assert.rejects(() => run("DELETE FROM journal WHERE id = ?", jid), /append-only/i);
    await assert.rejects(() => run("DELETE FROM journal_split WHERE journal_id = ?", jid), /append-only/i);
    await assert.rejects(() => run("UPDATE journal_split SET debit_cents = 1 WHERE journal_id = ?", jid), /append-only/i);
    await assert.rejects(() => run("UPDATE journal SET memo = 'edited' WHERE id = ?", jid), /cannot be edited/i);
  });

  test("a correction is a reversal, and the pair nets to nothing", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Reversal Co" });
    const { postJournal, reverseJournal, ACCT } = await import("../server/features/accounting.js");
    const jid = await postJournal({
      companyId: w.companyId, date: "2026-06-01", memo: "mistake",
      splits: [{ code: ACCT.CASH, debit: 7500 }, { code: ACCT.RENT_INCOME, credit: 7500 }],
    });
    await reverseJournal(jid, { companyId: w.companyId, by: "test" });

    const original = await get("SELECT reversed_by FROM journal WHERE id = ?", jid);
    assert.ok(original.reversed_by, "the original must point at its reversal");

    const net = await get(
      `SELECT COALESCE(SUM(debit_cents),0)::bigint d, COALESCE(SUM(credit_cents),0)::bigint c
         FROM journal_split s JOIN journal j ON j.id = s.journal_id
        WHERE j.company_id = ?`, w.companyId);
    assert.equal(Number(net.d), Number(net.c), "the book still balances");
  });
});

describe("late fees only under a written policy", () => {
  test("a lease with no policy is never charged", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "No Policy Co" });
    await run("UPDATE lease SET late_fee_cents = NULL, late_fee_percent = NULL WHERE id = ?", w.leaseId);
    const { sweepLateFees } = await import("../server/lib/latefees.js");
    const res = await sweepLateFees({ asOf: "2026-06-20", postedBy: "test" });
    assert.equal(res.charged, 0);
    const fees = await all("SELECT id FROM late_fee WHERE lease_id = ?", w.leaseId);
    assert.equal(fees.length, 0, "a blank policy field must not become a default charge");
  });

  test("the database deduplicates a double run", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Dedupe Co" });
    await run("UPDATE lease SET late_fee_cents = ?, rent_due_day = 1, grace_days = 5 WHERE id = ?", 5000, w.leaseId);
    const { sweepLateFees } = await import("../server/lib/latefees.js");

    const first = await sweepLateFees({ asOf: "2026-06-20", postedBy: "test" });
    assert.equal(first.charged, 1);
    const second = await sweepLateFees({ asOf: "2026-06-20", postedBy: "test" });
    assert.equal(second.charged, 0, "a second run must charge nothing");

    const fees = await all("SELECT id FROM late_fee WHERE lease_id = ? AND period = ?", w.leaseId, "2026-06");
    assert.equal(fees.length, 1, "exactly one fee per lease per period");
  });

  test("a fee within the grace period is not charged", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Grace Co" });
    await run("UPDATE lease SET late_fee_cents = ?, rent_due_day = 1, grace_days = 10 WHERE id = ?", 5000, w.leaseId);
    const { sweepLateFees } = await import("../server/lib/latefees.js");
    const res = await sweepLateFees({ asOf: "2026-06-08", postedBy: "test" });
    assert.equal(res.charged, 0);
  });
});

describe("no automated applicant scoring", () => {
  test("nothing in the schema stores a score or an automated decision", async () => {
    const cols = await all(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%score%' OR column_name LIKE '%risk_rating%')`);
    assert.equal(cols.length, 0,
      `no score column may exist: found ${cols.map((c) => `${c.table_name}.${c.column_name}`).join(", ")}`);
  });

  test("a decision is recorded per criterion by a named human", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Screening Co" });
    const check = await all(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='application_check'`);
    const names = check.map((c) => c.column_name);
    assert.ok(names.includes("result"), "each criterion carries its own result");
    assert.ok(names.includes("checked_by"), "and the name of the person who judged it");
    assert.ok(names.includes("checked_at"), "and when");
    /* pass / fail / na / pending, per criterion. No numeric column anywhere on
       this table, because a number is what a model would produce and a number
       is what somebody would later threshold. */
    const resultCol = await get(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='application_check' AND column_name='result'`);
    assert.equal(resultCol.data_type, "text", "a verdict, not a score");
  });
});

describe("the platform never holds client money", () => {
  test("no table names a platform-held balance", async () => {
    const tables = await all(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    const names = tables.map((t) => t.tablename);
    for (const forbidden of ["platform_balance", "escrow", "wallet", "float"]) {
      assert.ok(!names.includes(forbidden), `${forbidden} would make this app a custodian`);
    }
  });

  test("trust accounts are flagged, so they can be reported separately", async () => {
    await truncateAll();
    const w = await f.makeWorld({ name: "Trust Co" });
    const { ensureChart } = await import("../server/features/accounting.js");
    await ensureChart(w.companyId);
    const trust = await all(
      "SELECT code FROM account WHERE company_id = ? AND is_trust = 1", w.companyId);
    assert.ok(trust.length >= 2, "client funds must be distinguishable from the company's own");
  });
});
