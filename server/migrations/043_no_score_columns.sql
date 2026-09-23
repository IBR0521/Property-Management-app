/* Taking the score columns off the adverse action notice.

   042 put five of them there — score, source, date, range, factors — because
   the law requires those things to appear on the notice when a credit score
   influenced a decision. That reasoning was right and the conclusion was
   wrong, and `invariants.test.js` said so within the hour: it has asserted
   since Phase 1 that **no score column may exist anywhere**, full stop, and
   it does not make exceptions for good reasons. Good reasons are how a rule
   like that dies.

   The rule survives because the notice does not need them. `rendered_body`
   is the notice — frozen at the moment it was written, the same text that
   went into the outbox — and the score is in it, in prose, where the law
   wants it. Storing it a second time as a field bought the ability to query
   by it, which is the one thing this feature must never make possible.

   So: five columns fewer, the same notice, and an invariant that is still
   absolute rather than nearly absolute. */

ALTER TABLE adverse_action
  DROP COLUMN score,
  DROP COLUMN score_source,
  DROP COLUMN score_date,
  DROP COLUMN score_range,
  DROP COLUMN score_factors;
