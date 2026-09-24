/* F7  Double-entry accounting and the trust ledger.

   One function writes to this book: postJournal. Rent, maintenance bills,
   owner distributions, late fees and bank matches all go through it, so there
   is exactly one place where the shape of a financial write is decided.

   The database enforces balance, a two-split minimum, and immutability (see
   005_accounting.sql). The checks here are not a substitute for that — they
   exist to fail early with a message naming the caller's mistake, instead of
   letting a deferred constraint fire at COMMIT and report a journal id nobody
   can trace back. */
import { all, get, one, insert, update, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, today, monthKey } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import {
  planSweep, commitSweep, SweepRefused, CONFIRMATION as SWEEP_CONFIRMATION,
} from "../lib/trustsweep.js";

/* The codes the rest of the app posts against. Referred to by name so a call
   site never carries a bare string that a typo turns into a silent miss. */
export const ACCT = {
  CASH: "1000",
  TRUST_CASH: "1010",
  IN_TRANSIT: "1020",
  RENT_RECEIVABLE: "1200",
  TENANT_RECEIVABLE: "1300",
  PAYABLE: "2000",
  DEPOSITS_HELD: "2100",
  OWNER_FUNDS: "2200",
  PREPAID_RENT: "2300",
  /* Rent charged and not yet collected. Non-trust on purpose: you do not
     owe an owner money you have not received, and crediting a trust
     liability here would make the trust reconciliation fail by the
     arrears, for ever. */
  RENT_DUE_OWNERS: "2400",
  RETAINED: "3000",
  OPENING_CONVERSION: "3100",
  RENT_INCOME: "4000",
  LATE_FEE_INCOME: "4100",
  MGMT_FEE_INCOME: "4200",
  FEE_RECOVERED: "4300",
  REPAIRS: "5000",
  BANK_CHARGES: "5100",
  PROCESSING_FEES: "5200",
  RETURN_CHARGES: "5300",
};

/* The whole chart, and the only definition of it for a new company.

   This list and the INSERT in migration 020 have to agree. They drifted once —
   020 added the payment accounts for companies that already existed, and a
   company created afterwards got a chart without them, so posting a rent
   payment failed with "Not found" from a code lookup. The test below asserts
   every ACCT constant resolves, which is what makes that a failure rather
   than a surprise. */
const DEFAULT_CHART = [
  [ACCT.CASH, "Operating cash", "asset", "debit", 0],
  [ACCT.TRUST_CASH, "Trust cash — client funds", "asset", "debit", 1],
  [ACCT.IN_TRANSIT, "Payments in transit", "asset", "debit", 1],
  [ACCT.RENT_RECEIVABLE, "Rent receivable", "asset", "debit", 0],
  [ACCT.TENANT_RECEIVABLE, "Tenant receivable", "asset", "debit", 0],
  [ACCT.PAYABLE, "Accounts payable", "liability", "credit", 0],
  [ACCT.DEPOSITS_HELD, "Tenant deposits held", "liability", "credit", 1],
  [ACCT.OWNER_FUNDS, "Owner funds held", "liability", "credit", 1],
  [ACCT.PREPAID_RENT, "Prepaid rent", "liability", "credit", 1],
  [ACCT.RENT_DUE_OWNERS, "Rent due to owners — uncollected", "liability", "credit", 0],
  [ACCT.RETAINED, "Retained earnings", "equity", "credit", 0],
  [ACCT.OPENING_CONVERSION, "Opening balance conversion", "equity", "credit", 0],
  /* Retired: under agency the rent is the owner's income, so nothing credits
     this. Kept in the chart for the companies whose older journals used it —
     see migration 050 — and created inactive so it is never offered for a new
     posting. `ensureChart` only inserts accounts that are missing, so this
     does not revive one a company has deliberately retired. */
  [ACCT.RENT_INCOME, "Rent income", "income", "credit", 0, 0],
  [ACCT.LATE_FEE_INCOME, "Late fee income", "income", "credit", 0],
  [ACCT.MGMT_FEE_INCOME, "Management fee income", "income", "credit", 0],
  [ACCT.FEE_RECOVERED, "Processing fee recovered", "income", "credit", 0],
  [ACCT.REPAIRS, "Repairs and maintenance", "expense", "debit", 0],
  [ACCT.BANK_CHARGES, "Bank charges", "expense", "debit", 0],
  [ACCT.PROCESSING_FEES, "Payment processing fees", "expense", "debit", 0],
  [ACCT.RETURN_CHARGES, "Returned payment charges", "expense", "debit", 0],
];

