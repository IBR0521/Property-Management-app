/* Tenants paying rent.

   The money never enters a platform balance. Charges are created on behalf of
   the company's own connected account, so funds go from the tenant to that
   company's bank. These tables record what happened; they are not a wallet.

   Three things drive the shape.

   **A payment has a life, not a moment.** An ACH debit is authorised today,
   settles in two to five days, and can be returned two weeks later for
   insufficient funds. Between authorisation and settlement the money is real,
   owed to the owner, and not yet spendable — which is why `1020 Payments in
   transit` exists and why a payment carries dates for each stage rather than
   one `paid` flag.

   **A return unwinds something everybody believed.** The tenant was told they
   paid, the owner's statement said so, the delinquency closed. When the return
   arrives the ledger must be corrected by a reversing entry rather than by
   deleting the original, because the journal is append-only and because the
   original did happen — it was the settlement that failed.

   **A saved payment method is a standing instruction.** Autopay charges a bank
   account on a schedule without anybody present, so what was consented to and
   when has to be recorded. */

-- --- how a tenant pays -----------------------------------------------------

CREATE TABLE tenant_payment_method (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id       TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  tenant_id      TEXT REFERENCES tenant(id) ON DELETE SET NULL,

  kind           TEXT NOT NULL CHECK (kind IN ('ach', 'card')),
  /* Stripe's id for the method, stored on the connected account. Not a
     credential we can use on its own and not card data — the card number
     never reaches this server, which is the point of using their elements. */
  stripe_payment_method_id TEXT NOT NULL,
  /* Enough to recognise it on a screen and nothing more. */
  label          TEXT,
  last4          TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'failed', 'removed')),

  /* When the tenant agreed this may be charged without them present, and from
     where. Autopay is a standing instruction and a disputed one is answered
     with this or not at all. */
  mandate_accepted_at TEXT,
  mandate_ip          TEXT,
  mandate_text        TEXT,

  created_at     TEXT NOT NULL,
  removed_at     TEXT,
  UNIQUE (company_id, stripe_payment_method_id)
);

CREATE INDEX tenant_payment_method_lease_idx
  ON tenant_payment_method (lease_id, status);

-- --- a payment -------------------------------------------------------------

CREATE TABLE tenant_payment (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id       TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  unit_id        TEXT REFERENCES unit(id),
  owner_id       TEXT REFERENCES owner(id),
  payment_method_id TEXT REFERENCES tenant_payment_method(id) ON DELETE SET NULL,

  kind           TEXT NOT NULL CHECK (kind IN ('ach', 'card')),
  /* Every figure the quote produced, frozen. Recomputing a fee later against
     rates that have since changed would make a receipt disagree with itself. */
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  fee_cents          BIGINT NOT NULL DEFAULT 0,
  tenant_fee_cents   BIGINT NOT NULL DEFAULT 0,
  charged_cents      BIGINT NOT NULL,
  period             TEXT,

  /* pending    created, not yet submitted
     processing authorised, money in flight
     succeeded  settled into the company's account
     failed     never left the tenant's account
     returned   settled and then clawed back
     refunded   sent back deliberately */
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'succeeded',
                                   'failed', 'returned', 'refunded')),

  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id         TEXT,

  initiated_by   TEXT NOT NULL DEFAULT 'tenant'
                 CHECK (initiated_by IN ('tenant', 'autopay', 'staff')),

  /* The two books, linked when the payment settles and again when it is
     reversed. Null until then: an authorised payment is not yet income. */
  ledger_entry_id TEXT REFERENCES ledger_entry(id),
  journal_id      TEXT REFERENCES journal(id),
  reversal_journal_id TEXT REFERENCES journal(id),

  failure_code   TEXT,
  failure_reason TEXT,
  /* R01 insufficient funds, R02 account closed, and so on. Kept because the
     right response differs: a closed account means stop trying, and a company
     may put a lease on cash-only after one. */
  return_code    TEXT,

  created_at     TEXT NOT NULL,
  submitted_at   TEXT,
  settled_at     TEXT,
  failed_at      TEXT,
  returned_at    TEXT
);

CREATE INDEX tenant_payment_lease_idx ON tenant_payment (lease_id, created_at DESC);
CREATE INDEX tenant_payment_status_idx ON tenant_payment (company_id, status);
CREATE INDEX tenant_payment_period_idx ON tenant_payment (lease_id, period)
  WHERE status IN ('processing', 'succeeded');

-- --- autopay ---------------------------------------------------------------

CREATE TABLE autopay (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id       TEXT NOT NULL UNIQUE REFERENCES lease(id) ON DELETE CASCADE,
  payment_method_id TEXT NOT NULL REFERENCES tenant_payment_method(id) ON DELETE CASCADE,

  /* Charged this many days before the due date, so an ACH debit has time to
     settle before rent is late. Zero means on the day. */
  days_before_due INTEGER NOT NULL DEFAULT 3
                  CHECK (days_before_due >= 0 AND days_before_due <= 28),

  /* A ceiling the tenant sets. Rent rises; an instruction to take whatever is
     owed does not expire on its own, and a tenant who agreed to $1,450 should
     not silently be charged $1,800. Null means no ceiling. */
  max_amount_cents BIGINT,

  active         INTEGER NOT NULL DEFAULT 1,
  /* The last period this successfully charged, so a second run in the same
     month does nothing. */
  last_period    TEXT,
  last_run_at    TEXT,
  last_error     TEXT,

  enrolled_at    TEXT NOT NULL,
  cancelled_at   TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX autopay_active_idx ON autopay (company_id, active) WHERE active = 1;

-- --- blocking payments on a lease ------------------------------------------

/* Cash-only after a returned payment, or during an eviction where accepting
   rent can waive the proceeding. A reason is required and shown to the tenant:
   "payment unavailable" with no explanation generates a phone call, which is
   the thing this product exists to remove. */
ALTER TABLE lease ADD COLUMN payments_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lease ADD COLUMN payments_blocked_reason TEXT;
ALTER TABLE lease ADD COLUMN payments_blocked_at TEXT;
ALTER TABLE lease ADD COLUMN payments_blocked_by TEXT;

/* The tenant-facing payment page needs a credential, and tenants have no
   account here by design. Same 32-byte token as every other public page. */
ALTER TABLE lease ADD COLUMN pay_token TEXT;

UPDATE lease
   SET pay_token = translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_')
 WHERE pay_token IS NULL;

ALTER TABLE lease ALTER COLUMN pay_token SET NOT NULL;
CREATE UNIQUE INDEX lease_pay_token_idx ON lease (pay_token);
