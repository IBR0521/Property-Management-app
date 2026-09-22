/* Making the two books point at each other.

   `ledger_entry` is the single-entry record that drives owner statements, and
   has existed since 001. `journal` is the double-entry book, added with the
   accounting work. Only the late-fee sweep has ever written to both.

   The result on a live database: twelve rent payments totalling $13,710 in
   `ledger_entry`, and nothing at all in the journal. The trial balance is
   internally consistent, because the database enforces that, and it is
   incomplete — which is harder to notice and just as wrong.

   This column is what makes that findable. An entry with no journal is a
   query rather than an invisible discrepancy, and the parity test can assert
   "no owner-visible money exists outside the company's books" as a fact about
   the schema rather than a hope about the call sites. */

ALTER TABLE ledger_entry ADD COLUMN journal_id TEXT REFERENCES journal(id);

/* Deliberately not NOT NULL. Historical rows predate double entry and have no
   journal to point at until the conversion runs; making the column mandatory
   would mean either refusing to migrate or inventing journals inside a
   migration, and a migration is the wrong place to post accounting entries —
   it cannot be reviewed before it runs and it cannot be reversed. */
CREATE INDEX ledger_entry_journal_idx ON ledger_entry (journal_id);

/* The query the parity check runs: owner-visible money with no double-entry
   record behind it. Partial, because the answer should be empty and an index
   over the exceptions stays small. */
CREATE INDEX ledger_entry_unposted_idx ON ledger_entry (company_id, date)
  WHERE journal_id IS NULL;

/* Accounts the payment paths need and the original chart did not have.

   Stripe in transit is the one that matters. A tenant's payment is authorised
   days before it settles into the company's bank, and during that window the
   money is real, owed to the owner, and not yet anywhere the company can
   spend it. Without an in-transit account it would either be counted as cash
   the company does not have, or not counted at all. */
INSERT INTO account (id, company_id, code, name, type, normal_balance, is_trust, active, created_at)
SELECT
  md5(c.id || a.code), c.id, a.code, a.name, a.type, a.normal_balance, a.is_trust, 1,
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM company c
CROSS JOIN (VALUES
  ('1020', 'Payments in transit',        'asset',     'debit',  1),
  ('1300', 'Tenant receivable',          'asset',     'debit',  0),
  ('2300', 'Prepaid rent',               'liability', 'credit', 1),
  ('4300', 'Processing fee recovered',   'income',    'credit', 0),
  ('5200', 'Payment processing fees',    'expense',   'debit',  0),
  ('5300', 'Returned payment charges',   'expense',   'debit',  0),
  ('3100', 'Opening balance conversion', 'equity',    'credit', 0)
) AS a(code, name, type, normal_balance, is_trust)
ON CONFLICT (company_id, code) DO NOTHING;
