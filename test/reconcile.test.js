/* Reconciling a batch to a single bank line.

   A tenant pays on the 3rd. Stripe settles it, holds it with eleven others,
   and deposits one lump on the 6th. The bank statement shows that one line.
   The original matcher looked for a single record of exactly that size and
   found nothing, so the largest and most frequent line on a property
   manager's statement was also the one that could never be ticked off.

   The same shape applies going out: a run of contractor payments is one ACH
   debit covering many invoices.

   The other half of this is `1020 Payments in transit`. Settled rent used to
   be posted straight into trust cash, which said it was in the company's bank
   on the day the tenant authorised it. It was not — it was at Stripe, for
   days. Without that split there is nothing to reconcile *against*: matching
   the deposit would post the rent a second time. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { proposeMatches, confirmMatch, createManualAccount } from "../server/features/banking.js";
import {
  settlePayment, recordStripePayout, payoutsAwaitingBank, createPayment,
} from "../server/lib/payments.js";
import { savePayeeAccount, draftOwnerRun, approveBatch } from "../server/lib/payouts.js";
import { postMoney } from "../server/lib/ledger.js";

const RENT = 145000;

let world, bankAccountId;

function fakeStripe({ contents = [], throws = null } = {}) {
  return {
    async createPaymentIntent() { return { id: `pi_${Math.random().toString(36).slice(2)}`, status: "processing" }; },
    async payoutContents() {
      if (throws) throw new Error(throws);
      return contents;
    },
  };
}

async function connect() {
  await run(
    `UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1,
            accept_ach = 1, ach_fee_model = 'absorb' WHERE id = ?`,
    "acct_test", world.companyId);
}

/* A settled tenant payment, with the charge id Stripe would give it. */
async function settledPayment({ chargeId, amountCents = RENT, leaseId = null }) {
  const made = await createPayment({
    companyId: world.companyId, leaseId: leaseId || world.leaseId,
    amountCents, kind: "ach", period: "2026-06", stripe: fakeStripe(),
  });
  assert.equal(made.ok, true, made.reason);
  await settlePayment({ paymentId: made.paymentId, settledAt: "2026-06-03 09:00:00", chargeId });
  return await get("SELECT * FROM tenant_payment WHERE id = ?", made.paymentId);
}

async function bankLine({ amountCents, name, date = "2026-06-06" }) {
  const txnId = id();
  await insert("bank_txn", {
    id: txnId, company_id: world.companyId, bank_account_id: bankAccountId,
    external_id: `tx_${txnId.slice(-8)}`, posted_date: date,
    amount_cents: amountCents, name_raw: name, state: "unmatched",
    created_at: stamp(),
  });
  return await get("SELECT * FROM bank_txn WHERE id = ?", txnId);
}

const balanceOf = async (code) => {
  const row = await get(
    `SELECT COALESCE(SUM(s.debit_cents) - SUM(s.credit_cents), 0)::bigint AS c
       FROM journal_split s JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.code = ? AND j.company_id = ?`, code, world.companyId);
  return Number(row.c);
};

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Reconcile Co" });
  await run("UPDATE lease SET rent_cents = ? WHERE id = ?", RENT, world.leaseId);
  await connect();

  /* Through the real path, so the account has the item row it needs. */
  bankAccountId = await createManualAccount({
    companyId: world.companyId, name: "Operating", mask: "6789",
    isTrust: true, createdBy: "test",
  });
});

/* --- where settled money sits ----------------------------------------------- */

describe("money the processor is holding", () => {
  test("settled rent is in transit, not in the bank", async () => {
    await settledPayment({ chargeId: "ch_1" });
    assert.equal(await balanceOf("1020"), RENT - 500, "held by the processor");
    assert.equal(await balanceOf("1010"), 0, "nothing has reached the bank");
  });

  test("the in-transit balance is what a manager can check against Stripe", async () => {
    /* The reason the account earns its place: it answers "how much is on its
       way to me", which is otherwise a question only the Stripe dashboard
       can answer. */
    await settledPayment({ chargeId: "ch_1" });
    await settledPayment({ chargeId: "ch_2", amountCents: 90000 });
    assert.equal(await balanceOf("1020"), (RENT - 500) + (90000 - 500));
  });
});

