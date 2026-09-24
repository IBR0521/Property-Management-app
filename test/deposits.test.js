/* Security deposits.

   This is the fourth thing in the project to post journals, and the Phase 6
   corrections are what happens when a posting is wrong for a few months. So
   the postings are asserted line by line, and the one that was settled with
   the customer before a line of it was written — **a deduction credits the
   owner, not the manager** — has a test of its own.

   The other thing this file holds is that the money is the journal. What is
   held is `2100` for that lease, not `lease.deposit_cents`, because a return
   that disagreed with the books would be paying out money the books do not
   think exists. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import {
  heldFor, takeDeposit, openReturn, addDeduction, removeDeduction, deductedFrom,
  returnDetail, settleReturn, renderItemisation,
  planConversion, describeConversion, commitConversion, DepositRefused,
} from "../server/lib/deposits.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world, company;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Deposits Co" });
  company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
});

/* Balances on one account, for the whole company. Credits minus debits, so a
   liability reads positive when money is held. */
async function liability(code) {
  const row = await get(
    `SELECT COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
       FROM journal_split s JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = ?`, world.companyId, code);
  return Number(row.cents);
}
async function asset(code) {
  const row = await get(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS cents
       FROM journal_split s JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = ?`, world.companyId, code);
  return Number(row.cents);
}

async function depositRule(windowDays = 30) {
  await insert("compliance_rule", {
    id: id(), company_id: world.companyId, kind: "deposit_return",
    label: "Security deposit return", window_days: windowDays,
    authority_note: "per ORC 5321.16, confirmed by counsel",
    active: 1, created_at: stamp(),
  });
}

async function held(cents = 120000) {
  await takeDeposit({
    companyId: world.companyId, leaseId: world.leaseId,
    amountCents: cents, date: "2026-01-01", by: "test" });
  await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", cents, world.leaseId);
}

/* --- taking one ----------------------------------------------------------------- */

describe("taking a deposit", () => {
  test("it lands in trust cash as a liability to the tenant, not as income", async () => {
    await takeDeposit({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: 120000, date: "2026-01-01", by: "test" });

    assert.equal(await asset("1010"), 120000, "the money is in the trust account");
    assert.equal(await liability("2100"), 120000, "and it is owed to the tenant");
    assert.equal(await liability("2200"), 0,
      "a deposit is not the owner's money — treating it as income is the classic failure");
  });

  test("it writes both books, like every other movement of somebody else's money",
    async () => {
      const posted = await takeDeposit({
        companyId: world.companyId, leaseId: world.leaseId,
        amountCents: 90000, date: "2026-01-01", by: "test" });
      const entry = await get("SELECT * FROM ledger_entry WHERE id = ?", posted.entryId);
      assert.equal(entry.journal_id, posted.journalId);
      assert.equal(entry.kind, "deposit_held");
    });

  test("what is held comes from the journal, not from the lease row", async () => {
    await run("UPDATE lease SET deposit_cents = 999999 WHERE id = ?", world.leaseId);
    assert.equal(await heldFor(world.companyId, world.leaseId), 0,
      "a number somebody typed is not money");

    await takeDeposit({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: 120000, date: "2026-01-01", by: "test" });
    assert.equal(await heldFor(world.companyId, world.leaseId), 120000);
  });

  test("nothing and nonsense are refused", async () => {
    for (const amount of [0, -100, "banana", null]) {
      await assert.rejects(() => takeDeposit({
        companyId: world.companyId, leaseId: world.leaseId, amountCents: amount }),
        DepositRefused);
    }
  });
});

/* --- the return ------------------------------------------------------------------ */

describe("opening a return", () => {
  test("it reads what is held and the company's own deadline", async () => {
    await held();
    await depositRule(30);

    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId,
      moveoutDate: "2026-06-30", by: "Dana" });

    assert.equal(Number(ret.held_cents), 120000);
    assert.equal(ret.moveout_date, "2026-06-30");
    assert.equal(ret.due_by, addDays("2026-06-30", 30));
    assert.match(ret.basis, /ORC 5321\.16/, "the basis they gave us, not one we invented");
    assert.equal(ret.status, "open");
  });

  test("with no rule there is no deadline, because this app does not invent one",
    async () => {
      await held();
      const ret = await openReturn({
        companyId: world.companyId, leaseId: world.leaseId,
        moveoutDate: "2026-06-30", by: "Dana" });
      assert.equal(ret.due_by, null);
      assert.equal(ret.basis, null);
    });

  test("opening it twice returns the same one", async () => {
    await held();
    const first = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
    const second = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
    assert.equal(first.id, second.id);
    assert.equal((await all("SELECT id FROM deposit_return")).length, 1);
  });

  test("and the database refuses a second open one even if the code does not", async () => {
    await held();
    const first = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });

    await assert.rejects(() => insert("deposit_return", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      held_cents: 120000, moveout_date: "2026-07-01", status: "open",
      opened_at: stamp(),
    }), /duplicate key|unique/i);
    assert.ok(first.id);
  });

  test("a move-out opens one, so a tenancy cannot end without it", async () => {
    await held();
    await depositRule(30);

    const app = await import("./helpers/http.js").then((m) => m.startApp());
    const agent = (await import("./helpers/http.js")).client(app.origin);
    await agent.signIn(world.staff.admin.email, f.PASSWORD);

    const res = await agent.post("/app/portfolio/moveout",
      { lease_id: world.leaseId, moveout_date: "2026-06-30" },
      { csrfFrom: "/app/portfolio" });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/app\/deposits\//,
      "it lands on the return rather than leaving somebody to find it");

    const ret = await get("SELECT * FROM deposit_return WHERE lease_id = ?", world.leaseId);
    assert.ok(ret);
    assert.equal(Number(ret.held_cents), 120000);
    await app.close();
  });
});

/* --- deductions ------------------------------------------------------------------ */

describe("deductions", () => {
  async function opened() {
    await held();
    await depositRule(30);
    return await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
  }

  test("each one needs a reason in the words the tenant will read", async () => {
    const ret = await opened();
    await assert.rejects(() => addDeduction({
      companyId: world.companyId, returnId: ret.id, reason: "", amountCents: 5000, by: "Dana" }),
      /needs a reason/);
    await assert.rejects(() => addDeduction({
      companyId: world.companyId, returnId: ret.id, reason: "x", amountCents: 5000, by: "Dana" }),
      /needs a reason/);
  });

  test("a deposit cannot be overdrawn", async () => {
    const ret = await opened();
    await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Carpet in the second bedroom", amountCents: 100000, by: "Dana" });

    await assert.rejects(() => addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Repainting", amountCents: 30000, by: "Dana" }),
      /cannot be overdrawn/);

    assert.equal(await deductedFrom(ret.id), 100000, "the second one was not written");
  });

  test("it can carry the repair it came from", async () => {
    const ret = await opened();
    await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Carpet", amountCents: 15000,
      workOrderId: world.workOrderId, by: "Dana" });

    const detail = await returnDetail({ companyId: world.companyId, returnId: ret.id });
    assert.equal(detail.deductions[0].work_order_id, world.workOrderId);
    assert.ok(detail.deductions[0].reference, "and the reference, for the itemisation");
  });

  test("one can be removed while the return is open, and not after", async () => {
    const ret = await opened();
    const deduction = await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Carpet", amountCents: 15000, by: "Dana" });

    await removeDeduction({ companyId: world.companyId, deductionId: deduction.id });
    assert.equal(await deductedFrom(ret.id), 0);

    const again = await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Carpet", amountCents: 15000, by: "Dana" });
    await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    await assert.rejects(
      () => removeDeduction({ companyId: world.companyId, deductionId: again.id }),
      /part of the record/);
  });
});

/* --- settling -------------------------------------------------------------------- */

describe("settling", () => {
  async function opened(depositCents = 120000) {
    await held(depositCents);
    await depositRule(30);
    return await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
  }

  test("the whole deposit back, when nothing is deducted", async () => {
    const ret = await opened();
    const settled = await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    assert.equal(settled.status, "settled");
    assert.equal(Number(settled.returned_cents), 120000);
    assert.equal(await liability("2100"), 0, "nothing is held any more");
    assert.equal(await asset("1010"), 0,
      "and the whole 120,000 has left the trust account, back to the tenant");
    assert.equal(await liability("2200"), 0, "the owner gets none of it");
  });

  test("a deduction credits the owner, which is the decision this was built on",
    async () => {
      /* The owner bore the repair. A deduction reimburses them; booking it as
         management income would be an owner's money landing on the manager's
         books, which is the Phase 6 mistake and was invisible for months. */
      const ret = await opened();
      await addDeduction({
        companyId: world.companyId, returnId: ret.id,
        reason: "Carpet in the second bedroom, beyond fair wear",
        amountCents: 45000, by: "Dana" });

      const cashBefore = await asset("1010");
      await settleReturn({
        companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

      assert.equal(await liability("2100"), 0);
      assert.equal(cashBefore - (await asset("1010")), 75000,
        "75,000 left the trust account, which is what went back to the tenant");
      assert.equal(await liability("2200"), 45000, "and the deduction is the owner's");
      assert.equal(await liability("4100"), 0, "not fee income");
      assert.equal(await liability("4200"), 0, "and not management fee income");
    });

  test("the posting balances", async () => {
    const ret = await opened();
    await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Cleaning beyond fair wear", amountCents: 20000, by: "Dana" });
    const settled = await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    const splits = await all(
      "SELECT * FROM journal_split WHERE journal_id = ?", settled.journal_id);
    const net = splits.reduce(
      (n, s) => n + Number(s.debit_cents) - Number(s.credit_cents), 0);
    assert.equal(net, 0);
    for (const s of splits) {
      assert.equal(s.lease_id, world.leaseId, "every line carries the tenancy");
      assert.ok(s.owner_id, "and the owner, so a report can attribute it");
    }
  });

  test("settling twice is refused", async () => {
    const ret = await opened();
    await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });
    await assert.rejects(() => settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-06", by: "Dana" }),
      /already been settled/);
  });

  test("the whole deposit deducted returns nothing and still posts", async () => {
    const ret = await opened();
    await addDeduction({
      companyId: world.companyId, returnId: ret.id,
      reason: "Unpaid rent for the final month", amountCents: 120000, by: "Dana" });
    const settled = await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    assert.equal(Number(settled.returned_cents), 0);
    assert.equal(await liability("2200"), 120000);
    assert.equal(await asset("1010"), 120000,
      "the money is still in the trust account — it moved from the tenant's claim on it "
      + "to the owner's, and nothing was paid out");
  });
});

/* --- the itemisation -------------------------------------------------------------- */

describe("the statement the tenant is given", () => {
  test("every deduction is listed with its reason, and the arithmetic is checkable",
    async () => {
      await held();
      await depositRule(30);
      const ret = await openReturn({
        companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
      await addDeduction({
        companyId: world.companyId, returnId: ret.id,
        reason: "Carpet in the second bedroom", amountCents: 45000, by: "Dana" });
      await addDeduction({
        companyId: world.companyId, returnId: ret.id,
        reason: "Cleaning", amountCents: 12000, by: "Dana" });

      const detail = await returnDetail({ companyId: world.companyId, returnId: ret.id });
      const text = renderItemisation({ detail, company, date: "2026-07-05" });

      assert.match(text, /Deposit held\s+\$1,200\.00/);
      assert.match(text, /Carpet in the second bedroom\s+\$450\.00/);
      assert.match(text, /Cleaning\s+\$120\.00/);
      assert.match(text, /Total deducted\s+\$570\.00/);
      assert.match(text, /Returned to you\s+\$630\.00/);
      assert.match(text, /ORC 5321\.16/, "and the basis for the deadline");
      assert.match(text, /say which line/, "and how to disagree with it");
    });

  test("with nothing deducted it says so, because several states require a statement anyway",
    async () => {
      await held();
      const ret = await openReturn({
        companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
      const detail = await returnDetail({ companyId: world.companyId, returnId: ret.id });
      const text = renderItemisation({ detail, company });
      assert.match(text, /No deductions have been made/);
    });

  test("it is frozen at settlement and queued through the outbox", async () => {
    await held();
    await run("UPDATE tenant SET email = ? WHERE id = ?", "ravi@example.test", world.tenantId);
    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
    const settled = await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    assert.ok(settled.itemisation, "what they were given is kept");
    assert.ok(settled.itemisation_outbox_id, "and it goes out the way everything else does");

    const queued = await get("SELECT * FROM outbox WHERE id = ?", settled.itemisation_outbox_id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.body, settled.itemisation,
      "what was recorded and what was sent have to be the same words");
  });

  test("no email on file means written and not claimed sent", async () => {
    await held();
    await run("UPDATE tenant SET email = NULL WHERE id = ?", world.tenantId);
    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
    const settled = await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });
    assert.ok(settled.itemisation);
    assert.equal(settled.itemisation_outbox_id, null);
  });
});

/* --- the books afterwards ---------------------------------------------------------- */

describe("what the reconciliation says", () => {
  test("a posted deposit stops being a variance", async () => {
    await held();
    const before = await trustReconciliation(world.companyId, { asOf: "2026-06-01" });
    const dep = before.variances.find((v) => v.key === "deposits_vs_leases");
    assert.equal(dep.cents, 0, "the books and the leases agree once it is posted");
  });

  test("and a tenancy that has ended with the money still held is not one either",
    async () => {
      /* The tenant left on the 30th and their money is still in the trust
         account until somebody pays it back. Counting only active leases
         reported that as a variance for exactly the period somebody is most
         likely to be looking at this report. */
      await held();
      await run("UPDATE lease SET status = 'ended', moveout_date = ? WHERE id = ?",
        "2026-06-30", world.leaseId);
      await openReturn({
        companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });

      const rec = await trustReconciliation(world.companyId, { asOf: "2026-07-01" });
      const dep = rec.variances.find((v) => v.key === "deposits_vs_leases");
      assert.equal(dep.cents, 0);
    });

  test("and once it is settled, neither side counts it", async () => {
    await held();
    await run("UPDATE lease SET status = 'ended', moveout_date = ? WHERE id = ?",
      "2026-06-30", world.leaseId);
    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });
    await settleReturn({
      companyId: world.companyId, returnId: ret.id, date: "2026-07-05", by: "Dana" });

    const rec = await trustReconciliation(world.companyId, { asOf: "2026-07-10" });
    const dep = rec.variances.find((v) => v.key === "deposits_vs_leases");
    assert.equal(dep.cents, 0);
  });
});

/* --- the conversion ---------------------------------------------------------------- */

describe("deposits that were never posted", () => {
  test("the plan finds them and says what it would do", async () => {
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);

    const planned = await planConversion({ companyId: world.companyId });
    assert.equal(planned.length, 1);
    assert.equal(planned[0].missing.length, 1);
    assert.equal(planned[0].cents, 120000);

    const words = describeConversion(planned);
    assert.match(words, /not in the books/);
    assert.match(words, /\$1,200\.00/);
  });

  test("a lease whose deposit is already posted is left alone", async () => {
    await held();
    const planned = await planConversion({ companyId: world.companyId });
    assert.deepEqual(planned, []);
  });

  test("a partial posting is named and not touched", async () => {
    /* Guessing at the difference is how a conversion makes things worse. */
    await takeDeposit({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: 50000, date: "2026-01-01", by: "test" });
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);

    const planned = await planConversion({ companyId: world.companyId });
    assert.equal(planned[0].missing.length, 0);
    assert.equal(planned[0].partial.length, 1);
    assert.match(describeConversion(planned), /NOT touched/);

    const result = await commitConversion({
      confirm: "post-held-deposits", companyId: world.companyId });
    assert.equal(result[0].posted, 0);
    assert.equal(result[0].untouched, 1);
    assert.equal(await liability("2100"), 50000, "unchanged");
  });

  test("committing posts them and the reconciliation settles", async () => {
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);

    const result = await commitConversion({
      confirm: "post-held-deposits", companyId: world.companyId });
    assert.equal(result[0].posted, 1);
    assert.equal(result[0].cents, 120000);

    assert.equal(await liability("2100"), 120000);
    const rec = await trustReconciliation(world.companyId, { asOf: today() });
    assert.equal(rec.variances.find((v) => v.key === "deposits_vs_leases").cents, 0);
  });

  test("it will not run without the confirmation", async () => {
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);
    await assert.rejects(() => commitConversion({ companyId: world.companyId }),
      /post-held-deposits/);
    assert.equal(await liability("2100"), 0);
  });

  test("it never posts behind a close", async () => {
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);
    await run("UPDATE company SET books_closed_through = ? WHERE id = ?",
      "2026-06-30", world.companyId);

    const result = await commitConversion({
      confirm: "post-held-deposits", companyId: world.companyId });
    assert.equal(result[0].date, "2026-07-01",
      "the books being closed through a date means somebody signed off on the figures");
  });
});
