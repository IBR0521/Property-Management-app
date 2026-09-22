/* A tenant payment, from authorisation to the bank taking it back.

   The return is the reason this file is long. Everything else is a state
   machine; a return is the case where four separate things already told
   somebody the money arrived — the tenant's receipt, the owner's statement,
   the company's books, the closed delinquency — and every one of them has to
   be corrected without any of them being erased.

   Stripe is injected, so none of this needs a network, credentials, or a
   sandbox account. What is *not* tested here is whether Stripe's API behaves
   as documented; that is in OPEN-ITEMS and it is the first thing real keys
   will settle. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { parity } from "../server/lib/ledger.js";
import {
  createPayment, settlePayment, failPayment, returnPayment,
  balanceFor, blockedReason, recomputeDelinquency, TERMINAL_RETURN_CODES,
} from "../server/lib/payments.js";

const RENT = 145000;   // $1,450

let world;

/* Stripe, replaced. Records what it was asked for so the request shape can be
   asserted, and can be told to fail the way the real one does. */
let intentCounter = 0;

function fakeStripe({ status = "processing", fail = null, code = null } = {}) {
  const calls = [];
  return {
    calls,
    async createPaymentIntent(args) {
      calls.push(args);
      if (fail) {
        const err = new Error(fail);
        err.stripeCode = code;
        throw err;
      }
      /* Unique across the whole file, not per fake: the column is UNIQUE, and
         two fakes each numbering from one collided on the second payment. */
      return { id: `pi_test_${++intentCounter}`, status };
    },
  };
}

/* A saved bank account, as the tenant would have added one. */
async function paymentMethod() {
  const mid = id();
  await insert("tenant_payment_method", {
    id: mid, company_id: world.companyId, lease_id: world.leaseId,
    kind: "ach", stripe_payment_method_id: `pm_${mid.slice(-8)}`,
    label: "Checking", last4: "6789", status: "active",
    mandate_accepted_at: stamp(), created_at: stamp(),
  });
  return mid;
}

async function company(patch = {}) {
  await run(
    `UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1,
            accept_ach = 1, accept_card = 1, ach_fee_model = ?, card_fee_model = ?
      WHERE id = ?`,
    patch.accountId ?? "acct_test", patch.achModel ?? "absorb",
    patch.cardModel ?? "pass", world.companyId);
  return await get("SELECT * FROM company WHERE id = ?", world.companyId);
}

/* A delinquency for the period, as the nightly sweep would have opened it. */
async function delinquency(period, amountCents = RENT) {
  const did = id();
  await insert("delinquency", {
    id: did, company_id: world.companyId, lease_id: world.leaseId,
    period, late_since: `${period}-06`, amount_cents: amountCents,
    stage: 1, status: "open", opened_at: stamp(),
  });
  return did;
}

/* Take a payment all the way to settled, which is the starting position for
   every test about a return. */
async function settled({ period = "2026-06", amountCents = RENT, kind = "ach" } = {}) {
  const stripe = fakeStripe();
  const made = await createPayment({
    companyId: world.companyId, leaseId: world.leaseId,
    amountCents, kind, period, stripe,
  });
  assert.equal(made.ok, true, made.reason);
  await settlePayment({ paymentId: made.paymentId, settledAt: `${period}-03 09:00:00`, chargeId: "ch_test" });
  return await get("SELECT * FROM tenant_payment WHERE id = ?", made.paymentId);
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Payments Co" });
  await run("UPDATE lease SET rent_cents = ? WHERE id = ?", RENT, world.leaseId);
  await company();
});

/* --- what stops a payment before it starts -------------------------------- */