/* --- recording a payout ------------------------------------------------------ */

describe("a payout from Stripe", () => {
  test("it is recorded with what is inside it", async () => {
    const a = await settledPayment({ chargeId: "ch_1" });
    const b = await settledPayment({ chargeId: "ch_2", amountCents: 90000 });

    await recordStripePayout({
      companyId: world.companyId,
      payout: {
        id: "po_test_1", amount: 234000, currency: "usd", status: "paid",
        arrival_date: Math.floor(new Date("2026-06-06T00:00:00Z").getTime() / 1000),
        destination: { bank_name: "Chase", last4: "6789" },
      },
      stripe: fakeStripe({
        contents: [
          { type: "charge", source: "ch_1", fee: 500 },
          { type: "charge", source: "ch_2", fee: 500 },
          { type: "payout", source: "po_test_1", fee: 0 },
        ],
      }),
    });

    const payout = await get("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_test_1'");
    assert.equal(payout.status, "paid");
    assert.equal(payout.arrival_date, "2026-06-06");
    assert.equal(Number(payout.payment_count), 2);
    assert.equal(Number(payout.fee_cents), 1000);
    assert.match(payout.destination, /Chase.*6789/);

    for (const p of [a, b]) {
      const after = await get("SELECT * FROM tenant_payment WHERE id = ?", p.id);
      assert.equal(after.stripe_payout_id, payout.id, "each payment knows its payout");
    }
  });

  test("it matches a payment by its intent when there is no charge id", async () => {
    const payment = await settledPayment({ chargeId: null });
    await recordStripePayout({
      companyId: world.companyId,
      payout: { id: "po_test_2", amount: RENT - 500, status: "paid" },
      stripe: fakeStripe({
        contents: [{ type: "charge", source: { id: "ch_x", payment_intent: payment.stripe_payment_intent_id }, fee: 500 }],
      }),
    });
    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.ok(after.stripe_payout_id);
  });

  test("failing to read the contents still records the payout", async () => {
    /* A payout we cannot itemise is still worth having: the bank line can be
       matched either way, and a reconciliation that needs an API call to
       succeed is a reconciliation that stops during an outage. */
    await settledPayment({ chargeId: "ch_1" });
    const res = await recordStripePayout({
      companyId: world.companyId,
      payout: { id: "po_test_3", amount: 144500, status: "paid" },
      stripe: fakeStripe({ throws: "Stripe is unavailable" }),
    });

    assert.equal(res.ok, true);
    const payout = await get("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_test_3'");
    assert.equal(payout.payment_count, null, "we have the payout but not its contents");
  });

  test("the same payout arriving twice updates rather than duplicates", async () => {
    const base = { id: "po_test_4", amount: 144500, status: "in_transit" };
    await recordStripePayout({ companyId: world.companyId, payout: base, stripe: fakeStripe() });
    await recordStripePayout({
      companyId: world.companyId, payout: { ...base, status: "paid" }, stripe: fakeStripe(),
    });

    const rows = await all("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_test_4'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "paid");
  });

  test("a failed payout keeps its reason", async () => {
    await recordStripePayout({
      companyId: world.companyId,
      payout: {
        id: "po_test_5", amount: 144500, status: "failed",
        failure_message: "The bank account has been closed.",
      },
      stripe: fakeStripe(),
    });
    const payout = await get("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_test_5'");
    assert.equal(payout.status, "failed");
    assert.match(payout.failure_message, /closed/);
  });

  test("only paid payouts are offered to the bank line", async () => {
    for (const [ref, status] of [["po_a", "paid"], ["po_b", "in_transit"], ["po_c", "failed"]]) {
      await recordStripePayout({
        companyId: world.companyId,
        payout: { id: ref, amount: 100000, status }, stripe: fakeStripe(),
      });
    }
    const waiting = await payoutsAwaitingBank(world.companyId);
    assert.deepEqual(waiting.map((p) => p.stripe_payout_id), ["po_a"]);
  });
});

/* --- matching the deposit ----------------------------------------------------- */

describe("matching a Stripe deposit", () => {
  async function payoutOf(amountCents, charges) {
    await recordStripePayout({
      companyId: world.companyId,
      payout: {
        id: "po_match_1", amount: amountCents, status: "paid",
        arrival_date: Math.floor(new Date("2026-06-06T00:00:00Z").getTime() / 1000),
        destination: { bank_name: "Chase", last4: "6789" },
      },
      stripe: fakeStripe({ contents: charges.map((c) => ({ type: "charge", source: c, fee: 500 })) }),
    });
    return await get("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_match_1'");
  }

  test("one deposit is proposed for a dozen rents", async () => {
    await settledPayment({ chargeId: "ch_1" });
    await settledPayment({ chargeId: "ch_2", amountCents: 90000 });
    const payout = await payoutOf(234000, ["ch_1", "ch_2"]);

    const txn = await bankLine({ amountCents: 234000, name: "STRIPE TRANSFER ST-X1Y2Z3" });
    const proposals = await proposeMatches(world.companyId, txn);

    const top = proposals[0];
    assert.equal(top.targetType, "stripe_payout");
    assert.equal(top.targetId, payout.id);
    assert.match(top.label, /2 payments/);
  });

  test("Stripe's clearing string outscores a coincidence of the same size", async () => {
    /* A ledger entry that happens to be the same amount is a coincidence, not
       a reconciliation. The deposit should win. */
    await settledPayment({ chargeId: "ch_1" });
    const payout = await payoutOf(144500, ["ch_1"]);
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: "2026-06-06", kind: "rent_payment", amountCents: 144500,
      memo: "Coincidence", source: "manual", postedBy: "test",
    });

    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER ST-X1Y2Z3" });
    const proposals = await proposeMatches(world.companyId, txn);
    assert.equal(proposals[0].targetType, "stripe_payout");
    assert.equal(proposals[0].targetId, payout.id);
  });

  test("confirming moves the money out of transit and into the bank", async () => {
    await settledPayment({ chargeId: "ch_1" });
    const payout = await payoutOf(144500, ["ch_1"]);
    assert.equal(await balanceOf("1020"), 144500);
    assert.equal(await balanceOf("1010"), 0);

    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });
    await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "stripe_payout", targetId: payout.id, by: "staff-1",
    });

    assert.equal(await balanceOf("1020"), 0, "the processor is holding nothing now");
    assert.equal(await balanceOf("1010"), 144500, "and it is in the bank");
  });

  test("the rent is not counted twice", async () => {
    /* The bug this whole split exists to prevent: without 1020, matching the
       deposit would post rent into trust cash on top of the settlement. */
    await settledPayment({ chargeId: "ch_1" });
    const payout = await payoutOf(144500, ["ch_1"]);
    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });
    await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "stripe_payout", targetId: payout.id, by: "staff-1",
    });

    const income = await balanceOf("4000");
    assert.equal(income, 0, "no rent income was recognised by the deposit landing");
    assert.equal(await balanceOf("1010"), 144500, "one lot of cash, not two");
  });

  test("a matched payout is not offered again", async () => {
    await settledPayment({ chargeId: "ch_1" });
    const payout = await payoutOf(144500, ["ch_1"]);
    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });
    await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "stripe_payout", targetId: payout.id, by: "staff-1",
    });

    const second = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER", date: "2026-06-13" });
    const proposals = await proposeMatches(world.companyId, second);
    assert.ok(!proposals.some((p) => p.targetId === payout.id));
  });

  test("the match is recorded against the bank line", async () => {
    await settledPayment({ chargeId: "ch_1" });
    const payout = await payoutOf(144500, ["ch_1"]);
    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });
    await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "stripe_payout", targetId: payout.id, by: "staff-1",
    });

    const match = await get("SELECT * FROM bank_match WHERE bank_txn_id = ?", txn.id);
    assert.equal(match.target_type, "stripe_payout");
    assert.ok(match.journal_id);
    const after = await get("SELECT * FROM bank_txn WHERE id = ?", txn.id);
    assert.equal(after.state, "matched");
  });
});

