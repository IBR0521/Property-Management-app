/* The date, on the split.

   ## What this is fixing

   Every financial report groups splits by account and filters by the
   journal's date, which meant joining `journal_split` to `journal` for the
   one column. At 676,000 splits that join is 676,000 primary-key lookups and
   2.7 million buffer hits, and it is where the balance sheet spent ten and a
   half of its ten and a half seconds:

       Nested Loop Left Join  (actual time=0.067..4700.992 rows=676015)
         ->  Bitmap Heap Scan on journal_split   307ms
         ->  Index Scan using journal_pkey       4.4 SECONDS, 676,015 loops

   Found by seeding 2,000 units and five years and measuring, which is the
   whole point of doing that.

   ## Why denormalising is safe here and usually is not

   The objection to copying a column is drift: two places to change, and one
   day only one of them gets changed.

   **A journal cannot drift.** It is append-only — that is the oldest rule in
   this schema — and a mistake is corrected by posting its mirror, never by
   editing the original. A posted journal's date is fixed for ever, so the
   copy on its splits is fixed for ever too. This is the case the usual
   objection does not cover.

   The constraint below says it rather than trusting it: a split's date has to
   equal its journal's, checked by the database on every insert, so the two
   cannot disagree even if a writer forgets. */

ALTER TABLE journal_split ADD COLUMN date TEXT;

/* The backfill has to get past the append-only trigger, which refused it —
   correctly, and it is worth saying so rather than quietly working around it.
   `journal_split_no_update` exists so that a posted split can never be
   edited, and adding a column to every row of a table is an edit.

   This is the one legitimate case: the value being written is not a change to
   what was posted, it is a copy of something that was already true about it.
   The trigger goes off for exactly the length of the backfill and comes
   straight back, inside one transaction, so there is no window in which the
   ledger is writable. */
ALTER TABLE journal_split DISABLE TRIGGER journal_split_no_update;

/* And the balance check, which is a deferred constraint trigger: an update
   touching every row queues one deferred event per row, and the ALTER that
   follows cannot run with them pending. Nothing about the balance is
   changing — only a date is being copied — so the check has nothing to do
   except be queued. */
ALTER TABLE journal_split DISABLE TRIGGER journal_split_balanced;

UPDATE journal_split s SET date = j.date FROM journal j WHERE j.id = s.journal_id;

ALTER TABLE journal_split ENABLE TRIGGER journal_split_balanced;
ALTER TABLE journal_split ENABLE TRIGGER journal_split_no_update;

ALTER TABLE journal_split ALTER COLUMN date SET NOT NULL;

/* The reports read (account, date) and sum the two amounts. Including them in
   the index makes it an index-only scan, so the heap is not touched at all
   for a balance. */
CREATE INDEX journal_split_account_date_idx
  ON journal_split (account_id, date) INCLUDE (debit_cents, credit_cents);

/* And the same shape for the two dimensions the per-property and per-owner
   reports filter on. */
CREATE INDEX journal_split_property_date_idx
  ON journal_split (property_id, date) WHERE property_id IS NOT NULL;
CREATE INDEX journal_split_lease_date_idx
  ON journal_split (lease_id, date) WHERE lease_id IS NOT NULL;

/* The copy cannot disagree with the original. A writer that forgets is
   refused rather than quietly producing a report that is wrong in a way
   nobody can see. */
CREATE OR REPLACE FUNCTION journal_split_date_matches() RETURNS trigger AS $$
BEGIN
  IF NEW.date IS DISTINCT FROM (SELECT date FROM journal WHERE id = NEW.journal_id) THEN
    RAISE EXCEPTION 'journal_split.date (%) does not match its journal''s date', NEW.date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_split_date_matches_trg
  BEFORE INSERT OR UPDATE OF date, journal_id ON journal_split
  FOR EACH ROW EXECUTE FUNCTION journal_split_date_matches();
