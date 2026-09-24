# Open items — what only you can supply

One list, kept current across every phase, so nothing has to be dug out of six
separate reports at the end.

Nothing here blocks development. Everything is built against a sandbox, a fake
or a documented mock, and each item says what is unverified until the real
thing arrives.

---

## Resolved — the production database, emptied and re-seeded on 2026-09-22

**What happened.** I ran one test file with `node --env-file=.env.local --test`
and without `NODE_ENV=test`. `config.js` only swaps in `TEST_DATABASE_URL`
when that variable is set, so the suite was handed the live Supabase URL
exactly as asked, and the harness's first action is `DROP SCHEMA public
CASCADE`. Every row went, including the two owners' opening journals from the
Phase 3 conversion.

**What you decided.** No backup; re-seed. Done — the database now holds the
Leafridge demo portfolio: 3 owners, 5 properties, 8 units, 7 leases, 7
vendors, 4 work orders, 3 open delinquencies, 21 obligations, and 20 ledger
entries with 20 journals behind them. Parity clean, journal balanced at
$14,742.65 on both sides, schema at `024`.

| | What | Why it matters |
|---|---|---|
| 0a | **The demo sign-in was reset and is in the chat, not in this file** | The seed prints a generated password once. Its first run was cut off before that line, so I set a new one and gave it to you directly. Change it when you next sign in. |
| 0b | **Turn on point-in-time recovery if the plan allows it** | There was no backup to restore from. This database has twice been the only copy of something. |

**What stops it recurring.** The destructive calls in `test/helpers/db.js` now
check for themselves rather than trusting something upstream: they refuse
unless the pool came from `TEST_DATABASE_URL` *and* the connected database is
named like a throwaway. `npm test` reads a committed `.env.test`, so it no
longer depends on my remembering to set anything. The exact command that
caused this is now refused, and four tests in `test/security.test.js` hold
that in place.

A related gap closed with it: `npm run seed` had been broken for two phases
because nothing ran it. `test/seed.test.js` now does, on every suite run.

---

## Payments — what real Stripe keys will settle

Everything below is built and tested against a replaced `fetch`, so the request
shapes, the headers and the failure handling are exercised. What is *not*
exercised is whether Stripe behaves as documented. These are the first things
to check the day keys exist.

| | What | Why it matters |
|---|---|---|
| P0 | **`STRIPE_CONNECT_CLIENT_ID`**, from Stripe → Settings → Connect → Platform settings | Without it the Connect button on `/app/payments` is disabled and says so. It is the first thing needed; everything else on that screen follows from it. |
| P1 | **`STRIPE_CONNECT_WEBHOOK_SECRET`**, from the Connect endpoint in the Stripe dashboard | Connect events have their own endpoint (`/api/webhooks/stripe-connect`) and their own signing secret, deliberately not shared with the subscription webhook. Unset means tenant payments never settle. |
| P2 | **Confirm the event names for an ACH return** | The documented shapes differ between `charge.failed`, `payment_intent.payment_failed` and a dispute depending on the return code. The handler routes by the *payment's own state* rather than the event name — settled-then-failed is a return, never-settled is a failure — so an unanticipated name degrades to a recorded "not handled" rather than to money silently staying on the books. Worth confirming anyway. |
| P3 | **Confirm `us_bank_account` is enabled** on the connected account | Checkout is created with `payment_method_types: ["us_bank_account"]`. If the account has not enabled ACH, the session errors and the tenant sees a failure nobody can explain. |
| P4 | **Verify the `{CHECKOUT_SESSION_ID}` placeholder** comes back in the success URL | The return page finds the payment by session id. If Stripe does not substitute it, the tenant lands on a generic "it will appear shortly" message instead of their receipt. |
| P5a | **Confirm Stripe's payout event names and the balance-transaction shape** | Payouts are recorded from `payout.*` events and itemised by reading balance transactions for the payout. A failure to itemise is handled — the payout is still recorded and still matchable — but the field names are unverified. |
| P5 | **Decide whether to pass on the return charge** | A returned payment posts the bank's charge to `5300 Return charges` as the company's cost. Passing it to the tenant is a policy decision with state-law limits, and nothing does it automatically. |

---

## Payouts — what only a real bank and real paper can settle

The formats are built against the published record layouts and a hand-computed
fixture. What no test here can tell you is whether *your* bank accepts *your*
file, because most of it is per-institution.

| | What | Why it matters |
|---|---|---|
| O1 | **Your ACH company identification**, from the bank that sets up origination | Ten digits they assign. It is not your tax number unless they say so, and the wrong one gets the file rejected. Entered on Payments out → Bank details. |
| O2 | **Ask whether they want a balanced file** | Some banks want the offsetting debit written into the file; others take it from the account. There is a switch for it and sending the wrong one is a rejection. |
| O3 | **Send one small run first** | One payee, a few dollars, to an account you control. The first file is the only real test of the format against that bank's parser. |
| O4 | **Print the alignment sheet on plain paper** and hold it against a blank cheque | The offsets are the common US business layout. Stock differs between suppliers, and a cheque two millimetres out is rejected by the bank's reader. `check_layout` on the company row takes an override. |
| O5 | **Confirm the positive-pay column order and date format** | Both differ between banks and both are parameters. The default is the most common shape; an empty account column is the usual reason one is rejected, and the run screen warns about that one. |
| O6 | **Buy cheque stock with the MICR line pre-printed** | We deliberately do not draw it: it needs the E-13B typeface and magnetic toner, and drawn in an ordinary font it looks right and is not machine readable. |

---

## Messaging — what only a real domain can settle

The inbox works today over SMS and from the portal. Inbound *email* is built
and deliberately switched off until two things exist, because the alternative
is an endpoint anybody can post into as any tenant.

| | What | Why it matters |
|---|---|---|
| M1 | **`RESEND_INBOUND_SECRET`** | Verifies the inbound-parse webhook. Unset, `/api/webhooks/resend-inbound` returns 401 and accepts nothing — an unauthenticated version of it would let anybody write into any company's inbox as any tenant. |
| M2 | **`PORTAL_REPLY_DOMAIN`**, and the inbound route pointed at it | Outbound email carries `reply+<token>@<domain>`, and that token is the only *certain* way to know which conversation a reply belongs to. Unset is a working state — threading falls back to `In-Reply-To` and to matching the sender — and the inbox says so on screen rather than being quietly worse. |
| M3 | **Confirm Resend's inbound payload shape** | The mapping handles `from`/`to`/`cc`/`envelope.to`, both header shapes, and HTML-only bodies, tested against a fixture. The first real inbound message is the real test. |
| M4 | **A note about the company's own email confirmation** | A company whose address is unconfirmed cannot send anything, including inbox replies. That is the existing rule and it is right; the inbox now names it on screen rather than saying "check the log". |

---

## Mobile and push — what needs a real device or a real domain

The service worker, the manifests and the payload encryption are all verified
here. What cannot be verified on a laptop is whether the three companies that
run the push services accept what we send them.

| | What | Why it matters |
|---|---|---|
| P1 | **`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`** | Generate with `npm run vapid`. Unset means push is off and every screen says so. Half-set is refused at boot. The public key is handed to browsers, so replacing it later invalidates every subscription anybody has made. |
| P2 | **One real subscription from a real browser, sent to** | The encryption reproduces the RFC 8291 §5 vectors byte for byte, and the VAPID tokens verify against their own key. Neither of those proves Apple, Google and Mozilla accept the result — that needs one real endpoint and one real send, and it is the only way to find out. |
| P3 | **Installing on an actual phone** | Needs HTTPS on a real domain; `localhost` is a secure context but a home-screen install from it is not the same first run. The manifests, icons and offline page are verified in a browser, the install prompt is not. |
| P5 | **Type under 14px on a phone — a design decision, not a defect** | The 375px audit found text at 11px (the navigation count badge, the relative date on a queue row), 12px (the compact pill, chips, secondary lines) and 13px (the queue row's reason). The audit's own threshold was 14px. Raising the type scale changes the information density of every screen, so it is pindrop's call rather than one to slip in. Touch targets were fixed, because a mis-tap is a defect; type size is a design. |
| P6 | **`/app/setup`: three Save buttons reached by scrolling sideways** | They sit in a table that scrolls inside its own container, so they are reachable — but on a phone you have to scroll the table right to find them. Fixing it means changing that table's layout at phone width, which is again a design decision. No other page has this. |
| P4 | **The manifests carry no company name** | An installed icon says "Operations" or "Your home", not "Leafridge". A manifest is fetched without credentials, so the server cannot know which company is installing. Fixable with a per-company manifest URL if it matters; it is a deliberate generic today rather than an oversight. |

---

## Accounting — found while correcting the postings

| | What | Why it matters |
|---|---|---|
| ~~A1~~ | ~~**A repair can be booked twice**~~ | **Fixed.** The contractor's invoice is the truth when there is one: it is the document money is paid against and the one an owner can be shown. Closing a job that is already billed records the figure and posts nothing, saying so on screen. An invoice arriving after a close-out supersedes it — the posting is reversed, not edited, and the owner's ledger is mirrored so the two books cannot drift. Tested in both orders and with neither. |
| ~~A6~~ | ~~**Nothing ever credits `1200 Rent receivable`**~~ | **Fixed.** Late fees were charged there from Phase 1 and no path cleared one, so a fee stayed outstanding for ever and the money that paid it was recorded as prepaid rent held for the *owner* — the manager's income inflating the owner's trust position. Payments settle it now, after the rent and never before, because applying a payment to fees first can manufacture rent arrears and rent arrears is the ground for eviction. |
| ~~A7~~ | ~~**Earned fees sit in the trust account until swept**~~ | **Fixed.** `/app/accounting/trust` shows what is yours and records the transfer you make between your own two accounts — `Dr 1000 / Cr 1010`. It records; it does not move money, the same rule the payouts follow. It refuses outright while the reconciliation reports any error, because the claim "this money is nobody's" is worthless if the obligation side is broken, and a surplus measured against a broken obligation total could be a tenant's deposit. |
| A2 | **`4000 Rent income` is now unposted** | Under agency the rent is the owner's income, not the manager's, so nothing credits it any more. It remains in the chart. Either retire it or repurpose it for owner-level reporting; leaving an account nobody posts to is a trap for whoever reads the chart next. |
| A3 | **`5000 Repairs` now means only the manager's own costs** | Owner-borne repairs reduce owner funds instead. The vendor-invoice path still debits 5000, which is right only if the invoice is the manager's to bear — see A1. |
| A4 | **Post the deposits that are on leases and in no account** | $8,435.00 across seven leases, which the trust reconciliation has reported as a variance every month since Phase 6 — correctly. Phase 9 built the deposit ledger and a conversion in the shape of `correct.js`: run `npm run deposits:plan` to see what it would do and `npm run deposits:commit` to do it. It never posts behind a close, and a lease with *part* of a deposit posted is named and left alone, because guessing at the difference is how a conversion makes things worse. **This is your call — it posts journals against your books.** |

| ~~A5~~ | ~~**Colour pairs missing WCAG AA**~~ | **Done, at your direction.** `--ink-soft` #717784 → #6a7079 (4.99:1 on white, 4.54:1 on the page background). The borders were split rather than darkened: a new `--control-edge` at #858c9a (3.38:1 / 3.07:1) carries the ten places that are genuinely controls, and the decorative `--hairline` stays light — 1.4.11 does not govern a panel edge or a table row rule, and darkening those would have put a grey line between every row. Every pair WCAG governs now passes. |

---

## Backups — what Phase 10 could not do for you

| | What | Why it matters |
|---|---|---|
| B1 | **Enable point-in-time recovery on Supabase**, 7 days minimum | Daily backups alone mean losing up to a day. A bad migration is noticed hours later, not immediately. It is a paid feature, so it is off until someone turns it on. |
| B2 | **Run `scripts/restoredrill.sh` against a real Supabase PITR restore** | The drill proves `pg_dump`/`pg_restore` round-trip this schema, against the 2,000-unit portfolio. Supabase's restore is a different mechanism and is unproven. |
| B3 | **Back up Vercel Blob — there is no backup at all** | Every uploaded photograph, receipt, insurance certificate and signed document has exactly one copy. A deposit dispute turns on the move-out photographs. `node server/lib/verify.js --files` reports files the database names and cannot find; nothing brings them back. |
| B4 | **Run `verify.js --files` against production once** | It has never been run outside the test environment, so the Vercel Blob branch is exercised only by unit tests. |

---

## Security — overdue, and not blocked on anything

| | What | Why it matters |
|---|---|---|
| 1 | **Rotate the Supabase `sb_secret_…` service-role key** | It bypasses RLS by design and was pasted into a chat log. The database lockdown does not defend against it. |
| 2 | **Rotate the database password** and update `DATABASE_URL` in Vercel | Same reason. It was in the same chat log. |
| 3 | **Turn on "Enforce SSL on incoming connections"** in Supabase → Database Settings | The pooler currently accepts unencrypted connections. |
| 4 | **Download the CA certificate** into `DATABASE_CA_CERT` | TLS is encrypted but unverified today, so it defends against eavesdropping but not interception. `/health` reports which mode is live. |

**Fixed in Phase 7a, no action needed — recorded because it was live.**
`/app/company`, `/app/company/access` and `/app/billing` declared
`settings.manage` in the sidebar and had no entry in the routing gate, so any
signed-in account could open them and POST to them: rename the company, change
the emergency phone number, change the address email is sent from, and change
the public handle every printed QR sticker points at. `/app/messages` had
neither, and exposed every message to every tenant and owner. All four are now
gated, and a test holds the sidebar against the gate for every role.

---

## Deployment

| | What | Why it matters |
|---|---|---|
| 5 | **The production Vercel URL**, set as `APP_BASE_URL` | Twilio signs webhooks over the full URL; a mismatch rejects every callback. Also used for links inside messages. I have only ever seen a preview URL. |
| 6 | **Confirm the deploy succeeds with the cron block restored** | A cron entry broke a deploy once by exceeding the Hobby plan limit. One daily entry is within it, but I cannot deploy to confirm. |
| ~~7a~~ | ~~**Two npm advisories in `@vercel/blob`'s `undici`**~~ | **Done in Phase 10.** `@vercel/blob` upgraded 0.27 → 2.8. `npm audit` reports 0 vulnerabilities, and the full suite passes on the new major. |
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

## Billing and platform (Phase 2)

| | What | Why it matters |
|---|---|---|
| 12 | **A Stripe account**, and `STRIPE_SECRET_KEY` (test key first) | Nothing has run against Stripe, even test mode. The API shapes follow their documentation and the signature checks are verified against signatures generated by their algorithm, but the first real call is the test. |
| 13 | **Four Stripe prices**, one per band, as `STRIPE_PRICE_STARTER` / `_GROWTH` / `_PROFESSIONAL` / `_SCALE` | The plan table shows what we charge; Stripe decides what is charged. A missing one names itself in the error. |
| 14 | **`STRIPE_WEBHOOK_SECRET`** from the endpoint you create | Without it the webhook fails closed and subscription state never updates. |
| 15 | **Confirm or change the prices** in `server/lib/plans.js` | Currently $49 / $149 / $399 / $799 a month by unit band. I invented these; they are displayed to customers. |
| 16 | **`PLATFORM_OPERATOR_EMAIL`** — the one address that may see across companies | Unset means the platform admin area does not exist, which is the correct default until you set it. |

`config.js` refuses to start with a live Stripe key outside production, so a
test run cannot charge a real card.

---

## Phase 3 — one decision I stopped for

| | What | Why I have not done it |
|---|---|---|
| 17 | **Approve the ledger conversion on the live database** | `ledger_entry` and `journal` were written independently until now, so 22 entries exist that owners have been shown and the company's books do not know about. The conversion posts **two opening journals** — one per owner — dated 2026-08-03, memo `Conversion: pre-double-entry ledger balance`:<br><br>• owner …221d0f3d — 10 entries, net **+$6,864.75**<br>• owner …68e762c9 — 12 entries, net **+$5,912.60**<br><br>The journal is append-only, so this cannot be deleted afterwards — only reversed, which leaves both halves visible forever. Tested on a throwaway database (12 tests). Run with:<br>`node -e "import('./server/lib/convert.js').then(m=>m.commit({confirm:'post-opening-journals'}))"` |

---

## Still to be decided (not yet blocking)

| | What | When it becomes urgent |
|---|---|---|
| A | **Sentry DSN**, or another error tracker, or neither | Any time. Unset is a genuine no-op with no outbound calls. |
| B | **Stripe Connect** settings, and Standard vs Express | Phase 3. Compared in that phase's plan. This is the *tenant rent* path, separate from the subscription billing above — funds go to the PM company's own account and never through the platform. |
| C | **The product name and domain** | Phase 9, when `index.html` stops being a Columbus estate agent's site. Also settles whether companies get subdomains rather than `/c/slug` paths. |
| D | **Recurring charges beyond rent** — pet rent, parking, storage, utility billing | The first migration from AppFolio, Buildium or Rent Manager. A lease here has one rent and one due day; those systems bill several lines per lease, and an import loses the difference. The import preview now says so in its own words rather than burying it in the list of unread columns, but the feature does not exist and the roadmap still carries it. Deciding it needs a schema for the charge, a place for it in the monthly charge run, and a line on the owner statement. |
| E | **A background data export for a very large portfolio** | When a customer has millions of journal rows. The export reads every table inside one transaction so the archive is a single consistent moment, which means it holds the table data in memory until the archive is written. Tens of megabytes for a few thousand units; not viable for a portfolio an order of magnitude larger, and it would exceed a serverless function's timeout before it exceeded its memory. The fix is a job that builds into blob storage and emails a link, not a bigger buffer. |
| F | **Whether the API and webhooks belong on the plan gate** | Whenever pricing is next looked at. Today any company can issue keys and add endpoints. Making either a paid tier is a business decision rather than a technical one; the place it would go is `plans.js`, which already knows what each plan includes. |
