/* The life of a tenant payment.

   Four transitions, and the last one is the difficult one.

   **Created.** A quote is taken and frozen on the row, an intent is created on
   the company's own Stripe account, and nothing has moved.

   **Settled.** The money has arrived in the company's bank. Only now is it
   recorded in either book — an authorised payment is not income, and counting
   it as one would show an owner money that may yet bounce.

   **Failed.** It never left the tenant's account. Nothing to unwind.

   **Returned.** It settled, everybody was told, and two weeks later the bank
   pulled it back. The tenant has a receipt, the owner's statement showed it,
   the delinquency closed. Unwinding that is the whole problem: the journal is
   append-only, so the correction is a reversing entry rather than a deletion,
   and the original stays visible because it did happen — it was the
   settlement that failed, not the record of it.

   `stripe` is injected so every one of these can be driven without a network
   and without credentials. The default is the real boundary. */
import { all, get, one, insert, update, run, tx } from "./db.js";
import { id } from "./ids.js";
import { stamp, today, monthKey, addDays, dueDateFor } from "./dates.js";
import { log } from "./logger.js";
import { quote, methodAvailable } from "./fees.js";
import { usd } from "./money.js";
import { postMoney } from "./ledger.js";
import * as defaultStripe from "./connect.js";

/* Return codes that mean stop trying. A closed or frozen account will not
   accept the next attempt either, and a company will usually want the lease on
   cash-only after one. Insufficient funds is deliberately absent — that is a
   bad week, not a bad account. */
export const TERMINAL_RETURN_CODES = new Set([
  "R02",  // account closed
  "R03",  // no account / unable to locate
  "R04",  // invalid account number
  "R07",  // authorisation revoked by customer
  "R08",  // payment stopped
  "R10",  // customer advises unauthorised
  "R16",  // account frozen
  "R20",  // non-transaction account
  "R29",  // corporate customer advises not authorised
]);

export function blockedReason(lease) {
  if (!lease) return "That lease could not be found.";
  if (lease.payments_blocked) {
    return lease.payments_blocked_reason
      || "Online payment is turned off for this home. Please contact the office.";
  }
  if (lease.status !== "active") return "This tenancy is not active.";
  return null;
}

/* How much rent has actually been paid for a period.

   Two sources, deliberately answered differently.

   **Online payments** are counted by their own status for the period, not by
   the date their ledger entry carries. Dates were the original rule — every
   `rent_payment` entry within 45 days of the 1st — and it fails on exactly
   the case that matters most: an ACH return can arrive sixty days after the
   debit, so the correcting entry falls outside the window while the original
   stays inside it. The month then reads as paid on money the bank took back,
   the delinquency stays closed, and nobody is told.

   **Manually recorded payments** keep the dated rule, because there is no
   payment row behind them — somebody typed in a cheque. Their entries are
   the ones not claimed by any payment row, which is what the two NOT IN
   clauses exclude.

   The owner's statement still shows both halves of a return. This is about
   what is owed, not about what is visible. */
export async function paidForPeriod(leaseId, period) {
  const since = `${period}-01`;

  const manual = await get(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS c
       FROM ledger_entry e
      WHERE e.lease_id = ? AND e.kind = 'rent_payment'
        AND e.date >= ? AND e.date <= ?
        AND NOT EXISTS (
          SELECT 1 FROM tenant_payment p
           WHERE p.ledger_entry_id = e.id OR p.reversal_ledger_entry_id = e.id)`,
    leaseId, since, addDays(since, 45));

  const online = await get(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS c FROM tenant_payment
      WHERE lease_id = ? AND period = ? AND status = 'succeeded'`,
    leaseId, period);

  return Number(manual.c) + Number(online.c);
}

/* What the tenant owes for a period, from the ledger rather than from a
   running total. A stored balance drifts; a recomputed one cannot. */
export async function balanceFor(leaseId, period = monthKey(today())) {
  const lease = await one("SELECT * FROM lease WHERE id = ?", leaseId);
  const settledCents = await paidForPeriod(leaseId, period);

  const fees = await get(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS c FROM late_fee
      WHERE lease_id = ? AND period = ? AND waived_at IS NULL`, leaseId, period);

  /* Payments already in flight count against what is owed, or a tenant who
     paid on Monday is shown the full amount again on Tuesday and pays twice. */
  const inFlight = await get(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS c FROM tenant_payment
      WHERE lease_id = ? AND period = ? AND status IN ('pending', 'processing')`,
    leaseId, period);

  const due = Number(lease.rent_cents) + Number(fees.c);
  const settled = settledCents;
  const pending = Number(inFlight.c);

  return {
    period,
    rentCents: Number(lease.rent_cents),
    feeCents: Number(fees.c),
    dueCents: due,
    paidCents: settled,
    pendingCents: pending,
    outstandingCents: Math.max(0, due - settled - pending),
  };
}