describe("refusing to take a payment", () => {
  test("a blocked lease says why, in words a tenant can act on", async () => {
    await run(
      `UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ?
        WHERE id = ?`,
      "We are holding an eviction filing. Please call the office on (614) 555-0100.",
      world.leaseId);

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    const reason = blockedReason(lease);
    assert.match(reason, /call the office/i);

    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /call the office/i);
  });

  test("a blocked lease with no reason still says something", async () => {
    /* "Payment unavailable" with no explanation generates the phone call this
       product exists to remove. */
    await run("UPDATE lease SET payments_blocked = 1 WHERE id = ?", world.leaseId);
    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.match(blockedReason(lease), /contact the office/i);
  });

  test("an ended tenancy cannot pay rent online", async () => {
    await run("UPDATE lease SET status = 'ended' WHERE id = ?", world.leaseId);
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not active/i);
  });

  test("a method the company does not offer is refused", async () => {
    await run("UPDATE company SET accept_card = 0 WHERE id = ?", world.companyId);
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, kind: "card", stripe: fakeStripe(),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not available/i);
  });

  test("no connected account means no payment, whatever the settings say", async () => {
    /* The company can have every method switched on and still be unable to
       take money. Offering a pay button here produces a failure the tenant
       cannot understand and the manager cannot explain. */
    await run("UPDATE company SET stripe_account_id = NULL WHERE id = ?", world.companyId);
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    assert.equal(res.ok, false);
  });

  test("zero and negative amounts are refused", async () => {
    for (const amount of [0, -100, -RENT]) {
      const res = await createPayment({
        companyId: world.companyId, leaseId: world.leaseId,
        amountCents: amount, stripe: fakeStripe(),
      });
      assert.equal(res.ok, false, `${amount} should be refused`);
    }
    assert.equal((await all("SELECT id FROM tenant_payment")).length, 0,
      "a refused payment leaves no row behind");
  });
});

/* --- creating -------------------------------------------------------------- */

describe("creating a payment", () => {
  test("the quote is frozen onto the row, not recomputed later", async () => {
    /* Rates change. A receipt that recomputes its own fee against today's
       rates eventually disagrees with what was charged. */
    await run("UPDATE company SET ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, kind: "ach", stripe: fakeStripe(),
    });
    assert.equal(res.ok, true);

    const row = await get("SELECT * FROM tenant_payment WHERE id = ?", res.paymentId);
    assert.equal(Number(row.amount_cents), RENT);
    assert.equal(Number(row.fee_cents), 500, "0.8% of $1,450 capped at $5");
    assert.equal(Number(row.tenant_fee_cents), 500, "passed on in full");
    assert.equal(Number(row.charged_cents), RENT + 500);

    /* And the rate changing afterwards does not move the frozen figures. */
    await run("UPDATE company SET ach_fee_cap_cents = 2000 WHERE id = ?", world.companyId);
    const again = await get("SELECT * FROM tenant_payment WHERE id = ?", res.paymentId);
    assert.equal(Number(again.charged_cents), RENT + 500);
  });

  test("Stripe is charged the total, not the rent", async () => {
    await run("UPDATE company SET ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const stripe = fakeStripe();
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, kind: "ach", stripe,
    });
    assert.equal(stripe.calls[0].amountCents, RENT + 500,
      "showing one total and charging another is how you earn a chargeback");
  });

  test("the charge is made on the company's account, never ours", async () => {
    const stripe = fakeStripe();
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe,
    });
    assert.equal(stripe.calls[0].accountId, "acct_test");
  });

  test("the idempotency key is the payment row, so a retry is not a second debit", async () => {
    const stripe = fakeStripe();
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe,
    });
    assert.equal(stripe.calls[0].idempotencyKey, `tp:${res.paymentId}`);
  });

  test("an autopay charge tells Stripe nobody is present", async () => {
    /* A bank challenge with no one there to answer it hangs forever. Saying
       off_session makes it fail cleanly so it can be retried with the tenant
       in front of the screen. */
    const stripe = fakeStripe();
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, initiatedBy: "autopay", paymentMethodId: await paymentMethod(), stripe,
    });
    assert.equal(stripe.calls[0].offSession, true);
    assert.equal(stripe.calls[0].confirm, true);
  });

  test("a tenant-initiated payment is on-session", async () => {
    const stripe = fakeStripe();
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe,
    });
    assert.equal(stripe.calls[0].offSession, false);
  });

  test("nothing is recorded in either book at creation", async () => {
    /* An authorised payment is not income. Counting it as one shows an owner
       money that may yet bounce. */
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    assert.equal((await all("SELECT id FROM ledger_entry")).length, 0);
    assert.equal((await all("SELECT id FROM journal")).length, 0);
  });

  test("a Stripe refusal marks the payment failed rather than leaving it pending", async () => {
    /* A row stuck on "pending" is one a tenant sees forever and a manager
       cannot explain. */
    const res = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId, amountCents: RENT,
      stripe: fakeStripe({ fail: "Your bank declined the debit.", code: "account_closed" }),
    });
    assert.equal(res.ok, false);
    const row = await get("SELECT * FROM tenant_payment WHERE id = ?", res.paymentId);
    assert.equal(row.status, "failed");
    assert.equal(row.failure_code, "account_closed");
    assert.match(row.failure_reason, /declined/i);
  });
});

