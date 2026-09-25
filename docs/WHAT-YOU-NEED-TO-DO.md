# What only you can do

48 open items. None of them is code — everything on my side of the line is
done. What is left is credentials, accounts, a bank, two decisions against
your own books, and one deployment that has been serving stale code since
Phase 4.

Ordered by what unblocks what, not by which section they live in. **Stages 1
and 2 are the ones that matter today**; everything after is one feature at a
time, and each can wait until you want that feature.

---

# Stage 1 — today, and before anything else

## 1a. Rotate the two secrets that are in a chat log

Both were pasted into a conversation. Until they are rotated, the database
lockdown does not defend against whoever else has read it.

| | Where | What to do |
|---|---|---|
| Service-role key | Supabase → Project Settings → API | Roll the `sb_secret_…` key. It bypasses row-level security **by design**, so it is the one that matters most. |
| Database password | Supabase → Database → Settings | Reset it, then update `DATABASE_URL` in Vercel → Settings → Environment Variables. |

Do these in that order and redeploy once, or the app will be pointing at the
old password for a few minutes.

## 1b. Turn on SSL enforcement, then verify it

1. Supabase → Database → Settings → **Enforce SSL on incoming connections**.
2. Download the CA certificate from the same page.
3. Paste it into Vercel as `DATABASE_CA_CERT`.

Without step 3 the connection is encrypted but **unverified** — it resists
eavesdropping and not interception. `/health` reports which of the two modes
is live, so you can check rather than assume.

## 1c. Fix the deployment

**The Vercel deployment has been serving old code since Phase 4.** Every
result in every report I have written describes this repository, not what is
answering requests. Until this is true, nothing else on this page matters.

- Confirm which branch and commit Vercel is building.
- Confirm the build succeeds **with the cron block in `vercel.json`** — one
  cron entry broke a deploy once by exceeding the Hobby plan's limit. One
  daily entry is within it, but I cannot deploy to check.
- Set `APP_BASE_URL` to the production URL. Twilio signs webhooks over the
  full URL, so a mismatch rejects every callback, and it is used for the links
  inside messages.
- Set `APP_ENCRYPTION_KEY` in **every** environment. Bank tokens and taxpayer
  IDs refuse to store without it, and losing it makes sealed fields
  unrecoverable — so it belongs in a secret manager, not only in Vercel.

---

# Stage 2 — this week

## 2a. Backups

Right now there is one copy of everything.

1. **Supabase → Database → Backups → enable point-in-time recovery**, 7 days
   minimum. It is a paid feature; daily backups alone mean losing up to a day,
   and a bad migration is noticed hours later.
2. **Drill it.** `scripts/restoredrill.sh` proves `pg_dump` and `pg_restore`
   round-trip this schema — it does not prove Supabase's restore works, which
   is a different mechanism. Restore to a scratch project and run the drill
   against it.
3. **Back up Vercel Blob.** There is no backup at all. Every uploaded
   photograph, receipt, insurance certificate and signed document has exactly
   one copy, and a deposit dispute turns on the move-out photographs.
4. Run `node server/lib/verify.js --files` against production once. It reads
   every file the database names and reports the ones that are gone. It has
   never run outside a test environment.

## 2b. The two conversions against your books

Both are built, tested, and deliberately not run, because they post journals
to a live ledger that is append-only.

| | What | How |
|---|---|---|
| **A4** | $8,435.00 of deposits recorded on leases and in no account | `npm run deposits:plan` shows exactly what would post. `npm run deposits:commit` does it. |
| **17** | 22 ledger entries owners have been shown that the books do not know about — two opening journals, +$6,864.75 and +$5,912.60 | `node -e "import('./server/lib/convert.js').then(m=>m.commit({confirm:'post-opening-journals'}))"` |

Read the plan output before running either. A posted journal can only be
mirrored, never deleted.

---

# Stage 3 — one feature at a time