/* --- creating -------------------------------------------------------------- */

/* Everything both payment paths need before either talks to Stripe: the
   refusals, the quote, and the row. Shared so that a rule enforced on the
   tenant's page — a blocked lease, a method the company does not offer —
   cannot be missing from the autopay run, which is the path with nobody
   watching it. */
async function openPaymentRow({
  companyId, leaseId, amountCents, kind, paymentMethodId, initiatedBy, period,
}) {
  const company = await one("SELECT * FROM company WHERE id = ?", companyId);
  const lease = await one(
    `SELECT l.*, u.id AS unit, p.owner_id FROM lease l
       JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
      WHERE l.id = ? AND l.company_id = ?`, leaseId, companyId);

  const blocked = blockedReason(lease);
  if (blocked) return { ok: false, reason: blocked };

  if (!methodAvailable(company, kind)) {
    return { ok: false, reason: "That payment method is not available." };
  }

  const amount = Math.round(Number(amountCents) || 0);
  if (amount <= 0) return { ok: false, reason: "Enter an amount." };

  const q = quote({ company, method: kind, amountCents: amount });
  const paymentId = id();
  const forPeriod = period || monthKey(today());

  await insert("tenant_payment", {
    id: paymentId, company_id: companyId, lease_id: lease.id,
    unit_id: lease.unit_id, owner_id: lease.owner_id,
    payment_method_id: paymentMethodId,
    kind, amount_cents: q.amountCents, fee_cents: q.feeCents,
    tenant_fee_cents: q.tenantFeeCents, charged_cents: q.tenantPaysCents,
    period: forPeriod, status: "pending",
    initiated_by: initiatedBy, created_at: stamp(),
  });

  return { ok: true, paymentId, quote: q, company, lease, period: forPeriod };
}

/* --- the tenant, with a browser in front of them --------------------------

   Sent to Stripe's own hosted page. Their bank details never reach this
   server, and the whole flow is two form posts and a redirect, so it works
   with JavaScript switched off. */
export async function startCheckout({
  companyId, leaseId, amountCents, kind = "ach", period = null,
  successUrl, cancelUrl, saveForFuture = false, stripe = defaultStripe,
}) {
  const opened = await openPaymentRow({
    companyId, leaseId, amountCents, kind, paymentMethodId: null,
    initiatedBy: "tenant", period,
  });
  if (!opened.ok) return opened;

  const { paymentId, quote: q, company, lease } = opened;

  try {
    const session = await stripe.createCheckoutSession({
      accountId: company.stripe_account_id,
      amountCents: q.tenantPaysCents,
      methods: kind === "ach" ? ["us_bank_account"] : ["card"],
      description: `Rent ${opened.period}`,
      successUrl, cancelUrl, saveForFuture,
      metadata: {
        company_id: companyId, lease_id: lease.id,
        payment_id: paymentId, period: opened.period,
      },
      idempotencyKey: `co:${paymentId}`,
    });

    await update("tenant_payment", paymentId, {
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === "string"
        ? session.payment_intent : session.payment_intent?.id || null,
      submitted_at: stamp(),
    });

    return { ok: true, paymentId, quote: q, url: session.url, session };
  } catch (err) {
    await update("tenant_payment", paymentId, {
      status: "failed", failed_at: stamp(),
      failure_code: err.stripeCode || null,
      failure_reason: String(err.message || "").slice(0, 300),
    });
    log.warn("checkout could not be started", { paymentId, reason: err.message });
    return { ok: false, reason: err.message, paymentId };
  }
}

