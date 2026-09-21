/* Who is going to the job.

   A work order has carried `vendor_id` since 001 — the outside trade being
   dispatched. It has never had a way to say which of the company's own people
   is handling it, because until now every staff member saw the whole queue and
   the question did not arise.

   A technician changes that. They work from a van, on a phone, and have no
   reason to see the rest of the portfolio; "my jobs" has to mean something
   before the role is more than a set of refusals. */
ALTER TABLE work_order ADD COLUMN assigned_staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL;

/* The technician's whole screen is this query, so it gets an index rather
   than a sequential scan of every job the company has ever logged. */
CREATE INDEX work_order_assigned_idx ON work_order (assigned_staff_id, status)
  WHERE assigned_staff_id IS NOT NULL;
