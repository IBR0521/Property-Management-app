/* Staff roles beyond admin/manager, and the late-fee ledger.

   The original CHECK allowed two roles because there were two jobs. A leasing
   agent and a maintenance tech both need the queue and neither needs the bank
   balance, so the constraint has to widen before lib/auth.js can mean anything
   by "role". Dropped by lookup rather than by name: the name is whatever
   Postgres generated when 001 ran, and guessing it wrong fails the migration. */

DO $$
DECLARE cn TEXT;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'staff'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staff DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('admin','manager','accountant','leasing','maintenance'));

/* Late fees.

   Written as their own table rather than only as a ledger line so the sweep can
   ask "have I already charged this lease for this period" with a unique index
   instead of a heuristic over free-text memos. That uniqueness is what makes a
   double run harmless. */
CREATE TABLE late_fee (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,                  -- YYYY-MM the fee is for
  assessed_date TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  -- How it was worked out, kept verbatim so a tenant dispute can be answered
  -- without re-deriving it from rules that may have changed since.
  basis         TEXT NOT NULL,
  rent_cents    BIGINT NOT NULL,
  days_late     INTEGER NOT NULL,
  journal_id    TEXT REFERENCES journal(id),
  ledger_entry_id TEXT REFERENCES ledger_entry(id),
  waived_at     TEXT,
  waived_by     TEXT,
  waived_reason TEXT,
  created_at    TEXT NOT NULL,
  /* One fee per lease per month. The sweep relies on this: it inserts and lets
     the database refuse the duplicate, which is safe even if two runs overlap.
     A SELECT-then-INSERT would not be. */
  UNIQUE (lease_id, period)
);

CREATE INDEX late_fee_company_period_idx ON late_fee (company_id, period);

/* Late fee policy per lease. Nullable throughout: a lease with nothing set
   falls back to the company default in code, and a lease with fee_cents = 0
   is explicitly a lease that is never charged. */
ALTER TABLE lease ADD COLUMN late_fee_cents    INTEGER;
ALTER TABLE lease ADD COLUMN late_fee_percent  REAL;
ALTER TABLE lease ADD COLUMN late_fee_max_cents INTEGER;
ALTER TABLE lease ADD COLUMN late_fee_daily    INTEGER NOT NULL DEFAULT 0;

/* A named lock per job, so two overlapping cron invocations cannot both run the
   sweep. Postgres advisory locks are the mechanism; this table only records
   what ran and when, for the operator. */
CREATE TABLE job_run (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT,
  detail      TEXT
);

CREATE INDEX job_run_name_idx ON job_run (name, started_at);
