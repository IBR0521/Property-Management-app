/* One repair, one cost.

   `vendor_invoice.work_order_id` links a bill to a job, and closing that job
   recorded a cost independently. Both posted, nothing stopped a manager doing
   both, and no seeded row ever did — so it had never been seen. It would have
   surfaced as inflated expenses on the first P&L by property, against an
   owner who had been charged twice for one repair.

   The contractor's invoice is the truth when there is one: it is the document
   money is actually paid against and the one an owner can be shown. Both
   orders are tested because both happen — a technician finishing on Tuesday
   and the bill arriving on Friday, and a manager entering the bill first. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today } from "../server/lib/dates.js";
import { ensureChart } from "../server/features/accounting.js";
import { closeOut } from "../server/features/maintenance.js";
import { recordInvoice } from "../server/features/vendors.js";
import { parity } from "../server/lib/ledger.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world, staff;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "One Cost Co" });
  await ensureChart(world.companyId);
  staff = { id: world.staff.admin.id, name: "Dana" };
  /* A contractor who may be dispatched and paid, so compliance is not what
     this file ends up testing. */
  await run(
    `UPDATE vendor SET gl_expires = ?, wc_expires = ?, license_expires = ?
      WHERE id = ?`, "2099-01-01", "2099-01-01", "2099-01-01", world.vendorId);
});

const balanceOf = async (code) => {
  const row = await get(
    `SELECT a.normal_balance,
            COALESCE(SUM(s.debit_cents),0)::bigint AS dr,
            COALESCE(SUM(s.credit_cents),0)::bigint AS cr
       FROM account a LEFT JOIN journal_split s ON s.account_id = a.id
      WHERE a.company_id = ? AND a.code = ? GROUP BY a.normal_balance`, world.companyId, code);
  if (!row) return 0;
  return row.normal_balance === "debit" ? Number(row.dr) - Number(row.cr)
                                        : Number(row.cr) - Number(row.dr);
};

const ownerLedger = async () => {
  const row = await get(
    "SELECT COALESCE(SUM(amount_cents),0)::bigint AS c FROM ledger_entry WHERE company_id = ?",
    world.companyId);
  return Number(row.c);
};

const workOrder = async () =>
  await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);

const invoice = (cents, extra = {}) => recordInvoice({
  companyId: world.companyId, vendorId: world.vendorId,
  workOrderId: world.workOrderId, invoiceNo: "INV-1",
  invoiceDate: today(), amountCents: cents, taxCents: 0,
  memo: "repair", createdBy: staff.id, ...extra,
});

const close = async (cents) => await closeOut({
  companyId: world.companyId, wo: await workOrder(), staff,
  actualCents: cents, files: [], note: "done",
});

/* --- the bill arrives after the job is closed -------------------------------- */

describe("closed out first, billed afterwards", () => {
  test("the owner is charged once, at the invoiced amount", async () => {
    /* The common order: a technician finishes on Tuesday and the bill comes
       on Friday for a different number. */
    await close(20000);
    assert.equal(await ownerLedger(), -20000, "the close-out figure, to begin with");

    await invoice(25000);

    assert.equal(await ownerLedger(), -25000, "the bill, and only the bill");
    assert.equal(await balanceOf("2200"), -25000, "and the books agree");
  });

  test("the close-out posting is reversed, not edited", async () => {
    /* The journal is append-only. Both halves stay visible: what was recorded
       when the job was done, and what the bill turned out to be. */
    await close(20000);
    const original = await get(
      "SELECT * FROM journal WHERE source_type = 'work_order' AND source_id = ?",
      world.workOrderId);

    await invoice(25000);

    const after = await get("SELECT * FROM journal WHERE id = ?", original.id);
    assert.ok(after.reversed_by, "superseded by a reversal");
    assert.equal(after.memo, original.memo, "and the original is untouched");

    const reversal = await get("SELECT * FROM journal WHERE id = ?", after.reversed_by);
    assert.match(reversal.memo, /Superseded by/);
  });

  test("the owner's ledger and the books do not drift apart", async () => {
    /* Reversing the journal without mirroring the ledger entry would leave
       the owner's statement carrying the close-out figure while the books
       carried the invoice — a control account and its subsidiary ledger
       disagreeing by the difference, which is the exact failure the trust
       reconciliation exists to catch. */
    await close(20000);
    await invoice(25000);

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.variances.find((v) => v.key === "clients_vs_subledger").cents, 0);
    assert.equal((await parity(world.companyId)).inParity, true);
  });

  test("a bill for the same amount still leaves one cost", async () => {
    await close(25000);
    await invoice(25000);
    assert.equal(await ownerLedger(), -25000);
  });

  test("a second invoice does not supersede a reversed posting again", async () => {
    /* The reversal has already happened. Finding it a second time would post
       a mirror of a mirror. */
    await close(20000);
    await invoice(25000);
    const before = (await all("SELECT id FROM journal")).length;

    await invoice(30000, { invoiceNo: "INV-2" });

    const added = (await all("SELECT id FROM journal")).length - before;
    assert.equal(added, 1, "the second invoice posts itself and nothing else");
    assert.equal(await ownerLedger(), -55000, "two bills, two costs — which is correct");
  });
});

