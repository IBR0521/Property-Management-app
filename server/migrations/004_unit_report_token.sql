/* A QR sticker per unit.

   The sticker is printed and left in the kitchen, so the token in it has to
   outlive every session and cannot be rotated on a schedule — reprinting a
   building's stickers is a physical job. It is therefore not a credential in
   the sense /t/:token is: it identifies a front door, it does not unlock any
   data. Knowing one lets you report a repair for that unit and nothing else,
   which is why 12 bytes is enough here where the tenant status page uses 32.

   Generated in SQL so the column is never null and no backfill script has to
   be remembered. base64 minus the two URL-hostile characters: translate drops
   '=' because it has no replacement, and 12 bytes encode without padding
   anyway. */
ALTER TABLE unit ADD COLUMN report_token TEXT;

UPDATE unit
   SET report_token = translate(encode(gen_random_bytes(12), 'base64'), '+/=', '-_')
 WHERE report_token IS NULL;

ALTER TABLE unit ALTER COLUMN report_token SET NOT NULL;

CREATE UNIQUE INDEX unit_report_token_idx ON unit (report_token);
