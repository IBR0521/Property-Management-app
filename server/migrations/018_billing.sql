/* Subscriptions.

   This is the platform's own revenue, and it is the one place in this codebase
   where money moves *to us* rather than between a tenant, an owner and a
   contractor. It is deliberately kept apart from the accounting tables for
   that reason: the double-entry journal is the customer's book, and our
   invoice has no business in it.

   Two rules shape the schema.

   **A lapsed subscription never deletes anything.** It makes the company
   read-only. Their data stays theirs, every screen still loads, and writes are
   refused with an explanation and a link to pay. Deleting a customer's
   portfolio because a card expired would be indefensible, and "export before
   we delete" is a threat rather than a product.

   **What Stripe says is what is true.** Subscription state is a copy of
   Stripe's, updated by webhook, never computed locally from dates. A local
   guess about whether somebody has paid will eventually disagree with the
   processor, and when it does it will lock out a paying customer. */

CREATE TABLE subscription (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL UNIQUE REFERENCES company(id) ON DELETE CASCADE,

  -- Which band they are on. Null while trialling and never chosen.
  plan_key            TEXT,

  /* Stripe's own identifiers. Nullable because a company exists, and trials,
     before any of them do. */
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,

  /* Mirrors Stripe's status vocabulary rather than inventing one, so the
     webhook is a copy rather than a translation. 'none' is ours: it means
     nothing has ever been started. */
  status              TEXT NOT NULL DEFAULT 'none'
                      CHECK (status IN ('none', 'trialing', 'active', 'past_due',
                                        'canceled', 'unpaid', 'incomplete', 'paused')),

  trial_ends_at       TEXT,
  current_period_end  TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,

  /* Denormalised from the portfolio when a plan is chosen or a webhook
     arrives, so the billing page can show what band they are in without
     counting units on every request. */
  units_at_last_check INTEGER,
  last_checked_at     TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX subscription_status_idx ON subscription (status);

/* Every company that already exists predates billing. They start on a trial
   rather than locked out — turning billing on must not read as an outage to
   somebody who was working fine yesterday. */
INSERT INTO subscription (id, company_id, status, trial_ends_at, created_at, updated_at)
SELECT md5(c.id || 'sub'), c.id, 'trialing',
       to_char((now() + interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM company c
ON CONFLICT (company_id) DO NOTHING;

/* Webhook idempotency, the same pattern as delivery_event and for the same
   reason: Stripe delivers at least once and replays on any non-2xx, so the
   same event arrives repeatedly. company_id is nullable because an event is
   identified by Stripe's ids and the company is not known until it is
   matched. */
CREATE TABLE stripe_event (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES company(id) ON DELETE CASCADE,
  stripe_id     TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  outcome       TEXT
);

CREATE INDEX stripe_event_received_idx ON stripe_event (received_at);