export async function createPayment({
  companyId, leaseId, amountCents, kind = "ach",
  paymentMethodId = null, initiatedBy = "tenant", period = null,
  stripe = defaultStripe,
}) {
  const opened = await openPaymentRow({
    companyId, leaseId, amountCents, kind, paymentMethodId, initiatedBy, period,
  });
  if (!opened.ok) return opened;

  const { paymentId, quote: q, company, lease } = opened;
  const forPeriod = opened.period;

  try {
    const intent = await stripe.createPaymentIntent({
      accountId: company.stripe_account_id,
      amountCents: q.tenantPaysCents,
      description: `Rent ${forPeriod}`,
      paymentMethodId,
      confirm: Boolean(paymentMethodId),
      offSession: initiatedBy === "autopay",
      metadata: {
        company_id: companyId, lease_id: lease.id, payment_id: paymentId, period: forPeriod,
      },
      /* Keyed on the payment row, so a retried request cannot become a second
         charge on somebody's bank account. */
      idempotencyKey: `tp:${paymentId}`,
    });

    /* "processing" here means the money is in flight, not that it arrived.
       An ACH debit sits in that state for days and a card that settles
       instantly still does not become income until the webhook confirms it —
       `settlePayment` is the only thing that writes to either book. */
    const inFlight = intent.status === "succeeded" || intent.status === "processing";
    await update("tenant_payment", paymentId, {
      stripe_payment_intent_id: intent.id,
      status: inFlight ? "processing" : "pending",
      submitted_at: stamp(),
    });

    return { ok: true, paymentId, quote: q, intent };
  } catch (err) {
    await update("tenant_payment", paymentId, {
      status: "failed", failed_at: stamp(),
      failure_code: err.stripeCode || err.declineCode || null,
      failure_reason: String(err.message || "").slice(0, 300),
    });
    log.warn("payment could not be created", { paymentId, reason: err.message });
    return { ok: false, reason: err.message, paymentId };
  }
}

/* --- settling -------------------------------------------------------------- */

/* The money has arrived. Only now does either book learn about it.

   Idempotent: a webhook delivered twice must not post rent twice, and Stripe
   delivers at least once. */
export async function settlePayment({ paymentId, settledAt = null, chargeId = null }) {
  const payment = await one("SELECT * FROM tenant_payment WHERE id = ?", paymentId);
  if (payment.status === "succeeded") {
    return { ok: true, alreadySettled: true, journalId: payment.journal_id };
  }
  if (payment.status === "returned" || payment.status === "refunded") {
    return { ok: false, reason: `that payment was already ${payment.status}` };
  }

  const when = (settledAt || stamp()).slice(0, 10);

  return await tx(async () => {
    const { entryId, journalId } = await postMoney({
      companyId: payment.company_id, ownerId: payment.owner_id,
      unitId: payment.unit_id, leaseId: payment.lease_id,
      date: when, kind: "rent_payment", amountCents: Number(payment.amount_cents),
      memo: `Rent ${payment.period || ""} — ${payment.kind.toUpperCase()}`.trim(),
      source: "system", sourceType: "tenant_payment", sourceId: payment.id,
      postedBy: payment.initiated_by,
    });

    /* A fee the tenant paid is the company's income and the processor's fee is
       the company's cost. Posted separately rather than netted, because
       netting hides both and an accountant needs each. */
    if (Number(payment.tenant_fee_cents) > 0 || Number(payment.fee_cents) > 0) {
      await postFeeJournal(payment, when);
    }

    await update("tenant_payment", payment.id, {
      status: "succeeded", settled_at: settledAt || stamp(),
      stripe_charge_id: chargeId, ledger_entry_id: entryId, journal_id: journalId,
    });

    await recomputeDelinquency(payment.lease_id, payment.period);
    return { ok: true, entryId, journalId };
  });
}

async function postFeeJournal(payment, when) {
  const { postJournal, ACCT } = await import("../features/accounting.js");
  const tenantShare = Number(payment.tenant_fee_cents);
  const total = Number(payment.fee_cents);
  if (total <= 0) return null;

  const splits = [
    { code: ACCT.PROCESSING_FEES, debit: total, memo: "processor fee" },
    ...(tenantShare > 0
      ? [{ code: ACCT.FEE_RECOVERED, credit: tenantShare, memo: "fee recovered from tenant" }]
      : []),
    ...(total - tenantShare > 0
      ? [{ code: ACCT.TRUST_CASH, credit: total - tenantShare, memo: "fee borne by the company" }]
      : []),
  ];

  return await postJournal({
    companyId: payment.company_id, date: when,
    memo: `Processing fee — ${payment.kind.toUpperCase()} ${payment.period || ""}`.trim(),
    source: "rent", sourceType: "tenant_payment", sourceId: payment.id,
    postedBy: "system", splits,
  });
}

/* --- failing --------------------------------------------------------------- */

