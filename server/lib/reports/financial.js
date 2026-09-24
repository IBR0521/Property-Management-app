/* The financial statements.

   Four reports off one query, because they are four views of the same book and
   building them separately is how they stop agreeing with each other.

   ## The distinction everything here turns on

   A **balance sheet is as at a moment**: every posting from the beginning of
   the book up to that date. A **profit and loss is for a period**: only the
   postings between two dates. Mixing them up produces a balance sheet that
   does not balance and a P&L that grows for ever, and the mistake is easy
   because both take dates and neither complains.

   So the two take different arguments on purpose. `balanceSheet` takes
   `asOf`. `profitAndLoss` takes `from` and `to`.

   ## Why the balance sheet carries current earnings

   Nothing in this application closes income and expense into retained
   earnings at year end. So as at any date, the equity side has to include
   everything earned and spent since the book began, or assets will exceed
   liabilities plus equity by exactly that amount. It is shown as its own line
   — "Earnings not yet closed" — rather than folded into retained earnings,
   because it is a different thing and an accountant will want to see it.

   ## Unallocated is always shown

   Some splits legitimately carry no property: a bank charge belongs to no
   owner, and an invoice with no work order has no unit. A report by property
   that silently drops those rows stops agreeing with the trial balance, and
   nobody can tell why. Every dimensional total here carries an explicit
   Unallocated row, even when it is zero. */
import { all, get } from "../db.js";
import { today } from "../dates.js";

/* Balances per account, with the date test inside the SUM rather than on the
   join.

   On the join it does nothing: the split is reached from the account, so a
   split whose journal falls outside the range still contributes its amounts
   while the journal comes back NULL. That is how the trial balance shipped
   with a date filter that silently did not filter, and it is worth restating
   here because every report in this file would inherit it. */
/* Every account that is active **or** carries history.

   The filter was `a.active = 1` alone, which meant retiring an account that
   had ever been posted to silently removed its postings from every report in
   this file. Measured rather than assumed: an account holding $500 of income,
   retired, took the income off the profit and loss and put the balance sheet
   out by exactly that amount.

   Retiring is meant to stop an account being offered for new postings, which
   is what the journal form's own filter does. It is not meant to rewrite the
   past — and a balance sheet that stops balancing because somebody tidied the
   chart is the last thing anybody would connect back to the tidying. */
async function balances(companyId, { from = null, to = null, propertyId = null, ownerId = null,
                                     unallocatedOnly = false } = {}) {
  /* No join to `journal`.

     The date lives on the split (migration 046), which is what turns this
     from 676,000 primary-key lookups into an index-only scan. At 2,000 units
     and five years the balance sheet was ten and a half seconds, and four
     hundred milliseconds of that was the splits — the rest was the join this
     no longer does. */
  const rows = await all(
    `SELECT a.code, a.name, a.type, a.normal_balance, a.is_trust,
            COALESCE(SUM(CASE WHEN ${inRange} THEN s.debit_cents  ELSE 0 END), 0)::bigint AS debits,
            COALESCE(SUM(CASE WHEN ${inRange} THEN s.credit_cents ELSE 0 END), 0)::bigint AS credits
       FROM account a
       LEFT JOIN journal_split s ON s.account_id = a.id
        AND (?::text IS NULL OR s.property_id = ?)
        AND (?::text IS NULL OR s.owner_id = ?)
        AND (? = 0 OR s.property_id IS NULL)
      WHERE a.company_id = ?
        AND (a.active = 1
             OR EXISTS (SELECT 1 FROM journal_split h WHERE h.account_id = a.id))
      GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_trust
      ORDER BY a.code`,
    from, from, to, to, from, from, to, to,
    propertyId, propertyId, ownerId, ownerId, unallocatedOnly ? 1 : 0,
    companyId);

  return rows.map((r) => {
    const debits = Number(r.debits), credits = Number(r.credits);
    return {
      code: r.code, name: r.name, type: r.type, isTrust: Boolean(r.is_trust),
      debits, credits,
      balance: r.normal_balance === "debit" ? debits - credits : credits - debits,
    };
  }).filter((r) => r.debits !== 0 || r.credits !== 0);
}

