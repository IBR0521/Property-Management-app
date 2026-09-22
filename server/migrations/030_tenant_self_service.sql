/* The two things a tenant does for themselves.

   **Renters insurance.** Most leases require it and almost no company has a
   reliable record of who currently holds it, because the process is an email
   with a PDF attached that somebody files in a folder. A tenant uploading it
   themselves, against their own tenancy, with an expiry date that can be
   swept, is the whole feature.

   The important restraint: **this application does not decide whether a
   policy is acceptable.** It records what was uploaded and what expiry the
   tenant stated, and a member of staff confirms it. Reading a PDF and
   declaring somebody insured would be the app asserting a legal fact it
   cannot check — the same family of mistake as scoring an applicant
   automatically, and the roadmap forbids that for the same reason.

   **Contact details.** A tenant can correct their own phone number, which is
   the field most likely to be wrong and the one that matters when a boiler
   fails at eleven at night.

   Their email is deliberately not editable here. It is their login, and
   changing it would move their portal access to a different person — an
   account takeover with a typo. Doing it properly needs a verification
   round-trip to the new address, which is real work and is better done
   deliberately later than half-done now. The screen says so. */

-- --- what the lease asks for -------------------------------------------------

/* The company's requirement, not ours. A lease that does not require cover
   should not nag a tenant about it, and the minimum is whatever the lease
   says rather than a number this application invented. */
ALTER TABLE lease ADD COLUMN insurance_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lease ADD COLUMN insurance_min_liability_cents BIGINT;

-- --- what the tenant uploaded ------------------------------------------------

CREATE TABLE renters_insurance (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id        TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  /* Who uploaded it, where we know. Null for a staff upload on behalf. */
  tenant_id       TEXT REFERENCES tenant(id) ON DELETE SET NULL,

  /* Stated by whoever uploaded it, and never parsed out of the document.
     A carrier name read by a machine from a scanned PDF is a guess, and a
     guess in this field is a company believing it has cover it does not. */
  carrier         TEXT,
  policy_no       TEXT,
  liability_cents BIGINT,
  starts_on       TEXT,
  expires_on      TEXT NOT NULL,

  doc_path        TEXT,
  doc_mime        TEXT,

  /* pending    uploaded, nobody has looked at it
     accepted   a member of staff confirmed it
     rejected   a member of staff refused it, with a reason the tenant reads
     superseded a newer one replaced it
     expired    its own date passed */
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded', 'expired')),

  uploaded_by     TEXT NOT NULL DEFAULT 'tenant'
                  CHECK (uploaded_by IN ('tenant', 'staff')),
  uploaded_at     TEXT NOT NULL,

  /* The human decision. `review_note` is shown to the tenant when it is a
     rejection, because "rejected" with no reason produces a phone call. */
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_note     TEXT,

  created_at      TEXT NOT NULL
);

CREATE INDEX renters_insurance_lease_idx ON renters_insurance (lease_id, uploaded_at DESC);
CREATE INDEX renters_insurance_expiry_idx ON renters_insurance (company_id, expires_on)
  WHERE status IN ('pending', 'accepted');

-- --- how a tenant wants to be contacted --------------------------------------

/* Consent already exists per (company, channel, contact) in `contact_consent`,
   and that is the right place for it. What is new is that a tenant can now set
   it themselves rather than it only being recorded from a STOP reply or a
   bounce, so the source column gains a value it did not have before.

   Nothing is added here for it. The column is free text on purpose, so
   "portal" needs no migration — this note exists so that the absence of one
   is a decision rather than an oversight. */
