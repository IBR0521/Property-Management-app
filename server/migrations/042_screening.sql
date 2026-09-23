/* Tenant screening.

   ## What this is not

   It is not a consumer reporting agency, and the platform is not a reseller.
   Pulling a credit file means credentialing with the bureau, an on-site
   inspection of physical premises, and — for anybody in the middle — a
   reporting agency's own accuracy obligations toward every applicant plus
   permissible-purpose checks on every end-user landlord.

   So the company brings their own screening account. What is here is
   everything the law requires **whoever** pulls the report: the applicant's
   consent, the record of what was read, the adverse action notice, and rules
   about how long any of it is kept.

   ## There is no score column, and that is the point

   A screening report has a number on the front of it, and numbers want to be
   sorted. The day a `score` column exists on an application, somebody adds
   "decline below 620" and the oldest rule in this application — no automated
   applicant scoring, no automated decision — is gone without anybody deciding
   to remove it.

   So the report is a document and a person's summary of it. The only place a
   score is recorded is on the adverse action notice, because the law requires
   it there — and that record is created *after* a decision, by a human typing
   what they read, so it cannot have influenced anything.

   ## Why the consent wording is frozen

   Same reason a lease document is. What matters later is not that somebody
   ticked a box, it is what they were shown when they ticked it. The wording
   is stored verbatim with a hash over it, so an altered record stops
   matching. */

CREATE TABLE screening_consent (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,

  /* Named to the applicant, because a consent that does not say who will see
     the file is not consent to anything in particular. */
  provider       TEXT NOT NULL,
  provider_name  TEXT NOT NULL,

  /* Verbatim, and the hash over it. */
  wording        TEXT NOT NULL,
  wording_hash   TEXT NOT NULL,

  typed_name     TEXT NOT NULL,
  ip             TEXT,
  user_agent     TEXT,

  /* Withdrawn rather than deleted: that somebody consented and later changed
     their mind is itself part of the record. */
  withdrawn_at   TEXT,

  consented_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX screening_consent_app_idx ON screening_consent (application_id, consented_at DESC);

CREATE TABLE screening_request (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  /* No consent, no request. Enforced in the application as well, but a
     NOT NULL here is the version that cannot be forgotten. */
  consent_id     TEXT NOT NULL REFERENCES screening_consent(id) ON DELETE RESTRICT,

  provider       TEXT NOT NULL,
  /* ordered    the applicant has been sent to the provider
     received   a report is here
     cancelled  it was not gone through with */
  status         TEXT NOT NULL DEFAULT 'ordered'
                 CHECK (status IN ('ordered', 'received', 'cancelled')),

  /* The provider's own reference, so a person can find it on their side. */
  reference      TEXT,

  /* The report itself, while it is kept. */
  report_path    TEXT,
  report_mime    TEXT,
  report_bytes   INTEGER,

  /* What the person who read it wrote down. Deliberately prose: a field that
     held a figure would be a field something could sort on. */
  summary        TEXT,

  ordered_by     TEXT,
  ordered_at     TEXT NOT NULL,
  received_at    TEXT,

  /* Retention. The row stays for ever — it is the record that screening
     happened — and the report itself does not. */
  deleted_at     TEXT,
  deleted_why    TEXT
);

CREATE INDEX screening_request_app_idx ON screening_request (application_id, ordered_at DESC);
/* For the retention sweep: the ones still holding a file. */
CREATE INDEX screening_request_holding_idx
  ON screening_request (company_id, received_at)
  WHERE report_path IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE adverse_action (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,

  /* The elements the notice is required to contain. Captured here, at the
     moment of decision, rather than read back from a report that will be
     deleted on schedule. */
  agency_name    TEXT NOT NULL,
  agency_address TEXT,
  agency_phone   TEXT,

  /* Only when a credit score influenced the decision, and TEXT throughout on
     purpose. A score transcribed from a report is "712", or "no score", or
     "N/A" — and a numeric column here would be the one sortable score in the
     system, which is the thing this feature must not create. */
  score          TEXT,
  score_source   TEXT,
  score_date     TEXT,
  score_range    TEXT,
  score_factors  TEXT,

  /* The notice is required even when the report was a minor factor, so this
     is asked in those words and recorded as it was answered. */
  contributed    INTEGER NOT NULL DEFAULT 1,

  /* Frozen, like every other notice this application sends. */
  rendered_body  TEXT NOT NULL,
  template_key   TEXT NOT NULL DEFAULT 'adverse_action',

  channel        TEXT,
  to_contact     TEXT,
  /* The outbox row, so "was it sent" is answered by the delivery record
     rather than by this one claiming it. */
  outbox_id      TEXT,

  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX adverse_action_app_idx ON adverse_action (application_id, created_at DESC);
CREATE INDEX adverse_action_company_idx ON adverse_action (company_id, created_at DESC);