/* A company created after migration 005 ran has no chart. Rather than making
   that a setup step somebody forgets, the first post creates it. */
/* Fills in anything missing rather than returning early when the chart is
   non-empty. The early return was the other half of the drift: a company with
   the original twelve accounts never gained the seven the payment paths need,
   and the failure surfaced as a 404 on recording rent. */
export async function ensureChart(companyId) {
  const existing = await all(
    "SELECT code FROM account WHERE company_id = ?", companyId);
  const have = new Set(existing.map((r) => r.code));

  for (const [code, name, type, normal, trust, active = 1] of DEFAULT_CHART) {
    if (have.has(code)) continue;
    await insert("account", {
      id: id(), company_id: companyId, code, name, type,
      normal_balance: normal, is_trust: trust, active, created_at: stamp(),
    });
  }
}

export async function accountByCode(companyId, code) {
  await ensureChart(companyId);
  return await one(
    "SELECT * FROM account WHERE company_id = ? AND code = ?", companyId, code);
}

/* --- the closed period ----------------------------------------------------

   A company may draw a line and say the books before it are finished. Nothing
   posts behind that line, and the line moves only by closing or reopening,
   both of which are deliberate and both of which are audited.

   There is no per-posting override on purpose. An override is a thing people
   click, and a closed period that can be posted into by clicking is not a
   closed period. Reopen, post, close again — three visible acts instead of one
   invisible one. */
export class PeriodClosed extends BadRequest {
  constructor(message) {
    super(message);
    /* Named so a caller that posts on a schedule can count these and carry on
       rather than treating a company's deliberate choice as a fault. */
    this.periodClosed = true;
  }
}

export async function closedThrough(companyId) {
  const row = await get("SELECT books_closed_through FROM company WHERE id = ?", companyId);
  return row?.books_closed_through || null;
}

/* Both writers call this. `reverseJournal` inserts into `journal` directly
   rather than going through `postJournal`, so a guard in one place only would
   have left reversals able to post into a closed month — which is the single
   most likely way somebody would have got round it. */
export async function assertPeriodOpen(companyId, date) {
  const line = await closedThrough(companyId);
  if (!line) return;
  const on = date || today();
  if (on <= line) {
    throw new PeriodClosed(
      `The books are closed through ${human(line)}, so nothing can be posted dated ${human(on)}. `
      + `Either date it after ${human(line)}, or reopen the period first under Accounting.`);
  }
}

/* --- the only writer ------------------------------------------------------ */

/* splits: [{ code | accountId, debit | credit, memo, ownerId, propertyId,
              unitId, leaseId, vendorId }]
   Amounts are integer cents. `debit` and `credit` are separate keys rather than
   one signed number, because a signed number makes it possible to write a
   "negative debit", which is a credit wearing a disguise and balances a book
   that is actually wrong. */
