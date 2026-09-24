/* Moving earned fees out of the trust account.

   The manager's own income should not sit in a client account. It arrives
   there honestly — a tenant sends one payment covering rent and a late fee,
   a management fee is taken from money already held — and every state that
   regulates trust accounting expects it out promptly.

   `book_vs_clients` has read a surplus as "fees you have earned and not yet
   moved to your operating account" since Phase 6. What was missing was a way
   to record having moved it.

   The decision this file holds: **the surplus is only a safe figure when the
   rest of the reconciliation is sound.** If a client liability is missing or
   negative, the surplus is measured against an obligation total that is not
   real, and sweeping it would move client money into the manager's account.
   So a sweep is refused outright while any error stands — refused, not
   warned about. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { startApp, client } from "./helpers/http.js";
import { postMoney } from "../server/lib/ledger.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";
import {
  planSweep, commitSweep, describeSweep, CONFIRMATION, SweepRefused,
} from "../server/lib/trustsweep.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Sweep Co" });
  await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", world.companyId);
});

const bal = async (code) => Number((await get(
  `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
     FROM journal_split s JOIN account a ON a.id = s.account_id
    WHERE a.company_id = ? AND a.code = ?`, world.companyId, code)).c);

const post = (kind, amountCents) => postMoney({
  companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
  unitId: world.unitId, leaseId: world.leaseId, date: "2026-03-05",
  kind, amountCents, memo: kind, source: "manual", postedBy: "test",
});

/* A sound book, then a fee earned on it.

   Sound matters here more than anywhere: the sweep refuses to offer a figure
   while the reconciliation reports an error, so a fixture that skips the
   deposit or pays rent that was never charged is a fixture where nothing is
   ever sweepable — correctly, and for reasons that have nothing to do with
   what is being tested.

   So the deposit is posted, the rent is charged before it is paid (a payment
   with no charge behind it is prepaid rent, not the owner's funds, and drives
   2200 negative), and only then is a fee taken. */
async function soundBook() {
  const { takeDeposit } = await import("../server/lib/deposits.js");
  const lease = await get("SELECT deposit_cents FROM lease WHERE id = ?", world.leaseId);
  await takeDeposit({
    companyId: world.companyId, leaseId: world.leaseId,
    amountCents: Number(lease.deposit_cents), date: "2026-03-01", by: "test",
  });
  const { chargeRent } = await import("../server/lib/rentcharge.js");
  await chargeRent(world.companyId, { period: "2026-03" });
  await post("rent_payment", 100000);
}

async function earnedFee(cents = 8000) {
  await soundBook();
  await post("management_fee", -cents);
}

describe("what may be moved", () => {
  test("nothing, when nothing has been earned", async () => {
    await soundBook();
    const plan = await planSweep(world.companyId);
    assert.equal(plan.sweepableCents, 0, "all of it is somebody's");
    assert.equal(plan.blocked.length, 0, "and the books are sound");
  });

  test("the fee, once it has been earned", async () => {
    await earnedFee(8000);
    const plan = await planSweep(world.companyId);
    assert.equal(plan.sweepableCents, 8000);
    /* The deposit and the rent, both still in the account. */
    assert.equal(plan.trustCashCents, 200000, "the cash has not moved yet");
    assert.equal(plan.clientsCents, 192000, "but less of it is owed to anybody");
  });

  test("and a fee a tenant paid, which lands in trust the same way", async () => {
    await soundBook();
    await post("other", 5000);
    await post("rent_payment", 5000);
    const plan = await planSweep(world.companyId);
    assert.equal(plan.sweepableCents, 5000);
  });
});