/* Repeated twice in the SELECT, once for each side. Reads the split's own
   date rather than its journal's — they are the same value, and the database
   enforces that they are. */
const inRange = "(?::text IS NULL OR s.date >= ?) AND (?::text IS NULL OR s.date <= ?)";

const sumOf = (rows, type) => rows.filter((r) => r.type === type)
  .reduce((n, r) => n + r.balance, 0);

/* --- profit and loss -------------------------------------------------------- */

export async function profitAndLoss(companyId, { from = null, to = today(),
                                                 propertyId = null, ownerId = null } = {}) {
  const rows = await balances(companyId, { from, to, propertyId, ownerId });
  const income = rows.filter((r) => r.type === "income");
  const expense = rows.filter((r) => r.type === "expense");

  const incomeCents = income.reduce((n, r) => n + r.balance, 0);
  const expenseCents = expense.reduce((n, r) => n + r.balance, 0);

  return {
    kind: "profit_and_loss",
    from, to, propertyId, ownerId,
    income, expense,
    incomeCents, expenseCents,
    netCents: incomeCents - expenseCents,
  };
}

/* The same, split by property, with an Unallocated row that is always
   present. The parts must add up to the whole, and the test says so. */
export async function profitAndLossByProperty(companyId, { from = null, to = today() } = {}) {
  const properties = await all(
    "SELECT id, line1, city FROM property WHERE company_id = ? ORDER BY line1", companyId);

  const columns = [];
  for (const p of properties) {
    const pl = await profitAndLoss(companyId, { from, to, propertyId: p.id });
    columns.push({
      propertyId: p.id, label: `${p.line1}, ${p.city}`,
      incomeCents: pl.incomeCents, expenseCents: pl.expenseCents, netCents: pl.netCents,
    });
  }

  /* Never omitted, even at zero. A report by property that quietly drops the
     rows belonging to no property stops agreeing with the total, and the
     person reading it has no way to know. */
  const loose = await balances(companyId, { from, to, unallocatedOnly: true });
  const looseIncome = sumOf(loose, "income");
  const looseExpense = sumOf(loose, "expense");

  columns.push({
    propertyId: null, label: "Unallocated",
    incomeCents: looseIncome, expenseCents: looseExpense,
    netCents: looseIncome - looseExpense,
    note: "Postings that belong to no property — bank charges, and invoices with no job attached.",
  });

  const total = await profitAndLoss(companyId, { from, to });
  return {
    kind: "profit_and_loss_by_property", from, to, columns,
    totalCents: total.netCents,
    /* The arithmetic that makes the report trustworthy, computed rather than
       assumed. Anything but zero and the columns do not explain the total. */
    unexplainedCents: total.netCents - columns.reduce((n, c) => n + c.netCents, 0),
  };
}

/* --- balance sheet ---------------------------------------------------------- */