export async function postJournal({
  companyId, date, memo, source = "manual", sourceType = null, sourceId = null,
  postedBy = "system", splits,
}) {
  if (!Array.isArray(splits) || splits.length < 2) {
    throw new BadRequest("A journal needs at least two splits.");
  }
  if (!memo || !String(memo).trim()) {
    throw new BadRequest("A journal needs a memo — an unexplained entry is an audit finding.");
  }

  await ensureChart(companyId);

  let debits = 0, credits = 0;
  const resolved = [];
  for (const s of splits) {
    const d = Math.round(Number(s.debit || 0));
    const c = Math.round(Number(s.credit || 0));
    if (d < 0 || c < 0) throw new BadRequest("Split amounts are positive; the side carries the sign.");
    if ((d === 0) === (c === 0)) {
      throw new BadRequest("Each split is either a debit or a credit, never both and never neither.");
    }
    const accountId = s.accountId || (await accountByCode(companyId, s.code)).id;
    debits += d; credits += c;
    resolved.push({ ...s, accountId, d, c });
  }

  if (debits !== credits) {
    throw new BadRequest(
      `This journal does not balance: debits ${usd(debits)} against credits ${usd(credits)}.`);
  }

  await assertPeriodOpen(companyId, date);

  const on = date || today();

  return await tx(async () => {
    const jid = id();
    await insert("journal", {
      id: jid, company_id: companyId, date: on, memo: String(memo).trim(),
      source, source_type: sourceType, source_id: sourceId,
      posted_by: postedBy, created_at: stamp(),
    });
    for (const r of resolved) {
      await insert("journal_split", {
        id: id(), journal_id: jid, account_id: r.accountId,
        /* The journal's date, on the split.

           Every financial report groups by account and filters by date, and
           joining 676,000 splits to their journals for that one column is
           where the balance sheet spent ten of its ten and a half seconds at
           2,000 units. A posted journal is append-only, so its date cannot
           change and the copy cannot drift — and the database checks the two
           match on the way in rather than trusting this line. */
        date: on,
        /* And what it was for, for the same reason. Aged receivables has to
           know whether a charge is rent — rent ages from its due date, which
           comes from the period in `source_id` — and joining 120,000 splits
           to their journals for those two columns cost 800ms of a 945ms
           query. Append-only, so the copy cannot drift; checked on the way
           in, so it cannot be forgotten either. */
        source_type: sourceType, source_id: sourceId,
        debit_cents: r.d, credit_cents: r.c,
        owner_id: r.ownerId || null, property_id: r.propertyId || null,
        unit_id: r.unitId || null, lease_id: r.leaseId || null, vendor_id: r.vendorId || null,
        memo: r.memo || null,
      });
    }
    return jid;
  });
}

/* A wrong entry is corrected by posting its mirror, never by editing it. The
   original stays visible and the pair nets to nothing, which is what an
   auditor expects to see. */
export async function reverseJournal(journalId, { companyId, by = "system", memo, date } = {}) {
  const original = await one(
    "SELECT * FROM journal WHERE id = ? AND company_id = ?", journalId, companyId);
  if (original.reversed_by) {
    throw new BadRequest("That journal has already been reversed.");
  }
  const splits = await all("SELECT * FROM journal_split WHERE journal_id = ?", journalId);

  /* The reversal's own date, not the original's. Reversing a journal that sits
     in a closed period is ordinary and allowed — the correction lands in an
     open one. What is refused is dating the reversal itself behind the line. */
  await assertPeriodOpen(companyId, date || today());

  const on = date || today();

  return await tx(async () => {
    const jid = id();
    await insert("journal", {
      id: jid, company_id: companyId, date: on,
      memo: memo || `Reversal of: ${original.memo}`,
      source: original.source, source_type: original.source_type, source_id: original.source_id,
      reverses_id: original.id, posted_by: by, created_at: stamp(),
    });
    for (const s of splits) {
      // Sides swapped: every debit becomes a credit of the same size.
      await insert("journal_split", {
        id: id(), journal_id: jid, account_id: s.account_id,
        /* The reversal's own date, not the original's — the same date the
           journal above carries. */
        date: on,
        /* The source is the original's, which is what the reversal journal
           above carries too: a reversal is about the same thing the posting
           was about. */
        source_type: original.source_type, source_id: original.source_id,
        debit_cents: s.credit_cents, credit_cents: s.debit_cents,
        owner_id: s.owner_id, property_id: s.property_id, unit_id: s.unit_id,
        lease_id: s.lease_id, vendor_id: s.vendor_id,
        memo: s.memo ? `reversal — ${s.memo}` : "reversal",
      });
    }
    await update("journal", original.id, { reversed_by: jid });
    return jid;
  });
}