/* --- the bill arrives first --------------------------------------------------- */

describe("billed first, closed out afterwards", () => {
  test("closing the job records the figure and posts nothing", async () => {
    await invoice(25000);
    assert.equal(await ownerLedger(), -25000);

    const res = await close(20000);

    assert.equal(res.costPosted, false);
    assert.ok(res.supersededBy, "it knows which invoice took precedence");
    assert.equal(await ownerLedger(), -25000, "still one cost");
  });

  test("it says why, rather than dropping the number silently", async () => {
    /* Somebody who types a cost and sees nothing happen assumes it is
       broken — and the next thing they do is type it somewhere else. */
    await invoice(25000);
    const res = await close(20000);

    assert.match(res.message, /already been billed/);
    assert.match(res.message, /\$250\.00/, "and names the figure that won");
  });

  test("the figure is still recorded on the job", async () => {
    /* Not posted is not the same as discarded. What the person who did the
       work thought it cost is worth keeping next to what was billed. */
    await invoice(25000);
    await close(20000);
    assert.equal(Number((await workOrder()).actual_cents), 20000);
    assert.equal((await workOrder()).status, "complete");
  });

  test("a voided invoice does not block the close-out", async () => {
    /* The bill was withdrawn, so it is not the truth about anything.

       This caught a real one: the module excluded 'cancelled', which is not a
       value the column can hold, so it excluded nothing. */
    await invoice(25000);
    await run("UPDATE vendor_invoice SET status = 'void'");

    const res = await close(20000);
    assert.equal(res.costPosted, true);
  });
});

/* --- with no contractor at all ------------------------------------------------ */

describe("an in-house repair", () => {
  test("it posts, because nothing else is going to", async () => {
    /* The failure worse than double-booking is not booking at all. A job with
       no bill behind it must still reach the owner's ledger. */
    const res = await close(18000);
    assert.equal(res.costPosted, true);
    assert.equal(await ownerLedger(), -18000);
    assert.equal(await balanceOf("2200"), -18000);
    assert.equal(await balanceOf("1010"), -18000, "paid out of trust");
  });
});

/* --- whose cost it is ---------------------------------------------------------- */

describe("which book the invoice lands on", () => {
  test("a repair on somebody's property reduces what is owed to them", async () => {
    /* It was debiting 5000 Repairs — the manager's own expense account —
       which inflated their P&L by every repair they had ever arranged on
       somebody else's behalf. */
    await invoice(25000);

    assert.equal(await balanceOf("2200"), -25000, "the owner's money");
    assert.equal(await balanceOf("5000"), 0, "not the manager's expense");
    assert.equal(await balanceOf("2000"), 25000, "and the contractor is owed");
  });

  test("the owner is on the journal, so a report by owner can find it", async () => {
    await invoice(25000);
    const split = await get(
      `SELECT s.owner_id FROM journal_split s JOIN account a ON a.id = s.account_id
        WHERE a.code = '2200' AND s.debit_cents > 0`);
    assert.equal(split.owner_id, world.ownerId);
  });

  test("an invoice with no property is the manager's own bill", async () => {
    /* The office printer. Genuinely theirs. */
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId,
      workOrderId: null, invoiceNo: "OFFICE-1", invoiceDate: today(),
      amountCents: 9900, taxCents: 0, memo: "toner", createdBy: staff.id,
    });

    assert.equal(await balanceOf("5000"), 9900, "the manager's expense");
    assert.equal(await balanceOf("2200"), 0, "no owner is involved");
    assert.equal(await ownerLedger(), 0, "and nothing reaches anybody's statement");
  });

  test("an owner-borne invoice reaches the statement the owner is shown", async () => {
    /* Without this the cost would be in the books and absent from the ledger
       the owner actually reads. */
    await invoice(25000);
    const entry = await get("SELECT * FROM ledger_entry WHERE company_id = ?", world.companyId);
    assert.equal(entry.kind, "expense");
    assert.equal(Number(entry.amount_cents), -25000);
    assert.equal(entry.owner_id, world.ownerId);
    assert.equal(entry.work_order_id, world.workOrderId);
  });
});

