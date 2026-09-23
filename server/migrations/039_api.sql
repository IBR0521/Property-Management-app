/* A public API, and the keys that reach it.

   ## A key is not a second authorisation model

   The temptation with an API is to give it its own permission system, and
   that is how a product ends up with two answers to "may this caller do
   this" that disagree. There is one answer here: **a key can do what its
   holder could do, and less.**

   So a key belongs to a member of staff. What it may do is the intersection
   of its scopes with that person's role — resolved on every request, from
   the current staff row, so deactivating somebody or changing their role
   takes their keys with it. A key outliving the authority it was issued
   under is the failure this shape exists to prevent.

   ## Why the secret is stored as a SHA-256 and not as a scrypt hash

   Passwords get scrypt because people choose them, and a slow hash is what
   buys time against a guessable secret. An API key is 32 bytes from the
   system's random source: there is nothing to guess, and a slow hash on
   every request would be a self-inflicted rate limit. SHA-256 of a 256-bit
   random value is not brute-forceable, and the whole key is never stored.

   The key is shown once, at creation, and cannot be recovered afterwards —
   because "we can show it to you again" means "we have it", and the day a
   database leaks is the day that matters.

   ## Why the rate counter is not `rate_hit`

   `rate_hit` writes one row per attempt, which is right for a sign-in form
   that a person uses eight times an hour and wrong for an API that a script
   uses a thousand times. This counts into one row per key per window, with
   an upsert — so the cost of rate limiting does not grow with the traffic
   it is limiting. Fixed windows rather than rolling, which allows a burst
   across a boundary and is the ordinary trade every fixed-window limiter
   makes. */

CREATE TABLE api_key (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* Whose authority this key carries. Not nullable: a key with no holder is
     a key with no ceiling. */
  staff_id      TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,

  name          TEXT NOT NULL,

  /* SHA-256 of the secret half, hex. The key itself is never stored. */
  secret_hash   TEXT NOT NULL,
  /* The first few characters, so a person can tell two keys apart in a list
     without either of them being recoverable from it. */
  hint          TEXT NOT NULL,

  /* JSON array of scope names. A column rather than a join table: scopes are
     a fixed vocabulary the application owns, they are always read all at
     once, and a row per scope buys nothing but a join. */
  scopes        TEXT NOT NULL DEFAULT '[]',

  last_used_at  TEXT,
  /* Where from, last time. Enough to answer "is this key still in use and by
     what" without keeping a log of every call for ever. */
  last_used_ip  TEXT,
  calls         BIGINT NOT NULL DEFAULT 0,

  revoked_at    TEXT,
  revoked_by    TEXT,

  created_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX api_key_company_idx ON api_key (company_id, created_at DESC);
CREATE INDEX api_key_staff_idx ON api_key (staff_id);

-- --- rate limiting, one row per key per window --------------------------------

CREATE TABLE api_rate (
  key_id        TEXT NOT NULL REFERENCES api_key(id) ON DELETE CASCADE,
  /* The ISO hour the window starts at, e.g. 2026-09-24T14. A string because
     every other time in this schema is one, and because it is the natural
     key rather than a number that has to be explained. */
  window_start  TEXT NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE INDEX api_rate_window_idx ON api_rate (window_start);

-- --- what the API was asked for -----------------------------------------------

/* Not a copy of every request. What it answers is "what has this key been
   doing", which needs the route and the outcome, and does not need the body
   — a request log holding payloads is a second copy of the customer's data
   with none of the protections the first one has.

   Pruned by the scheduler, because a log nobody bounds is a table that
   eventually costs more than the feature. */
CREATE TABLE api_request (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  key_id        TEXT REFERENCES api_key(id) ON DELETE SET NULL,
  at            TEXT NOT NULL,
  method        TEXT NOT NULL,
  /* The pattern, not the path: `/api/v1/units/:id` rather than one row per
     unit anybody has ever fetched. */
  route         TEXT NOT NULL,
  status        INTEGER NOT NULL,
  ms            INTEGER,
  ip            TEXT,
  /* Only when something went wrong, and only the reason. */
  error         TEXT
);

CREATE INDEX api_request_company_idx ON api_request (company_id, at DESC);
CREATE INDEX api_request_key_idx ON api_request (key_id, at DESC);