/* --- matching money going out ------------------------------------------------- */

describe("matching a payout run", () => {
  async function approvedRun() {
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: "2026-06-01", kind: "rent_payment", amountCents: 400000,
      memo: "Rent", source: "manual", postedBy: "test",
    });
    await savePayeeAccount({
      companyId: world.companyId, ownerId: world.ownerId, method: "check",
    });
    const draft = await draftOwnerRun({
      companyId: world.companyId, effectiveDate: "2026-06-05", method: "check",
    });
    await approveBatch({ batchId: draft.batchId, companyId: world.companyId, by: "staff-1" });
    return await get("SELECT * FROM payout_batch WHERE id = ?", draft.batchId);
  }

  test("one debit is proposed for a whole run", async () => {
    const batch = await approvedRun();
    const txn = await bankLine({
      amountCents: -400000, name: "ACH DEBIT PAYROLL FILE", date: "2026-06-05",
    });

    const proposals = await proposeMatches(world.companyId, txn);
    const top = proposals.find((p) => p.targetType === "payout_batch");
    assert.ok(top, "the run was offered");
    assert.equal(top.targetId, batch.id);
    assert.match(top.label, /Owner distribution/);
  });

  test("confirming posts nothing, because approval already did", async () => {
    /* The journals for the payments were posted when the run was approved,
       which already credited cash. Posting again here would take the money
       out twice. */
    const batch = await approvedRun();
    const cashBefore = await balanceOf("1010");

    const txn = await bankLine({ amountCents: -400000, name: "ACH DEBIT", date: "2026-06-05" });
    const journalId = await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "payout_batch", targetId: batch.id, by: "staff-1",
    });

    assert.equal(journalId, null, "no journal from the match itself");
    assert.equal(await balanceOf("1010"), cashBefore, "cash is unchanged");

    const match = await get("SELECT * FROM bank_match WHERE bank_txn_id = ?", txn.id);
    assert.equal(match.target_type, "payout_batch");
    assert.equal(match.journal_id, null);
  });

  test("a draft run is not offered, because no money has left", async () => {
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: "2026-06-01", kind: "rent_payment", amountCents: 400000,
      memo: "Rent", source: "manual", postedBy: "test",
    });
    await savePayeeAccount({ companyId: world.companyId, ownerId: world.ownerId, method: "check" });
    await draftOwnerRun({
      companyId: world.companyId, effectiveDate: "2026-06-05", method: "check",
    });

    const txn = await bankLine({ amountCents: -400000, name: "ACH DEBIT", date: "2026-06-05" });
    const proposals = await proposeMatches(world.companyId, txn);
    assert.ok(!proposals.some((p) => p.targetType === "payout_batch"));
  });

  test("a run already matched is not offered again", async () => {
    const batch = await approvedRun();
    const txn = await bankLine({ amountCents: -400000, name: "ACH DEBIT", date: "2026-06-05" });
    await confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "payout_batch", targetId: batch.id, by: "staff-1",
    });

    const second = await bankLine({ amountCents: -400000, name: "ACH DEBIT", date: "2026-07-05" });
    const proposals = await proposeMatches(world.companyId, second);
    assert.ok(!proposals.some((p) => p.targetId === batch.id));
  });
});

