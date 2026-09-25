/* Getting back in after forgetting a password.

   There was no way. A person could change their password from inside their
   account and had no route in from outside it — so the first time anybody
   forgot one, the only remedy was somebody editing the database by hand. For
   a product sold to companies whose staff turn over, that is not an omission
   anyone discovers gently.

   The shape is `email_verification`'s, because it is the same problem: a
   single-use token with an expiry, aimed at one person.

   ## Single use, and short

   `used_at` is set the moment a reset completes, and a used token is refused
   rather than being allowed to set a second password. An hour is long enough
   to read an email and short enough that a link left in an inbox is not a
   standing key to somebody's account.

   ## It does not say whether the address exists

   Enforced in code rather than here, and worth writing down beside the table:
   the request form answers the same way whether or not an address is known,
   because a form that says "no such account" is a way of asking which of your
   staff still work for you. */

CREATE TABLE password_reset (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  requested_ip TEXT,
  created_at  TEXT NOT NULL
);

/* The token is looked up by its hash, never stored in the clear: a reset
   table that leaked would otherwise be a list of live keys. */
CREATE UNIQUE INDEX password_reset_token_idx ON password_reset (token_hash);
CREATE INDEX password_reset_staff_idx ON password_reset (staff_id, created_at DESC);
