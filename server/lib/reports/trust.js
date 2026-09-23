/* The three-way trust reconciliation.

   This is the report a regulator asks for and the one that would have caught
   what is wrong with this application's books. It is being built before the
   postings are corrected, deliberately, so the correction has something that
   can tell it whether it worked.

   ## Why three legs and not two

   An ordinary bank reconciliation has two: what the bank says and what your
   book says. Trust accounting needs a third, because the money is not yours.
   It is not enough that the account balances — the sum of what you hold *for
   each individual client* has to equal it too. A trust account that
   reconciles perfectly against the book while one owner's balance has been
   spent on another owner's repair is the classic trust failure, and only the
   third leg sees it.

   So, four numbers and the variances between them:

     bank        what the bank says, less payments written and not yet cleared
     book        the trust asset accounts in the journal
     clients     the trust liability accounts in the journal
     subledger   the sum of the individual client balances

   `book` against `clients` asks whether the money you hold is accounted for.
   `clients` against `subledger` asks whether the control account agrees with
   the individual records behind it — the check that catches an error in one
   client's ledger that nets out in the total.

   ## On being unable to answer

   Every leg can be unavailable rather than zero, and the difference matters.
   No bank account connected is not "the bank holds nothing"; it is "nobody
   has told us". A leg that cannot be computed is reported as `null` with a
   reason, and a variance involving it is not calculated rather than being
   calculated against a zero nobody meant. */
import { all, get } from "../db.js";
import { today } from "../dates.js";

/* --- the legs -------------------------------------------------------------- */

/* Balances of the trust accounts in the journal, as at a date. Split by type
   because assets and liabilities are two different legs of this report and
   summing them together would produce a number with no meaning. */
async function journalTrustBalances(companyId, asOf) {
  /* The date test is inside the SUM, not on the join. On the join it does
     nothing: the split is reached from the account, so a split whose journal
     falls outside the range still contributes its own amounts while the
     journal comes back NULL. That is how the trial balance shipped with a
     date filter that silently did not filter. */
  const rows = await all(
    `SELECT a.code, a.name, a.type, a.normal_balance,
            COALESCE(SUM(CASE WHEN j.date <= ? THEN s.debit_cents ELSE 0 END), 0)::bigint  AS debits,
            COALESCE(SUM(CASE WHEN j.date <= ? THEN s.credit_cents ELSE 0 END), 0)::bigint AS credits
       FROM account a
       LEFT JOIN journal_split s ON s.account_id = a.id
       LEFT JOIN journal j ON j.id = s.journal_id
      WHERE a.company_id = ? AND a.is_trust = 1
      GROUP BY a.code, a.name, a.type, a.normal_balance
      ORDER BY a.code`, asOf, asOf, companyId);

  return rows.map((r) => {
    const debits = Number(r.debits), credits = Number(r.credits);
    return {
      code: r.code, name: r.name, type: r.type,
      debits, credits,
      balance: r.normal_balance === "debit" ? debits - credits : credits - debits,
    };
  });
}

/* What the bank says.

   `balance_cents` is the last figure an aggregator reported, or what somebody
   typed for a manually reconciled account. Either way it is a claim about the
   outside world rather than something this application computed, which is
   exactly why it is worth comparing against. */
async function bankLeg(companyId) {
  const accounts = await all(
    `SELECT id, name, mask, balance_cents, is_trust
       FROM bank_account
      WHERE company_id = ? AND active = 1 AND is_trust = 1
      ORDER BY name`, companyId);

  if (!accounts.length) {
    return { cents: null, unavailable: "no trust bank account is connected", accounts: [] };
  }

  /* A balance of exactly zero on every account is almost always "never
     reported" rather than "the account is empty", and treating it as a real
     figure would produce a confident variance against a number nobody
     supplied. */
  const anyReported = accounts.some((a) => Number(a.balance_cents) !== 0);
  if (!anyReported) {
    return {
      cents: null,
      unavailable: "no balance has been reported for the trust account(s)",
      accounts,
    };
  }

  return {
    cents: accounts.reduce((n, a) => n + Number(a.balance_cents), 0),
    unavailable: null,
    accounts,
  };
}

