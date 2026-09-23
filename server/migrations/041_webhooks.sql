/* Telling somebody else's system that something happened here.

   ## Why a delivery is a row and not a fire-and-forget request

   "Did you send it" is the first question every integration asks, and the
   only answer worth having is a record. So the intention to deliver is
   written in the same transaction as the thing it describes — either the
   work order exists and the delivery is queued, or neither — and every
   attempt afterwards updates that row. A customer can look at what was sent,
   when, what came back, and why it stopped.

   That also makes the sending asynchronous, which it has to be. A webhook
   endpoint is somebody else's server; a slow one must not make raising a
   work order slow, and a broken one must not make it fail.

   ## Why the endpoint carries its own secret

   One secret per endpoint, so rotating it or revoking a compromised one
   affects that integration and nothing else. Shown once when it is made, for
   the same reason an API key is.

   ## Why an endpoint disables itself

   An endpoint that has failed every attempt for days is a URL somebody
   decommissioned and forgot to remove, and retrying it for ever is a slow
   outbound scan of an address we no longer have a reason to be contacting.
   It disables itself and says why, rather than filling a queue nobody
   reads. */

CREATE TABLE webhook_endpoint (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  url           TEXT NOT NULL,
  /* `whsec_` + base64, the shape the Standard Webhooks libraries expect. */
  secret        TEXT NOT NULL,
  description   TEXT,

  /* JSON array of event names. Empty means every event, which is what a
     first integration usually wants and is stated rather than implied. */
  events        TEXT NOT NULL DEFAULT '[]',

  active        INTEGER NOT NULL DEFAULT 1,
  /* Set when this endpoint turned itself off, with the reason. */
  disabled_at   TEXT,
  disabled_why  TEXT,
  /* Reset by any success. The auto-disable counts this, not total failures:
     an endpoint that fails once a week is having a bad week, and one that has
     failed the last forty times is gone. */
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  last_success_at TEXT,
  last_failure_at TEXT,

  created_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX webhook_endpoint_company_idx ON webhook_endpoint (company_id, created_at DESC);

CREATE TABLE webhook_delivery (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  endpoint_id   TEXT NOT NULL REFERENCES webhook_endpoint(id) ON DELETE CASCADE,

  event         TEXT NOT NULL,
  /* The body, exactly as it will be signed and sent. Kept rather than rebuilt
     from the record it describes: a webhook says what was true when it fired,
     and re-deriving it later would send a different thing under the same id. */
  payload       TEXT NOT NULL,

  /* pending    queued, or waiting for its next attempt
     delivered  the endpoint answered 2xx
     failed     the endpoint answered something final, like a 404 or a 410
     blocked    refused before it was sent — a private address, or not https
     dead       out of attempts */
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'delivered', 'failed', 'blocked', 'dead')),

  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,

  response_status INTEGER,
  /* Truncated. Enough to recognise an error page, not enough to be a copy of
     somebody else's application. */
  response_body TEXT,
  error         TEXT,

  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  last_attempt_at TEXT
);

CREATE INDEX webhook_delivery_due_idx
  ON webhook_delivery (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX webhook_delivery_company_idx ON webhook_delivery (company_id, created_at DESC);
CREATE INDEX webhook_delivery_endpoint_idx ON webhook_delivery (endpoint_id, created_at DESC);