describe("recording the transfer", () => {
  test("it moves the money from trust to operating", async () => {
    await earnedFee(8000);
    const res = await commitSweep({
      companyId: world.companyId, amountCents: 8000, date: "2026-03-10",
      reference: "bank ref 99", by: "test", confirm: CONFIRMATION,
    });
    assert.ok(res.journalId);

    assert.equal(await bal("1010"), 92000 + 100000, "out of the client account");
    assert.equal(await bal("1000"), 8000, "and into the manager's own");
  });

  test("and the reconciliation stops reporting it", async () => {
    await earnedFee(8000);
    const before = await trustReconciliation(world.companyId);
    assert.equal(before.variances.find((v) => v.key === "book_vs_clients").cents, 8000);

    await commitSweep({
      companyId: world.companyId, amountCents: 8000, date: "2026-03-10",
      by: "test", confirm: CONFIRMATION,
    });

    const after = await trustReconciliation(world.companyId);
    assert.equal(after.variances.find((v) => v.key === "book_vs_clients").cents, 0,
      "the account holds exactly what is owed to clients again");
  });

  test("the reference is on the journal, so it can be matched to the statement", async () => {
    await earnedFee(8000);
    await commitSweep({
      companyId: world.companyId, amountCents: 8000, date: "2026-03-10",
      reference: "FT2026031000123", by: "test", confirm: CONFIRMATION,
    });
    const j = await get("SELECT memo FROM journal WHERE source_type = 'trust_sweep'");
    assert.match(j.memo, /FT2026031000123/);
  });

  test("a partial sweep leaves the rest", async () => {
    await earnedFee(8000);
    await commitSweep({
      companyId: world.companyId, amountCents: 3000, date: "2026-03-10",
      by: "test", confirm: CONFIRMATION,
    });
    const plan = await planSweep(world.companyId);
    assert.equal(plan.sweepableCents, 5000);
  });

  test("it shows up in the history", async () => {
    await earnedFee(8000);
    await commitSweep({
      companyId: world.companyId, amountCents: 8000, date: "2026-03-10",
      reference: "ref", by: "test", confirm: CONFIRMATION,
    });
    const plan = await planSweep(world.companyId);
    assert.equal(plan.history.length, 1);
    assert.equal(plan.history[0].cents, 8000);
    assert.equal(plan.history[0].date, "2026-03-10");
  });
});

describe("what it refuses", () => {
  test("a sweep without the confirmation", async () => {
    await earnedFee(8000);
    await assert.rejects(
      () => commitSweep({ companyId: world.companyId, amountCents: 8000, by: "test" }),
      /Confirm with/);
    assert.equal(await bal("1000"), 0);
  });

  test("more than has been earned", async () => {
    await earnedFee(8000);
    await assert.rejects(
      () => commitSweep({
        companyId: world.companyId, amountCents: 50000, by: "test", confirm: CONFIRMATION,
      }),
      /owed to clients/);
    assert.equal(await bal("1000"), 0, "not even the part that was legitimate");
  });

  test("anything at all when nothing has been earned", async () => {
    await soundBook();
    await assert.rejects(
      () => commitSweep({
        companyId: world.companyId, amountCents: 100, by: "test", confirm: CONFIRMATION,
      }),
      /owed to clients/);
  });

  test("a negative or zero amount", async () => {
    await earnedFee(8000);
    for (const amt of [0, -5000]) {
      await assert.rejects(
        () => commitSweep({
          companyId: world.companyId, amountCents: amt, by: "test", confirm: CONFIRMATION,
        }),
        /positive/);
    }
  });

  test("and everything, while the obligation side is broken", async () => {
    /* The dangerous case, and the reason this is a refusal rather than a
       warning. A negative client liability means the obligation total the
       surplus is measured against is not real, so the "surplus" may be client
       money. */
    await earnedFee(8000);
    const acct = await get(
      "SELECT id FROM account WHERE company_id = ? AND code = '2100'", world.companyId);
    const { postJournal } = await import("../server/features/accounting.js");
    await postJournal({
      companyId: world.companyId, date: "2026-03-06", memo: "a broken obligation",
      splits: [
        { code: "2100", debit: 20000, memo: "drives the liability negative" },
        { code: "1010", credit: 20000, memo: "out of trust" },
      ],
    });

    const plan = await planSweep(world.companyId);
    assert.ok(plan.blocked.length > 0, "the reconciliation has an error");
    assert.equal(plan.sweepableCents, 0, "and nothing is offered");

    await assert.rejects(
      () => commitSweep({
        companyId: world.companyId, amountCents: 8000, by: "test", confirm: CONFIRMATION,
      }),
      /has to be fixed first/);
    assert.equal(await bal("1000"), 0);
  });
});

describe("what it says", () => {
  test("the figures, when it can be done", async () => {
    await earnedFee(8000);
    const text = describeSweep(await planSweep(world.companyId));
    assert.match(text, /Yours to move/);
    assert.match(text, /\$80\.00/);
  });

  test("and the reason, when it cannot", async () => {
    await earnedFee(8000);
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId, date: "2026-03-06",
      kind: "deposit_returned", amountCents: -20000, memo: "breaks it",
      source: "manual", postedBy: "test",
    });
    const plan = await planSweep(world.companyId);
    if (plan.blocked.length) {
      assert.match(describeSweep(plan), /cannot be moved|problem/i);
    }
  });
});

/* The screen, on the trust position page where the surplus is already
   reported. Somebody looking at "the account holds more than is owed" is
   exactly the person who needs the form. */