/* --- the invariant ------------------------------------------------------------- */

describe("through every order of events", () => {
  test("the two books stay in parity and the trust account reconciles", async () => {
    const orders = [
      ["closed then billed", async () => { await close(20000); await invoice(25000); }],
      ["billed then closed", async () => { await invoice(25000); await close(20000); }],
      ["closed, never billed", async () => { await close(20000); }],
      ["billed, never closed", async () => { await invoice(25000); }],
    ];

    for (const [name, sequence] of orders) {
      await truncateAll();
      world = await f.makeWorld({ name: "Order Co" });
      await ensureChart(world.companyId);
      await run(`UPDATE vendor SET gl_expires = ?, wc_expires = ?, license_expires = ? WHERE id = ?`,
        "2099-01-01", "2099-01-01", "2099-01-01", world.vendorId);
      await sequence();

      assert.equal((await parity(world.companyId)).inParity, true, name);
      const r = await trustReconciliation(world.companyId);
      assert.equal(r.variances.find((v) => v.key === "clients_vs_subledger").cents, 0, name);
    }
  });
});

/* --- telling somebody before they type, not after -------------------------- */

describe("what the screen says before a figure is entered", () => {
  const workOrder = async () => await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);

  test("with a contractor assigned and no bill yet, it says the bill will replace it", async () => {
    /* The gap this closes. Being told afterwards that your figure was
       superseded reads as the application losing your work; being told at
       the time reads as it knowing what it is doing. */
    const { costOutlook } = await import("../server/lib/repaircost.js");
    await run("UPDATE work_order SET vendor_id = ? WHERE id = ?", world.vendorId, world.workOrderId);

    const outlook = await costOutlook(world.companyId, await workOrder());

    assert.equal(outlook.post, true, "it still posts — nothing else is going to");
    assert.equal(outlook.expectInvoice, true);
    assert.match(outlook.warning, /replaced when their invoice arrives/);
    assert.match(outlook.warning, new RegExp((await get("SELECT name FROM vendor WHERE id = ?", world.vendorId)).name));
  });

  test("with no contractor at all it says nothing alarming", async () => {
    const { costOutlook } = await import("../server/lib/repaircost.js");
    const outlook = await costOutlook(world.companyId, await workOrder());

    assert.equal(outlook.post, true);
    assert.equal(outlook.expectInvoice, false);
    assert.equal(outlook.warning, null);
  });

  test("with a bill already in, it says the figure will not be posted", async () => {
    const { costOutlook } = await import("../server/lib/repaircost.js");
    await invoice(25000);

    const outlook = await costOutlook(world.companyId, await workOrder());
    assert.equal(outlook.post, false);
    assert.match(outlook.reason, /already been billed/);
    assert.match(outlook.reason, /\$250\.00/);
  });

  test("the manager's close-out form carries it", async () => {
    const { startApp, client } = await import("./helpers/http.js");
    const app = await startApp();
    try {
      await run("UPDATE work_order SET vendor_id = ? WHERE id = ?", world.vendorId, world.workOrderId);
      const c = client(app.origin);
      await c.signIn(world.staff.admin.email, f.PASSWORD);

      const { body } = await c.text(`/app/maintenance/${world.workOrderId}`);
      assert.match(body, /replaced when their invoice arrives/);
    } finally { await app.close(); }
  });

  test("and so does the technician's", async () => {
    const { startApp, client } = await import("./helpers/http.js");
    const app = await startApp();
    try {
      await run("UPDATE work_order SET vendor_id = ?, assigned_staff_id = ? WHERE id = ?",
        world.vendorId, world.staff.admin.id, world.workOrderId);
      const c = client(app.origin);
      await c.signIn(world.staff.admin.email, f.PASSWORD);

      const { body } = await c.text(`/app/jobs/${world.workOrderId}`);
      assert.match(body, /replaced when their invoice arrives/);
    } finally { await app.close(); }
  });

  test("the technician is warned loudly when it is already billed", async () => {
    /* A line of help text is enough for "this may change"; a figure that
       will not be posted at all deserves a notice. */
    const { startApp, client } = await import("./helpers/http.js");
    const app = await startApp();
    try {
      await invoice(25000);
      await run("UPDATE work_order SET assigned_staff_id = ? WHERE id = ?",
        world.staff.admin.id, world.workOrderId);
      const c = client(app.origin);
      await c.signIn(world.staff.admin.email, f.PASSWORD);

      const { body } = await c.text(`/app/jobs/${world.workOrderId}`);
      assert.match(body, /Already billed/);
    } finally { await app.close(); }
  });
});

