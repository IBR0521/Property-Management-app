/* What a split was for, on the split.

   ## What this is fixing

   The same thing 046 fixed, on the same table, for the same reason — and
   found the same way, by timing every page against 2,000 units.

   Aged receivables reads every movement on tenant receivable and has to know
   what each charge was for, because rent ages from its **due date** and the
   due date comes from the period in `journal.source_id`. So it joined
   `journal_split` to `journal` for two columns, 120,000 times:

       with the journal join     945ms
       without it                144ms

   Six hundred and sixty per cent, to fetch two text columns that were already
   determined the moment the journal was posted.

   046 put `date` here and the balance sheet went from 10.5s to 474ms. This is
   the rest of that same sentence.

   ## Why denormalising is safe here

   The argument is 046's and it has not changed: **a journal cannot drift.**
   It is append-only, the oldest rule in this schema, and a mistake is
   corrected by posting its mirror rather than by editing the original. A
   posted journal's source is fixed for ever, so the copy on its splits is
   fixed for ever too.

   And the trigger at the bottom says it rather than trusting it. */

ALTER TABLE journal_split ADD COLUMN source_type TEXT;
ALTER TABLE journal_split ADD COLUMN source_id TEXT;

/* Past the append-only trigger, exactly as 046 did, and for the same reason:
   the value being written is not a change to what was posted, it is a copy of
   something already true about it. Off for the length of the backfill and
   back inside the same transaction, so there is no window in which the ledger
   is writable. */
ALTER TABLE journal_split DISABLE TRIGGER journal_split_no_update;

/* The balance check is a deferred constraint trigger: an update touching
   every row queues one deferred event per row and the ALTER that follows
   cannot run with them pending. Nothing about the balance changes here. */
ALTER TABLE journal_split DISABLE TRIGGER journal_split_balanced;

/* And the date check, which fires on UPDATE and would re-verify every row's
   date against its journal for a write that does not touch the date. */
ALTER TABLE journal_split DISABLE TRIGGER journal_split_date_matches_trg;

UPDATE journal_split s
   SET source_type = j.source_type, source_id = j.source_id
  FROM journal j WHERE j.id = s.journal_id;

ALTER TABLE journal_split ENABLE TRIGGER journal_split_date_matches_trg;
ALTER TABLE journal_split ENABLE TRIGGER journal_split_balanced;
ALTER TABLE journal_split ENABLE TRIGGER journal_split_no_update;

/* Not NOT NULL: `journal.source_type` is itself nullable — a manual journal
   has no source — so a copy that refused nulls would refuse the original. */

/* Aged receivables asks two questions of one account, both grouped by lease:
   every charge, and the total paid against it. Both lead with `account_id`
   because that is what the report filters on first, and both carry every
   column their query selects so neither has to touch the heap.

   The credits half mattered more than it looked. Summing 108,000 credit rows
   into 2,000 totals was 464ms — longer than fetching all 120,000 charges —
   because the index from 046 is keyed on (account, date) and carries no
   `lease_id`, so grouping by lease meant reading every row. */
CREATE INDEX journal_split_account_lease_debit_idx
  ON journal_split (account_id, lease_id, date)
  INCLUDE (debit_cents, source_type, source_id)
  WHERE lease_id IS NOT NULL AND debit_cents > 0;

CREATE INDEX journal_split_account_lease_credit_idx
  ON journal_split (account_id, lease_id, date)
  INCLUDE (credit_cents)
  WHERE lease_id IS NOT NULL AND credit_cents > 0;

/* The copy cannot disagree with the original, checked on the way in, so a
   writer that forgets is refused rather than quietly producing a report that
   ages somebody's rent from the wrong day. */
CREATE OR REPLACE FUNCTION journal_split_source_matches() RETURNS trigger AS $$
DECLARE j_type TEXT; j_id TEXT;
BEGIN
  SELECT source_type, source_id INTO j_type, j_id FROM journal WHERE id = NEW.journal_id;
  IF NEW.source_type IS DISTINCT FROM j_type OR NEW.source_id IS DISTINCT FROM j_id THEN
    RAISE EXCEPTION 'journal_split source (%, %) does not match its journal''s (%, %)',
      NEW.source_type, NEW.source_id, j_type, j_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_split_source_matches_trg
  BEFORE INSERT OR UPDATE OF source_type, source_id, journal_id ON journal_split
  FOR EACH ROW EXECUTE FUNCTION journal_split_source_matches();
