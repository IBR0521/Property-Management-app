/* Paying owners and vendors.

   The platform never holds the money here either. A payout run produces two
   things the company takes to their own bank — an ACH file they upload, or
   cheques they print — and records what was issued. The bank moves the funds;
   this records that it was asked to.

   That shape is why there is a `payout_batch` at all rather than a flag on
   each payment. A run is a unit: one effective date, one file, one set of
   totals the company reconciles against their statement. Losing the grouping
   would make "which file was this in" unanswerable three weeks later, which
   is exactly when somebody asks.

   Approval is separate from issue for the same reason it is everywhere else
   in this application: the person who assembles a run and the person who
   releases the money to the bank should be able to be different people, and
   in a company of any size they are. */

-- --- where the money goes ---------------------------------------------------

/* Bank details for an owner or a vendor, sealed the same way bank tokens and
   taxpayer identification are: AES-256-GCM, so a database dump is not a list
   of account numbers. The last four are stored in clear for display, because
   "the account ending 6789" is what a person needs to recognise it and the
   whole number is never needed on a screen. */
CREATE TABLE payee_account (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* One of the two is set. A check constraint rather than two tables: the
     payout run treats them identically and splitting them would mean every
     query is a union. */
  owner_id        TEXT REFERENCES owner(id) ON DELETE CASCADE,
  vendor_id       TEXT REFERENCES vendor(id) ON DELETE CASCADE,

  method          TEXT NOT NULL DEFAULT 'check'
                  CHECK (method IN ('ach', 'check')),

  routing_number  TEXT,
  account_enc     TEXT,
  account_last4   TEXT,
  account_type    TEXT NOT NULL DEFAULT 'checking'
                  CHECK (account_type IN ('checking', 'savings')),
  account_name    TEXT,

  /* Where a cheque is posted, which is not always the address on file. */
  mail_to         TEXT,

  /* A zero-dollar entry sent ahead of the first real payment so the receiving
     bank can confirm the account exists. Cheaper than a return, and how a
     careful company opens an account relationship. */
  prenote_sent_at TEXT,
  verified_at     TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT,

  CONSTRAINT payee_is_one_or_the_other CHECK (
    (owner_id IS NOT NULL AND vendor_id IS NULL) OR
    (owner_id IS NULL AND vendor_id IS NOT NULL)
  ),
  /* An ACH payee without an account number is a payment that cannot happen.
     Better refused by the database than discovered by the bank. */
  CONSTRAINT ach_needs_an_account CHECK (
    method <> 'ach' OR (routing_number IS NOT NULL AND account_enc IS NOT NULL)
  )
);

CREATE UNIQUE INDEX payee_account_owner_idx ON payee_account (owner_id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX payee_account_vendor_idx ON payee_account (vendor_id) WHERE vendor_id IS NOT NULL;

-- --- a run ------------------------------------------------------------------

CREATE TABLE payout_batch (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL CHECK (kind IN ('owner', 'vendor')),
  method          TEXT NOT NULL CHECK (method IN ('ach', 'check')),

  /* The date the bank is asked to move the money, which is not the date the
     run was assembled and not the date it was approved. */
  effective_date  TEXT NOT NULL,
  reference       TEXT,

  /* draft     being assembled, nothing committed
     approved  released, files generated, journals posted
     issued    the file has been handed to the bank or the cheques printed
     cancelled abandoned before approval */
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'issued', 'cancelled')),

  total_cents     BIGINT NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,

  /* Frozen at approval. Regenerating a file later against changed data would
     produce something that disagrees with what the bank already has. */
  file_name       TEXT,
  file_text       TEXT,
  file_hash       TEXT,

  created_by      TEXT,
  created_at      TEXT NOT NULL,
  approved_by     TEXT,
  approved_at     TEXT,
  issued_at       TEXT,
  cancelled_at    TEXT,
  cancel_reason   TEXT
);

CREATE INDEX payout_batch_company_idx ON payout_batch (company_id, status, effective_date DESC);

CREATE TABLE payout_item (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  batch_id        TEXT NOT NULL REFERENCES payout_batch(id) ON DELETE CASCADE,

  owner_id        TEXT REFERENCES owner(id),
  vendor_id       TEXT REFERENCES vendor(id),
  invoice_id      TEXT REFERENCES vendor_invoice(id),

  /* The payee's name and account as they were when the run was approved.
     A vendor who changes bank next month must not change what last month's
     file says it paid. */
  payee_name      TEXT NOT NULL,
  routing_number  TEXT,
  account_last4   TEXT,
  check_number    INTEGER,

  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  memo            TEXT,
  /* What made up the amount, as JSON, so a stub and a statement can show the
     same breakdown without recomputing it from data that has since moved. */
  detail          TEXT,

  journal_id      TEXT REFERENCES journal(id),
  ledger_entry_id TEXT REFERENCES ledger_entry(id),

  /* A cheque that was printed and then spoiled, or a payment recalled before
     the file went. Voiding is a state, never a deletion: the cheque number
     was used and the bank needs to be told. */
  voided_at       TEXT,
  void_reason     TEXT,

  created_at      TEXT NOT NULL
);

CREATE INDEX payout_item_batch_idx ON payout_item (batch_id);
CREATE INDEX payout_item_owner_idx ON payout_item (company_id, owner_id);
CREATE INDEX payout_item_vendor_idx ON payout_item (company_id, vendor_id);

/* One cheque number is used once. The register is what positive pay is built
   from, and a duplicate number in it means the bank cannot tell which of two
   cheques it should honour. */
CREATE UNIQUE INDEX payout_item_check_number_idx
  ON payout_item (company_id, check_number)
  WHERE check_number IS NOT NULL;

-- --- the cheque book --------------------------------------------------------

/* Where the next cheque number comes from. A counter per company rather than
   a global one, and held in its own row so incrementing it is a single
   statement that cannot interleave with another run. */
CREATE TABLE check_register (
  company_id      TEXT PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  next_number     INTEGER NOT NULL DEFAULT 1001,
  /* The account cheques are drawn on, for the positive-pay file. */
  account_last4   TEXT,
  account_number  TEXT,
  updated_at      TEXT
);

/* The company's own bank details, for the ACH file's origin records. Separate
   from bank_account, which is the Plaid-linked account used for
   reconciliation — the same bank in practice, but one is a read connection
   and this is what goes in a file header. */
ALTER TABLE company ADD COLUMN ach_company_id     TEXT;
ALTER TABLE company ADD COLUMN ach_routing_number TEXT;
ALTER TABLE company ADD COLUMN ach_account_enc    TEXT;
ALTER TABLE company ADD COLUMN ach_account_last4  TEXT;
ALTER TABLE company ADD COLUMN ach_account_type   TEXT NOT NULL DEFAULT 'checking'
  CHECK (ach_account_type IN ('checking', 'savings'));
ALTER TABLE company ADD COLUMN ach_bank_name      TEXT;
/* Some banks want the offsetting debit stated in the file; others take it
   from the account. Which one is a question for the bank. */
ALTER TABLE company ADD COLUMN ach_balanced_file  INTEGER NOT NULL DEFAULT 0;
