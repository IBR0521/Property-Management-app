/* Money a tenant pays every month that is not rent.

   A lease here has one rent and one due day. AppFolio, Buildium and Rent
   Manager bill several lines against a lease, so an export where a tenant
   pays $1,450 rent, $50 for the dog and $75 for a space has always imported
   as $1,450 and lost $125 a month, on every lease, for ever. The importer has
   known — `RECURRING_MONEY` in `lib/import/mappings.js` is a curated list of
   thirty column names it warns it cannot read. This is the other half.

   ## `payee` is the field this table exists for

   Whose income a charge is decides its posting, and getting it wrong is not a
   reporting error:

     owner     Dr 1300 tenant receivable / Cr 2400 rent due to owners,
               then 2400 -> 2200 when the money arrives. Exactly like rent,
               because it *is* the owner's money: the dog lives in the
               owner's property and the space is the owner's space.

     manager   Dr 1200 rent receivable / Cr 4100 fee income. Exactly like a
               late fee, because it is the manager's own charge.

   Putting the manager's income into the trust account is commingling, and
   taking the owner's income out of it is worse. So the column is NOT NULL
   with no default: a charge that has not said whose it is cannot be created.

   ## Only `owner` works today, and the check says so

   A tenant paying a manager-income charge lands money in trust cash (1010)
   against a non-trust receivable (1200), which raises trust assets with no
   matching client liability — the reconciliation would fail by the fee, every
   month. Settling that properly needs a "due to the manager from trust"
   liability and a sweep to move it out, which is its own piece of work.
   Nothing credits 1200 today either: late fees have been charged to it since
   Phase 1 and no path has ever cleared one.

   Rather than ship a posting that is wrong in a way only a reconciliation
   would catch, the constraint below allows the value and the model refuses
   it, in words, naming why. Widening it is a code change and a test, not a
   migration. */

CREATE TABLE recurring_charge (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,

  label         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  payee         TEXT NOT NULL CHECK (payee IN ('owner', 'manager')),
  frequency     TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly')),

  /* When it runs. `end_date` null means until the lease ends. */
  start_date    TEXT NOT NULL,
  end_date      TEXT,

  /* Whether a partial month is charged in full or in part. A pet rent is
     prorated like rent; a flat monthly administration charge is not, because
     the administration happened. */
  prorate       INTEGER NOT NULL DEFAULT 1 CHECK (prorate IN (0, 1)),

  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),

  /* So a re-run of an import updates rather than duplicates, the same shape
     `lease_source_idx` uses. */
  source_system TEXT,
  source_id     TEXT,

  created_at    TEXT NOT NULL,
  created_by    TEXT,

  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX recurring_charge_lease_idx ON recurring_charge (lease_id) WHERE active = 1;
CREATE INDEX recurring_charge_company_idx ON recurring_charge (company_id);

CREATE UNIQUE INDEX recurring_charge_source_idx
  ON recurring_charge (company_id, source_system, source_id)
  WHERE source_id IS NOT NULL;

/* Charged once per period, and the database is what guarantees it.

   The same shape as `journal_one_rent_charge_per_period`, and for the same
   reason: two overlapping ticks both pass a check-then-insert, and the window
   between the check and the insert is exactly where a double charge lives.
   `source_id` carries `<chargeId>:<period>`. */
CREATE UNIQUE INDEX journal_one_recurring_charge_per_period
  ON journal (company_id, source_id)
  WHERE source_type = 'recurring_charge'
    AND reverses_id IS NULL AND reversed_by IS NULL;
