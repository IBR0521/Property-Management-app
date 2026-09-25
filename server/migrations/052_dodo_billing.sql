/* The platform's own subscription is billed by Dodo Payments.

   Stripe stays in the schema because a subscription that already exists there
   is still a fact, and tenant rent is a different Stripe account entirely.
   New plans are started in Dodo. What Dodo says is what is true: these columns
   are a copy of that, written by the webhook, never guessed from a date. */

ALTER TABLE subscription ADD COLUMN dodo_customer_id TEXT UNIQUE;
ALTER TABLE subscription ADD COLUMN dodo_subscription_id TEXT UNIQUE;

/* Dodo delivers at least once and retries any non-2xx. webhook_id is the
   header they send for exactly this, so a replay is a no-op. */
CREATE TABLE dodo_event (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES company(id) ON DELETE CASCADE,
  webhook_id    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  outcome       TEXT
);

CREATE INDEX dodo_event_received_idx ON dodo_event (received_at);
