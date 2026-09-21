/* Contractor compliance, invoicing and 1099 reporting.

   The point of the insurance columns is the barrier they drive: an uninsured
   contractor who damages a property becomes the manager's problem, and the
   moment to discover an expired certificate is before dispatch, not after. So
   the dates live next to the vendor and the check runs in the dispatch path. */

ALTER TABLE vendor ADD COLUMN legal_name        TEXT;
ALTER TABLE vendor ADD COLUMN address           TEXT;
ALTER TABLE vendor ADD COLUMN license_no        TEXT;
ALTER TABLE vendor ADD COLUMN license_expires   TEXT;

-- General liability.
ALTER TABLE vendor ADD COLUMN gl_carrier        TEXT;
ALTER TABLE vendor ADD COLUMN gl_policy_no      TEXT;
ALTER TABLE vendor ADD COLUMN gl_expires        TEXT;

-- Workers compensation. This is the one that blocks payouts.
ALTER TABLE vendor ADD COLUMN wc_carrier        TEXT;
ALTER TABLE vendor ADD COLUMN wc_policy_no      TEXT;
ALTER TABLE vendor ADD COLUMN wc_expires        TEXT;
ALTER TABLE vendor ADD COLUMN wc_exempt         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendor ADD COLUMN coi_path          TEXT;   -- certificate of insurance

-- 1099 identity. The TIN is sealed the same way bank tokens are: it is the
-- field on this table that turns a breach into identity theft.
ALTER TABLE vendor ADD COLUMN w9_received_at    TEXT;
ALTER TABLE vendor ADD COLUMN tax_id_enc        TEXT;
ALTER TABLE vendor ADD COLUMN tax_id_last4      TEXT;   -- for display, never the whole number
ALTER TABLE vendor ADD COLUMN tax_classification TEXT
  CHECK (tax_classification IN ('individual','sole_prop','partnership','c_corp','s_corp','llc','trust','other'));
ALTER TABLE vendor ADD COLUMN is_1099           INTEGER NOT NULL DEFAULT 1;

-- A manual override, for a vendor in dispute. Independent of insurance.
ALTER TABLE vendor ADD COLUMN payout_hold       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendor ADD COLUMN payout_hold_reason TEXT;

ALTER TABLE vendor ADD COLUMN onboarding_state  TEXT NOT NULL DEFAULT 'invited'
  CHECK (onboarding_state IN ('invited','documents_pending','approved','suspended'));

CREATE TABLE vendor_invoice (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  vendor_id     TEXT NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  work_order_id TEXT REFERENCES work_order(id),
  property_id   TEXT REFERENCES property(id),
  unit_id       TEXT REFERENCES unit(id),
  invoice_no    TEXT,
  invoice_date  TEXT NOT NULL,
  due_date      TEXT,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  tax_cents     BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','approved','blocked','paid','void')),
  -- Why a payout was refused, kept so the vendor can be told something useful.
  block_reason  TEXT,
  approved_by   TEXT,
  approved_at   TEXT,
  memo          TEXT,
  doc_path      TEXT,
  journal_id    TEXT REFERENCES journal(id),
  created_at    TEXT NOT NULL,
  UNIQUE (company_id, vendor_id, invoice_no)
);

CREATE INDEX vendor_invoice_status_idx ON vendor_invoice (company_id, status);
CREATE INDEX vendor_invoice_vendor_idx ON vendor_invoice (vendor_id, invoice_date);

CREATE TABLE vendor_payout (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  vendor_id     TEXT NOT NULL REFERENCES vendor(id) ON DELETE RESTRICT,
  invoice_id    TEXT REFERENCES vendor_invoice(id),
  paid_date     TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL DEFAULT 'check'
                CHECK (method IN ('check','ach','card','cash','other')),
  reference     TEXT,
  journal_id    TEXT REFERENCES journal(id),
  /* Decided at payout time and frozen, because a vendor's classification can
     change and last year's 1099 must not change with it. */
  is_1099_reportable INTEGER NOT NULL DEFAULT 1,
  tax_year      INTEGER NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX vendor_payout_1099_idx ON vendor_payout (company_id, tax_year, vendor_id);
