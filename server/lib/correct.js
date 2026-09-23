/* Correcting journals posted under the old rules.

   Two postings were wrong for as long as this application has had books.

   **Rent received** credited `1300 Tenant receivable` to clear a charge that
   was never made, instead of crediting `2200 Owner funds held`. The receivable
   ran to minus thirteen thousand dollars on seeded data and the owners' money
   was recorded nowhere.

   **A repair paid on an owner's behalf** debited `5000 Repairs` — the
   manager's own expense account — so the manager's P&L carried costs it never
   bore, and the owner's funds were never reduced by money that had genuinely
   left them.

   ## What this does, and what it deliberately does not

   It **reclassifies**: for each journal posted under an old rule, it posts a
   correcting journal that moves the misposted leg. The original stays exactly
   where it is, the correction sits beside it, and the pair reads as what it
   is — a mistake and its repair. The journal is append-only, so this is the
   only honest shape available anyway.

   It does **not** back-post the rent charges that were never raised. The
   argument is the one `convert.js` made about retrospective journals and it
   has not got weaker: the detail such a charge would assert — which month,
   what proration, on which day — is being inferred now from a lease row, not
   recorded then. Every historical charge was in any case paid, so charging it
   and clearing it nets to nothing on the receivable. Rent is charged from here
   on by the scheduler, where the detail is real.

   ## The date

   The later of the original's date and the day after the books were closed.
   A company that has never closed a period gets its history corrected in
   place. A company that closed December gets the correction in January with a
   memo saying which period it belongs to — because a posting landing behind a
   filed trust reconciliation does not fix it, it makes a document that was
   signed as true retroactively false.

   ## It reports unless told to commit

   Like `convert.js`, and for the same reason: the first thing this does on a
   live database cannot be undone. */
import { all, get, one } from "./db.js";
import { today, human, addDays } from "./dates.js";
import { usd } from "./money.js";

/* The signatures of the old rules. Two splits each, and unambiguous: the
   vendor-invoice path credits 2000 rather than 1010, so nothing else in the
   application produces either shape. */
const OLD_RULES = {
  rent_payment: {
    label: "Rent received, credited to the receivable instead of the owner",
    debit: "1010", credit: "1300",
    /* The money was the owner's the moment it arrived. Moving the credit off
       the receivable and onto owner funds is the whole correction. */
    fix: (amount) => [
      { code: "1300", debit: amount, memo: "correcting: rent was not a receivable clearance" },
      { code: "2200", credit: amount, memo: "correcting: rent received is the owner's" },
    ],
  },
  owner_expense: {
    label: "An owner's cost booked as the manager's expense",
    debit: "5000", credit: "1010",
    /* An agent spending a client's money reduces what is owed to that client.
       It does not incur an expense. */
    fix: (amount) => [
      { code: "2200", debit: amount, memo: "correcting: the cost was the owner's" },
      { code: "5000", credit: amount, memo: "correcting: not the manager's expense" },
    ],
  },
};

/* Journals matching an old rule that have not already been corrected.

   Matched on the shape of the splits rather than on `source`, because source
   is a label a call site chose and the splits are what actually happened. */
async function misposted(companyId, rule) {
  return await all(
    `SELECT j.id, j.date, j.memo, j.source_type, j.source_id,
            ds.debit_cents::bigint AS cents,
            ds.owner_id, ds.property_id, ds.unit_id, ds.lease_id
       FROM journal j
       JOIN journal_split ds ON ds.journal_id = j.id
       JOIN account da ON da.id = ds.account_id AND da.code = ?
       JOIN journal_split cs ON cs.journal_id = j.id
       JOIN account ca ON ca.id = cs.account_id AND ca.code = ?
      WHERE j.company_id = ?
        AND ds.debit_cents > 0 AND cs.credit_cents > 0
        AND j.reverses_id IS NULL
        AND j.reversed_by IS NULL
        /* Exactly two splits: the corrected postings have four, or two
           against different accounts, so shape alone separates them. */
        AND (SELECT COUNT(*) FROM journal_split x WHERE x.journal_id = j.id) = 2
        /* Not already put right. */
        AND NOT EXISTS (
          SELECT 1 FROM journal c
           WHERE c.company_id = j.company_id
             AND c.source_type = 'posting_correction'
             AND c.source_id = j.id)
      ORDER BY j.date, j.created_at`,
    rule.debit, rule.credit, companyId);
}

/* --- what it would do ------------------------------------------------------- */

