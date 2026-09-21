/* Double-entry accounting.

   The existing ledger_entry table stays exactly as it is. It is a single-entry
   record of what happened to an owner's money and it drives owner statements;
   ripping it out would break every statement already issued. This is a second,
   stricter book that sits beside it: ledger_entry answers "what does this owner
   see", journal answers "does the whole company balance".

   Three rules are enforced by the database rather than by the code that writes
   to it, because a rule enforced in application code is a rule that holds until
   somebody writes a new call site.

     1. Every journal's debits equal its credits. Checked at COMMIT, not per
        row, because the rows of a balanced journal are necessarily unbalanced
        while they are being inserted one at a time.
     2. A journal has at least two splits. One split that happens to net to
        zero is not double entry.
     3. Nothing is ever deleted or amended. A mistake is corrected by posting
        the reversing journal, which is what an auditor expects to find. */

CREATE TABLE account (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,              -- 1000, 2000 … sorts the chart
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  -- Which side increases this account. Assets and expenses are debit-normal;
  -- everything else is credit-normal. Stored rather than derived so a report
  -- never has to re-derive the sign convention.
  normal_balance  TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  -- Client money held on behalf of owners and tenants. Trust accounts are the
  -- ones a state auditor asks about, so they are flagged, not inferred.
  is_trust        INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  UNIQUE (company_id, code)
);

CREATE TABLE journal (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE RESTRICT,
  date          TEXT NOT NULL,               -- YYYY-MM-DD, the accounting date
  memo          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','rent','maintenance','owner','vendor','bank','late_fee','system')),
  -- What in the rest of the app caused this. Lets a work order or an invoice
  -- show its accounting, and lets the reconciler find the journal for a charge.
  source_type   TEXT,
  source_id     TEXT,
  -- Reversals point at what they undo. Both directions, so a journal knows it
  -- has been reversed without a scan.
  reverses_id   TEXT REFERENCES journal(id),
  reversed_by   TEXT REFERENCES journal(id),
  posted_by     TEXT,                        -- staff id, or 'system'
  created_at    TEXT NOT NULL
);

CREATE INDEX journal_company_date_idx ON journal (company_id, date);
CREATE INDEX journal_source_idx ON journal (source_type, source_id);

CREATE TABLE journal_split (
  id            TEXT PRIMARY KEY,
  journal_id    TEXT NOT NULL REFERENCES journal(id) ON DELETE RESTRICT,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  debit_cents   BIGINT NOT NULL DEFAULT 0,
  credit_cents  BIGINT NOT NULL DEFAULT 0,
  -- Who the money is about. All optional: a bank fee belongs to no owner.
  owner_id      TEXT REFERENCES owner(id),
  property_id   TEXT REFERENCES property(id),
  unit_id       TEXT REFERENCES unit(id),
  lease_id      TEXT REFERENCES lease(id),
  vendor_id     TEXT REFERENCES vendor(id),
  memo          TEXT,
  /* Exactly one side carries the amount, and it is positive. Allowing a
     negative credit would let one row balance itself and make the sum below
     meaningless. */
  CONSTRAINT split_one_sided CHECK (
    debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents = 0) <> (credit_cents = 0)
  )
);

CREATE INDEX journal_split_journal_idx ON journal_split (journal_id);
CREATE INDEX journal_split_account_idx ON journal_split (account_id);
CREATE INDEX journal_split_owner_idx ON journal_split (owner_id);

/* --- rule 1 and 2: the journal balances, checked at COMMIT ----------------- */

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  jid TEXT;
  d   BIGINT;
  c   BIGINT;
  n   INTEGER;
BEGIN
  jid := COALESCE(NEW.journal_id, OLD.journal_id);
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*)
    INTO d, c, n
    FROM journal_split WHERE journal_id = jid;

  IF n = 0 THEN
    RETURN NULL;                      -- nothing left to balance
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % has only % split — double entry needs at least two', jid, n
      USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal % does not balance: debits % vs credits %', jid, d, c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

/* DEFERRABLE INITIALLY DEFERRED is the whole point: the check runs once, when
   the transaction commits, by which time every split of the journal is in. A
   normal trigger would fire on the first split and reject every journal ever
   written. */
CREATE CONSTRAINT TRIGGER journal_split_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_split
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

/* --- rule 3: posted history is immutable ---------------------------------- */

CREATE OR REPLACE FUNCTION forbid_ledger_rewrite() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'the ledger is append-only: post a reversing journal instead of changing %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_no_delete
  BEFORE DELETE ON journal FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER journal_split_no_delete
  BEFORE DELETE ON journal_split FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();
CREATE TRIGGER journal_split_no_update
  BEFORE UPDATE ON journal_split FOR EACH ROW EXECUTE FUNCTION forbid_ledger_rewrite();

/* journal itself takes updates, but only to record that it was reversed.
   Everything else about a posted journal is frozen. */
CREATE OR REPLACE FUNCTION journal_only_reversal_link() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.date    IS DISTINCT FROM OLD.date
     OR NEW.memo    IS DISTINCT FROM OLD.memo
     OR NEW.source  IS DISTINCT FROM OLD.source
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id   IS DISTINCT FROM OLD.source_id
     OR NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION 'a posted journal cannot be edited — post a reversing journal'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_frozen
  BEFORE UPDATE ON journal FOR EACH ROW EXECUTE FUNCTION journal_only_reversal_link();

/* --- a default chart for companies that already exist --------------------- */

INSERT INTO account (id, company_id, code, name, type, normal_balance, is_trust, active, created_at)
SELECT
  md5(c.id || a.code), c.id, a.code, a.name, a.type, a.normal_balance, a.is_trust, 1,
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM company c
CROSS JOIN (VALUES
  ('1000', 'Operating cash',            'asset',     'debit',  0),
  ('1010', 'Trust cash — client funds', 'asset',     'debit',  1),
  ('1200', 'Rent receivable',           'asset',     'debit',  0),
  ('2000', 'Accounts payable',          'liability', 'credit', 0),
  ('2100', 'Tenant deposits held',      'liability', 'credit', 1),
  ('2200', 'Owner funds held',          'liability', 'credit', 1),
  ('3000', 'Retained earnings',         'equity',    'credit', 0),
  ('4000', 'Rent income',               'income',    'credit', 0),
  ('4100', 'Late fee income',           'income',    'credit', 0),
  ('4200', 'Management fee income',     'income',    'credit', 0),
  ('5000', 'Repairs and maintenance',   'expense',   'debit',  0),
  ('5100', 'Bank charges',              'expense',   'debit',  0)
) AS a(code, name, type, normal_balance, is_trust)
ON CONFLICT (company_id, code) DO NOTHING;
