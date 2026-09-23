/* One repair, one cost.

   A repair could be recorded twice. `vendor_invoice.work_order_id` links a
   bill to a job, and closing that job records `actual_cents` independently.
   Both posted a cost, nothing stopped a manager doing both, and no seeded row
   ever did — so it had never been seen. It would have surfaced as inflated
   expenses on the first P&L by property, against an owner who had been charged
   twice for one repair.

   ## Which one is the truth

   The contractor's invoice, when there is one. The close-out figure is what
   the person who did the work recorded; the invoice is the document money is
   actually paid against, and it is the one an owner can be shown. So:

     closing a job with an invoice already on it   records the figure,
                                                   posts nothing, and says so
     an invoice arriving after a close-out         supersedes it: the
                                                   close-out posting is
                                                   reversed and the invoice
                                                   posted in its place

   Both orders are covered because both happen. A technician finishing on
   Tuesday and the bill arriving on Friday is the common one; a manager
   entering the bill first and closing the job afterwards is not rare.

   ## Superseding, not editing

   The journal is append-only, so the close-out posting is reversed rather
   than changed, and the owner's ledger gets a mirroring entry so the two books
   do not drift apart. Both halves stay visible: what was recorded when the job
   was done, and what the bill turned out to be. That difference is worth
   seeing. */
import { all, get, one } from "./db.js";
import { today } from "./dates.js";
import { usd } from "./money.js";
import { log } from "./logger.js";

/* The live cost posting for a work order, or null. Live meaning not itself a
   reversal and not already reversed — a superseded one does not count. */
export async function costPostingFor(companyId, workOrderId) {
  return await get(
    `SELECT * FROM journal
      WHERE company_id = ? AND source_type = 'work_order' AND source_id = ?
        AND reverses_id IS NULL AND reversed_by IS NULL
      ORDER BY created_at LIMIT 1`,
    companyId, workOrderId);
}

/* An invoice already attached to this job, if any. A voided one does not
   count: the bill was withdrawn, so it is not the truth about anything.

   The status is 'void'. An earlier version of this excluded 'cancelled',
   which is not a value this column can hold — so it excluded nothing, and a
   withdrawn bill would still have blocked the close-out from posting. Found
   by a test that asserted the behaviour rather than the query. */
export async function invoiceFor(companyId, workOrderId) {
  if (!workOrderId) return null;
  return await get(
    `SELECT * FROM vendor_invoice
      WHERE company_id = ? AND work_order_id = ? AND status <> 'void'
      ORDER BY created_at LIMIT 1`,
    companyId, workOrderId);
}

/* Whether closing this job should post its cost, and if not, why not — so the
   screen can say it rather than leaving somebody to wonder where their number
   went. */
export async function shouldPostCloseOutCost(companyId, workOrderId) {
  const invoice = await invoiceFor(companyId, workOrderId);
  if (!invoice) return { post: true, invoice: null, reason: null };

  return {
    post: false,
    invoice,
    reason: `${usd(Number(invoice.amount_cents) + Number(invoice.tax_cents || 0))} has already been `
      + "billed by the contractor for this job, so the cost comes from their invoice. "
      + "The figure entered here is recorded on the job and not posted again.",
  };
}

/* Take the close-out posting back out, because the bill has arrived and it is
   the one that counts.

   Two halves, and both matter. The journal is reversed, which leaves the
   original and its mirror image visible for ever. And the owner-visible ledger
   entry is mirrored too, linked to that reversal — without which the owner's
   statement would still carry the close-out figure while the books carried the
   invoice, and the control account and the subsidiary ledger would disagree by
   the difference. */
export async function supersedeCloseOutCost({ companyId, workOrderId, by, date, reason }) {
  const posting = await costPostingFor(companyId, workOrderId);
  if (!posting) return { superseded: false, cents: 0 };

  const { reverseJournal } = await import("../features/accounting.js");
  const { postMoney } = await import("./ledger.js");

  const entry = await get(
    `SELECT * FROM ledger_entry
      WHERE company_id = ? AND journal_id = ?`, companyId, posting.id);

  const reversalId = await reverseJournal(posting.id, {
    companyId, by: by || "system", date: date || today(),
    memo: reason || `Superseded: ${posting.memo}`,
  });

  if (entry) {
    /* The mirror, carrying the reversal's id rather than posting a second
       journal of its own. `postMoney` takes a journal that already exists for
       exactly this case. */
    await postMoney({
      companyId, ownerId: entry.owner_id,
      propertyId: entry.property_id, unitId: entry.unit_id, leaseId: entry.lease_id,
      date: date || today(), kind: entry.kind,
      amountCents: -Number(entry.amount_cents),
      memo: reason || "Superseded by the contractor's invoice",
      source: entry.source, workOrderId,
      sourceType: "work_order", sourceId: workOrderId,
      postedBy: by || "system",
      journalId: reversalId,
    });
  }

  log.info("close-out cost superseded by an invoice", { workOrderId });
  return { superseded: true, cents: Math.abs(Number(entry?.amount_cents || 0)), reversalId };
}