/* Payments written and not yet seen leaving the bank.

   A cheque posted to the book the day it is written will not appear on a
   statement for a fortnight, and the gap is not an error — it is the whole
   reason a bank reconciliation exists. Only batches actually issued count:
   a draft is a proposal, not a payment. */
async function outstandingPayments(companyId, asOf) {
  const row = await get(
    `SELECT COALESCE(SUM(i.amount_cents), 0)::bigint AS cents, COUNT(*)::int AS n
       FROM payout_item i
       JOIN payout_batch b ON b.id = i.batch_id
      WHERE i.company_id = ?
        AND i.voided_at IS NULL
        AND b.status = 'issued'
        AND b.effective_date <= ?
        AND NOT EXISTS (
          SELECT 1 FROM bank_match m
           WHERE m.target_type = 'payout_batch' AND m.target_id = b.id)`,
    companyId, asOf);
  return { cents: Number(row?.cents || 0), count: Number(row?.n || 0) };
}

/* The individual client balances, from the records each client is actually
   shown — not from the control accounts. That is the point of this leg: a
   control account and its subsidiary ledger can disagree, and when they do it
   is the subsidiary ledger somebody has been reading. */
async function subledgerLeg(companyId, asOf) {
  const owners = await all(
    `SELECT o.id, o.name, COALESCE(SUM(e.amount_cents), 0)::bigint AS cents
       FROM owner o
       LEFT JOIN ledger_entry e ON e.owner_id = o.id AND e.date <= ?
      WHERE o.company_id = ?
      GROUP BY o.id, o.name
      ORDER BY o.name`, asOf, companyId);

  /* Deposits are recorded on the lease and, today, posted nowhere. Carried as
     its own figure rather than folded into the total, because a deposit that
     exists on a lease and not in the books is a finding in its own right and
     hiding it inside a subtotal is how it stays unnoticed. */
  const dep = await get(
    `SELECT COALESCE(SUM(deposit_cents), 0)::bigint AS cents, COUNT(*)::int AS n
       FROM lease
      WHERE company_id = ? AND status = 'active' AND deposit_cents > 0`, companyId);

  return {
    owners: owners.map((o) => ({ ownerId: o.id, name: o.name, cents: Number(o.cents) })),
    ownersCents: owners.reduce((n, o) => n + Number(o.cents), 0),
    depositsOnLeases: { cents: Number(dep?.cents || 0), count: Number(dep?.n || 0) },
  };
}

/* --- the report ------------------------------------------------------------ */

export async function trustReconciliation(companyId, { asOf = today() } = {}) {
  const [balances, bank, outstanding, sub] = await Promise.all([
    journalTrustBalances(companyId, asOf),
    bankLeg(companyId),
    outstandingPayments(companyId, asOf),
    subledgerLeg(companyId, asOf),
  ]);

  const assets = balances.filter((b) => b.type === "asset");
  const liabilities = balances.filter((b) => b.type === "liability");

  const bookCents = assets.reduce((n, b) => n + b.balance, 0);
  const clientsCents = liabilities.reduce((n, b) => n + b.balance, 0);

  /* The bank's figure brought onto the same footing as the book: money paid
     out that the bank has not yet acted on is already gone as far as the book
     is concerned. */
  const adjustedBank = bank.cents === null ? null : bank.cents - outstanding.cents;

  const legs = {
    bank: {
      cents: adjustedBank,
      reported: bank.cents,
      outstandingPayments: outstanding,
      unavailable: bank.unavailable,
      accounts: bank.accounts,
    },
    book: { cents: bookCents, rows: assets },
    clients: { cents: clientsCents, rows: liabilities },
    subledger: {
      cents: sub.ownersCents,
      owners: sub.owners,
      depositsOnLeases: sub.depositsOnLeases,
    },
  };

  /* Each variance is a named question rather than a number, because "out by
     $759.15" is useless and "the fee you have earned is still sitting in the
     trust account" is actionable. */
  const variances = [
    {
      key: "bank_vs_book",
      label: "The bank against the book",
      question: "Does the trust account hold what the book says it holds?",
      cents: adjustedBank === null ? null : adjustedBank - bookCents,
      unavailable: bank.unavailable,
    },
    {
      key: "book_vs_clients",
      label: "The book against what is owed",
      question: "Is every pound held accounted for as somebody's money?",
      cents: bookCents - clientsCents,
      unavailable: null,
    },
    {
      key: "clients_vs_subledger",
      label: "The control account against the individual ledgers",
      question: "Does the total agree with the records each client is shown?",
      cents: clientsCents - sub.ownersCents,
      unavailable: null,
    },
  ];

  const findings = explain({ legs, variances, balances });

  /* Unavailable is not balanced. A reconciliation that reports success because
     it could not check is worse than one that reports nothing — and the first
     version of this did exactly that: with no bank connected it compared the
     two legs it had, found them equal, and said the trust account
     reconciled. Every leg has to be both checkable and zero. */
  const balanced = variances.every((v) => !v.unavailable && v.cents === 0);

  return {
    asOf, legs, variances, findings, balanced,
    unchecked: variances.filter((v) => v.unavailable).map((v) => v.key),
  };
}

