/* Charging rent.

   Rent was received and never charged. `4000 Rent income` was credited by one
   posting rule that nothing invoked, `1300 Tenant receivable` accumulated
   credits clearing charges that were never made, and on seeded data it sat at
   minus thirteen thousand dollars — an asset account below zero.

   What goes in is the other half: a charge, posted per lease per period.

   The account it credits is new and the choice matters. An earlier draft had
   the charge credit `2200 Owner funds held`, which is a **trust** liability,
   against `1300`, which is not a trust asset. Every unpaid charge would have
   pushed trust liabilities above trust assets, so the three-way reconciliation
   would have failed by exactly the arrears, permanently, by construction.

   The principle underneath: you do not owe an owner money you have not
   collected. Charging rent creates a claim on a tenant, not an obligation to
   an owner, so the charge lands on a non-trust liability and only receipt
   moves it into trust. */

-- --- how a part month is charged --------------------------------------------

/* A lease starting on the 18th does not owe a full month, and what it does owe
   is convention rather than arithmetic. Per company, because US practice
   varies by state, by firm and by the lease. */
ALTER TABLE company ADD COLUMN proration_basis TEXT NOT NULL DEFAULT 'daily_actual'
  CHECK (proration_basis IN ('daily_actual', 'daily_30', 'full_month'));

-- --- one live charge per lease per period -----------------------------------

/* The database enforces it, not the job. A scheduler that runs twice in a
   minute, or catches up after the process was down for a week, must not
   charge a tenant twice — and "the code checks first" is the kind of guarantee
   that holds until two ticks overlap.

   `source_id` carries `<leaseId>:<period>`, so the uniqueness is exactly the
   statement "this lease has been charged for this month".

   Two exclusions, and both earn their place. A reversal carries the same
   source id as the journal it reverses, so it must not collide with it. And a
   journal that *has been* reversed drops out of the index the moment
   `reversed_by` is set — which is what makes a correction possible: reverse
   the wrong charge and the slot frees up for the right one. */
CREATE UNIQUE INDEX journal_one_rent_charge_per_period
  ON journal (company_id, source_id)
  WHERE source_type = 'rent_charge'
    AND reverses_id IS NULL
    AND reversed_by IS NULL;

-- --- the dimension every property report reads ------------------------------

/* There is an index on journal_split (owner_id) and none on property_id, so a
   P&L by property scans every split in the company. Cheap now, expensive to
   notice later. */
CREATE INDEX journal_split_property_idx ON journal_split (property_id)
  WHERE property_id IS NOT NULL;
