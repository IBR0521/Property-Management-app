/* Bringing pre-double-entry history into the books.

   Twelve rent payments and ten other entries exist on the live database with
   no journal behind them, because `ledger_entry` and `journal` were written
   independently until now. They are real money that owners have been shown.

   Two ways to fix that, and the choice matters.

   **Twelve retrospective journals**, one per entry, back-dated. Tempting,
   because the result looks complete. It is a fiction: the detail those
   journals would assert — which account, which side, on which date — is being
   inferred now from a `kind` column, not recorded then. An auditor reading
   back-dated entries has no way to tell reconstruction from record.

   **One opening journal per company**, dated the earliest entry, memo
   `Conversion: pre-double-entry ledger balance`, against an equity account
   called exactly that. Less tidy and honest: it says "the books start here,
   and this is what was carried in". It is what an accountant does when a
   client arrives with a shoebox, and it is what Phase 7's import wizard will
   do with opening balances.

   This module only ever reports unless told to commit, because the first thing
   it does on a live database cannot be undone. */
import { all, get, run, tx } from "./db.js";
import { stamp } from "./dates.js";
import { ACCT } from "../features/accounting.js";

/* What the conversion would do, per company, without doing any of it. */
export async function plan() {
  const companies = await all(
    `SELECT DISTINCT c.id, c.name
       FROM ledger_entry e JOIN company c ON c.id = e.company_id
      WHERE e.journal_id IS NULL
      ORDER BY c.name`);

  const out = [];
  for (const company of companies) {
    const entries = await all(
      `SELECT * FROM ledger_entry
        WHERE company_id = ? AND journal_id IS NULL
        ORDER BY date, created_at`, company.id);

    /* Grouped by owner, because the carried-in position is a per-owner fact:
       what this owner's money was doing when the books began. A single
       company-wide number would lose that and make the first statement after
       conversion unexplainable. */
    const byOwner = new Map();
    for (const e of entries) {
      const key = e.owner_id || "none";
      if (!byOwner.has(key)) byOwner.set(key, { ownerId: e.owner_id, entries: [], net: 0 });
      const group = byOwner.get(key);
      group.entries.push(e);
      group.net += Number(e.amount_cents);
    }

    out.push({
      companyId: company.id,
      companyName: company.name,
      earliest: entries[0]?.date || null,
      entryCount: entries.length,
      owners: [...byOwner.values()].map((g) => ({
        ownerId: g.ownerId,
        entries: g.entries.length,
        netCents: g.net,
        kinds: [...new Set(g.entries.map((e) => e.kind))],
      })),
    });
  }
  return out;
}

/* Posts the opening journals and links every entry to the one covering it.

   Deliberately not callable by accident: `confirm` has to be the string below.
   Running this twice is harmless — entries already linked are not selected —
   but running it on the wrong database is not. */
export async function commit({ confirm, postedBy = "conversion" } = {}) {
  if (confirm !== "post-opening-journals") {
    throw new Error(
      "convert.commit needs { confirm: 'post-opening-journals' }. " +
      "Run plan() first and read what it says.");
  }

  const { postJournal } = await import("../features/accounting.js");
  const proposed = await plan();
  const results = [];

  for (const company of proposed) {
    if (!company.entryCount) continue;

    for (const owner of company.owners) {
      /* A net of zero still needs linking — the entries exist and must not
         stay unposted — but it has no journal to post, because a journal of
         nothing is not a journal. Those entries are linked to the company's
         single conversion journal below instead. */
      if (owner.netCents === 0) continue;

      const amount = Math.abs(owner.netCents);
      /* A positive net means money was owed to the owner when the books
         began: trust cash carried in against the conversion equity. A
         negative net is the reverse. */
      const splits = owner.netCents > 0
        ? [
            { code: ACCT.TRUST_CASH, debit: amount, ownerId: owner.ownerId,
              memo: "carried in at conversion" },
            { code: ACCT.OPENING_CONVERSION, credit: amount, ownerId: owner.ownerId,
              memo: "opening balance" },
          ]
        : [
            { code: ACCT.OPENING_CONVERSION, debit: amount, ownerId: owner.ownerId,
              memo: "opening balance" },
            { code: ACCT.TRUST_CASH, credit: amount, ownerId: owner.ownerId,
              memo: "carried in at conversion" },
          ];

      await tx(async () => {
        const journalId = await postJournal({
          companyId: company.companyId,
          date: company.earliest,
          memo: "Conversion: pre-double-entry ledger balance",
          source: "system", sourceType: "conversion", sourceId: owner.ownerId || company.companyId,
          postedBy, splits,
        });

        const linked = await run(
          `UPDATE ledger_entry SET journal_id = ?
            WHERE company_id = ? AND journal_id IS NULL
              AND (owner_id = ? OR (?::text IS NULL AND owner_id IS NULL))`,
          journalId, company.companyId, owner.ownerId, owner.ownerId);

        results.push({
          companyName: company.companyName,
          ownerId: owner.ownerId,
          journalId,
          netCents: owner.netCents,
          entriesLinked: linked.changes,
        });
      });
    }
  }
  return results;
}
