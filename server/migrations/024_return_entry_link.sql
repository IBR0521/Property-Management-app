/* The correcting entry a return leaves behind.

   `ledger_entry_id` records where a settlement landed on the owner's
   statement. A return adds a second, negative entry, and nothing pointed at
   it — which mattered more than it sounds.

   "How much rent has been paid for this month" was answered by summing ledger
   entries dated within 45 days of the 1st. That works while a payment settles
   a few days after it is made. It breaks on a return, because a return can
   arrive sixty days later: the correcting entry falls outside the window, the
   sum still counts the original, and the delinquency stays closed on rent that
   bounced. The tenant is not chased and the owner is not told.

   With both entries identified, the sum can be computed from the payments'
   own status for the period rather than from where their entries happen to
   fall on a calendar, and manual recordings keep the dated behaviour they
   have always had. */

ALTER TABLE tenant_payment ADD COLUMN reversal_ledger_entry_id TEXT REFERENCES ledger_entry(id);
