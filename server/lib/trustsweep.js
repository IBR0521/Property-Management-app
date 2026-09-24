/* Moving earned fees out of the trust account.

   A manager's own income should not sit in a client account. It arrives there
   honestly — a tenant sends one payment covering rent and a late fee, and a
   management fee is taken from money already held — and every state that
   regulates trust accounting expects it to be taken out promptly. Until it
   is, the account holds money belonging to nobody it is held for, which is
   the definition of commingling.

   The books have always said so. `book_vs_clients` reads a surplus as "fees
   you have earned and not yet moved to your operating account… it should not
   grow month on month". What has been missing is the other half: a way to
   record having moved it.

   ## This records a transfer; it does not make one

   The same rule as the payouts: the money never passes through this platform.
   Somebody moves it between their own two bank accounts and tells this what
   they did, and the books stop reporting it. There is no integration here and
   there should not be.

       Dr 1000 Operating cash     the manager's own account
       Cr 1010 Trust cash         no longer held in trust

   ## What may be swept, and when it may not

   The sweepable figure is the surplus: what the trust account holds, less
   what is owed to clients. That is the right number **only when the rest of
   the reconciliation is sound**, and the dangerous case is specific — if a
   client liability is missing or negative, the surplus is measured against an
   obligation total that is not real, and sweeping it would move client money
   into the manager's account.

   So a sweep is refused outright while the reconciliation reports any error.
   Not warned about: refused. The whole point of the figure is that it is
   money nobody is owed, and that claim is worthless if the obligation side is
   broken. */
import { all, get, one } from "./db.js";
import { id } from "./ids.js";
import { stamp, today } from "./dates.js";
import { usd } from "./money.js";
import { log } from "./logger.js";

export class SweepRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "SweepRefused";
  }
}

export const CONFIRMATION = "move-earned-fees";

export async function planSweep(companyId, { asOf = today() } = {}) {
  const { trustReconciliation } = await import("./reports/trust.js");
  const rec = await trustReconciliation(companyId, { asOf });

  const surplus = rec.variances.find((v) => v.key === "book_vs_clients");
  const sweepable = Math.max(0, Number(surplus?.cents || 0));

  /* Every error the reconciliation found. While any of them stands, the
     surplus is not a number anybody should act on. */
  const blocked = (rec.findings || [])
    .filter((f) => f.severity === "error")
    .map((f) => ({ title: f.title, detail: f.detail }));

  /* Not blocking, but worth saying. A book the bank has not been reconciled
     against could be wrong in either direction, and a sweep is the one moment
     that turns a book figure into a real transfer. */
  const warnings = [];
  if (rec.legs.bank.unavailable) {
    warnings.push({
      title: "The bank has not been compared against the book",
      detail: `${rec.legs.bank.unavailable}. The figure below is what your records say the `
        + "trust account holds, not what the bank says. Check the balance before you move it.",
    });
  }

  const history = await all(
    `SELECT j.id, j.date, j.memo, j.created_at,
            COALESCE(SUM(s.debit_cents), 0)::bigint AS cents
       FROM journal j JOIN journal_split s ON s.journal_id = j.id
       JOIN account a ON a.id = s.account_id
      WHERE j.company_id = ? AND j.source_type = 'trust_sweep' AND a.code = '1000'
      GROUP BY j.id, j.date, j.memo, j.created_at
      ORDER BY j.date DESC, j.created_at DESC
      LIMIT 12`, companyId);

  return {
    asOf,
    sweepableCents: blocked.length ? 0 : sweepable,
    surplusCents: sweepable,
    trustCashCents: rec.legs.book.cents,
    clientsCents: rec.legs.clients.cents,
    blocked, warnings,
    history: history.map((h) => ({
      journalId: h.id, date: h.date, memo: h.memo, cents: Number(h.cents),
    })),
  };
}

export async function commitSweep({
  companyId, amountCents, date = today(), reference = null,
  by = "system", confirm = null,
}) {
  if (confirm !== CONFIRMATION) {
    throw new SweepRefused(
      `This records money leaving the trust account. Confirm with "${CONFIRMATION}".`);
  }

  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new SweepRefused("A sweep has to be a positive amount.");
  }

  /* Re-planned here rather than trusting what a screen was shown. The figure
     may have moved between the page being drawn and the form being posted,
     and this is the moment it matters. */
  const plan = await planSweep(companyId, { asOf: date });
  if (plan.blocked.length) {
    throw new SweepRefused(
      `The trust reconciliation has a problem that has to be fixed first: `
      + `${plan.blocked[0].title}. Until it is, the surplus is measured against an `
      + `obligation total that is not real, and moving it could take client money.`);
  }
  if (cents > plan.sweepableCents) {
    throw new SweepRefused(
      `Only ${usd(plan.sweepableCents)} is yours to move. The rest of what the trust `
      + `account holds is owed to clients.`);
  }

  const { postJournal, ACCT } = await import("../features/accounting.js");
  const sweepId = id();
  const memo = reference
    ? `Earned fees moved to operating — ${reference}`
    : "Earned fees moved to operating";

  const journalId = await postJournal({
    companyId, date, memo,
    source: "manual", sourceType: "trust_sweep", sourceId: sweepId, postedBy: by,
    splits: [
      { code: ACCT.CASH, debit: cents, memo: "into the operating account" },
      { code: ACCT.TRUST_CASH, credit: cents, memo: "no longer held in trust" },
    ],
  });

  log.info("trust sweep recorded", { companyId, cents, journalId, by });
  return { journalId, sweepId, cents, date };
}

export function describeSweep(plan) {
  const lines = [];
  if (plan.blocked.length) {
    lines.push("Nothing can be moved while the reconciliation has a problem:");
    for (const b of plan.blocked) lines.push(`  ${b.title}`);
    return lines.join("\n");
  }
  lines.push(`Trust account holds  ${usd(plan.trustCashCents)}`);
  lines.push(`Owed to clients      ${usd(plan.clientsCents)}`);
  lines.push(`Yours to move        ${usd(plan.sweepableCents)}`);
  for (const w of plan.warnings) lines.push(`\n  ! ${w.title}`);
  return lines.join("\n");
}