export async function failPayment({ paymentId, code = null, reason = null }) {
  const payment = await one("SELECT * FROM tenant_payment WHERE id = ?", paymentId);
  if (payment.status === "succeeded") {
    /* A failure arriving after a settlement is a return, not a failure, and
       calling it one would leave the money recorded as received. */
    return { ok: false, reason: "that payment already settled; a later reversal is a return" };
  }
  if (payment.status === "failed") return { ok: true, alreadyFailed: true };

  await update("tenant_payment", payment.id, {
    status: "failed", failed_at: stamp(),
    failure_code: code, failure_reason: String(reason || "").slice(0, 300),
  });
  return { ok: true };
}

/* --- returning ------------------------------------------------------------- */

/* It settled, everybody was told, and the bank pulled it back.

   Three things unwind, and all of them have to, or the tenant is credited with
   money the company does not have:

     the journal      by a reversing entry, because the ledger is append-only
     the owner ledger by a negative entry, so the statement corrects itself
     the delinquency  reopened, because the rent was not in fact paid

   Idempotent on the payment's status: a webhook replayed a week later must not
   reverse twice. */
export async function returnPayment({
  paymentId, returnCode = null, reason = null, returnedAt = null, feeCents = 0,
}) {
  const payment = await one("SELECT * FROM tenant_payment WHERE id = ?", paymentId);

  if (payment.status === "returned") {
    return { ok: true, alreadyReturned: true, reversalJournalId: payment.reversal_journal_id };
  }
  if (payment.status !== "succeeded") {
    /* Never settled, so there is nothing to claw back — record it as a
       failure instead. */
    await failPayment({ paymentId, code: returnCode, reason });
    return { ok: true, treatedAsFailure: true };
  }

  /* A settled payment always has a journal behind it — `settlePayment` posts
     one inside the same transaction that marks it settled. If one is missing,
     something has gone wrong upstream, and inventing a correcting entry on top
     of books that are already inconsistent would bury the problem rather than
     surface it. */
  if (!payment.journal_id) {
    throw new Error(
      `Payment ${payment.id} is marked settled but has no journal behind it; `
      + `refusing to reverse books that are already inconsistent.`);
  }

  const when = (returnedAt || stamp()).slice(0, 10);
  const { reverseJournal } = await import("../features/accounting.js");

  return await tx(async () => {
    const reversalId = await reverseJournal(payment.journal_id, {
      companyId: payment.company_id, by: "return",
      memo: `Returned ${returnCode || ""} — rent ${payment.period || ""}`.trim(),
      date: when,
    });

    /* The owner's statement corrects itself with a visible negative line
       rather than the original quietly disappearing. An owner who saw rent
       last month and does not see it this month needs to know why.

       The reversal posted above *is* this entry's double-entry record, so it
       is handed in rather than a second journal being posted — two journals
       for one reversal would take the rent off the books twice. */
    const { entryId: reversalEntryId } = await postMoney({
      companyId: payment.company_id, ownerId: payment.owner_id,
      unitId: payment.unit_id, leaseId: payment.lease_id,
      date: when, kind: "rent_payment", amountCents: -Math.abs(Number(payment.amount_cents)),
      memo: `Payment returned${returnCode ? ` (${returnCode})` : ""} — rent ${payment.period || ""}`.trim(),
      source: "system", sourceType: "tenant_payment", sourceId: payment.id,
      postedBy: "return", journalId: reversalId,
    });

    /* A bank charge for the return is the company's cost, not the tenant's,
       until somebody decides to pass it on deliberately. */
    if (Number(feeCents) > 0) {
      const { postJournal, ACCT } = await import("../features/accounting.js");
      await postJournal({
        companyId: payment.company_id, date: when,
        memo: `Returned payment charge — ${payment.period || ""}`.trim(),
        source: "rent", sourceType: "tenant_payment", sourceId: payment.id,
        postedBy: "system",
        splits: [
          { code: ACCT.RETURN_CHARGES, debit: Number(feeCents), memo: "bank charge" },
          { code: ACCT.TRUST_CASH, credit: Number(feeCents), memo: "charged to the account" },
        ],
      });
    }

    await update("tenant_payment", payment.id, {
      status: "returned", returned_at: returnedAt || stamp(),
      return_code: returnCode, failure_reason: String(reason || "").slice(0, 300),
      reversal_journal_id: reversalId, reversal_ledger_entry_id: reversalEntryId,
    });

    /* A returned payment means the rent is owed again. */
    await recomputeDelinquency(payment.lease_id, payment.period);

    /* An account that is closed or revoked will not work next month either.
       The lease goes cash-only with a reason a person can read, rather than
       the tenant discovering it when autopay fails silently. */
    if (returnCode && TERMINAL_RETURN_CODES.has(returnCode)) {
      await run(
        `UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ?,
                payments_blocked_at = ? WHERE id = ?`,
        `A payment was returned (${returnCode}). Please contact the office to arrange payment.`,
        stamp(), payment.lease_id);
      await run("UPDATE autopay SET active = 0, last_error = ? WHERE lease_id = ?",
        `returned ${returnCode}`, payment.lease_id);
    }

    log.warn("payment returned", {
      paymentId: payment.id, returnCode, amount: payment.amount_cents,
    });

    return { ok: true, reversalJournalId: reversalId };
  });
}

