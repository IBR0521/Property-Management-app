# Where each key comes from

Direct links and click-paths. Verified September 2026 — dashboards get
reorganised, so if a path has moved, the service name and the section are
what to search for.

Everything you collect goes in one place:
**https://vercel.com/dashboard** → your project → **Settings** →
**Environment Variables** → set each for **Production** *and* **Preview**.

---

## Supabase — the database

**https://supabase.com/dashboard** → your project

| Need | Where |
|---|---|
| Rotate the service-role key | **Settings → API Keys** |
| Rotate the database password | **Settings → Database** → *Database password* → Reset |
| `DATABASE_CA_CERT` | **Settings → Database** → *SSL Configuration* → download the certificate |
| Enforce SSL | **Settings → Database** → *SSL Configuration* → turn on **Enforce SSL on incoming connections** |
| Point-in-time recovery | **Database → Backups** (a paid add-on) |

**A change worth knowing about.** Supabase is retiring the `anon` and
`service_role` keys and replacing them with publishable (`sb_publishable_…`)
and secret (`sb_secret_…`) keys. The old ones live under a **Legacy API Keys**
tab and stay valid until you disable them. Since you are rotating anyway,
**create a new secret key and move to it** rather than rolling a legacy one
you will have to replace again.

Whichever you use: the secret and legacy service-role keys bypass row-level
security. That is what they are for, and why this one matters most.

---

## Vercel — hosting

**https://vercel.com/dashboard** → your project

| Need | Where |
|---|---|
| Set every variable below | **Settings → Environment Variables** |
| Check what is actually deployed | **Deployments** — the branch and commit of the live one |
| `BLOB_READ_WRITE_TOKEN` | **Storage → Blob** — injected automatically once a store is attached |
| Cron | **Settings → Cron Jobs**, driven by `vercel.json` |

The deployment has been serving Phase 4 code. **Deployments** is where you
confirm which commit is live.

---

## Generate these yourself — no account needed

```bash
openssl rand -base64 32     # APP_ENCRYPTION_KEY
openssl rand -hex 32        # CRON_SECRET
npm run vapid               # VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
```

`APP_BASE_URL` is your own production URL, e.g. `https://app.yourdomain.com`.

**Keep `APP_ENCRYPTION_KEY` somewhere other than Vercel too.** Losing it makes
every sealed field — bank tokens, taxpayer IDs — permanently unreadable.

---

## Resend — email

**https://resend.com** → sign up (free tier is enough to start)

| Key | Where |
|---|---|
| `RESEND_API_KEY` | **API Keys** → Create API Key |
| `RESEND_WEBHOOK_SECRET` | **Webhooks** → add an endpoint → copy its signing secret |
| `RESEND_INBOUND_SECRET` | **Webhooks** → inbound endpoint (only if tenants should reply) |
| `EMAIL_FROM` | You choose — must be on the domain below |
| `PORTAL_REPLY_DOMAIN` | Your domain, for replies |

**Then the part that is not in Resend.** Add a domain under **Domains**, and
Resend gives you DNS records. Put them wherever your domain is registered —
Cloudflare, Namecheap, GoDaddy, Route 53. You need all three:

- **SPF** — says Resend may send as you
- **DKIM** — signs the mail
- **DMARC** — tells receivers what to do when the first two fail

Without these, rent notices land in spam. DNS takes minutes to a few hours.

---

## Twilio — SMS

**https://console.twilio.com**

| Key | Where |
|---|---|
| `TWILIO_ACCOUNT_SID` | On the console home page |
| `TWILIO_AUTH_TOKEN` | Same page — click to reveal |
| `TWILIO_FROM_NUMBER` | **Phone Numbers → Manage → Buy a number** (needs SMS capability) |
| `TWILIO_MESSAGING_SERVICE_SID` | **Messaging → Services** — use this *instead* of a number if you have several |

US numbers need **A2P 10DLC registration** before they will send to US
carriers. It takes a few days and is done in Twilio under **Messaging →
Regulatory Compliance**. Start it early; it is the long pole in messaging.

---

## Stripe — taking rent, and your own billing

**https://dashboard.stripe.com**

| Key | Where |
|---|---|
| `STRIPE_SECRET_KEY` | **Developers → API keys** → Secret key |
| `STRIPE_PUBLISHABLE_KEY` | Same page → Publishable key |
| `STRIPE_WEBHOOK_SECRET` | **Developers → Webhooks** → your endpoint → expand *Signing secret* |
| `STRIPE_CONNECT_CLIENT_ID` | **Connect → Settings** → *Integration* — starts `ca_` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | **Developers → Webhooks** → the **Connect** endpoint (a separate one from the account endpoint) |
| `STRIPE_PRICE_STARTER` and the other three | **Product catalogue** → each product → the price id, starts `price_` |

Two things to know:

- **Connect needs enabling first.** Until you activate it, there is no
  **Connect** section and no `ca_` id.
- **Test and live keys are separate**, and `config.js` refuses to start with
  an `sk_live_` key outside production — so a test run cannot charge a real
  card.

Also enable **`us_bank_account`** as a payment method under
**Settings → Payment methods**, or ACH rent will not work.

---

## Plaid — bank feeds

**https://dashboard.plaid.com**

| Key | Where |
|---|---|
| `PLAID_CLIENT_ID` | **Team Settings → Keys** |
| `PLAID_SECRET` | Same page — a different secret per environment |
| `PLAID_ENV` | `sandbox`, `development` or `production` |
| `PLAID_WEBHOOK_SECRET` | **Team Settings → Webhooks** |

Sandbox works immediately. Production access needs an application and a
review. Statement import works without any of this, so it can wait.

---

## Your bank — payouts

Not a dashboard. This is a phone call or an email to your business banker, and
it is the one item here with a human on the other end.

Ask them for:

1. Your **ACH company identification** (ten digits, sometimes called an
   originator id)
2. Whether they want a **balanced file** — some want the offsetting debit
   written in, others take it from the account, and the wrong one is rejected
3. Their **positive-pay column order and date format**
4. Their **cut-off time** for same-day versus next-day ACH

Then send one small run — one payee, a few dollars, to an account you control.
The first file is the only real test of the format against their parser.

**Cheque stock** comes from a print supplier, not the bank: order stock with
the **MICR line pre-printed**. We deliberately do not draw it — it needs the
E-13B typeface and magnetic toner, and drawn in an ordinary font it looks
right and is not machine readable.

---

## Sentry — optional

**https://sentry.io** → create a project → **Settings → Client Keys (DSN)**

Unset is a genuine no-op. Nothing is sent anywhere.

---

## The order I would do it in

| | Account | Time |
|---|---|---|
| 1 | Supabase — rotate both, SSL, CA cert | 20 minutes |
| 2 | Generate `APP_ENCRYPTION_KEY`, `CRON_SECRET`, `APP_BASE_URL` | 5 minutes |
| 3 | Vercel — paste it all in, confirm the live commit | 20 minutes |
| 4 | Resend — key, domain, **and start the DNS records** | 30 minutes, then a DNS wait |
| 5 | Twilio — **start A2P 10DLC registration**, it takes days | 30 minutes, then wait |
| 6 | Stripe — enable Connect, then the six keys | 45 minutes |
| 7 | Plaid, your bank, Sentry | when you want those features |

**Start 4 and 5 early even if you are not ready to use them** — both have
waiting periods that are not in your control, and everything else is instant.

---

## Sources

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase: migrating to publishable and secret keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Stripe API keys](https://docs.stripe.com/keys)
- [Stripe authentication](https://docs.stripe.com/api/authentication)
