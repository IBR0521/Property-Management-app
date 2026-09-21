-- ===========================================================================
-- Rate limiting
-- ---------------------------------------------------------------------------
-- There was none. Sign-in could be brute-forced and the public tenant and
-- application forms could be flooded without limit.
--
-- This lives in the database rather than in process memory because the app
-- runs serverless: every invocation is a fresh process, so an in-memory
-- counter would reset constantly and enforce nothing.
-- ===========================================================================

CREATE TABLE rate_hit (
  bucket      TEXT NOT NULL,        -- what is being limited, e.g. 'signin'
  subject     TEXT NOT NULL,        -- who: an ip, or ip+email
  at          TEXT NOT NULL,        -- ISO timestamp of the attempt
  id          TEXT PRIMARY KEY
);
CREATE INDEX idx_rate_hit_lookup ON rate_hit(bucket, subject, at);