Each block below switches on one thing. None blocks the others, and each can
wait until you want that feature working.

## Email — unlocks every message the product sends

Until this is done, **nothing is sent**. The product is honest about that: a
message says "not sent" rather than claiming otherwise.

1. A Resend account and API key (the free tier is enough to start).
2. A sending domain with **SPF, DKIM and DMARC** in DNS. Without domain
   authentication, rent notices land in spam.
3. `RESEND_INBOUND_SECRET` and `PORTAL_REPLY_DOMAIN` if you want tenants to be
   able to reply to messages.
4. Then decide **the 43 queued messages**. Switching to live sends all of
   them, backdated, including rent notices whose dates have passed.
   `/app/messages` has per-message discard and a bulk "older than N days".
   **My recommendation: discard them.**
5. Send one of each kind and confirm the provider accepted it.

## Push notifications

    npm run vapid

Put the three printed values in your environment. Then one real subscription
from a real browser, because the encryption reproduces the RFC 8291 vectors
exactly and that still does not prove Apple, Google and Mozilla accept the
result. Installing on an actual phone needs HTTPS on a real domain.

**Replacing the public key later invalidates every subscription anybody has
made**, so generate it once and keep it.

## Taking rent — Stripe

1. `STRIPE_CONNECT_CLIENT_ID` and `STRIPE_CONNECT_WEBHOOK_SECRET`.
2. Confirm `us_bank_account` is enabled on the account.
3. Confirm the event names for an ACH return and the `{CHECKOUT_SESSION_ID}`
   placeholder against a real test payment.
4. Decide whether a returned payment's bank charge is passed to the tenant —
   a policy decision with state-law limits. Nothing does it automatically.
5. Take one real payment and reconcile it end to end before any tenant does.

## Paying owners — your bank

This one needs a person at the bank, not a web form.

1. Ask them for your **ACH company identification**.
2. Ask whether they want a **balanced file** — some banks want the offsetting
   debit written in, others take it from the account, and sending the wrong
   one is a rejection.
3. Confirm the **positive-pay column order and date format**. Both differ
   between banks and both are parameters here.
4. **Send one small run first** — one payee, a few dollars, to an account you
   control. The first file is the only real test of the format against that
   bank's parser.
5. For cheques: buy stock with the **MICR line pre-printed**. We deliberately
   do not draw it — it needs the E-13B typeface and magnetic toner, and drawn
   in an ordinary font it looks right and is not machine readable. Print the
   alignment sheet on plain paper first.

## Your own subscription billing

A Stripe account, four prices, `STRIPE_WEBHOOK_SECRET`, and
`PLATFORM_OPERATOR_EMAIL` for the support-access screens. Confirm or change
the prices before anybody sees them.

---

# Stage 4 — decisions, whenever you like

None of these blocks anything. Each is a business choice, and each becomes
code the moment you make it.

| | The decision | What happens then |
|---|---|---|
| **C** | The product name and domain | Settles whether companies get subdomains or `/c/slug` paths, and replaces the Columbus estate agent's marketing page |
| **A** | Sentry, another error tracker, or neither | Unset is a genuine no-op with no outbound calls |
| **B** | Stripe Connect: Standard or Express | Compared in the Phase 3 plan |
| **F** | Whether the API and webhooks sit behind the plan gate | Today any company can issue keys. The place it would go is `plans.js` |
| **P5** | Type under 14px on a phone | The 375px audit found 11–13px text. A design decision, not a defect |
| **P6** | Three Save buttons on `/app/setup` reached by scrolling sideways | Fixing it changes that table's layout at phone width, which is why I stopped |

---

# What I have already done

Everything on my side. For the record, closed this session: recurring charges,
the `1200` hole, the trust sweep, aged receivables, the owner-list bug, the
chart cleanup, the export's memory, the manifests, and the whole UX pass —
plus signup discoverability and a password reset that did not exist.

**2,078 tests, 0 failing.**
