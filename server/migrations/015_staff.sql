/* Staff: invitations, a field-technician role, and two-factor authentication.

   Until now a staff member existed because the seed script made one. A real
   company adds people, and the way you add a person to software that holds
   other people's money is not "type a password for them and read it out" — it
   is a link only they can use, that expires.

   The technician role is deliberately separate from `maintenance`. A
   maintenance coordinator works the whole queue from a desk. A technician
   works the jobs assigned to them, from a van, on a phone, and has no reason
   to see the rest of the portfolio. Phase 5 builds that view; this is the role
   it needs to exist for. */

-- --- the technician role ---------------------------------------------------

DO $$
DECLARE cn TEXT;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'staff'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%role%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE staff DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('admin', 'manager', 'accountant', 'leasing', 'maintenance', 'technician'));

-- --- invitations -----------------------------------------------------------

/* An invitation is a tokenised link, the same pattern as every other one here.
   The staff row is not created until the invitation is accepted: a row that
   exists but cannot sign in is indistinguishable from a deactivated colleague,
   and the difference matters when an administrator is auditing who has access.

   The role is chosen at invitation time and frozen into the token, so the
   person accepting cannot choose their own. */
CREATE TABLE staff_invite (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL
               CHECK (role IN ('admin', 'manager', 'accountant', 'leasing', 'maintenance', 'technician')),
  token        TEXT NOT NULL UNIQUE,
  invited_by   TEXT REFERENCES staff(id) ON DELETE SET NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL,
  /* One live invitation per address per company. Sending a second while the
     first is outstanding should replace it rather than leave two valid links
     to the same seat. Partial, so accepted and revoked rows do not block a
     genuine re-invitation later. */
  UNIQUE (company_id, email, accepted_at, revoked_at)
);

CREATE INDEX staff_invite_company_idx ON staff_invite (company_id, created_at);

-- --- two-factor authentication ---------------------------------------------

/* The secret is sealed with the same AES-256-GCM envelope as bank tokens and
   taxpayer IDs. A TOTP secret in the clear is a second password sitting next
   to the first one. */
ALTER TABLE staff ADD COLUMN totp_secret_enc   TEXT;

/* Enrolment is two steps: generate a secret, then prove a code from it works.
   Until that proof arrives the secret is present but not enforced, or a
   mistyped setup would lock somebody out of their own account. */
ALTER TABLE staff ADD COLUMN totp_confirmed_at TEXT;

/* Codes are stored hashed, like passwords, and struck through as they are
   used. Without recovery codes the failure mode of 2FA is a locked-out
   administrator and a support request nobody can satisfy. */
CREATE TABLE staff_recovery_code (
  id         TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX staff_recovery_code_staff_idx ON staff_recovery_code (staff_id);

/* An administrator can require it for everybody. Enforced at sign-in: a staff
   member without it is walked through enrolment before they reach anything
   else. */
ALTER TABLE company ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0;

/* Which session has already presented a second factor. A session is only
   half-authenticated until it does, and the gate in app.js reads this. */
ALTER TABLE session ADD COLUMN totp_at TEXT;
