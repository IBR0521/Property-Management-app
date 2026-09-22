/* Canned replies for the inbox.

   **Deliberately not `notice_template`.** That table holds legal notices for
   the delinquency ladder, and it carries an invariant this one must not
   inherit: an unapproved notice cannot be sent, and editing the text clears
   the attorney's sign-off. That rule exists because a notice is a step in a
   process that ends in a courtroom.

   "Thanks, we have booked a contractor for Tuesday" is not that. Putting the
   two in one table would mean either requiring an attorney to approve a
   pleasantry, or letting unapproved text be sent as a notice — the first is
   absurd and the second breaks the invariant. So: two tables, and the
   difference is stated here rather than discovered later.

   A template is *inserted into the reply box*, never sent on its own. A
   person reads it, edits it, and sends it. That is not politeness — it is
   what stops a message going out with an unfilled placeholder in it. */

CREATE TABLE message_template (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  name          TEXT NOT NULL,
  /* Which channel it suits. A text has to be short; an email can carry a
     paragraph. `any` is for something that works either way. */
  channel       TEXT NOT NULL DEFAULT 'any'
                CHECK (channel IN ('any', 'email', 'sms')),

  subject       TEXT,
  body          TEXT NOT NULL,

  /* Kept rather than deleted: a company that retires a template still has
     messages that were written from it, and "where did this wording come
     from" is a question somebody asks. */
  archived_at   TEXT,

  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,

  UNIQUE (company_id, name)
);

CREATE INDEX message_template_company_idx ON message_template (company_id)
  WHERE archived_at IS NULL;

/* Which template a message was written from, where it was. Not a foreign key
   constraint on delete, because retiring a template must not take the history
   of what was said with it. */
ALTER TABLE message ADD COLUMN template_id TEXT REFERENCES message_template(id) ON DELETE SET NULL;
