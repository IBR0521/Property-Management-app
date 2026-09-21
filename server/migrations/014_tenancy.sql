/* Multiple companies on one deployment.

   The schema has carried company_id since 001 and every query is scoped by it,
   so the data has always been ready for this. What was not ready is the way a
   public page decides which company it belongs to: five places took whatever
   row came back first from `SELECT * FROM company LIMIT 1`.

   With one company that is correct. With two, a tenant scanning their own QR
   sticker is shown a different company's name and told their address is not
   one we manage — because the token lookup is correctly scoped and simply
   finds nothing.

   A slug fixes the two entry points that carry no other identifier. The rest
   already carry a token that names one record, and therefore one company. */

-- --- identity --------------------------------------------------------------

/* The public handle: /c/leafridge/report. Unique, lower-case, and stable once
   issued — it ends up printed on QR stickers and in links people bookmark.

   Nullable only for the moment between adding the column and backfilling it
   below; made NOT NULL at the end of this file. */
ALTER TABLE company ADD COLUMN slug TEXT;

/* Derived from the name: lower-case, alphanumerics and hyphens, collapsed and
   trimmed. Suffixed with a counter where two companies would collide, because
   "Smith Properties" is not a rare name. */
UPDATE company SET slug = base.candidate || CASE WHEN base.rn = 1 THEN '' ELSE '-' || base.rn::text END
FROM (
  SELECT id,
         NULLIF(trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '') AS candidate,
         row_number() OVER (
           PARTITION BY NULLIF(trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '')
           ORDER BY created_at, id
         ) AS rn
    FROM company
) AS base
WHERE company.id = base.id;

-- A company whose name produced nothing usable still needs a handle.
UPDATE company SET slug = 'company-' || substr(md5(id), 1, 8) WHERE slug IS NULL OR slug = '';

ALTER TABLE company ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX company_slug_idx ON company (slug);

-- --- who they are, for documents and mail ----------------------------------

/* The trading name is already `name`. This is the one that goes on a lease and
   a 1099, which is frequently different and legally the one that matters. */
ALTER TABLE company ADD COLUMN legal_name   TEXT;
ALTER TABLE company ADD COLUMN logo_path    TEXT;
ALTER TABLE company ADD COLUMN address      TEXT;
ALTER TABLE company ADD COLUMN website      TEXT;

/* ISO 4217. Stored rather than assumed so a report cannot render dollars for a
   company that does not use them. */
ALTER TABLE company ADD COLUMN currency     TEXT NOT NULL DEFAULT 'USD';

/* Local opening hours, as minutes from midnight in the company's own timezone.
   Used to decide whether "call us" is advice or a dead end, and later to avoid
   texting somebody at 3am. */
ALTER TABLE company ADD COLUMN business_open_minute  INTEGER NOT NULL DEFAULT 540;   -- 09:00
ALTER TABLE company ADD COLUMN business_close_minute INTEGER NOT NULL DEFAULT 1020;  -- 17:00

-- --- signup and onboarding -------------------------------------------------

/* A company exists from the moment it signs up, unverified. The alternative —
   holding the signup in limbo until an email is clicked — loses companies to
   spam folders. Sign-in works; sending on their behalf does not, until this is
   set. */
ALTER TABLE company ADD COLUMN verified_at TEXT;

/* What the dashboard checklist has left to show. A JSON object rather than a
   column per step, because the steps will change and a migration per product
   decision is a bad trade. Read defensively; never trusted for authorisation. */
ALTER TABLE company ADD COLUMN onboarding TEXT NOT NULL DEFAULT '{}';

/* Existing companies predate signup and are not waiting on anything. */
UPDATE company
   SET verified_at = created_at,
       onboarding = '{"seeded":true}'
 WHERE verified_at IS NULL;

CREATE TABLE email_verification (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  -- 32 bytes, the same standard as every other tokenised link here.
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX email_verification_staff_idx ON email_verification (staff_id);
