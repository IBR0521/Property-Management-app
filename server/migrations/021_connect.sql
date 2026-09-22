/* Connecting a property manager's own payment account.

   Standard Connect, not Express. The difference is who carries the risk:
   Stripe holds the *platform* liable for negative balances on Express
   accounts, so a company that takes $40,000 of rent and then refunds it would
   leave us holding the loss. That is the custodial exposure this whole design
   exists to avoid, and a nicer onboarding flow is not worth reintroducing it.

   With Standard, the property management company completes Stripe's own
   onboarding, holds the account, sees the full dashboard, and carries its own
   chargebacks. Payments are created *on behalf of* that account, so funds go
   from the tenant to them and never touch a platform balance at any point. */

ALTER TABLE company ADD COLUMN stripe_account_id TEXT UNIQUE;

/* Read back from Stripe rather than inferred from "they clicked connect".

   A connected account can exist and still be unable to accept payments —
   identity checks outstanding, bank account not added, a document rejected
   weeks later. Showing a tenant a pay button in that state produces a failure
   the tenant cannot understand and the manager cannot explain. */
ALTER TABLE company ADD COLUMN stripe_charges_enabled  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company ADD COLUMN stripe_payouts_enabled  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company ADD COLUMN stripe_requirements     TEXT;
ALTER TABLE company ADD COLUMN stripe_checked_at       TEXT;

/* --- who pays the processing fee ------------------------------------------

   absorb   the company pays it; the tenant is charged rent exactly
   pass     the tenant is charged rent plus the fee
   split    a fixed percentage of the fee is added to the tenant's charge

   Stored per company and per method, because the answer is usually different:
   ACH on $1,450 costs a few dollars and is often absorbed, while the card fee
   on the same amount is over forty and almost never is.

   Surcharging a card is restricted by the card networks and by several US
   states, and the limits differ between credit and debit. The application
   allows it and says so in the interface; it does not attempt to encode fifty
   jurisdictions' rules, and the setting is marked for legal review the same
   way the notice templates are. */
ALTER TABLE company ADD COLUMN ach_fee_model  TEXT NOT NULL DEFAULT 'absorb'
  CHECK (ach_fee_model IN ('absorb', 'pass', 'split'));
ALTER TABLE company ADD COLUMN card_fee_model TEXT NOT NULL DEFAULT 'pass'
  CHECK (card_fee_model IN ('absorb', 'pass', 'split'));

-- Percentage of the fee the tenant bears when the model is 'split'. 0-100.
ALTER TABLE company ADD COLUMN ach_fee_split_percent  REAL NOT NULL DEFAULT 50;
ALTER TABLE company ADD COLUMN card_fee_split_percent REAL NOT NULL DEFAULT 50;

/* Which methods a company offers at all. Cards are off by default: rent is a
   large amount, the fee is proportional, and a company should decide to offer
   it rather than discover it. */
ALTER TABLE company ADD COLUMN accept_ach  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE company ADD COLUMN accept_card INTEGER NOT NULL DEFAULT 0;

/* The rates used to quote a fee to a tenant before they authorise.

   Stripe's published rates at the time of writing, stored rather than
   hard-coded because they change, they are negotiable at volume, and a quoted
   fee that does not match what is actually charged is worse than not quoting
   one. Cents and basis points so there is no floating point in the arithmetic
   that decides what somebody is charged. */
ALTER TABLE company ADD COLUMN ach_fee_bps       INTEGER NOT NULL DEFAULT 80;    -- 0.80%
ALTER TABLE company ADD COLUMN ach_fee_cap_cents INTEGER NOT NULL DEFAULT 500;   -- $5.00
ALTER TABLE company ADD COLUMN card_fee_bps      INTEGER NOT NULL DEFAULT 290;   -- 2.90%
ALTER TABLE company ADD COLUMN card_fee_fixed_cents INTEGER NOT NULL DEFAULT 30;

/* Connect events arrive about an account rather than a subscription, so they
   need their own idempotency record for the same reason stripe_event does. */
CREATE TABLE connect_event (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES company(id) ON DELETE CASCADE,
  stripe_id     TEXT NOT NULL UNIQUE,
  account_id    TEXT,
  kind          TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  outcome       TEXT
);

CREATE INDEX connect_event_company_idx ON connect_event (company_id, received_at DESC);
