/* The password Google issued for the company's own mailbox.

   A Gmail address in from_email has to be sent by Google, or the recipient
   never sees that address. The secret is sealed. A database copy does not
   contain a usable password. */

ALTER TABLE company ADD COLUMN mailbox_secret_sealed TEXT;