/* --- reporting ------------------------------------------------------------ */

export async function trialBalance(companyId, { from, to } = {}) {
  /* The date test is inside the SUM and not on the join, and that is the whole
     correctness of this query.

     It used to sit on `LEFT JOIN journal ... AND j.date <= ?`. Because the
     split is joined from the account, a split whose journal fell outside the
     range still produced a row — the journal came back NULL and the split's
     own debit and credit were summed anyway. The filter did nothing at all:
     the screen offered From and To, said "filtered" underneath them, and
     returned the all-time figure. Filtering to 1990 on seeded data returned
     every penny of 2026. */
  /* And the journal is not joined at all any more. The date is on the split
     (migration 046), which is what makes this an index-only scan — five
     seconds at 2,000 units and five years, almost all of it primary-key
     lookups for one column that was already known. */
  const rows = await all(
    `SELECT a.id, a.code, a.name, a.type, a.normal_balance, a.is_trust,
            COALESCE(SUM(CASE WHEN (?::text IS NULL OR s.date >= ?)
                               AND (?::text IS NULL OR s.date <= ?)
                              THEN s.debit_cents ELSE 0 END), 0)::bigint  AS debits,
            COALESCE(SUM(CASE WHEN (?::text IS NULL OR s.date >= ?)
                               AND (?::text IS NULL OR s.date <= ?)
                              THEN s.credit_cents ELSE 0 END), 0)::bigint AS credits
       FROM account a
       LEFT JOIN journal_split s ON s.account_id = a.id
      WHERE a.company_id = ?
      GROUP BY a.id, a.code, a.name, a.type, a.normal_balance, a.is_trust
      ORDER BY a.code`,
    from || null, from || null, to || null, to || null,
    from || null, from || null, to || null, to || null, companyId);

  return rows.map((r) => {
    const debits = Number(r.debits), credits = Number(r.credits);
    // A debit-normal account's balance is debits minus credits, and the other
    // way round for credit-normal. Reporting the raw difference would show half
    // the chart as negative.
    const balance = r.normal_balance === "debit" ? debits - credits : credits - debits;
    return { ...r, debits, credits, balance };
  });
}

/* Trust money is other people's. Held separately in law, and reported
   separately here so the number can actually be checked against a bank. */
export async function trustPosition(companyId) {
  const rows = await trialBalance(companyId);
  const trust = rows.filter((r) => r.is_trust);
  const assets = trust.filter((r) => r.type === "asset").reduce((n, r) => n + r.balance, 0);
  const liabilities = trust.filter((r) => r.type === "liability").reduce((n, r) => n + r.balance, 0);
  return { assets, liabilities, variance: assets - liabilities, rows: trust };
}

export async function journalsFor(sourceType, sourceId) {
  return await all(
    "SELECT * FROM journal WHERE source_type = ? AND source_id = ? ORDER BY created_at",
    sourceType, sourceId);
}

/* --- routes --------------------------------------------------------------- */

const ACCOUNTING_TABS = [
  { key: "trial", href: "/app/accounting", label: "Trial balance" },
  { key: "journals", href: "/app/accounting/journals", label: "Journals" },
  { key: "trust", href: "/app/accounting/trust", label: "Trust position" },
];

/* What is the manager's, and a form to record having taken it.

   A surplus in the trust account is normally fees earned and not yet moved.
   The figure is only meaningful while the rest of the reconciliation is
   sound, so when it is not this shows the reason instead of an amount — the
   claim "this money is nobody's" is worthless if the obligation side is
   broken. */