/* --- settling -------------------------------------------------------------- */

describe("settling", () => {
  test("both books learn about it, and they are linked", async () => {
    const payment = await settled();
    assert.equal(payment.status, "succeeded");
    assert.ok(payment.ledger_entry_id, "the owner's statement");
    assert.ok(payment.journal_id, "the company's books");

    const entry = await get("SELECT * FROM ledger_entry WHERE id = ?", payment.ledger_entry_id);
    assert.equal(Number(entry.amount_cents), RENT);
    assert.equal(entry.journal_id, payment.journal_id, "the entry points at its journal");
  });

  test("rent lands in trust cash, because it is the owner's money", async () => {
    const payment = await settled();
    const splits = await all(
      `SELECT a.code, s.debit_cents, s.credit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, payment.journal_id);
    const debited = splits.find((s) => Number(s.debit_cents) > 0);
    assert.equal(debited.code, "1010", "client money, distinguishable from the company's own");
  });

  test("a webhook delivered twice does not post rent twice", async () => {
    /* Stripe delivers at least once, which means sometimes more than once. */
    const payment = await settled();
    const again = await settlePayment({ paymentId: payment.id });
    assert.equal(again.alreadySettled, true);

    const entries = await all(
      "SELECT id FROM ledger_entry WHERE kind = 'rent_payment'");
    assert.equal(entries.length, 1, "one payment, one entry");
  });

  test("the processing fee is posted as its own cost, not netted away", async () => {
    /* Netting the fee against the rent hides both numbers, and an accountant
       needs each of them separately. */
    await run("UPDATE company SET ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const payment = await settled();

    const feeJournal = await get(
      `SELECT * FROM journal WHERE source_id = ? AND memo ILIKE '%fee%'`, payment.id);
    assert.ok(feeJournal, "the fee has its own journal");

    const splits = await all(
      `SELECT a.code, s.debit_cents, s.credit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, feeJournal.id);
    const codes = Object.fromEntries(splits.map((s) =>
      [s.code, Number(s.debit_cents) || -Number(s.credit_cents)]));

    assert.equal(codes["5200"], 500, "the processor's fee is a cost");
    assert.equal(codes["4300"], -500, "recovered from the tenant, so it is income");
  });

  test("an absorbed fee is borne by the company, and says so", async () => {
    const payment = await settled();   // ach_fee_model defaults to absorb
    const feeJournal = await get(
      `SELECT * FROM journal WHERE source_id = ? AND memo ILIKE '%fee%'`, payment.id);
    const splits = await all(
      `SELECT a.code, s.debit_cents, s.credit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, feeJournal.id);
    const codes = Object.fromEntries(splits.map((s) =>
      [s.code, Number(s.debit_cents) || -Number(s.credit_cents)]));

    assert.equal(codes["5200"], 500);
    assert.equal(codes["1010"], -500, "it comes out of the cash that arrived");
    assert.equal(codes["4300"], undefined, "nothing was recovered from the tenant");
  });

  test("settling closes the delinquency", async () => {
    const did = await delinquency("2026-06");
    await settled({ period: "2026-06" });
    const d = await get("SELECT * FROM delinquency WHERE id = ?", did);
    assert.equal(d.status, "resolved");
    assert.equal(Number(d.amount_cents), 0);
  });

  test("a part payment leaves the delinquency open, at the remainder", async () => {
    const did = await delinquency("2026-06");
    await settled({ period: "2026-06", amountCents: 50000 });
    const d = await get("SELECT * FROM delinquency WHERE id = ?", did);
    assert.equal(d.status, "open");
    assert.equal(Number(d.amount_cents), RENT - 50000);
  });

  test("the two books stay in parity", async () => {
    await settled();
    const p = await parity(world.companyId);
    assert.equal(p.inParity, true, `${p.unposted} entries with no journal behind them`);
  });
});

/* --- failing --------------------------------------------------------------- */

describe("failing", () => {
  test("a payment that never left is marked failed and touches no book", async () => {
    const made = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    await failPayment({ paymentId: made.paymentId, code: "R01", reason: "insufficient funds" });

    const row = await get("SELECT * FROM tenant_payment WHERE id = ?", made.paymentId);
    assert.equal(row.status, "failed");
    assert.equal((await all("SELECT id FROM ledger_entry")).length, 0);
  });

  test("a failure arriving after settlement is refused, because it is a return", async () => {
    /* Treating it as a failure would leave the money recorded as received
       while the bank has already taken it back. */
    const payment = await settled();
    const res = await failPayment({ paymentId: payment.id, code: "R01" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /return/i);

    const row = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(row.status, "succeeded", "the status was not quietly downgraded");
  });
});

/* --- returning ------------------------------------------------------------- */

describe("a returned payment", () => {
  test("the journal is reversed, not deleted", async () => {
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01", returnedAt: "2026-06-18 10:00:00" });

    const original = await get("SELECT * FROM journal WHERE id = ?", payment.journal_id);
    assert.ok(original, "the original is still there — it did happen");
    assert.ok(original.reversed_by, "and it knows it was reversed");

    const reversal = await get("SELECT * FROM journal WHERE id = ?", original.reversed_by);
    assert.equal(reversal.reverses_id, original.id, "the pair points both ways");
  });

  test("the reversal mirrors every split, sides swapped", async () => {
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    const original = await get("SELECT * FROM journal WHERE id = ?", payment.journal_id);
    const before = await all(
      "SELECT account_id, debit_cents, credit_cents FROM journal_split WHERE journal_id = ? ORDER BY account_id",
      original.id);
    const after = await all(
      "SELECT account_id, debit_cents, credit_cents FROM journal_split WHERE journal_id = ? ORDER BY account_id",
      original.reversed_by);

    assert.equal(before.length, after.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].account_id, before[i].account_id);
      assert.equal(Number(after[i].debit_cents), Number(before[i].credit_cents));
      assert.equal(Number(after[i].credit_cents), Number(before[i].debit_cents));
    }
  });

  test("trust cash nets back to where it started", async () => {
    /* The point of the whole exercise: after a return, the company's books do
       not show money it does not have. */
    const payment = await settled();
    const cashBefore = await trustCash();
    assert.equal(cashBefore, RENT - 500, "rent in, absorbed fee out");

    await returnPayment({ paymentId: payment.id, returnCode: "R01" });
    assert.equal(await trustCash(), -500,
      "the rent is gone; the fee the company already paid is not");
  });

  test("the owner sees a visible negative line, not a vanished one", async () => {
    /* An owner who saw rent last month and does not see it this month needs to
       know why, and a statement that silently changes is not a statement. */
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    const entries = await all(
      "SELECT * FROM ledger_entry WHERE lease_id = ? ORDER BY created_at", world.leaseId);
    assert.equal(entries.length, 2, "the original stands, and a correction follows it");
    assert.equal(Number(entries[0].amount_cents), RENT);
    assert.equal(Number(entries[1].amount_cents), -RENT);
    assert.match(entries[1].memo, /returned/i);
    assert.match(entries[1].memo, /R01/);

    const total = entries.reduce((n, e) => n + Number(e.amount_cents), 0);
    assert.equal(total, 0, "the owner is owed nothing for a payment that bounced");
  });

  test("the correcting entry carries the reversal journal, not a second one", async () => {
    /* Posting a fresh journal alongside the reversal would take the rent off
       the books twice. */
    const payment = await settled();
    const res = await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    const correction = await get(
      "SELECT * FROM ledger_entry WHERE lease_id = ? AND amount_cents < 0", world.leaseId);
    assert.equal(correction.journal_id, res.reversalJournalId);

    const rentJournals = await all(
      "SELECT id FROM journal WHERE source_id = ? AND memo NOT ILIKE '%fee%'", payment.id);
    assert.equal(rentJournals.length, 2, "the original and its reversal, and nothing else");
  });

  test("parity holds after a return", async () => {
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01" });
    const p = await parity(world.companyId);
    assert.equal(p.inParity, true, "the correcting entry has a journal behind it");
  });

  test("the delinquency reopens, because the rent was not in fact paid", async () => {
    const did = await delinquency("2026-06");
    const payment = await settled({ period: "2026-06" });
    assert.equal((await get("SELECT status FROM delinquency WHERE id = ?", did)).status, "resolved");

    await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    const d = await get("SELECT * FROM delinquency WHERE id = ?", did);
    assert.equal(d.status, "open");
    assert.equal(Number(d.amount_cents), RENT);
    assert.equal(d.resolved_at, null);
    assert.equal(Number(d.stage), 1, "the ladder resumes where it was, it does not restart");
  });

  test("a return delivered twice reverses once", async () => {
    const payment = await settled();
    const first = await returnPayment({ paymentId: payment.id, returnCode: "R01" });
    const second = await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    assert.equal(second.alreadyReturned, true);
    assert.equal(second.reversalJournalId, first.reversalJournalId);

    const entries = await all("SELECT id FROM ledger_entry WHERE lease_id = ?", world.leaseId);
    assert.equal(entries.length, 2, "not three");
  });

  test("a return on a payment that never settled is recorded as a failure", async () => {
    const made = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, stripe: fakeStripe(),
    });
    const res = await returnPayment({ paymentId: made.paymentId, returnCode: "R01" });
    assert.equal(res.treatedAsFailure, true);

    const row = await get("SELECT * FROM tenant_payment WHERE id = ?", made.paymentId);
    assert.equal(row.status, "failed");
    assert.equal((await all("SELECT id FROM journal")).length, 0, "nothing to reverse");
  });

  test("a bank charge for the return is the company's cost", async () => {
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01", feeCents: 1500 });

    const chargeJournal = await get(
      "SELECT * FROM journal WHERE source_id = ? AND memo ILIKE '%charge%'", payment.id);
    assert.ok(chargeJournal);
    const splits = await all(
      `SELECT a.code, s.debit_cents FROM journal_split s
         JOIN account a ON a.id = s.account_id WHERE s.journal_id = ?`, chargeJournal.id);
    const debited = splits.find((s) => Number(s.debit_cents) > 0);
    assert.equal(debited.code, "5300", "return charges, not passed to the tenant automatically");
  });
});

/* --- what a return code means --------------------------------------------- */

describe("reading the return code", () => {
  test("a closed account puts the lease on cash-only, with a reason", async () => {
    /* R02 will fail next month too. Letting autopay keep trying means the
       tenant discovers it when the eviction notice arrives. */
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R02" });

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 1);
    assert.match(lease.payments_blocked_reason, /R02/);
    assert.match(lease.payments_blocked_reason, /contact the office/i);
  });

  test("insufficient funds does not, because that is a bad week", async () => {
    /* R01 is the most common return there is and blocking on it would put
       half a rent roll on cash-only every January. */
    assert.equal(TERMINAL_RETURN_CODES.has("R01"), false);
    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R01" });

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 0);
  });

  test("an unauthorised claim stops the standing instruction", async () => {
    /* R10 means the tenant told their bank they did not agree to this.
       Charging them again is how a complaint becomes a regulator's letter. */
    const method = await paymentMethod();
    await insert("autopay", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      payment_method_id: method, days_before_due: 3, active: 1,
      enrolled_at: stamp(), created_at: stamp(),
    });

    const payment = await settled();
    await returnPayment({ paymentId: payment.id, returnCode: "R10" });

    const ap = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.equal(Number(ap.active), 0);
    assert.match(ap.last_error, /R10/);
  });
});

/* --- what the tenant is shown they owe ------------------------------------- */

describe("the balance a tenant is shown", () => {
  test("rent plus unwaived late fees", async () => {
    await insert("late_fee", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      unit_id: world.unitId, period: "2026-06", assessed_date: "2026-06-06",
      amount_cents: 7500, basis: "flat $75 after 5 days", rent_cents: RENT,
      days_late: 6, created_at: stamp(),
    });

    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.dueCents, RENT + 7500);
    assert.equal(b.outstandingCents, RENT + 7500);
  });

  test("a waived fee is not owed", async () => {
    await insert("late_fee", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      unit_id: world.unitId, period: "2026-06", assessed_date: "2026-06-06",
      amount_cents: 7500, basis: "flat $75", rent_cents: RENT, days_late: 6,
      waived_at: stamp(), waived_by: "staff", created_at: stamp(),
    });
    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.dueCents, RENT);
  });

  test("a payment already in flight is not asked for again", async () => {
    /* Otherwise a tenant who paid on Monday is shown the full amount on
       Tuesday and pays twice, and then the office spends a fortnight
       refunding it. */
    await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, period: "2026-06", stripe: fakeStripe(),
    });

    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.pendingCents, RENT);
    assert.equal(b.outstandingCents, 0, "nothing further is owed while it is in flight");
  });

  test("a failed payment is owed again", async () => {
    const made = await createPayment({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: RENT, period: "2026-06", stripe: fakeStripe(),
    });
    await failPayment({ paymentId: made.paymentId, code: "R01" });

    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.pendingCents, 0);
    assert.equal(b.outstandingCents, RENT);
  });

  test("a settled payment clears it", async () => {
    await settled({ period: "2026-06" });
    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.paidCents, RENT);
    assert.equal(b.outstandingCents, 0);
  });

  test("a returned payment puts it back", async () => {
    const payment = await settled({ period: "2026-06" });
    await returnPayment({ paymentId: payment.id, returnCode: "R01", returnedAt: "2026-06-18 10:00:00" });

    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.paidCents, 0, "the pair nets to nothing");
    assert.equal(b.outstandingCents, RENT);
  });

  test("the balance never goes negative on an overpayment", async () => {
    await settled({ period: "2026-06", amountCents: RENT + 10000 });
    const b = await balanceFor(world.leaseId, "2026-06");
    assert.equal(b.outstandingCents, 0, "a credit is not a negative amount due");
  });
});

/* --- the shared recompute -------------------------------------------------- */

describe("recomputing what is owed", () => {
  test("it is derived from the ledger, not adjusted in place", async () => {
    /* A stored balance that is decremented drifts. One recomputed from the
       entries cannot, which is why the manual screen and the automated paths
       call the same function. */
    const did = await delinquency("2026-06");
    await settled({ period: "2026-06", amountCents: 100000 });
    assert.equal(Number((await get("SELECT amount_cents FROM delinquency WHERE id = ?", did)).amount_cents),
      RENT - 100000);

    await settled({ period: "2026-06", amountCents: 45000 });
    const d = await get("SELECT * FROM delinquency WHERE id = ?", did);
    assert.equal(d.status, "resolved");
  });

  test("no delinquency for the period is not an error", async () => {
    const res = await recomputeDelinquency(world.leaseId, "2026-06");
    assert.equal(res, null);
  });
});

async function trustCash() {
  const row = await get(
    `SELECT COALESCE(SUM(s.debit_cents) - SUM(s.credit_cents), 0)::bigint AS c
       FROM journal_split s JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.code = '1010' AND j.company_id = ?`, world.companyId);
  return Number(row.c);
}
