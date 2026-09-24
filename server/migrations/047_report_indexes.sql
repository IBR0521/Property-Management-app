/* Indexes the load test asked for.

   Found by seeding 2,000 units and five years and measuring every screen,
   which is the only way any of this is findable: at nine units every plan
   looks the same.

   `ledger_entry (lease_id, date)` — the rent screen sums a tenancy's payments
   for a month, once per tenancy. There was an index on `(company_id, date)`
   and one on `(owner_id, date)` and none on the lease, so each of two
   thousand sums scanned. */
CREATE INDEX ledger_entry_lease_date_idx ON ledger_entry (lease_id, date)
  WHERE lease_id IS NOT NULL;

/* `delinquency (lease_id, period)` — joined per tenancy by the same screen,
   and by the late-fee sweep every night. */
CREATE INDEX delinquency_lease_period_idx ON delinquency (lease_id, period);

/* `work_order (company_id, status)` already exists for the queue. This is the
   other question the queue asks: what is open, oldest first. */
CREATE INDEX work_order_open_idx ON work_order (company_id, created_at)
  WHERE status NOT IN ('complete', 'cancelled');