function sweepPanel(sweep, ctx) {
  if (sweep.blocked.length) {
    return html`
      <div class="panel">
        <div class="panel__head"><h2>Your own fees</h2><p>Cannot be worked out yet</p></div>
        <div class="panel__body">
          ${notice("danger", "Fix the reconciliation first",
            html`${sweep.blocked[0].title}. Until that is right, what looks like a surplus
              is measured against an obligation total that is not real, and moving it
              could take money that belongs to a client.`)}
        </div>
      </div>`;
  }

  if (!sweep.sweepableCents && !sweep.history.length) return "";

  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Your own fees</h2>
        <p>Earned, and still in the client account</p>
      </div>
      <div class="panel__body">
        ${sweep.warnings.map((w) => notice("warn", w.title, w.detail))}
        <div class="grid grid--3">
          <div class="tile"${attr("data-tone", sweep.sweepableCents ? "ok" : null)}>
            <span class="tile__label">Yours to move</span>
            <span class="tile__value">${usd(sweep.sweepableCents)}</span>
            <span class="tile__note">it should not grow month on month</span></div>
        </div>
        ${sweep.sweepableCents ? html`
          <form method="post" action="/app/accounting/trust/sweep" class="filterbar"
                style="padding:0;border:0;gap:0.5rem;flex-wrap:wrap;margin-top:1rem">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />
            <div class="field" style="min-width:7rem">
              <input name="amount" type="text" inputmode="decimal"
                     value="${(sweep.sweepableCents / 100).toFixed(2)}"
                     aria-label="Amount moved" required />
            </div>
            <div class="field" style="min-width:9rem">
              <input name="date" type="date" value="${today()}" aria-label="Date moved" />
            </div>
            <div class="field" style="min-width:10rem">
              <input name="reference" type="text" placeholder="Bank reference"
                     aria-label="Bank reference" />
            </div>
            <button class="pill outline sm" type="submit">Record the transfer</button>
          </form>
          <span class="field__help" style="display:block;margin-top:0.5rem">
            Move the money between your own accounts first. This records that you did;
            it does not move anything.</span>` : ""}
      </div>
      ${sweep.history.length ? html`
        <div class="panel__body panel__body--flush" style="border-top:1px solid var(--hairline)">
          <div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Date</th><th>Reference</th><th class="num">Moved</th></tr></thead>
            <tbody>${sweep.history.map((h) => html`
              <tr><td class="shrink">${human(h.date)}</td><td>${h.memo}</td>
                  <td class="num">${usd(h.cents)}</td></tr>`)}</tbody>
          </table></div>
        </div>` : ""}
    </div>`;
}

export function registerAccounting(router) {
  router.get("/app/accounting", async (ctx) => {
    const cid = ctx.staff.company_id;
    const from = ctx.query.from || "";
    const to = ctx.query.to || "";
    const rows = await trialBalance(cid, { from, to });
    const totalDr = rows.reduce((n, r) => n + r.debits, 0);
    const totalCr = rows.reduce((n, r) => n + r.credits, 0);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "accounting", counts: await navCounts(cid),
      title: "Trial balance",
      subtitle: totalDr === totalCr
        ? `${usd(totalDr)} on each side — in balance`
        : `OUT OF BALANCE by ${usd(Math.abs(totalDr - totalCr))}`,
      actions: html`<a class="pill solid sm" href="/app/accounting/new">New journal</a>`,
      body: html`
        ${tabs(ACCOUNTING_TABS, "trial")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${totalDr !== totalCr ? notice("danger", "The book does not balance",
          "This should be impossible — the database rejects unbalanced journals. Investigate before trusting any report on this page.") : ""}
        <div class="panel">
          <form method="get" action="/app/accounting" class="filterbar">
            <div class="field"><label for="from">From</label>
              <input id="from" name="from" type="date" value="${from}" /></div>
            <div class="field"><label for="to">To</label>
              <input id="to" name="to" type="date" value="${to}" /></div>
            <button class="pill outline sm" type="submit">Apply</button>
            ${from || to ? html`<a class="pill outline sm" href="/app/accounting">Clear</a>` : ""}
            <span class="filterbar__note">${from || to ? "filtered" : "all time"}</span>
          </form>
          <div class="panel__body panel__body--flush">
          <div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Account</th>
              <th class="num">Debits</th><th class="num">Credits</th><th class="num">Balance</th></tr></thead>
            <tbody>${rows.map((r) => html`
              <tr>
                <td><b>${r.code}</b> ${r.name}
                  ${r.is_trust ? html` <span class="chip" data-tone="brand">trust</span>` : ""}
                  <span class="cellsub">${r.type}</span></td>
                <td class="num">${r.debits ? usd(r.debits) : "—"}</td>
                <td class="num">${r.credits ? usd(r.credits) : "—"}</td>
                <td class="num"><b>${usd(r.balance)}</b></td>
              </tr>`)}</tbody>
            <tfoot><tr>
              <td><b>Total</b></td>
              <td class="num"><b>${usd(totalDr)}</b></td>
              <td class="num"><b>${usd(totalCr)}</b></td>
              <td class="num">${totalDr === totalCr ? "—" : html`<b>${usd(totalDr - totalCr)}</b>`}</td>
            </tr></tfoot>
          </table></div>
        </div></div>`,
    }));
  });

  router.get("/app/accounting/journals", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await all(
      `SELECT j.*,
              (SELECT COALESCE(SUM(debit_cents),0) FROM journal_split s WHERE s.journal_id = j.id)::bigint AS amount,
              (SELECT COUNT(*) FROM journal_split s WHERE s.journal_id = j.id)::int AS lines
         FROM journal j WHERE j.company_id = ?
        ORDER BY j.date DESC, j.created_at DESC LIMIT 200`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "accounting", counts: await navCounts(cid),
      title: "Journals", subtitle: `${rows.length} most recent`,
      actions: html`<a class="pill solid sm" href="/app/accounting/new">New journal</a>`,
      body: html`
        ${tabs(ACCOUNTING_TABS, "journals")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${rows.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Date</th><th>Memo</th><th>Source</th><th class="num">Amount</th><th class="shrink"></th></tr></thead>
            <tbody>${rows.map((r) => html`
              <tr>
                <td>${human(r.date)}</td>
                <td><a href="/app/accounting/j/${r.id}">${r.memo}</a>
                  ${r.reverses_id ? html`<span class="cellsub">reversal</span>` : ""}
                  ${r.reversed_by ? html`<span class="cellsub">reversed</span>` : ""}</td>
                <td>${r.source}</td>
                <td class="num">${usd(Number(r.amount))}<span class="cellsub">${r.lines} lines</span></td>
                <td class="shrink"><a class="pill outline sm" href="/app/accounting/j/${r.id}">Open</a></td>
              </tr>`)}</tbody></table></div>` : empty("No journals yet.")}
        </div></div>`,
    }));
  });

  router.get("/app/accounting/trust", async (ctx) => {
    const cid = ctx.staff.company_id;
    const pos = await trustPosition(cid);
    const sweep = await planSweep(cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "accounting", counts: await navCounts(cid),
      title: "Trust position",
      subtitle: pos.variance === 0 ? "Held equals owed" : `Variance of ${usd(Math.abs(pos.variance))}`,
      body: html`
        ${tabs(ACCOUNTING_TABS, "trust")}
        ${pos.variance !== 0 ? notice("danger", "Trust is out of position",
          html`Client funds held (${usd(pos.assets)}) do not equal what is owed to clients (${usd(pos.liabilities)}).
               In most states this is reportable. Find the difference before moving any money.`)
          : notice("ok", "In position", "Client money held matches what is owed to clients.")}
        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Trust cash held</span><span class="tile__value">${usd(pos.assets)}</span></div>
          <div class="tile"><span class="tile__label">Owed to clients</span><span class="tile__value">${usd(pos.liabilities)}</span></div>
          <div class="tile"><span class="tile__label">Variance</span><span class="tile__value">${usd(pos.variance)}</span>
            <span class="tile__note">must be zero</span></div>
        </div>
        <div class="panel"><div class="panel__body panel__body--flush">
          <div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Code</th><th>Account</th><th class="num">Balance</th></tr></thead>
            <tbody>${pos.rows.map((r) => html`
              <tr><td>${r.code}</td><td>${r.name}</td><td class="num">${usd(r.balance)}</td></tr>`)}</tbody>
          </table></div>
        </div></div>

        ${sweepPanel(sweep, ctx)}`,
    }));
  });

  /* Recording that earned fees were moved out of the trust account.

     This records a transfer; it does not make one. Somebody moves the money
     between their own two bank accounts and tells this what they did — the
     same rule the payouts follow, and the reason the platform is never the
     custodian. */
  router.post("/app/accounting/trust/sweep", async (ctx) => {
    const cid = ctx.staff.company_id;
    const cents = parseMoney(ctx.fields.amount);
    if (cents == null || cents <= 0) throw new BadRequest("Give the amount you moved.");
    try {
      await commitSweep({
        companyId: cid, amountCents: cents,
        date: String(ctx.fields.date || "") || today(),
        reference: String(ctx.fields.reference || "").trim() || null,
        by: ctx.staff.id, confirm: SWEEP_CONFIRMATION,
      });
    } catch (err) {
      if (err instanceof SweepRefused) throw new BadRequest(err.message);
      throw err;
    }
    redirect(ctx.res, `/app/accounting/trust?m=${encodeURIComponent("Recorded.")}`);
  });

  router.get("/app/accounting/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    await ensureChart(cid);
    const accounts = await all(
      "SELECT id, code, name FROM account WHERE company_id = ? AND active = 1 ORDER BY code", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "accounting", counts: await navCounts(cid),
      title: "New journal", subtitle: "Both sides, or it will not post",
      body: journalForm({ csrf: ctx.csrf, accounts, error: ctx.query.e }),
    }));
  });

  router.post("/app/accounting/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const bad = (m) => redirect(ctx.res, `/app/accounting/new?e=${encodeURIComponent(m)}`);

    /* Four rows on the form. Anything with an account and an amount counts;
       blank rows are simply not splits. */
    const splits = [];
    for (let i = 0; i < 4; i++) {
      const acct = String(f[`account_${i}`] || "");
      const amount = parseMoney(f[`amount_${i}`]);
      const side = f[`side_${i}`];
      if (!acct || amount == null || amount === 0) continue;
      splits.push({
        accountId: acct,
        debit: side === "debit" ? amount : 0,
        credit: side === "credit" ? amount : 0,
        memo: String(f[`memo_${i}`] || "").trim() || null,
      });
    }
    if (splits.length < 2) return bad("A journal needs at least two lines with an account and an amount.");

    try {
      const jid = await postJournal({
        companyId: cid, date: String(f.date || today()), memo: String(f.memo || ""),
        source: "manual", postedBy: ctx.staff.id, splits,
      });
      redirect(ctx.res, `/app/accounting/j/${jid}?m=${encodeURIComponent("Journal posted.")}`);
    } catch (err) {
      return bad(err.message);
    }
  });

  router.get("/app/accounting/j/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const j = await one("SELECT * FROM journal WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const splits = await all(
      `SELECT s.*, a.code, a.name FROM journal_split s JOIN account a ON a.id = s.account_id
        WHERE s.journal_id = ? ORDER BY s.debit_cents DESC`, j.id);
    const dr = splits.reduce((n, s) => n + Number(s.debit_cents), 0);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "accounting", counts: await navCounts(cid),
      title: j.memo, subtitle: `${human(j.date)} · ${usd(dr)} · posted by ${j.posted_by || "system"}`,
      actions: html`<a class="pill outline sm" href="/app/accounting/journals">All journals</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${j.reversed_by ? notice("warn", "Reversed",
          html`This entry was reversed by <a href="/app/accounting/j/${j.reversed_by}">another journal</a>.`) : ""}
        ${j.reverses_id ? notice(null, "This is a reversal",
          html`It undoes <a href="/app/accounting/j/${j.reverses_id}">the original journal</a>.`) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          <div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Account</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
            <tbody>${splits.map((s) => html`
              <tr>
                <td>${s.code} ${s.name}</td>
                <td>${s.memo || "—"}</td>
                <td class="num">${Number(s.debit_cents) ? usd(Number(s.debit_cents)) : ""}</td>
                <td class="num">${Number(s.credit_cents) ? usd(Number(s.credit_cents)) : ""}</td>
              </tr>`)}</tbody>
          </table></div>
        </div></div>
        ${j.reversed_by ? "" : html`
          <div class="panel">
            <div class="panel__head"><h2>Correcting this</h2></div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 0.75rem">
                Posted entries are never edited or deleted. A mistake is corrected by
                posting the mirror image, which leaves both halves on the record.
              </p>
              <form method="post" action="/app/accounting/j/${j.id}/reverse">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill outline" type="submit">Post a reversing journal</button>
              </form>
            </div>
          </div>`}`,
    }));
  });

  router.post("/app/accounting/j/:id/reverse", async (ctx) => {
    const cid = ctx.staff.company_id;
    const jid = await reverseJournal(ctx.params.id, { companyId: cid, by: ctx.staff.id });
    redirect(ctx.res, `/app/accounting/j/${jid}?m=${encodeURIComponent("Reversal posted. Both entries remain on the record.")}`);
  });
}

