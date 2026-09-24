/* Security deposits: the money, and what happens to it.

   ## Why this did not exist until now

   `ledger.js` has had `deposit_held` and `deposit_returned` in its posting
   table since Phase 1, and **nothing in this application has ever invoked
   either.** A deposit was a number on a lease row that the books did not know
   about. The compliance engine has counted forward from the move-out date to
   a deadline the whole time, warning that missing it usually carries a
   statutory penalty — with nothing for it to be a deadline *for*.

   That is the same shape as the Phase 6 finding about rent charging: a rule
   that looks complete, that nothing calls. It is also why the trust
   reconciliation has reported `deposits_vs_leases` as a variance on every
   company, correctly, every month.

   ## What a return is

   A row, opened when the tenancy ends, holding three things: what is held,
   when it has to be settled by, and what is taken out of it. Settling posts
   once and freezes the itemisation the tenant is given.

   **Every deduction credits the owner.** A deduction for damage is not the
   manager's income; it reimburses whoever paid to have it put right, which is
   the owner. Booking it as income would be the Phase 6 mistake again, an
   owner's money landing on the manager's books, and that one was invisible
   for months. Decided with the customer before a line of this was written.

   ## Why the itemisation is frozen

   Most states require the tenant to be given a written itemisation within the
   deadline, and what matters in a dispute is what they were actually sent. So
   it is rendered once, stored verbatim, and carries the outbox row that
   delivered it — this table never claims a delivery the delivery system did
   not make. */

CREATE TABLE deposit_return (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id       TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,

  /* What the books said was held when this opened. Read from 2100 rather than
     from `lease.deposit_cents`, because the journal is what the trust
     reconciliation reads and a return that disagreed with it would be
     returning money the books do not think exists. */
  held_cents     BIGINT NOT NULL,

  /* The day keys came back, and the deadline the company's own rule gives.
     `due_by` is nullable because a company that has not written a
     deposit-return rule has no deadline to state, and inventing one would be
     this application asserting what a statute requires. */
  moveout_date   TEXT NOT NULL,
  due_by         TEXT,
  /* Copied from the rule, so a later edit to the rule does not silently
     restate what this return was measured against. */
  basis          TEXT,

  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'settled', 'void')),

  /* Filled in at settlement. */
  returned_cents BIGINT,
  journal_id     TEXT REFERENCES journal(id),
  itemisation    TEXT,
  itemisation_outbox_id TEXT,

  opened_by      TEXT,
  opened_at      TEXT NOT NULL,
  settled_by     TEXT,
  settled_at     TEXT,
  note           TEXT
);

/* One *open* return per tenancy. A second open one would be a second claim on
   the same money, and which of them is real is not a question anybody should
   have to answer afterwards. Partial, so a settled return and a later voided
   one can both exist — the history is worth keeping and only the live claim
   needs to be unique.

   In the database rather than in code, for the same reason the rent charge's
   is: two requests at once would both pass a check. */
CREATE UNIQUE INDEX deposit_return_one_open_idx
  ON deposit_return (lease_id) WHERE status = 'open';

CREATE INDEX deposit_return_company_idx ON deposit_return (company_id, status, due_by);

CREATE TABLE deposit_deduction (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  return_id      TEXT NOT NULL REFERENCES deposit_return(id) ON DELETE CASCADE,

  /* In the words the tenant will read. A deduction with no reason is a
     deduction that cannot be defended, and several states require the reason
     in writing. */
  reason         TEXT NOT NULL,
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),

  /* The evidence, where there is any. A repair that was actually carried out
     is the strongest kind — it has an invoice, photographs and a cost behind
     it already. */
  work_order_id  TEXT REFERENCES work_order(id) ON DELETE SET NULL,

  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX deposit_deduction_return_idx ON deposit_deduction (return_id, created_at);