export async function plan({ companyId = null } = {}) {
  const companies = companyId
    ? await all("SELECT id, name, books_closed_through FROM company WHERE id = ?", companyId)
    : await all("SELECT id, name, books_closed_through FROM company ORDER BY name");

  const out = [];
  for (const company of companies) {
    const closed = company.books_closed_through || null;
    const groups = [];

    for (const [key, rule] of Object.entries(OLD_RULES)) {
      const rows = await misposted(company.id, rule);
      if (!rows.length) continue;

      groups.push({
        key, label: rule.label,
        count: rows.length,
        cents: rows.reduce((n, r) => n + Number(r.cents), 0),
        /* Where each correction would land, which is the question the close
           date exists to answer. */
        journals: rows.map((r) => ({
          journalId: r.id,
          originalDate: r.date,
          correctionDate: correctionDateFor(r.date, closed),
          movedPeriod: correctionDateFor(r.date, closed) !== r.date,
          cents: Number(r.cents),
          memo: r.memo,
          ownerId: r.owner_id, propertyId: r.property_id,
          unitId: r.unit_id, leaseId: r.lease_id,
        })),
      });
    }

    if (!groups.length) continue;

    out.push({
      companyId: company.id, name: company.name,
      closedThrough: closed,
      groups,
      totalJournals: groups.reduce((n, g) => n + g.count, 0),
      movedOutOfPeriod: groups.reduce(
        (n, g) => n + g.journals.filter((j) => j.movedPeriod).length, 0),
    });
  }
  return out;
}

/* The later of the original's date and the first open day after the close. */
export function correctionDateFor(originalDate, closedThrough) {
  if (!closedThrough) return originalDate;
  if (originalDate > closedThrough) return originalDate;
  const firstOpen = addDays(closedThrough, 1);
  /* A close date in the future would push corrections into the future too,
     which is worse than being a day late. */
  return firstOpen > today() ? today() : firstOpen;
}

/* A plan as text, for somebody about to run this against a live database. */
export function describe(planned) {
  if (!planned.length) return "Nothing to correct: no journal matches an old posting rule.\n";

  const lines = [];
  for (const company of planned) {
    lines.push(`${company.name}`);
    lines.push(`  books closed through: ${company.closedThrough ? human(company.closedThrough) : "never closed"}`);
    for (const g of company.groups) {
      lines.push(`  ${g.count} × ${g.label}`);
      lines.push(`      ${usd(g.cents)}`);
    }
    lines.push(company.movedOutOfPeriod
      ? `  ${company.movedOutOfPeriod} correction(s) land in a later period, because the original is in closed books`
      : "  every correction lands on the date of the posting it corrects");
    lines.push("");
  }
  return lines.join("\n");
}

/* --- doing it ---------------------------------------------------------------- */

export async function commit({ confirm, companyId = null, postedBy = "correction" } = {}) {
  if (confirm !== "correct-postings") {
    throw new Error(
      "correct.commit needs { confirm: 'correct-postings' }. "
      + "Run plan() first and read what it says.");
  }

  const { postJournal } = await import("../features/accounting.js");
  const planned = await plan({ companyId });
  const results = [];

  for (const company of planned) {
    let posted = 0, cents = 0, refused = 0;

    for (const group of company.groups) {
      const rule = OLD_RULES[group.key];

      for (const j of group.journals) {
        const note = j.movedPeriod
          ? ` (belongs to ${human(j.originalDate)}, posted here because the books are closed through ${human(company.closedThrough)})`
          : "";

        try {
          await postJournal({
            companyId: company.companyId,
            date: j.correctionDate,
            memo: `Correcting a posting: ${rule.label}${note}`,
            /* `source` is a closed list on the journal table and a correction
               is not one of its members. `source_type` is the specific field
               and carries it, which is the one reports and the audit trail
               actually read. */
            source: "system",
            sourceType: "posting_correction",
            /* The journal being corrected, so "why does this exist" is a
               join rather than an archaeology exercise. */
            sourceId: j.journalId,
            postedBy,
            splits: rule.fix(j.cents).map((s) => ({
              ...s,
              ownerId: j.ownerId, propertyId: j.propertyId,
              unitId: j.unitId, leaseId: j.leaseId,
            })),
          });
          posted += 1;
          cents += j.cents;
        } catch (err) {
          /* A closed period should already have been routed around by the
             date calculation. If one still refuses, it is counted and named
             rather than aborting every other company's correction. */
          if (err?.periodClosed) { refused += 1; continue; }
          throw err;
        }
      }
    }

    results.push({
      companyId: company.companyId, name: company.name,
      posted, cents, refused,
    });
  }

  return results;
}