/* --- delinquency ----------------------------------------------------------- */

/* Recomputed from the ledger rather than adjusted, so a correction or a
   return cannot leave a stale balance behind. Shared by the manual rent
   screen and by every automated path, because two implementations of "how much
   is owed" eventually disagree. */
export async function recomputeDelinquency(leaseId, period) {
  if (!period) return null;
  const lease = await get("SELECT * FROM lease WHERE id = ?", leaseId);
  if (!lease) return null;

  const row = await get("SELECT * FROM delinquency WHERE lease_id = ? AND period = ?", leaseId, period);
  if (!row) return null;

  const owed = Number(lease.rent_cents) - await paidForPeriod(leaseId, period);

  if (owed <= 0) {
    if (row.status !== "resolved") {
      await update("delinquency", row.id, {
        status: "resolved", resolved_at: stamp(), amount_cents: 0,
      });
    }
    return { resolved: true };
  }

  await update("delinquency", row.id, {
    amount_cents: owed,
    /* Reopened if a return took it back below paid. The ladder picks up from
       whatever stage it had reached rather than starting again. */
    status: row.status === "resolved" ? "open" : row.status,
    resolved_at: null,
  });
  return { resolved: false, owedCents: owed };
}

/* --- autopay --------------------------------------------------------------

   A standing instruction to take money out of somebody's bank account without
   asking again. Three things follow from that, and none of them is optional.

   **It is bounded.** The tenant sets a ceiling. Rent rises, and an instruction
   to take whatever is owed does not expire on its own — somebody who agreed to
   $1,450 should not silently be charged $1,800 after a renewal. Over the
   ceiling, the run stops and says so rather than charging the old amount,
   which would leave them short and late at the same time.

   **It is early.** The charge goes out `days_before_due` days ahead, because an
   ACH debit takes two to five days to settle and rent that settles on the 4th
   was paid late.

   **It explains itself.** A run that decided not to charge records why. "On"
   is not the same as "worked", and the difference is what a tenant finds out
   the hard way otherwise. */

export async function enrolAutopay({
  companyId, leaseId, paymentMethodId, daysBeforeDue = 3,
  maxAmountCents = null, ip = null,
}) {
  const lease = await one("SELECT * FROM lease WHERE id = ? AND company_id = ?", leaseId, companyId);
  const blocked = blockedReason(lease);
  if (blocked) return { ok: false, reason: blocked };

  const method = await get(
    "SELECT * FROM tenant_payment_method WHERE id = ? AND lease_id = ? AND status = 'active'",
    paymentMethodId, leaseId);
  if (!method) {
    return { ok: false, reason: "We need a saved bank account before autopay can be switched on." };
  }
  if (!method.mandate_accepted_at) {
    /* Charging off-session against a method with no recorded consent is the
       thing an R10 dispute is decided on. */
    return { ok: false, reason: "That payment method has no recorded authorisation." };
  }

  const days = Math.min(28, Math.max(0, Math.round(Number(daysBeforeDue) || 0)));
  const ceiling = maxAmountCents == null ? null : Math.max(0, Math.round(Number(maxAmountCents)));

  const existing = await get("SELECT * FROM autopay WHERE lease_id = ?", leaseId);
  if (existing) {
    await update("autopay", existing.id, {
      payment_method_id: paymentMethodId, days_before_due: days,
      max_amount_cents: ceiling, active: 1, cancelled_at: null,
      last_error: null, last_skip_reason: null,
    });
    return { ok: true, autopayId: existing.id, updated: true };
  }

  const autopayId = id();
  await insert("autopay", {
    id: autopayId, company_id: companyId, lease_id: leaseId,
    payment_method_id: paymentMethodId, days_before_due: days,
    max_amount_cents: ceiling, active: 1,
    enrolled_at: stamp(), created_at: stamp(),
  });
  log.info("autopay enrolled", { leaseId, days, ceiling, ip });
  return { ok: true, autopayId };
}

