/* A property company's own Stripe or PayPal key.

   The platform does not hold a processor account. Checkout is created with
   the key the company pasted, so the charge is already on their account and
   the money never lands here. The secrets are sealed. A database copy does
   not contain a usable key. */

ALTER TABLE company ADD COLUMN stripe_secret_sealed TEXT;
ALTER TABLE company ADD COLUMN stripe_webhook_sealed TEXT;

ALTER TABLE company ADD COLUMN paypal_client_id TEXT;
ALTER TABLE company ADD COLUMN paypal_secret_sealed TEXT;
ALTER TABLE company ADD COLUMN paypal_live INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tenant_payment DROP CONSTRAINT tenant_payment_kind_check;
ALTER TABLE tenant_payment ADD CONSTRAINT tenant_payment_kind_check
  CHECK (kind IN ('ach', 'card', 'paypal'));

ALTER TABLE tenant_payment ADD COLUMN paypal_order_id TEXT UNIQUE;
