/* The last one-time code this person used.

   A TOTP code is valid for a window, not an instant — thirty seconds, plus a
   step either side for clock drift. Without recording which step was accepted,
   a code read over somebody's shoulder or captured in transit stays usable for
   the remainder of that window, which is the one property a one-time password
   is supposed not to have.

   Stored on the staff row rather than the session so the code cannot be
   replayed into a *different* session either, which is the attack that
   matters: the person watching is not using your browser. */
ALTER TABLE staff ADD COLUMN totp_last_step BIGINT;
