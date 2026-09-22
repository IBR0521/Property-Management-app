/* One write, both books.

   `ledger_entry` answers "what does this owner see" and `journal` answers
   "does the company balance". They are both right to exist, and they were
   being written independently — which meant recording rent told the owner's
   statement and told the company's books nothing.

   Every money movement now goes through `postMoney()`, which writes the
   owner-visible entry and the double-entry journal in one transaction and
   links them. Either both exist or neither does.

   The mapping from one to the other is the interesting part, and it is here
   rather than at the call sites because it is an accounting decision rather
   than a feature decision. A call site knows "the tenant paid nine hundred
   dollars of rent"; it should not also have to know which two accounts that
   debits and credits. */
import { get, insert, run, tx } from "./db.js";
import { id } from "./ids.js";
import { stamp } from "./dates.js";

/* What each `ledger_entry.kind` means in double entry.

   `amount_cents` on a ledger entry is signed from the owner's point of view:
   positive is money towards the owner. The splits below are written from the
   company's, which is why some of them look inverted.

   Every pair is (debit, credit) and both sides name an account code from
   features/accounting.js. */
const POSTINGS = {
  /* Rent charged to a tenant. The owner is owed it before it arrives, so the
     receivable rises and income is recognised. */
  rent_charge: (amount) => [
    { code: "1300", debit: amount, memo: "rent charged" },
    { code: "4000", credit: amount, memo: "rent income" },
  ],

  /* Rent received. Client money, so it lands in trust cash and becomes owed
     to the owner rather than becoming the company's. This is the posting that
     was missing entirely. */
  rent_payment: (amount) => [
    { code: "1010", debit: amount, memo: "rent received into trust" },
    { code: "1300", credit: amount, memo: "tenant receivable cleared" },
  ],

  /* A cost paid on the owner's behalf. Reduces what is owed to them. */
  expense: (amount) => [
    { code: "5000", debit: amount, memo: "property expense" },
    { code: "1010", credit: amount, memo: "paid from trust" },
  ],

  management_fee: (amount) => [
    { code: "2200", debit: amount, memo: "deducted from owner funds" },
    { code: "4200", credit: amount, memo: "management fee earned" },
  ],

  /* A deposit is the tenant's money, held. It is a liability from the moment
     it arrives, and treating it as income is the classic trust-accounting
     failure. */
  deposit_held: (amount) => [
    { code: "1010", debit: amount, memo: "deposit received into trust" },
    { code: "2100", credit: amount, memo: "deposit owed to tenant" },
  ],

  deposit_returned: (amount) => [
    { code: "2100", debit: amount, memo: "deposit liability released" },
    { code: "1010", credit: amount, memo: "paid out of trust" },
  ],

  /* Late fees and anything else the owner sees. Income to the owner's
     position, so trust cash rises and the fee is recognised. */
  other: (amount) => [
    { code: "1200", debit: amount, memo: "charged" },
    { code: "4100", credit: amount, memo: "fee income" },
  ],
};

export function postingFor(kind, amountCents) {
  const build = POSTINGS[kind];
  if (!build) return null;
  const amount = Math.abs(Math.round(Number(amountCents) || 0));
  if (amount === 0) return null;
  return build(amount);
}

/* The one way owner-visible money is recorded.

   Returns { entryId, journalId }. The journal is posted first so the entry can
   carry its id — an entry pointing at a journal that failed to post would be
   worse than either alone, and the enclosing transaction means neither
   survives a failure in the other. */
export async function postMoney({
  companyId, ownerId, propertyId = null, unitId = null, leaseId = null,
  date, kind, amountCents, memo, source = "manual",
  workOrderId = null, receiptPath = null,
  sourceType = null, sourceId = null, postedBy = "system",
  journalSource = null, journalId: existingJournalId = null,
}) {
  const splits = postingFor(kind, amountCents);
  const { postJournal } = await import("../features/accounting.js");

  return await tx(async () => {
    /* A caller that has already posted the double-entry record — a reversal is
       the case that exists — hands it in rather than having a second one
       posted. Without this the mirror entry would either post a duplicate
       journal or carry none at all, and parity would fail either way. */
    let journalId = existingJournalId;

    if (splits && !journalId) {
      journalId = await postJournal({
        companyId, date, memo: memo || kind.replace(/_/g, " "),
        source: journalSource || sourceFor(kind),
        sourceType, sourceId, postedBy,
        splits: splits.map((s) => ({
          ...s,
          ownerId: ownerId || null,
          propertyId, unitId, leaseId,
        })),
      });
    }

    const entryId = id();
    await insert("ledger_entry", {
      id: entryId, company_id: companyId, owner_id: ownerId,
      property_id: propertyId, unit_id: unitId, lease_id: leaseId,
      date, kind, amount_cents: Math.round(Number(amountCents)),
      memo: memo || null, source,
      work_order_id: workOrderId, receipt_path: receiptPath,
      journal_id: journalId,
      created_at: stamp(),
    });

    return { entryId, journalId };
  });
}

function sourceFor(kind) {
  if (kind === "rent_charge" || kind === "rent_payment") return "rent";
  if (kind === "expense") return "maintenance";
  if (kind === "management_fee" || kind.startsWith("deposit")) return "owner";
  return "system";
}

/* --- the parity check -----------------------------------------------------

   Owner-visible money with no double-entry record behind it. The answer should
   always be empty; the test asserts that, and the accounting screen can show
   it so a discrepancy is visible to a person rather than only to a test. */
export async function unpostedEntries(companyId = null) {
  const { all } = await import("./db.js");
  return await all(
    `SELECT e.*, c.name AS company_name
       FROM ledger_entry e
       JOIN company c ON c.id = e.company_id
      WHERE e.journal_id IS NULL
        AND (?::text IS NULL OR e.company_id = ?)
      ORDER BY e.date, e.created_at`,
    companyId, companyId);
}

/* What the two books say, side by side.

   Not a single "are they equal" number, because they measure different
   things: the ledger is one owner's position and the journal is the whole
   company. What must hold is that every ledger entry has a journal behind it,
   and that is what is returned. */
export async function parity(companyId) {
  const row = await get(
    `SELECT
       COUNT(*)::int AS entries,
       COUNT(*) FILTER (WHERE journal_id IS NULL)::int AS unposted,
       COALESCE(SUM(amount_cents) FILTER (WHERE journal_id IS NULL), 0)::bigint AS unposted_cents
     FROM ledger_entry WHERE company_id = ?`, companyId);
  return {
    entries: Number(row?.entries || 0),
    unposted: Number(row?.unposted || 0),
    unpostedCents: Number(row?.unposted_cents || 0),
    inParity: Number(row?.unposted || 0) === 0,
  };
}
