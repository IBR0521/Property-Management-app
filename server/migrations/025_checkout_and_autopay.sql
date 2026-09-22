/* The hosted checkout, and what a completed one leaves behind.

   A tenant with a browser is sent to Stripe's own page rather than typing a
   bank account into ours: the details never reach this server, there is no
   third-party script to allow through the content security policy, and the
   flow is two form posts and a redirect, so it works with JavaScript off.

   The session id is stored because the return leg carries it and nothing
   else. A tenant coming back from Stripe hands us a session, and without this
   column there would be no way to say which payment they had just made
   without trusting a number in the query string. */

ALTER TABLE tenant_payment ADD COLUMN stripe_checkout_session_id TEXT UNIQUE;

/* Autopay needs somewhere to record a run that was considered and declined.

   "Nothing happened" has several causes a tenant is owed an explanation for:
   the balance was zero, the amount was over the ceiling they set, the lease
   was blocked. Without this the screen can only say autopay is on, which is
   not the same as saying it worked. */
ALTER TABLE autopay ADD COLUMN last_skip_reason TEXT;

/* The charge is attempted this many days before rent is due, so an ACH debit
   has time to settle. A run that produced a payment records the period, which
   is what stops a second run in the same month charging twice — the unique
   index makes that the database's job rather than the scheduler's. */
CREATE UNIQUE INDEX autopay_period_once_idx
  ON tenant_payment (lease_id, period)
  WHERE initiated_by = 'autopay' AND status <> 'failed';