export async function balanceSheet(companyId, { asOf = today() } = {}) {
  /* Everything from the beginning of the book to this date. A balance sheet
     with a `from` would be a statement of nothing in particular. */
  const rows = await balances(companyId, { from: null, to: asOf });

  const assets = rows.filter((r) => r.type === "asset");
  const liabilities = rows.filter((r) => r.type === "liability");
  const equity = rows.filter((r) => r.type === "equity");

  const assetCents = assets.reduce((n, r) => n + r.balance, 0);
  const liabilityCents = liabilities.reduce((n, r) => n + r.balance, 0);
  const equityCents = equity.reduce((n, r) => n + r.balance, 0);

  /* Nothing closes income into retained earnings, so as at any date the
     equity side has to carry everything earned and spent since the book
     began — otherwise assets exceed liabilities plus equity by exactly that.
     Its own line rather than folded into retained earnings, because it is a
     different thing.

     Derived from the rows already read rather than by calling
     `profitAndLoss`, which would run the same aggregate a second time: it
     asks for the same period with the same filters, and at 2,000 units that
     second pass was half the page. */
  const income = rows.filter((r) => r.type === "income");
  const expense = rows.filter((r) => r.type === "expense");
  const incomeCents = income.reduce((n, r) => n + r.balance, 0);
  const expenseCents = expense.reduce((n, r) => n + r.balance, 0);
  const earnings = {
    kind: "profit_and_loss", from: null, to: asOf, propertyId: null, ownerId: null,
    income, expense, incomeCents, expenseCents,
    netCents: incomeCents - expenseCents,
  };

  const restricted = (rows) => rows.filter((r) => r.isTrust);
  const unrestricted = (rows) => rows.filter((r) => !r.isTrust);

  const total = liabilityCents + equityCents + earnings.netCents;

  return {
    kind: "balance_sheet", asOf,
    assets: {
      restricted: restricted(assets), unrestricted: unrestricted(assets),
      cents: assetCents,
      restrictedCents: restricted(assets).reduce((n, r) => n + r.balance, 0),
    },
    liabilities: {
      restricted: restricted(liabilities), unrestricted: unrestricted(liabilities),
      cents: liabilityCents,
      restrictedCents: restricted(liabilities).reduce((n, r) => n + r.balance, 0),
    },
    equity: { rows: equity, cents: equityCents, earningsCents: earnings.netCents },
    totalCents: total,
    /* Assets less everything else. It is zero or the book is broken, and
       saying so on the report is better than leaving a reader to subtract. */
    outOfBalanceCents: assetCents - total,
  };
}

/* --- cash --------------------------------------------------------------------
 *
 * Not an indirect-method cash flow statement, and it does not claim to be.
 * What it answers is the question a property manager actually asks: what came
 * into each cash account this period, what went out, and against what. */
export async function cashMovement(companyId, { from = null, to = today() } = {}) {
  const accounts = await all(
    `SELECT id, code, name, is_trust FROM account
      WHERE company_id = ? AND type = 'asset' AND code IN ('1000','1010','1020')
      ORDER BY code`, companyId);

  const out = [];
  for (const account of accounts) {
    const opening = from
      ? await balanceAt(companyId, account.code, beforeDay(from))
      : 0;

    /* What each movement was against.

       Attributed per journal, not per pair of splits. Joining every other
       split in the journal counts the cash amount once for each of them,
       which on a four-split rent receipt reports three times the money that
       moved. The first version of this did exactly that.

       A journal touching cash and exactly one other account is labelled with
       that account. One touching several is labelled "split", the way a
       general ledger has always done it — the honest answer to an ambiguous
       question, and the detail is a click away in the ledger report. */
    const against = await all(
      `WITH moved AS (
         SELECT j.id AS journal_id,
                SUM(s.debit_cents)::bigint  AS in_cents,
                SUM(s.credit_cents)::bigint AS out_cents
           FROM journal_split s
           JOIN journal j ON j.id = s.journal_id
          WHERE s.account_id = ?
            AND (?::text IS NULL OR j.date >= ?) AND (?::text IS NULL OR j.date <= ?)
          GROUP BY j.id
       ),
       contra AS (
         SELECT m.journal_id, m.in_cents, m.out_cents,
                COUNT(DISTINCT a2.id)::int AS n,
                MIN(a2.code) AS code, MIN(a2.name) AS name
           FROM moved m
           JOIN journal_split os ON os.journal_id = m.journal_id
           JOIN account a2 ON a2.id = os.account_id AND a2.id <> ?
          GROUP BY m.journal_id, m.in_cents, m.out_cents
       )
       SELECT CASE WHEN n = 1 THEN code ELSE '—' END AS code,
              CASE WHEN n = 1 THEN name ELSE 'Split across several accounts' END AS name,
              SUM(in_cents)::bigint  AS in_cents,
              SUM(out_cents)::bigint AS out_cents
         FROM contra
        GROUP BY 1, 2
        ORDER BY 1`,
      account.id, from, from, to, to, account.id);

    /* Totals from the cash account's own splits rather than from the
       attribution, so the figure that matters cannot be thrown off by however
       the contra side happens to be shaped. */
    const totals = await get(
      `SELECT COALESCE(SUM(s.debit_cents), 0)::bigint  AS in_cents,
              COALESCE(SUM(s.credit_cents), 0)::bigint AS out_cents
         FROM journal_split s
         JOIN journal j ON j.id = s.journal_id
        WHERE s.account_id = ?
          AND (?::text IS NULL OR j.date >= ?) AND (?::text IS NULL OR j.date <= ?)`,
      account.id, from, from, to, to);

    const inCents = Number(totals?.in_cents || 0);
    const outCents = Number(totals?.out_cents || 0);

    out.push({
      code: account.code, name: account.name, isTrust: Boolean(account.is_trust),
      openingCents: opening,
      inCents, outCents,
      closingCents: opening + inCents - outCents,
      against: against.map((r) => ({
        code: r.code, name: r.name,
        inCents: Number(r.in_cents), outCents: Number(r.out_cents),
      })),
    });
  }

  return { kind: "cash_movement", from, to, accounts: out };
}

