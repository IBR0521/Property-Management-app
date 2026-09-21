/* Lease documents and their signatures.

   What makes an electronic signature defensible is not the image of a name —
   it is being able to show, years later, exactly which bytes the person agreed
   to and what happened at the moment they agreed. So the rendered document is
   frozen and hashed at the moment it goes out, and every signature stores the
   hash it was applied to. If the stored body is ever altered the hashes stop
   matching and the tampering is visible rather than silent. */

CREATE TABLE lease_template (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'lease' CHECK (kind IN ('lease','addendum','notice','renewal')),
  -- Markdown with {{token}} placeholders. Markdown because a lease is read by
  -- people, and the source has to stay legible to whoever maintains it.
  body_md     TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (company_id, name)
);

CREATE TABLE lease_document (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id     TEXT REFERENCES lease(id) ON DELETE SET NULL,
  unit_id      TEXT REFERENCES unit(id),
  template_id  TEXT REFERENCES lease_template(id),
  title        TEXT NOT NULL,
  /* The compiled result, with every token already replaced. Never re-rendered:
     the template can change tomorrow and this document must not. */
  body_md      TEXT NOT NULL,
  body_hash    TEXT NOT NULL,              -- sha256 of body_md, hex
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','out_for_signature','signed','void')),
  -- The signing link. Same pattern as every other tokenised page here: the URL
  -- is the credential, so it is 32 bytes.
  token        TEXT UNIQUE,
  -- Who still has to sign, as a JSON array of party types, so a document knows
  -- when it is finished without counting rows against a rule held elsewhere.
  required     TEXT NOT NULL DEFAULT '["tenant","manager"]',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT,
  completed_at TEXT,
  void_reason  TEXT
);

CREATE INDEX lease_document_lease_idx ON lease_document (lease_id);
CREATE INDEX lease_document_status_idx ON lease_document (company_id, status);

CREATE TABLE lease_signature (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES lease_document(id) ON DELETE CASCADE,
  party_type    TEXT NOT NULL CHECK (party_type IN ('tenant','manager','owner','guarantor','witness')),
  party_name    TEXT NOT NULL,
  party_email   TEXT NOT NULL,
  /* What the signer typed, kept verbatim alongside the hash. A typed name is
     the legal mark under ESIGN/UETA; the hash is what makes it checkable. */
  typed_name    TEXT NOT NULL,
  -- sha256 over document hash + party + typed name + timestamp + ip.
  signature_hash TEXT NOT NULL,
  -- The document hash as it stood when this signature was applied. Compared
  -- against lease_document.body_hash to detect a document changed after signing.
  document_hash TEXT NOT NULL,
  signed_at     TEXT NOT NULL,
  /* The compliance trail. Required, not optional: a signature with no record of
     where it came from is the one that gets challenged. */
  ip            TEXT NOT NULL,
  user_agent    TEXT NOT NULL,
  -- ESIGN requires affirmative consent to do business electronically, recorded
  -- separately from the signature itself.
  consent_esign INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (document_id, party_type, party_email)
);

CREATE INDEX lease_signature_document_idx ON lease_signature (document_id);

/* A signature is evidence. It is never edited and never deleted; a document
   that should not stand is voided, which leaves the signatures visible. */
CREATE OR REPLACE FUNCTION forbid_signature_rewrite() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'signatures are evidence and cannot be % — void the document instead',
    lower(TG_OP) USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lease_signature_immutable
  BEFORE UPDATE OR DELETE ON lease_signature
  FOR EACH ROW EXECUTE FUNCTION forbid_signature_rewrite();
