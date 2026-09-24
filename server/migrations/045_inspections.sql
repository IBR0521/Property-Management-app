/* Move-in and move-out inspections.

   ## Why this only makes sense now

   An inspection that produces a list of damage with no way to charge for it
   is a checklist app. 044 built the deposit ledger; this is what feeds it —
   a move-out item marked as changed becomes a deduction, carrying its
   photographs and the move-in record beside it.

   ## A condition is a word, not a number

   `good / fair / poor / damaged / not_present`, exactly as
   `application_check.result` is `pass / fail / na / pending`. The reasoning
   is the same one: a number is what a model would produce and a number is
   what somebody would later threshold, and neither belongs in a judgement a
   person is making about somebody's home.

   It also means this table does not need an exception in the sweep that
   guards the no-automated-scoring rule, which is worth more than the
   convenience of a five-point scale.

   ## Why the move-out is made from the move-in

   The question at a move-out is never "what is the condition", it is "what
   changed" — and a screen that shows one without the other is asking
   somebody to remember. So a move-out inspection is created by copying the
   move-in one, every item pointing back at the item it is being compared
   with, and the two are shown side by side.

   ## Why the move-in is signed and frozen

   It is the record a deposit dispute turns on. Same shape as a lease
   signature and a screening consent: the document as it stood is stored
   verbatim with a hash over it, and an altered record stops matching. */

CREATE TABLE inspection (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  /* Nullable: a periodic inspection of a vacant unit has no tenancy. */
  lease_id      TEXT REFERENCES lease(id) ON DELETE SET NULL,

  kind          TEXT NOT NULL CHECK (kind IN ('movein', 'moveout', 'periodic')),

  /* draft     being filled in
     complete  finished, and at a move-out this is what deductions come from
     signed    a tenant has put their name to it */
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'complete', 'signed')),

  /* The move-in this one is being compared with, on a move-out. */
  compares_to   TEXT REFERENCES inspection(id) ON DELETE SET NULL,

  performed_by  TEXT,
  performed_on  TEXT NOT NULL,

  /* The tenant's mark, and the record as it stood when they made it. */
  signed_name   TEXT,
  signed_at     TEXT,
  signed_ip     TEXT,
  frozen_body   TEXT,
  frozen_hash   TEXT,

  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX inspection_unit_idx ON inspection (unit_id, performed_on DESC);
CREATE INDEX inspection_lease_idx ON inspection (lease_id, kind);
CREATE INDEX inspection_company_idx ON inspection (company_id, status, performed_on DESC);

CREATE TABLE inspection_item (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  inspection_id TEXT NOT NULL REFERENCES inspection(id) ON DELETE CASCADE,

  room          TEXT NOT NULL,
  label         TEXT NOT NULL,
  /* Keeps the checklist in the order somebody walks the property, rather than
     in whatever order the rows happen to come back. */
  position      INTEGER NOT NULL DEFAULT 0,

  condition     TEXT CHECK (condition IN
                  ('good', 'fair', 'poor', 'damaged', 'not_present')),
  note          TEXT,

  /* The move-in item this is being compared with, on a move-out. */
  compares_to   TEXT REFERENCES inspection_item(id) ON DELETE SET NULL,

  created_at    TEXT NOT NULL
);

CREATE INDEX inspection_item_idx ON inspection_item (inspection_id, position, room);

CREATE TABLE inspection_photo (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  inspection_id TEXT NOT NULL REFERENCES inspection(id) ON DELETE CASCADE,
  /* Nullable: a photograph of a room as a whole belongs to the inspection
     rather than to one line of it. */
  item_id       TEXT REFERENCES inspection_item(id) ON DELETE CASCADE,

  path          TEXT NOT NULL,
  mime          TEXT,
  bytes         INTEGER,
  caption       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX inspection_photo_idx ON inspection_photo (inspection_id, item_id);

-- --- the link to the money ----------------------------------------------------

/* A deduction that came from an inspection line. This is the join the whole
   feature exists for: the tenant's itemisation can say which room, what it
   looked like when they moved in, what it looked like when they left, and
   point at the photographs of both. */
ALTER TABLE deposit_deduction
  ADD COLUMN inspection_item_id TEXT REFERENCES inspection_item(id) ON DELETE SET NULL;