async function balanceAt(companyId, code, asOf) {
  const rows = await balances(companyId, { from: null, to: asOf });
  return rows.find((r) => r.code === code)?.balance || 0;
}

const beforeDay = (isoDate) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/* --- the general ledger ------------------------------------------------------ */

/* Every posting, in order, with a running balance. The report that answers
   "where did this number come from", which is the one somebody reaches for
   when they do not believe any of the others. */
export async function generalLedger(companyId, {
  from = null, to = today(), code = null, propertyId = null, ownerId = null, limit = 5000,
} = {}) {
  const rows = await all(
    `SELECT j.date, j.memo AS journal_memo, j.source, j.source_type, j.id AS journal_id,
            a.code, a.name, a.normal_balance,
            s.debit_cents, s.credit_cents, s.memo,
            s.property_id, s.owner_id, s.unit_id, s.vendor_id
       FROM journal_split s
       JOIN journal j ON j.id = s.journal_id
       JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ?
        AND (?::text IS NULL OR j.date >= ?) AND (?::text IS NULL OR j.date <= ?)
        AND (?::text IS NULL OR a.code = ?)
        AND (?::text IS NULL OR s.property_id = ?)
        AND (?::text IS NULL OR s.owner_id = ?)
      ORDER BY a.code, j.date, j.created_at
      LIMIT ?`,
    companyId, from, from, to, to, code, code, propertyId, propertyId, ownerId, ownerId, limit);

  /* The running balance restarts per account, because a running total across
     different accounts is a number with no meaning. */
  let current = null, running = 0;
  const lines = rows.map((r) => {
    if (r.code !== current) { current = r.code; running = 0; }
    const debit = Number(r.debit_cents), credit = Number(r.credit_cents);
    running += r.normal_balance === "debit" ? debit - credit : credit - debit;
    return {
      date: r.date, code: r.code, account: r.name,
      memo: r.memo || r.journal_memo,
      source: r.source, journalId: r.journal_id,
      debitCents: debit, creditCents: credit, runningCents: running,
      propertyId: r.property_id, ownerId: r.owner_id,
    };
  });

  return {
    kind: "general_ledger", from, to, code, propertyId, ownerId,
    lines,
    truncated: lines.length >= limit,
    debitCents: lines.reduce((n, l) => n + l.debitCents, 0),
    creditCents: lines.reduce((n, l) => n + l.creditCents, 0),
  };
}