/* --- and afterwards, on the job's own history ------------------------------- */

describe("the history records the supersede", () => {
  test("it says what was recorded and what was billed", async () => {
    /* Without this the figure simply changes, and the only record of why is
       a journal memo nobody is looking at. */
    await close(20000);
    await invoice(25000);

    const entry = await get(
      "SELECT * FROM work_order_event WHERE work_order_id = ? AND kind = 'cost_superseded'",
      world.workOrderId);

    assert.ok(entry, "the job's history should carry it");
    assert.match(entry.note, /Recorded at close-out: \$200\.00/);
    assert.match(entry.note, /Billed: \$250\.00/);
  });

  test("it is not shown to the tenant", async () => {
    /* How a repair was costed is between the manager, the contractor and the
       owner. */
    await close(20000);
    await invoice(25000);

    const entry = await get(
      "SELECT tenant_visible FROM work_order_event WHERE work_order_id = ? AND kind = 'cost_superseded'",
      world.workOrderId);
    assert.equal(Number(entry.tenant_visible), 0);

    const wo = await get("SELECT public_token FROM work_order WHERE id = ?", world.workOrderId);
    const { startApp, client } = await import("./helpers/http.js");
    const app = await startApp();
    try {
      const { body } = await client(app.origin).text(`/t/${wo.public_token}`);
      assert.ok(!body.includes("Recorded at close-out"));
    } finally { await app.close(); }
  });

  test("it reads as English on the manager's timeline", async () => {
    await close(20000);
    await invoice(25000);

    const { startApp, client } = await import("./helpers/http.js");
    const app = await startApp();
    try {
      const c = client(app.origin);
      await c.signIn(world.staff.admin.email, f.PASSWORD);
      const { body } = await c.text(`/app/maintenance/${world.workOrderId}`);
      /* Without the apostrophe: the renderer escapes it to &#39;, so a
         regex carrying one matches the source and not the page. */
      assert.match(body, /Cost replaced by the contractor/);
    } finally { await app.close(); }
  });

  test("nothing is written when there was nothing to supersede", async () => {
    /* An invoice on a job nobody closed out has replaced nothing, and a
       history entry saying otherwise would be a small lie. */
    await invoice(25000);
    const entry = await get(
      "SELECT id FROM work_order_event WHERE work_order_id = ? AND kind = 'cost_superseded'",
      world.workOrderId);
    assert.equal(entry, undefined);
  });
});

/* Whose cost a vendor's invoice is.

   OPEN-ITEMS A3. `5000 Repairs` used to take every invoice, which booked the
   owner's repair as the manager's own expense: the manager's profit and loss
   carried repairs they never bore, and `2200` was never reduced by money that
   had genuinely left the owner's funds. An agent spending a client's money
   reduces what is owed to that client; it does not incur an expense.

   The code has branched on this since that correction. Nothing held it —
   `ownerBorne` appeared in no test — and a posting rule with no test is how
   the deposit and owner-list bugs survived ten phases each. */
