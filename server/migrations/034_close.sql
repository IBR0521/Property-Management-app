/* Closing the books.

   Until now any journal could be posted with any date, forever. That is fine
   for one company keeping its own records and wrong for a platform: a property
   manager who has reconciled a month, filed it, sent owner statements against
   it and issued 1099s from it cannot have that month change underneath them.
   In most US states a manager holding client funds must reconcile the trust
   account monthly and retain the reconciliation for years — a posting that
   lands behind one of those does not correct it, it makes a document that was
   signed as true retroactively false.

   So: a line, before which the books are finished.

   Null means never closed, which is where every existing company starts and
   is a perfectly good state to stay in. Nothing is closed on anybody's behalf.
   Closing and reopening are both deliberate acts and both are written to
   audit_log, because "who reopened December, and when" is the first question
   anybody asks afterwards. */

ALTER TABLE company ADD COLUMN books_closed_through TEXT;

-- --- the reconciliation, as it read on the day ------------------------------

/* A regulator does not ask what the trust account reconciles to today. They
   ask for the reconciliation as at the period end, as it was produced. Those
   are different questions once anything has been posted since, and recomputing
   answers the wrong one.

   So the report is stored, whole, the same way owner_statement.totals is
   snapshotted so a statement an owner already holds never changes underneath
   them. */
CREATE TABLE trust_reconciliation (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* The period end this reconciliation is for. */
  as_of         TEXT NOT NULL,

  /* Denormalised out of the snapshot so "show me the months that did not
     reconcile" is a query rather than a scan and a JSON parse. */
  balanced      INTEGER NOT NULL DEFAULT 0,
  bank_cents    BIGINT,
  book_cents    BIGINT NOT NULL,
  clients_cents BIGINT NOT NULL,
  subledger_cents BIGINT NOT NULL,

  /* The whole report as it read, including the findings. */
  snapshot      TEXT NOT NULL,

  /* Who stands behind it. A reconciliation nobody signed is a printout. */
  signed_by     TEXT,
  signed_at     TEXT,
  note          TEXT,

  created_at    TEXT NOT NULL,

  /* One per period end. Re-running before it is signed replaces it; after it
     is signed it is kept and the application refuses. */
  UNIQUE (company_id, as_of)
);

CREATE INDEX trust_reconciliation_company_idx
  ON trust_reconciliation (company_id, as_of DESC);
