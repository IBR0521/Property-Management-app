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