/* --- views ---------------------------------------------------------------- */

function journalForm({ csrf, accounts, error }) {
  const row = (i) => html`
    <div class="panel__body" style="border-top:1px solid var(--hairline)">
      <div class="formgrid formgrid--2">
        <div class="field">
          <label for="account_${i}">Account ${i + 1}</label>
          <select id="account_${i}" name="account_${i}">
            <option value="">—</option>
            ${accounts.map((a) => html`<option value="${a.id}">${a.code} · ${a.name}</option>`)}
          </select>
        </div>
        <div class="field">
          <label for="amount_${i}">Amount</label>
          <input id="amount_${i}" name="amount_${i}" type="text" inputmode="decimal" placeholder="0.00" />
        </div>
      </div>
      <div class="formgrid formgrid--2">
        <div class="field">
          <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Side</span>
          <div class="radioset">
            <label class="radiotile"><input type="radio" name="side_${i}" value="debit" checked /><span>Debit</span></label>
            <label class="radiotile"><input type="radio" name="side_${i}" value="credit" /><span>Credit</span></label>
          </div>
        </div>
        <div class="field">
          <label for="memo_${i}">Line memo</label>
          <input id="memo_${i}" name="memo_${i}" type="text" maxlength="200" />
        </div>
      </div>
    </div>`;

  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <form method="post" action="/app/accounting/new">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <div class="panel">
        <div class="panel__head"><h2>Journal</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field"><label for="date">Date</label>
              <input id="date" name="date" type="date" required value="${today()}" /></div>
            <div class="field"><label for="memo">Memo</label>
              <input id="memo" name="memo" type="text" required maxlength="200"
                     placeholder="What this entry is for" /></div>
          </div>
        </div>
        ${[0, 1, 2, 3].map(row)}
        <div class="panel__foot">
          Debits must equal credits. If they do not, the database refuses the entry
          and nothing is written.
        </div>
      </div>
      <div class="btnrow">
        <button class="pill solid" type="submit">Post journal</button>
        <a class="pill outline" href="/app/accounting">Cancel</a>
      </div>
    </form>`;
}
