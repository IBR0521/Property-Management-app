/* Platform administration.

   One person — the operator of this deployment — can see across companies.
   That is unavoidable for support, and it is also the single most dangerous
   capability in the system: it is the one account that is not scoped by
   company_id, and every isolation guarantee elsewhere assumes it is not being
   misused.

   So the design starts from the assumption that it will be questioned. Two
   rules, and both exist to make the answer checkable rather than assertable.

   **Impersonation is logged on both sides.** Not in our logs, where the
   customer cannot see them — in a table the impersonated company can read,
   alongside a banner that is visible the whole time it is happening. Support
   access a customer cannot see is the kind of thing that ends up in a breach
   disclosure rather than in a support ticket.

   **It cannot be used to become somebody.** An impersonated session may read,
   so support can see what the customer sees. It may not write, change a
   password, disable two-factor authentication, or touch billing. The purpose
   is to answer "what does this look like from their side", not to act as
   them. */

CREATE TABLE impersonation (
  id             TEXT PRIMARY KEY,
  /* The company being looked at. Deliberately named company_id so the
     isolation test treats it like every other company-scoped table, and so
     the company's own audit screen can query it the same way. */
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  -- The staff row whose view is being borrowed.
  staff_id       TEXT REFERENCES staff(id) ON DELETE SET NULL,

  /* The platform operator, by email rather than by a foreign key: they are
     not a row in staff, and recording who it was must survive them ever
     becoming one. */
  operator       TEXT NOT NULL,
  reason         TEXT NOT NULL,

  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  -- What they looked at, as a count. Not the paths: a support session should
  -- not become a second copy of the customer's data.
  pages_viewed   INTEGER NOT NULL DEFAULT 0,
  ip             TEXT,
  user_agent     TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX impersonation_company_idx ON impersonation (company_id, started_at DESC);
CREATE INDEX impersonation_open_idx ON impersonation (ended_at) WHERE ended_at IS NULL;

/* Which session is currently borrowing a view, so the gate can recognise it
   and refuse writes. Null on every ordinary session, which is all of them. */
ALTER TABLE session ADD COLUMN impersonation_id TEXT REFERENCES impersonation(id) ON DELETE SET NULL;
