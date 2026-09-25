# Every key and connection

The complete list, taken from `server/lib/config.js`, which is the only place
this application reads configuration. Nothing is read anywhere else.

**Where these go:** Vercel → your project → Settings → Environment Variables.
Set them for **Production** *and* **Preview**, or a preview deploy behaves
differently from the live one and you find out at the worst moment.

---

## 1. Already set — but two need rotating now

| Key | State | What to do |
|---|---|---|
| `DATABASE_URL` | set | **Rotate the password inside it.** Supabase → Database → Settings → reset password, then update this. The old one is in a chat log. |
| *(Supabase service-role key)* | set, in Supabase | **Roll it.** Supabase → Project Settings → API. It bypasses row-level security **by design**, so the database lockdown does not defend against whoever has the chat log. |
| `BLOB_READ_WRITE_TOKEN` | set by Vercel | Nothing. Vercel injects it when a Blob store is attached. |

---

## 2. Required before launch — the app refuses or misbehaves without them

| Key | Where to get it | What breaks without it |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Generate: `openssl rand -base64 32` | **Bank tokens and taxpayer IDs refuse to store.** The shape is validated at boot, not just its presence. **Losing it makes every sealed field unrecoverable** — keep it in a secret manager, not only in Vercel. |
| `APP_BASE_URL` | Your production URL, e.g. `https://app.yourdomain.com` | Twilio signs webhooks over the **full URL**, so a mismatch rejects every callback. Also every link inside every message. |
| `DATABASE_CA_CERT` | Supabase → Database → Settings → download CA certificate | TLS stays **encrypted but unverified** — resists eavesdropping, not interception. `/health` reports which mode is live. |
| `CRON_SECRET` | Generate: `openssl rand -hex 32` | The cron endpoint is the scheduler. Without a secret, anything that can reach the URL can trigger rent charges and sweeps. |

Also turn on **Enforce SSL on incoming connections** in Supabase → Database →
Settings. That is a switch, not a key.

---

## 3. Email — nothing is sent until these exist

The product is honest about this: a message reads "not sent" rather than
claiming otherwise. That is why the 43 queued messages are still queued.

| Key | Where | Notes |
|---|---|---|
| `RESEND_API_KEY` | resend.com → API Keys | Free tier is enough to start. |
| `EMAIL_FROM` | You choose | Must be on a domain you have authenticated below. |
| `RESEND_WEBHOOK_SECRET` | Resend → Webhooks | Delivery and bounce events. Without it you cannot tell a delivered message from a bounced one. |
| `RESEND_INBOUND_SECRET` | Resend → Inbound | Only if tenants should be able to **reply** to messages. Unset, `/api/webhooks/resend-inbound` returns 401 and accepts nothing — which is correct, because an unauthenticated version would let anybody write into any company's inbox as any tenant. |
| `PORTAL_REPLY_DOMAIN` | Your DNS | The domain replies come back to. |

**And in DNS, not in Vercel: SPF, DKIM and DMARC** on the sending domain.
Without domain authentication, rent notices land in spam.

## 4. SMS — the emergency path depends on it

| Key | Where |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio console |
| `TWILIO_AUTH_TOKEN` | Twilio console |
| `TWILIO_FROM_NUMBER` | A number you buy, **or** — |
| `TWILIO_MESSAGING_SERVICE_SID` | — a messaging service, if you use one instead of a single number |

The emergency design has a tenant see a stop card telling them to call, which
works on its own — but **the backup SMS to the on-call number never fires
without these.**

## 5. Taking rent — Stripe

| Key | Where |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys |
| `STRIPE_PUBLISHABLE_KEY` | same page |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe → Connect → Settings |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Stripe → Developers → Webhooks, the Connect endpoint |

`config.js` **refuses to start with an `sk_live_` key outside production**, so
a test run cannot charge a real card.

Then confirm against a real test payment: that `us_bank_account` is enabled,
the event names for an ACH return, the `{CHECKOUT_SESSION_ID}` placeholder,
and the payout event names and balance-transaction shape.

## 6. Your own subscription billing — Stripe again, different objects

| Key | Where |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks, your main endpoint |
| `STRIPE_PRICE_STARTER` | Stripe → Products → the price id (`price_…`) |
| `STRIPE_PRICE_GROWTH` | same |
| `STRIPE_PRICE_PROFESSIONAL` | same |
| `STRIPE_PRICE_SCALE` | same |
| `PLATFORM_OPERATOR_EMAIL` | You choose | Who may reach the platform and support-access screens. |

Confirm or change the four prices before anybody sees them.

## 7. Bank feeds — Plaid

| Key | Where |
|---|---|
| `PLAID_CLIENT_ID` | Plaid dashboard |
| `PLAID_SECRET` | Plaid dashboard, per environment |
| `PLAID_ENV` | `sandbox`, `development` or `production` |
| `PLAID_WEBHOOK_SECRET` | Plaid → Webhooks |

You said at the start we would do the connecting services last. This is one of
them — bank statement import works without it.

## 8. Push notifications

    npm run vapid

Prints three values. Paste them in:

| Key |
|---|
| `VAPID_PUBLIC_KEY` |
| `VAPID_PRIVATE_KEY` |
| `VAPID_SUBJECT` |

**Generate once and keep them.** The public key is handed to browsers, so
replacing it later invalidates every subscription anybody has made. Half-set
is refused at boot rather than half-working.

## 9. Optional

| Key | Default if unset |
|---|---|
| `SENTRY_DSN` | No error tracking. A genuine no-op — nothing is sent anywhere. |
| `DELIVERY_MODE` | Derived. Forces sandbox or live delivery when you want to override. |
| `LOG_FORMAT` | Plain text; set `json` for a log aggregator. |
| `PG_POOL_MAX` | 4. Raise only if you know the pooler's limit. |

Never set by hand: `NODE_ENV`, `APP_ENV`, `PORT`, `VERCEL`,
`AWS_LAMBDA_FUNCTION_NAME`, `TEST_DATABASE_URL` (the suite's, and the schema
drop refuses to run unless the pool was built from it).

---

## The shortest path to a working product

1. **Rotate** the service-role key and the database password.
2. **Set** `APP_ENCRYPTION_KEY`, `APP_BASE_URL`, `CRON_SECRET`,
   `DATABASE_CA_CERT`, and turn on SSL enforcement.
3. **Fix the deployment** — it has been serving code from Phase 4. Until then
   none of the above is actually running.
4. **Email** — Resend key, `EMAIL_FROM`, and SPF/DKIM/DMARC. This is the one
   that turns a silent product into a working one.
5. Everything else, when you want that feature.

Steps 1–3 are half a day. Step 4 is an afternoon and a DNS wait.