/* --- tenancy ------------------------------------------------------------------ */

describe("one company cannot reconcile another's", () => {
  test("a payout from another company is not proposed", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE company SET stripe_account_id = ? WHERE id = ?", "acct_other", other.companyId);
    await recordStripePayout({
      companyId: other.companyId,
      payout: { id: "po_other", amount: 144500, status: "paid" },
      stripe: fakeStripe(),
    });

    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });
    const proposals = await proposeMatches(world.companyId, txn);
    assert.ok(!proposals.some((p) => p.targetType === "stripe_payout"));
  });

  test("and cannot be confirmed across the boundary", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE company SET stripe_account_id = ? WHERE id = ?", "acct_other", other.companyId);
    await recordStripePayout({
      companyId: other.companyId,
      payout: { id: "po_other", amount: 144500, status: "paid" },
      stripe: fakeStripe(),
    });
    const payout = await get("SELECT * FROM stripe_payout WHERE stripe_payout_id = 'po_other'");
    const txn = await bankLine({ amountCents: 144500, name: "STRIPE TRANSFER" });

    await assert.rejects(() => confirmMatch({
      companyId: world.companyId, txnId: txn.id,
      targetType: "stripe_payout", targetId: payout.id, by: "staff-1",
    }), /Not found/);
  });
});