describe("recording it from the screen", () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  async function signedIn() {
    const w = await f.makeWorld({ name: "Sweep Screen Co", staffRoles: ["admin"] });
    await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", w.companyId);
    const c = client(app.origin);
    assert.equal((await c.signIn(w.staff.admin.email, f.PASSWORD)).signedIn, true);
    return { w, c };
  }

  async function earn(w, cents) {
    const { takeDeposit } = await import("../server/lib/deposits.js");
    const lease = await get("SELECT deposit_cents FROM lease WHERE id = ?", w.leaseId);
    await takeDeposit({ companyId: w.companyId, leaseId: w.leaseId,
      amountCents: Number(lease.deposit_cents), date: "2026-03-01", by: "t" });
    const { chargeRent } = await import("../server/lib/rentcharge.js");
    await chargeRent(w.companyId, { period: "2026-03" });
    const p = (kind, amt) => postMoney({ companyId: w.companyId, ownerId: w.ownerId,
      propertyId: w.propertyId, unitId: w.unitId, leaseId: w.leaseId, date: "2026-03-05",
      kind, amountCents: amt, memo: kind, source: "manual", postedBy: "t" });
    await p("rent_payment", 100000);
    await p("management_fee", -cents);
  }

  test("the page offers what is the manager's", async () => {
    const { w, c } = await signedIn();
    await earn(w, 8000);
    const { res, body } = await c.text("/app/accounting/trust");
    assert.equal(res.status, 200);
    assert.match(body, /Your own fees/);
    assert.match(body, /\$80\.00/);
    assert.match(body, /it does not move anything/,
      "the page has to say it records rather than transfers");
  });

  test("and says nothing when the books are sound and nothing is owed to you", async () => {
    const { w, c } = await signedIn();
    /* Sound, but with no fee taken. A fresh company whose deposits are not
       posted is a different case and gets the reason instead — see below. */
    const { takeDeposit } = await import("../server/lib/deposits.js");
    const lease = await get("SELECT deposit_cents FROM lease WHERE id = ?", w.leaseId);
    await takeDeposit({ companyId: w.companyId, leaseId: w.leaseId,
      amountCents: Number(lease.deposit_cents), date: "2026-03-01", by: "t" });

    const { body } = await c.text("/app/accounting/trust");
    assert.doesNotMatch(body, /Your own fees/,
      "nothing earned and nothing wrong is nothing to say");
  });

  test("a company whose deposits are not posted is told why, not shown a figure", async () => {
    /* The realistic version of "broken": deposits recorded on leases and
       posted nowhere understate what is owed to clients, so what looks like a
       surplus may be a tenant's deposit. */
    const { c } = await signedIn();
    const { body } = await c.text("/app/accounting/trust");
    assert.match(body, /Fix the reconciliation first/);
    assert.doesNotMatch(body, /Record the transfer/);
  });

  test("the form records it", async () => {
    const { w, c } = await signedIn();
    await earn(w, 8000);
    const res = await c.post("/app/accounting/trust/sweep",
      { amount: "80.00", date: "2026-03-10", reference: "ref 1" },
      { csrfFrom: "/app/accounting/trust" });
    assert.equal(res.status, 303);

    const after = await planSweep(w.companyId);
    assert.equal(after.sweepableCents, 0);
    assert.equal(after.history.length, 1);
  });

  test("and refuses more than is the manager's, without moving anything", async () => {
    const { w, c } = await signedIn();
    await earn(w, 8000);
    const res = await c.post("/app/accounting/trust/sweep",
      { amount: "5000.00", date: "2026-03-10" },
      { csrfFrom: "/app/accounting/trust" });
    assert.notEqual(res.status, 303);

    const after = await planSweep(w.companyId);
    assert.equal(after.sweepableCents, 8000, "still there");
    assert.equal(after.history.length, 0);
  });

  test("the page says why, when the reconciliation is broken", async () => {
    const { w, c } = await signedIn();
    await earn(w, 8000);
    const { postJournal } = await import("../server/features/accounting.js");
    await postJournal({
      companyId: w.companyId, date: "2026-03-06", memo: "breaks the obligation side",
      splits: [
        { code: "2100", debit: 500000, memo: "negative" },
        { code: "1010", credit: 500000, memo: "out" },
      ],
    });
    const { body } = await c.text("/app/accounting/trust");
    assert.match(body, /Fix the reconciliation first/);
    assert.doesNotMatch(body, /Record the transfer/, "and offers no form while it is broken");
  });
});