/* --- saying what a variance means ------------------------------------------
 *
 * A number on its own sends somebody to a spreadsheet. These are the causes
 * this application can recognise in its own data, each stated as the thing
 * that is true rather than as a diagnosis to go and confirm. */
function explain({ legs, variances, balances }) {
  const out = [];
  const by = (key) => variances.find((v) => v.key === key);

  const negativeTrust = balances.filter((b) => b.balance < 0);
  for (const b of negativeTrust) {
    out.push({
      severity: "error",
      title: `${b.code} ${b.name} is negative`,
      detail: b.type === "liability"
        ? "A liability account below zero means the books record owing less than nothing, "
          + "which is not a state that can arise from correct postings."
        : "A trust asset below zero means the books record holding less than nothing.",
    });
  }

  const bookVsClients = by("book_vs_clients");
  if (bookVsClients.cents > 0 && negativeTrust.length) {
    /* The benign reading of a surplus is unswept fees. It is not available
       here: a negative trust liability means the obligation side is simply
       not being recorded, and offering the reassuring explanation on top of
       an impossible balance would be the most misleading thing this report
       could say. */
    out.push({
      severity: "error",
      title: "The trust account appears to hold more than is owed — but the obligation side is broken",
      detail: "A surplus normally means fees you have earned and not yet swept. That reading is "
        + "not available while a trust liability is negative: the figure it is being measured "
        + "against is not a real obligation total. Fix the negative account first, then read "
        + "this number again.",
      cents: bookVsClients.cents,
    });
  } else if (bookVsClients.cents > 0) {
    out.push({
      severity: "warn",
      title: "The trust account holds more than is owed to clients",
      detail: "Usually fees you have earned and not yet moved to your operating account. "
        + "It should be a figure you recognise, and it should not grow month on month.",
      cents: bookVsClients.cents,
    });
  } else if (bookVsClients.cents < 0) {
    out.push({
      severity: "error",
      title: "The trust account holds less than is owed to clients",
      detail: "This is a shortfall: the records say you owe clients more than the account "
        + "contains. It is the finding a regulator is looking for.",
      cents: bookVsClients.cents,
    });
  }

  const controlVsSub = by("clients_vs_subledger");
  if (controlVsSub.cents !== 0) {
    out.push({
      severity: "error",
      title: "The control account and the individual ledgers disagree",
      detail: "One of them is wrong, and the individual ledgers are the ones clients are "
        + "shown. Until they agree, no owner statement can be relied on.",
      cents: controlVsSub.cents,
    });
  }

  if (legs.subledger.depositsOnLeases.cents > 0) {
    const held = balances.find((b) => b.code === "2100");
    if (!held || held.balance === 0) {
      out.push({
        severity: "error",
        title: "Deposits are recorded on leases and posted nowhere",
        detail: `${legs.subledger.depositsOnLeases.count} active lease(s) record a deposit, `
          + "and the deposits-held account has never been posted to. The money is "
          + "somebody else's and the books do not know it exists.",
        cents: legs.subledger.depositsOnLeases.cents,
      });
    }
  }

  if (legs.bank.unavailable) {
    out.push({
      severity: "info",
      title: "The bank leg could not be checked",
      detail: `${legs.bank.unavailable}. Two of the three legs were compared; the one that `
        + "proves the money is really there was not.",
    });
  }

  return out;
}
