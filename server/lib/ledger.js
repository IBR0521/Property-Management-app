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
  /* Rent charged to a tenant.

     Charges are posted per lease per period by `rentcharge.js`, from the
     lease, not typed against an owner — so nothing in the application reaches
     this any more. The rule stays, and stays correct, because `postMoney`
     writes a ledger entry with no journal behind it when a kind has no
     posting, and a silent parity break is a far worse outcome than a rule
     nobody calls.

     It credits 2400 and not 2200. 2200 is a trust liability, and saying you
     owe an owner money you have not collected makes the trust reconciliation
     fail by exactly the arrears, for ever. */
  rent_charge: (amount) => [
    { code: "1300", debit: amount, memo: "rent charged" },
    { code: "2400", credit: amount, memo: "owed to owner when collected" },
  ],

  /* Rent received. The part that is always true: the money arrived and it is
     the owner's. Whether it also clears a charge depends on whether there is
     one, which a table cannot ask — `rentPaymentSplits` adds that second pair
     when there is something to clear. */
  rent_payment: (amount) => [
    { code: "1010", debit: amount, memo: "rent received into trust" },
    { code: "2200", credit: amount, memo: "held for the owner" },
  ],

  /* A cost paid on the owner's behalf, out of the owner's money.

     It used to debit 5000 Repairs — the manager's own expense account — which
     recorded the owner's cost as a cost of running the management business.
     The manager's P&L carried repairs it never bore, and 2200 was never
     reduced by money that had genuinely left the owner's funds. An agent
     spending a client's money reduces what is owed to that client; it does
     not incur an expense. */
  expense: (amount) => [
    { code: "2200", debit: amount, memo: "reduces what is owed to the owner" },
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

/* Rent received, which is two things happening at once.

   **The money arrives and it is the owner's.** Always true, whatever was
   charged:

       Dr 1010 Trust cash          Cr 2200 Owner funds held

   **And a claim on the tenant turns into money in hand** — but only as far as
   there was a claim:

       Dr 2400 Rent due to owners  Cr 1300 Tenant receivable

   The second pair is capped at what is actually outstanding, and that cap is
   the whole reason this cannot be a line in a table. A tenant paying next
   month early has no charge to clear: releasing 2400 anyway would take an
   obligation off the books that was never put on it, and drive a liability
   account negative on a tenancy where nobody has done anything wrong.

   Capped, the overpayment simply stays in 2200 — held for the owner, which is
   exactly what it is. */
async function rentPaymentSplits({ companyId, leaseId, amount }) {
  const outstanding = await outstandingReceivable(companyId, leaseId);
  const clearing = Math.min(amount, Math.max(0, outstanding));
  const early = amount - clearing;

  /* The money is in the trust account either way. */
  const splits = [
    { code: "1010", debit: amount, memo: "rent received into trust" },
  ];

  if (clearing > 0) {
    /* A charge existed, so the claim on the tenant becomes money in hand and
       the obligation moves from uncollected to genuinely owed. */
    splits.push(
      { code: "1300", credit: clearing, memo: "tenant receivable cleared" },
      { code: "2400", debit: clearing, memo: "uncollected rent now collected" },
      { code: "2200", credit: clearing, memo: "held for the owner" },
    );
  }

  if (early > 0) {
    /* Paid ahead of a charge. It is not the owner's yet — nothing has been
       billed for it — so it is held as prepaid rent, which is a trust
       liability like any other client money. 2300 already exists for exactly
       this and had never been posted to.

       The tempting shortcut is to credit 2200 and be done. That would say the
       owner is owed rent for a month nobody has charged, and the month the
       charge finally lands the owner would be credited twice. */
    splits.push(
      { code: "2300", credit: early, memo: "paid ahead of a charge" },
    );
  }

  return splits;
}

/* What this lease has paid ahead, held and not yet earned. */
export async function prepaidBalance(companyId, leaseId) {
  if (!leaseId) return 0;
  const { get: getOne } = await import("./db.js");
  const row = await getOne(
    `SELECT COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = '2300' AND s.lease_id = ?`,
    companyId, leaseId);
  return Number(row?.cents || 0);
}

/* What this lease has been charged and not yet paid, from the book rather
   than from an expectation. Null lease — a payment recorded against an owner
   with no tenancy named — clears nothing, which is the safe answer. */
export async function outstandingReceivable(companyId, leaseId) {
  if (!leaseId) return 0;
  const { get: getOne } = await import("./db.js");
  const row = await getOne(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.company_id = ? AND a.code = '1300' AND s.lease_id = ?`,
    companyId, leaseId);
  return Number(row?.cents || 0);
}

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
  const amount = Math.abs(Math.round(Number(amountCents) || 0));

  /* Rent received splits across two liabilities — earned and held — but the
     owner's statement gets the whole receipt, because the whole receipt is
     theirs: 2200 and 2300 are both money this company holds for that owner,
     and the reconciliation compares their sum against the owner ledgers. */
  const splits = kind === "rent_payment" && amount > 0
    ? await rentPaymentSplits({ companyId, leaseId, amount })
    : postingFor(kind, amountCents);
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

    /* Inside the transaction, so a payment either reached both books and is
       queued for anybody listening, or none of the three happened.

       Here rather than at the call sites because this is the one writer of
       owner-visible money: a screen, the API, a bank import and the autopay
       run all come through it, and an event emitted per call site would be
       four chances to forget. */
    /* Positive only. A `rent_payment` for a negative amount is a reversal —
       `returnPayment` posts one when the bank takes a payment back — and
       telling a receiver that a payment of minus fourteen hundred dollars was
       *recorded* is worse than telling them nothing. The return has its own
       event, which says what actually happened and what it did to the lease. */
    if (kind === "rent_payment" && Math.round(Number(amountCents)) > 0) {
      const [{ emit }, { paymentPayload }] = await Promise.all([
        import("./webhooks/events.js"), import("./webhooks/payloads.js")]);
      await emit({
        companyId, event: "payment.recorded",
        data: await paymentPayload({ entryId, journalId }),
      });
    }

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