describe("an invoice lands in the account whose cost it is", () => {
  const bal = async (code) => Number((await get(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
       FROM journal_split s JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = ?`, world.companyId, code)).c);

  test("against a property, it reduces what is owed to the owner", async () => {
    const wo = await f.makeWorkOrder(world.companyId, world.unitId);
    const res = await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: wo,
      amountCents: 30000, taxCents: 0, invoiceNo: "INV-1",
      invoiceDate: today(), createdBy: staff.id,
    });

    assert.equal(res.ownerBorne, true);
    assert.equal(await bal("2200"), 30000,
      "the owner's money paid for it, so less is owed to them");
    assert.equal(await bal("5000"), 0,
      "and it is not the manager's expense — booking it as one inflated their P&L");
    assert.equal(await bal("2000"), -30000, "the contractor is owed either way");
  });

  test("with no property behind it, it is the manager's own", async () => {
    /* The office printer. No unit, so no owner whose money could have paid. */
    const res = await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId,
      amountCents: 12000, taxCents: 0, invoiceNo: "INV-2",
      invoiceDate: today(), createdBy: staff.id,
    });

    assert.equal(res.ownerBorne, false);
    assert.equal(await bal("5000"), 12000, "genuinely theirs to bear");
    assert.equal(await bal("2200"), 0, "and no owner's funds were touched");
  });

  test("the owner sees their repair on their own ledger", async () => {
    const wo = await f.makeWorkOrder(world.companyId, world.unitId);
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: wo,
      amountCents: 30000, taxCents: 0, invoiceDate: today(), createdBy: staff.id,
    });
    const entry = await get(
      "SELECT kind, amount_cents FROM ledger_entry WHERE owner_id = ? AND kind = 'expense'",
      world.ownerId);
    assert.ok(entry, "in the books and absent from the ledger would be worse than either");
    assert.equal(Number(entry.amount_cents), -30000);
  });

  test("the manager's own invoice reaches no owner's ledger", async () => {
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId,
      amountCents: 12000, taxCents: 0, invoiceDate: today(), createdBy: staff.id,
    });
    assert.deepEqual(
      await all("SELECT id FROM ledger_entry WHERE kind = 'expense'"), [],
      "nobody else paid for the office printer");
  });

  test("tax goes wherever the invoice goes", async () => {
    const wo = await f.makeWorkOrder(world.companyId, world.unitId);
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: wo,
      amountCents: 30000, taxCents: 2400, invoiceDate: today(), createdBy: staff.id,
    });
    assert.equal(await bal("2200"), 32400, "the owner pays the tax on their own repair");
    assert.equal(await bal("5000"), 0);
  });

  test("and the books still balance either way", async () => {
    const wo = await f.makeWorkOrder(world.companyId, world.unitId);
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId, workOrderId: wo,
      amountCents: 30000, taxCents: 2400, invoiceDate: today(), createdBy: staff.id,
    });
    await recordInvoice({
      companyId: world.companyId, vendorId: world.vendorId,
      amountCents: 12000, taxCents: 0, invoiceDate: today(), createdBy: staff.id,
    });
    const net = await get(
      `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
         FROM journal_split s JOIN journal j ON j.id = s.journal_id
        WHERE j.company_id = ?`, world.companyId);
    assert.equal(Number(net.c), 0);
    assert.equal((await parity(world.companyId)).inParity, true,
      "every owner-visible line has a journal behind it");
  });
});

/* Retiring an account, and what it must not do.

   OPEN-ITEMS A2. `4000 Rent income` is unposted under the agency model —
   a rent charge credits `2400` and the receipt moves it to `2200`, because an
   agent collecting rent holds somebody else's money rather than earning
   revenue. The account sat in every chart, offered on the journal form,
   posting to nothing: the account somebody reaches for when they are looking
   for where the rent went, and the wrong answer.

   The larger half of that item was that retiring it was not safe. Every
   report in `reports/financial.js` filtered on `active = 1`, so retiring an
   account with postings took them off the profit and loss and put the balance
   sheet out by the same amount — for any account, not just this one. */
describe("retiring an account", () => {
  test("takes it off the journal form", async () => {
    const offered = await all(
      "SELECT code FROM account WHERE company_id = ? AND active = 1 ORDER BY code",
      world.companyId);
    const codes = offered.map((r) => r.code);
    assert.ok(!codes.includes("4000"),
      "nothing credits 4000 under agency, so it must not be offered");
    assert.ok(codes.includes("2400"), "and the account that is credited still is");
  });

  test("but keeps the account and its history", async () => {
    const acct = await get(
      "SELECT code, name, active FROM account WHERE company_id = ? AND code = '4000'",
      world.companyId);
    assert.ok(acct, "a company whose older journals used it still needs the account");
    assert.equal(Number(acct.active), 0);
  });

  test("and does not remove its postings from the reports", async () => {
    /* The bug the fix is for. Posted to a retired account, then read back. */
    const { postJournal } = await import("../server/features/accounting.js");
    const { profitAndLoss, balanceSheet } = await import("../server/lib/reports/financial.js");
    await postJournal({
      companyId: world.companyId, date: "2026-03-01", memo: "rent, the old way",
      splits: [{ code: "1300", debit: 50000 }, { code: "4000", credit: 50000 }],
    });

    const pl = await profitAndLoss(world.companyId, { from: "2026-01-01", to: "2026-12-31" });
    assert.equal(pl.incomeCents, 50000,
      "income on a retired account is still income that was earned");

    const bs = await balanceSheet(world.companyId, { asOf: "2026-12-31" });
    assert.equal(bs.outOfBalanceCents, 0,
      "and a balance sheet must not stop balancing because somebody tidied the chart");
  });

  test("a retired account with nothing on it stays out of the way", async () => {
    const { profitAndLoss } = await import("../server/lib/reports/financial.js");
    const pl = await profitAndLoss(world.companyId, { from: "2026-01-01", to: "2026-12-31" });
    const codes = (pl.rows || []).map((r) => r.code);
    assert.ok(!codes.includes("4000"),
      "retired and never posted to is noise on a report nobody needs");
  });
});
