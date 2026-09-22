/* Reconciling Stripe's payouts to the bank line.

   A tenant pays on the 3rd. Stripe settles it, holds it with a dozen others,
   and deposits one lump on the 6th. The bank statement shows that one line.
   Nothing in the application could previously connect the two, which meant
   the most common money-in line on a property manager's statement was also
   the one nobody could tick off.

   This is also the correction that makes `1020 Payments in transit` mean
   something. Settled rent was being posted straight into `1010 Trust cash`,
   which said the money was in the company's bank on the day the tenant
   authorised it. It was not — it was at Stripe, for days. Now settlement
   debits 1020, and the payout arriving moves it 1020 → 1010. The balance of
   1020 at any moment is exactly the money Stripe is holding, which is a
   number a property manager can check against their Stripe dashboard.

   Without that split there is nothing to reconcile against: the bank deposit
   would post rent into trust cash a second time. */

CREATE TABLE stripe_payout (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  stripe_payout_id TEXT NOT NULL,
  amount_cents    BIGINT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',

  /* When Stripe says it should land. The bank's posted date is usually the
     same day and sometimes the next, which is why matching is by a window
     rather than by equality. */
  arrival_date    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  /* Stripe's own description of where it went: "STRIPE TRANSFER" and the last
     four of the bank account, usually. Kept because it is what the bank line
     will say. */
  destination     TEXT,
  failure_message TEXT,

  /* The payments Stripe says are inside it, when the balance transactions
     could be read. Null means we have the payout but not its contents, which
     is still worth having — the bank line can be matched either way. */
  payment_count   INTEGER,
  fee_cents       BIGINT,

  created_at      TEXT NOT NULL,
  paid_at         TEXT,

  UNIQUE (company_id, stripe_payout_id)
);

CREATE INDEX stripe_payout_company_idx ON stripe_payout (company_id, arrival_date DESC);

/* Which payout a settled payment went out in. Null until the payout arrives
   and its contents are read. */
ALTER TABLE tenant_payment ADD COLUMN stripe_payout_id TEXT REFERENCES stripe_payout(id);
CREATE INDEX tenant_payment_payout_idx ON tenant_payment (stripe_payout_id);

/* Two new things a bank line can be matched against: a deposit from Stripe,
   and the debit for an ACH file we sent. Both are batches — one bank line
   covering many payments — which is the case the original matcher had no
   answer for. */
ALTER TABLE bank_match DROP CONSTRAINT bank_match_target_type_check;
ALTER TABLE bank_match ADD CONSTRAINT bank_match_target_type_check
  CHECK (target_type IN ('ledger_entry', 'vendor_invoice', 'journal', 'delinquency',
                         'stripe_payout', 'payout_batch'));
