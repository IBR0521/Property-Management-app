# Open items — what only you can supply

One list, kept current across every phase, so nothing has to be dug out of six
separate reports at the end.

Nothing here blocks development. Everything is built against a sandbox, a fake
or a documented mock, and each item says what is unverified until the real
thing arrives.

---

## Security — overdue, and not blocked on anything

| | What | Why it matters |
|---|---|---|
| 1 | **Rotate the Supabase `sb_secret_…` service-role key** | It bypasses RLS by design and was pasted into a chat log. The database lockdown does not defend against it. |
| 2 | **Rotate the database password** and update `DATABASE_URL` in Vercel | Same reason. It was in the same chat log. |
| 3 | **Turn on "Enforce SSL on incoming connections"** in Supabase → Database Settings | The pooler currently accepts unencrypted connections. |
| 4 | **Download the CA certificate** into `DATABASE_CA_CERT` | TLS is encrypted but unverified today, so it defends against eavesdropping but not interception. `/health` reports which mode is live. |

---

## Deployment

| | What | Why it matters |
|---|---|---|
| 5 | **The production Vercel URL**, set as `APP_BASE_URL` | Twilio signs webhooks over the full URL; a mismatch rejects every callback. Also used for links inside messages. I have only ever seen a preview URL. |
| 6 | **Confirm the deploy succeeds with the cron block restored** | A cron entry broke a deploy once by exceeding the Hobby plan limit. One daily entry is within it, but I cannot deploy to confirm. |
| 7 | **`APP_ENCRYPTION_KEY` set in every environment** | Bank tokens and taxpayer IDs refuse to store without it. Losing it makes sealed fields unrecoverable, so it belongs in a secret manager. |

---

## Delivery (Phase 1)

| | What | Why it matters |
|---|---|---|
| 8 | **A Resend account and API key** (free tier is enough) | Until then the sandbox path is written but unexercised. The signature verification is fully tested against generated vectors; what is unverified is that Resend's live header matches my reading of the Svix spec. |
| 9 | **A sending domain**, with DNS access for SPF, DKIM and DMARC | Without domain authentication, rent notices land in spam. |
| 10 | **Decision: the 43 queued messages** | Switching to live sends all of them, backdated, including rent notices whose dates have passed. `/app/messages` has per-message discard and a bulk "older than N days". **Recommendation: discard.** I have not touched them. |
| 11 | *(Deferred)* Twilio account and A2P 10DLC registration | Only needed when SMS is switched on. See the decision below. |

---

## Decisions I have taken as defaults

Reversible, recorded so they are visible rather than buried.

**Email-only at launch.** Email needs no carrier registry and works for one
company or a thousand from day one. SMS in the US requires per-business A2P
10DLC registration with carrier vetting that takes days to weeks, which would
otherwise block every new signup from sending. SMS becomes an opt-in step a
company completes when they want it.

*Consequence:* the emergency on-call alert is SMS. Until a company completes
registration, that alert will not send. The tenant still sees the stop card
telling them to phone, which is the guarantee that actually holds, and the
failure is recorded on the work order. This is handled explicitly rather than
left to chance.

**ISV-model registration when SMS is added.** The property manager types their
legal name, EIN and address into our onboarding form; our code submits it to
the provider's API. Written once, runs for every customer, no manual work per
signup. The alternative — each company bringing their own provider account —
stays available as an escape hatch for larger firms.

---

## Still to be decided (not yet blocking)

| | What | When it becomes urgent |
|---|---|---|
| A | **Sentry DSN**, or another error tracker, or neither | Any time. Unset is a genuine no-op with no outbound calls. |
| B | **Stripe account** for subscription billing, and the price points by unit band | Phase 2, for the billing page. Built against Stripe test mode until then. |
| C | **Stripe Connect** platform settings, and Standard vs Express | Phase 3. Compared in that phase's plan. |
| D | **Your platform-admin identity** — which email may impersonate and see all companies | Phase 2. Defaults to an env var holding one address. |
| E | **The product name and domain** | Phase 9, when `index.html` stops being a Columbus estate agent's site. |