export async function cancelAutopay(leaseId) {
  const row = await get("SELECT * FROM autopay WHERE lease_id = ?", leaseId);
  if (!row) return { ok: true, alreadyOff: true };
  await update("autopay", row.id, { active: 0, cancelled_at: stamp() });
  return { ok: true };
}

/* Is today the day this lease's autopay should run, and for which month?

   Worked forwards from today rather than backwards from this month's due
   date. The difference only shows at a month boundary, and there it is the
   whole thing: rent due on the 1st, charged three days early, is charged on
   the 29th of the month *before* — so deriving the period from today's month
   asks for August's rent on the day September's is being collected, and the
   two never line up. The date three days out names the month being paid.

   Computed in the company's own timezone, because "three days before the
   first" is a different instant in Honolulu than in New York, and the wrong
   one charges a day early or a day late every month. */
export function autopayDueToday(lease, autopay, localToday) {
  const days = Number(autopay.days_before_due || 0);
  const target = addDays(localToday, days);
  const period = monthKey(target);
  const due = dueDateFor(period, lease.rent_due_day);
  const charge = addDays(due, -days);
  return { period, due, charge, isToday: localToday === charge };
}

/* One company's autopay run.

   Deliberately conservative: anything unexpected skips this lease with a
   recorded reason and moves on. A run that throws halfway leaves the rest of
   the rent roll uncharged, and nobody finds out until the delinquencies open. */
export async function runAutopay(company, { localToday, stripe = defaultStripe } = {}) {
  const out = { autopayCharged: 0, autopaySkipped: 0, autopayFailed: 0 };
  const day = localToday || today();

  const rows = await all(
    `SELECT a.*, l.rent_cents, l.rent_due_day, l.status AS lease_status,
            l.payments_blocked, l.payments_blocked_reason,
            m.stripe_payment_method_id, m.status AS method_status, m.kind AS method_kind
       FROM autopay a
       JOIN lease l ON l.id = a.lease_id
       LEFT JOIN tenant_payment_method m ON m.id = a.payment_method_id
      WHERE a.company_id = ? AND a.active = 1`, company.id);

  for (const row of rows) {
    const skip = async (reason) => {
      out.autopaySkipped++;
      await update("autopay", row.id, {
        last_run_at: stamp(), last_skip_reason: reason,
      });
    };

    const { period, isToday } = autopayDueToday(
      { rent_due_day: row.rent_due_day }, row, day);

    if (!isToday) continue;
    if (row.last_period === period) continue;   // already ran this month

    if (row.lease_status !== "active") { await skip("the tenancy is no longer active"); continue; }
    if (row.payments_blocked) {
      await skip(row.payments_blocked_reason || "online payment is switched off for this home");
      continue;
    }
    if (!row.stripe_payment_method_id || row.method_status !== "active") {
      await skip("the saved bank account is no longer usable");
      continue;
    }

    const balance = await balanceFor(row.lease_id, period);
    if (balance.outstandingCents <= 0) { await skip("nothing was owed"); continue; }

    /* The ceiling the tenant set. Over it, nothing is charged — not the
       ceiling amount, not the old rent. A part payment made without being
       asked leaves them short and late at once, and the point of the ceiling
       is that a change in what is owed gets a human decision. */
    const ceiling = row.max_amount_cents == null ? null : Number(row.max_amount_cents);
    if (ceiling != null && balance.outstandingCents > ceiling) {
      await skip(
        `the amount due was ${usd(balance.outstandingCents)}, over the `
        + `${usd(ceiling)} limit you set`);
      continue;
    }

    const made = await createPayment({
      companyId: company.id, leaseId: row.lease_id,
      amountCents: balance.outstandingCents, kind: row.method_kind || "ach",
      paymentMethodId: row.payment_method_id, initiatedBy: "autopay",
      period, stripe,
    });

    if (!made.ok) {
      out.autopayFailed++;
      await update("autopay", row.id, {
        last_run_at: stamp(), last_error: String(made.reason || "").slice(0, 300),
        last_skip_reason: null,
      });
      log.warn("autopay could not charge", { leaseId: row.lease_id, reason: made.reason });
      continue;
    }

    out.autopayCharged++;
    await update("autopay", row.id, {
      last_period: period, last_run_at: stamp(),
      last_error: null, last_skip_reason: null,
    });
  }

  return out;
}

