/* A default for pay_token.

   022 made the column NOT NULL and backfilled the rows that existed, and every
   insert path then had to remember to supply one. Exactly one did not — the
   move-in form — so creating a tenancy failed outright. The test suite caught
   it; a deploy would have caught it with a manager staring at a 500 halfway
   through moving somebody in.

   The lesson is not "remember harder". A NOT NULL column that every insert
   must populate identically is a column with a default, and the database is
   the only place that cannot be forgotten. The sticker token in migration 004
   is generated in JS for a different reason — it is rotated on demand, so the
   generator has to be callable — but nothing rotates a pay token per row.

   Existing rows are untouched: they were backfilled by 022. */
ALTER TABLE lease
  ALTER COLUMN pay_token
  SET DEFAULT translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
