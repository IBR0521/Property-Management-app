# Property operations

Back-office app for a property management company, mounted alongside the
existing marketing site on one origin.

**Zero runtime dependencies.** Node 22 built-ins only — `node:http`,
`node:sqlite`, `node:crypto`. No npm install, no build step, no CDN. The
`package.json` has no `dependencies` block at all.

```bash
npm install
npm run seed     # demo company + portfolio (once)
npm start        # http://localhost:4300
npm run reset    # wipe the database and re-seed
```

There is no local SQLite fallback any more — local development points at the
same Supabase database via `DATABASE_URL`, so there is only ever one dialect
to test against. Put it in `.env.local`, which is gitignored.

Sign in at `/app` as `dana@leafridgepm.test`. `npm run seed` generates a
random password and prints it once — it is not stored anywhere else and it
is not in this file, because a password written into a public repository is
not a password. Lost it? Re-run `npm run reset`, or change it at
`/app/account`.

## What is where

```
/                     the marketing site, untouched
/report               tenant maintenance intake      (no account)
/t/:token             tenant status page             (no account)
/apply                rental application             (no account)
/a/:token             applicant document upload      (no account)
/o/a/:token           owner approves or declines     (no account)
/o/s/:token           owner monthly statement        (no account)
/app/*                back office                    (staff session)
```

Tenants, owners and applicants never get a login. They get a 32-byte
tokenised URL scoped to one record. An owner who has to remember a password
does not open the statement, and a statement nobody opens is the same as no
statement.

```
server/
  index.js            http server, route table, auth guard, error handling
  seed.js             demo data
  migrations/         001_init.sql — the whole schema, 35 tables
  lib/
    db.js             sqlite connection, migration runner, query helpers
    http.js           body + multipart parsing, cookies, CSRF, send helpers
    render.js         html`` tagged template, escaped by default
    router.js         pattern router
    auth.js           scrypt passwords, sessions, tokenised lookups
    files.js          upload storage with magic-byte sniffing
    static.js         static serving with traversal containment
    scheduler.js      the tick: obligations, delinquency ladder, outbox
    triage.js         maintenance categories and severity questions
    dates.js          ISO-string calendar maths
    money.js          integer cents in, formatted string out
    counts.js         nav badge counts
  features/           one module per feature, each exports register(router)
  views/              app shell, public shell, icon set
app-assets/app.css    app layout only — every colour and radius from styles.css
data/                 app.db + uploads  (gitignore this)
```

## Design

App pages load `assets/css/styles.css` first and `app-assets/app.css` second.
Everything visual comes from the marketing stylesheet's tokens and components —
`--brand`, `--brand-deep`, `--surface`, `--hairline`, the radius scale, Manrope,
`.pill`, `.field`, `.blk-card`, `.pd-ico`. `styles.css` is not modified.

`app.css` adds structure the marketing page never needed (shell, tables,
pipeline board, chips) plus exactly three status colours — an operations screen
has to tell overdue from done from emergency, and the site palette is entirely
indigo. Both overrides of the marketing stylesheet are commented at the rule.

## The rules enforced in code, not in a policy document

**An emergency is never queued.** Intake asks answerable questions ("is water
running right now?"), not "is this urgent?". Any emergency answer escalates to
a phone call, alerts the on-call number, and shows the tenant a stop card —
never "logged, we'll be in touch". `lib/triage.js`, `features/maintenance.js`.

**Spend over an owner's threshold cannot be dispatched.** Assigning a vendor
with an estimate above the threshold creates a pending approval and puts the
job in `awaiting_owner` instead. `features/maintenance.js`.

**An unapproved notice template cannot be sent.** Notice wording is
jurisdiction-specific and belongs to the client's attorney. Approval needs both
a name and a date; editing the text clears the sign-off. The ladder stops and
flags rather than improvising. `features/rent.js`, `lib/scheduler.js`.

**No money moves through this app.** `ledger_entry` is a reporting ledger fed
by import or manual entry, for producing owner statements. It is not a trust
account and must not become one — that is a regulated system of record with
licence-level consequences for getting it wrong.

**No applicant scoring.** Screening criteria belong to the client, are applied
by a human, and are recorded per item per applicant. There is deliberately no
score and no automated decision: a model would systematise whatever bias sits
in the criteria and document having applied it uniformly. `features/applications.js`.

**Delivery is off by default.** With no provider configured, messages queue and
the app says so on every screen. A queue that silently claims to have sent a
late-rent notice is worse than one that admits it has not. Set
`DELIVERY_MODE=log` to drain to the console, or implement `drainOutbox` in
`lib/scheduler.js` against a real provider.

## The scheduler

Runs at boot and every ten minutes. Every job is idempotent — safe to run twice
in a minute, and safe after the process was down for a week, because each works
from current state rather than from "what happened since".

Generates obligations from compliance rules, ages them overdue, queues
reminders at each lead offset, opens delinquencies once rent passes due-plus-
grace, walks the ladder, judges payment promises, drains the outbox, prunes
sessions.

## Before a real deployment

- [ ] **Wire message delivery — this is the blocker.** Nothing is sent today:
      messages are composed and queued, and `drainOutbox` in `lib/scheduler.js`
      returns immediately with no provider set. The emergency design depends on
      it: the tenant sees a stop card and is told to call, which works, but the
      backup SMS to the on-call number never fires, so the whole guarantee rests
      on the tenant actually dialling. Email and SMS providers are plain HTTP
      APIs (Resend/Postmark/SES, Twilio), so `fetch` covers it and the
      zero-dependency property survives. Add retry and backoff — the `attempts`
      and `last_error` columns are already there — plus a "send a test" button
      in Setup.
- [ ] Replace the seeded compliance windows — they are marked `PLACEHOLDER`
      and must be confirmed with the client's attorney for their jurisdiction
- [ ] Replace the two unapproved notice templates with the attorney's text
- [ ] Have the screening criteria reviewed before they are used
- [ ] Serve over HTTPS (session cookies set `Secure` automatically then)
- [ ] Back up `data/app.db` — it is the whole system of record

---

# Deploying to Vercel

The app is a plain `(req, res)` handler, so Vercel runs it unchanged. Three
things had to move, because serverless has no disk and no process that stays
alive between requests:

| Local | On Vercel |
|---|---|
| SQLite file at `data/app.db` | Supabase Postgres, via the transaction pooler |
| `data/uploads/` on disk | Vercel Blob |
| `setInterval` every 10 minutes | **currently nothing — see below** |

The dialect change turned out to be small. The only non-portable SQL in the
whole codebase was one `PRAGMA`, one `group_concat` and one
`date(x, '+N day')`; everything else is plain ANSI. The ~700 `?` placeholders
are converted to Postgres's `$1..$n` inside `toPg()` in `server/lib/db.js`, so
no call site was rewritten.

## 1. Get the connection string

Supabase → **Project Settings → Database → Connection string → Transaction
pooler**. It looks like:

```
postgresql://postgres.<ref>:<password>@<host>.pooler.supabase.com:6543/postgres
```

Use the **transaction pooler on port 6543**, not the direct connection.
Serverless functions open a connection per invocation and will exhaust a
direct database's connection limit within minutes. The pooler exists for
exactly this.

Because the pooler runs pgbouncer in transaction mode, prepared statements are
disabled in `db.js` (`prepare: false`). Without that every query fails with
"prepared statement already exists".

## 2. Set the environment variables

In the Vercel project settings:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the transaction pooler string from step 1 |
| `CRON_SECRET` | any long random string — the cron endpoint refuses to run without it |
| `BLOB_READ_WRITE_TOKEN` | created for you when you add Vercel Blob to the project |

Without `BLOB_READ_WRITE_TOKEN` the app falls back to local disk, which on
Vercel means uploads vanish after the request. Add the Blob store before
anyone uploads a photo.

## 3. Seed the database once

Point your local machine at the hosted database and run the seed:

```bash
DATABASE_URL="postgresql://postgres.<ref>:<password>@<host>.pooler.supabase.com:6543/postgres" \
npm run seed
```

For a real client, replace `server/seed.js` with their actual portfolio — and
change the demo password, which is printed in that file in plain text.

## 4. Deploy

```bash
vercel --prod
```

`vercel.json` does the rest: everything routes to `api/index.js` except
`/api/*`, and the cron fires hourly.

## What runs where

```
api/index.js    the whole app          every request
api/cron.js     the scheduler          hourly, via Vercel Cron
server/app.js   the request handler    shared by both entry points
server/index.js the local dev server   never runs on Vercel
```

## Things to know

**No cron is scheduled right now.** The `crons` block has been removed from
`vercel.json`, so on Vercel nothing drives the scheduler automatically.

The endpoint still exists at `/api/cron` and still works — it is just not
being called. To turn it back on, put this back in `vercel.json`:

```json
"crons": [{ "path": "/api/cron", "schedule": "0 9 * * *" }]
```

Daily is the most frequent schedule the Hobby plan will accept; anything
tighter fails the deploy.

### What does not happen while it is off

Nothing breaks, but four things stop advancing on their own:

- new compliance obligations are not generated from move-outs or lease dates
- obligations never age from `open` to `overdue`
- delinquencies never open, and the ladder never advances a stage
- payment promises are never judged kept or broken

Everything request-driven is unaffected: maintenance intake, emergency
escalation, owner approvals, recording payments, turns and applications all
work exactly as before, because they happen during the request.

**The manual trigger covers the gap.** Compliance and Rent both have a
*Re-check now* button that runs the same tick on demand, and it is safe to
press as often as you like — every job is idempotent. A manager pressing it
once a morning is functionally the same as the cron.

You can also call it from anywhere with the secret:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron
```

What running on a daily schedule costs you, once re-enabled: deadline reminders and delinquency
ladder steps land up to 24 hours late. Nothing is missed — every job works
from current state rather than from "what happened since", so a late run
catches up completely. Emergencies are unaffected, because those escalate
during the request itself and never wait for the scheduler.

To run it more often you have two options:

- **Upgrade to Pro** and change the schedule in `vercel.json` to `0 * * * *`
  (hourly) or tighter.
- **Stay on Hobby and drive it externally.** The endpoint is a plain
  authenticated POST/GET, so any free scheduler can call it:

  ```
  curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron
  ```

  cron-job.org, GitHub Actions on a schedule, or an Uptime-style pinger all
  work. Keep `CRON_SECRET` set either way — the endpoint refuses to run
  without it.

**`maxDuration` is 15s for the app and 60s for the cron.** The cron does more
work per invocation than any single request, and a large portfolio will need
the headroom.

**Free-tier limits this stays inside:** one cron per day, function memory
512MB, `maxDuration` 15s for the app and 60s for the cron — all within Hobby
allowances. Vercel Blob has a free storage allowance; tenant photos are the
only thing written to it. Turso's free tier covers a portfolio of this size
comfortably.

**Nothing in this app costs money to run.** There is no payment API, no paid
third-party service, and no metered call anywhere in the code.


---

# Latency and region

This app makes many small queries per page. On SQLite that cost nothing. On a
network database each one is a round trip, and the difference is the whole
performance story.

**Put the function in the same region as the database.** `vercel.json` pins
`regions: ["pdx1"]` (Oregon) because the Supabase project is in `us-west-2`.
Vercel otherwise defaults to `iad1` in Washington DC — the opposite coast, and
roughly 70ms per query. Page rendering fifteen queries would spend a second
waiting on the network before writing a byte.

If you move the database, move this too:

| Supabase region | Vercel region |
|---|---|
| us-west-2 | `pdx1` |
| us-east-1 | `iad1` |
| eu-west-1, eu-west-2 | `dub1` or `lhr1` |
| eu-central-1 | `fra1` |
| ap-southeast-1 | `sin1` |

**What was fixed to get here**, measured against the live database from a
high-latency link (~500ms per round trip, which exaggerates everything and so
makes the differences obvious):

| Page | Before | After |
|---|---|---|
| `/app` | 31.1s | 9.7s |
| `/app/compliance` | 34.1s | 5.2s |
| `/app/portfolio` | 17.1s | 4.9s |

Three causes, all invisible on SQLite:

1. **`buildQueue` ran twice per page.** `navCounts` called it to read two
   numbers off the end. It now issues eight `COUNT`s concurrently instead.
2. **An N+1 on obligations.** The queue resolved each overdue obligation's
   address with its own query. Three queries now build a lookup for the page.
3. **Everything was sequential.** The queue's eight datasets, and compliance's
   three, are fetched with `Promise.all`. The connection pool is sized 4 so
   concurrent queries are not serialised back into a queue.

The remaining time is round trips, and co-location is what removes those.

---

# Database exposure

Supabase publishes every table in the `public` schema through PostgREST, and by
default grants `anon` and `authenticated` full privileges on all of them. The
`anon` role is reached with the **publishable key**, which is designed to be
public and normally ships in client-side code.

For this application that default meant anyone holding that key could read:

- `session.id` — and therefore impersonate a signed-in manager
- `staff.password_hash`
- every tenant's name, email and phone
- the `token` columns on `work_order`, `owner_approval`, `owner_statement` and
  `application` — which *are* the credentials for the tenant and owner links

and write to any of it.

`002_lockdown.sql` closes this with two independent layers:

1. **RLS enabled on every table, with no policies.** Any role that does not
   bypass RLS gets zero rows, always.
2. **Privileges revoked from `anon` and `authenticated`**, including default
   privileges so future tables do not inherit them. Even if a permissive policy
   were added later by mistake, there is no grant behind it.

This application is unaffected. It never uses PostgREST — it connects directly
as `postgres`, which owns the tables and has `rolbypassrls`.

`migrate()` re-runs the RLS sweep whenever a migration applies, so a table
added later cannot arrive unprotected.

Verified after applying: 36 of 36 tables with RLS, zero grants to anon or
authenticated, and the REST API returning `401 / 42501 insufficient privilege`
on every read and write attempt with the publishable key.

**Still worth doing:** rotate the database password and the `sb_secret_…`
service-role key. The service-role key bypasses RLS by design, so it is the one
credential this lockdown does not defend against.

---

# Security review

A full pass over authentication, transport, headers, abuse and the database.
Findings and what was done about each.

## Fixed

**The session cookie was never marked `Secure`.** The request URL was built
with a hardcoded `http://`, so `protocol` never read `https` and the flag was
never set in production. The scheme now comes from `x-forwarded-proto`, which
is what a proxy like Vercel actually sets. Verified: `Secure` appears behind an
HTTPS proxy and does not on plain localhost, where it would break development.

**Nothing was rate limited.** Sign-in was brute-forceable and the public tenant
and application forms could be flooded. `rate_hit` counts attempts in a rolling
window — in the database, because a serverless process does not survive between
requests and an in-memory counter would enforce nothing. Sign-in locks after 8
attempts per address+email in 15 minutes; the public forms allow 12 and 8 per
hour. The limiter fails open: a database problem should not lock everyone out
of their own sign-in page.

**No Content-Security-Policy.** Now set, with `script-src 'self'` — none of the
pages this handler renders carry an inline script, so an injected `<script>`
has nothing to execute. `frame-ancestors 'none'` stops clickjacking and
`form-action 'self'` stops an injected form posting credentials elsewhere.
HSTS is sent only over HTTPS. `Permissions-Policy` drops camera, microphone,
geolocation, payment and USB.

**Error pages echoed internals.** `err.message` went straight to the browser,
and `NotFound` carried a fragment of the SQL that failed. Only errors this app
raised deliberately now reach a visitor; everything else becomes a generic
line, with the real error in the server log.

**No way to change a password.** `/app/account` now does it, requiring the
current password, a minimum of 12 characters, and signing out every other
device on success. It also lists active sessions with a "sign out everywhere
else" button. Rate limited on the same basis as sign-in, because it is the
same guess.

**CSRF comparison was not constant-time.** Now `timingSafeEqual`.

## Database

- **RLS on 37 of 37 tables, zero policies** — deny-all for any role that does
  not bypass it. New tables from future migrations are swept automatically.
- **Grants:** only `postgres` and `service_role`. `anon`, `authenticated` and
  the `PUBLIC` pseudo-role hold nothing.
- **No `SECURITY DEFINER` functions and no views** in `public` — both are ways
  RLS can be sidestepped, and there are none.
- **GraphQL is not enabled**, so `pg_graphql` exposes nothing.
- **Storage has no buckets.**
- Verified by attempting reads and writes against the REST API with the
  publishable key: `401 / 42501 insufficient privilege` every time.

## Open — these need you, not code

**Rotate the `sb_secret_…` service-role key.** It holds 259 privileges and
bypasses RLS by design; that is its purpose, and no lockdown defends against
it. It was pasted into a chat log, so it must be rotated.

**Turn on "Enforce SSL on incoming connections"** in Supabase → Database
Settings. The pooler currently *accepts* unencrypted connections. This app
always uses TLS, but nothing stops a misconfigured client from not doing so.

**Supply the database CA certificate.** `ssl: "require"` encrypts but does not
verify the certificate, so it defends against eavesdropping and not against an
active interception. Supabase signs with its own CA, so verification needs that
CA file: download it from Project Settings → Database → SSL Configuration and
set its contents as `DATABASE_CA_CERT`. `/health` reports which mode is in use.

*(Closed — see "Repair QR codes" below.)*

# Repair QR codes

`/report` used to open with a dropdown of every unit under management, which
handed the portfolio to anyone who loaded the page. It is now two paths, and
neither lists anything:

**Scanned.** Every unit has a `report_token`, printed as a QR code on a sticker
that goes inside the unit. Scanning opens `/r/<token>`, which knows the address
and goes straight to "what kind of problem is it?". Two taps to a filed repair.

**Typed.** No sticker to hand, so the tenant types their address. It is matched
server-side after both sides are folded to the same shape — case, punctuation,
doubled spaces, and the usual suffixes, so "412 Maple Grove Dr", "412 maple
grove drive" and "412 Maple Grove Dr Apt 2" all land on the same unit. One
match goes straight through; several (a building) shows only that building's
unit numbers, which is not an enumeration because the tenant just told us which
building they are standing in; none returns a dead end and the phone number.

This is a lookup, not a search. It answers "is this address one of yours" —
which any intake form must — and never "what addresses do you have".

## The tokens

12 bytes, base64url, generated in SQL so the column is never null and no
backfill script has to be remembered. Shorter than the 32-byte tokens on
`/t/:token` and deliberately so: a sticker token identifies a front door, it
does not unlock anything. Knowing one lets you report a repair for that unit,
against a rate limit, and nothing else. 96 bits is far past guessable and keeps
the printed code sparse enough to scan off a scuffed label.

A code cannot be rotated on a schedule — reprinting a building is physical
work — so rotation is manual, on the unit's page, for the one case that
warrants it: a code photographed somewhere public and now attracting junk. It
takes effect immediately, and reprinting is the staff member's problem.

## Printing

`/app/portfolio/labels`, filterable to one property. Error correction is level
Q (~25% recoverable) because a label above a kitchen sink gets splashed and
painted over, and a code that dies at the first scratch is a support call. The
QR is inline SVG — sharp at any paper size, no second request, no image
library — and the URL is printed underneath, because someone will always type
it instead.

There is no print button. This app ships no client JavaScript, and
`window.print()` would have been the only reason to start; the browser's own
print command does the same job and works when script is blocked.

---

# Adding and editing records

Until now the app could operate a portfolio but not build one: properties,
apartments, owners, tenants and leases existed only because `seed.js` created
them. A firm taking on a new building had no way to enter it.

The data entry runs in dependency order, because that is the order the records
actually depend on each other:

    owner  ->  building  ->  apartments  ->  somebody living in one

**Owner** — People → Add owner. Name, contact, and the two numbers that drive
everything else: the approval threshold (spend above it waits for their yes)
and the statement day. A blank threshold falls back to the default rather than
to "approve everything", which is the direction that would dispatch unlimited
spend without asking.

**Building** — Properties → Add a building. Asks who owns it first; with no
owners on file it says so instead of showing an unusable form. Picking "a
house" creates its single unit in the same transaction, because asking a
manager to add "the unit" to a single-family home is a question with one
answer.

**Apartment** — from a building, or Properties → the unit → Building → Add
another. Saving returns a blank form rather than a list: a twelve-unit building
is twelve of these, and a round trip each time is twelve wasted clicks. Unit
numbers must be unique within a building.

**Move-in** — the mirror of the move-out that already existed. Creates the
tenant, the lease and the link between them in one transaction, because a
lease with no tenant on it is a row nobody can act on. Refused if the apartment
already has an active lease: two would make the rent ledger wrong.

Everything is reachable inside the four destinations that already exist. No new
nav items.

## Every apartment is born with its QR code

`report_token` is NOT NULL and generated in the same statement that creates the
unit, so a unit added through the app is never one whose sticker cannot be
printed. It appears on `/app/portfolio/labels` immediately. `stickerToken()` in
`lib/ids.js` is the single definition of that token's shape — creation and
rotation both call it, and it matches what migration 004 backfilled.

---

# Phase 2 modules

Six additions. What follows is what each one guarantees and where that
guarantee actually lives, because "the controller checks it" and "the database
refuses it" are very different promises.

Three things in the brief did not match the codebase and were built to the
codebase instead: this is not Express (a hand-rolled router over `node:http`,
three dependencies), roles were `admin`/`manager` only and the CHECK constraint
had to be widened before `lib/auth.js` could mean anything by "role", and a
`{{placeholder}}` engine plus a single-entry `ledger_entry` already existed, so
both were extended rather than duplicated.

## Double-entry accounting — `features/accounting.js`

`postJournal()` is the only writer. Rent, maintenance bills, owner
distributions, late fees and bank matches all go through it.

The guarantees are in `005_accounting.sql`, not in the controller:

- **Debits equal credits**, checked by a `DEFERRABLE INITIALLY DEFERRED`
  constraint trigger. Deferred is the whole point — the check runs once at
  COMMIT, when every split of the journal is in. A normal trigger would fire on
  the first split and reject every journal ever written.
- **At least two splits.** One split that nets to zero is not double entry.
- **Nothing is deleted or amended.** `DELETE` on a journal or a split raises,
  `UPDATE` on a split raises, and a posted journal accepts an update only to
  record that it was reversed. A mistake is corrected by posting the mirror,
  which is what an auditor expects to find.

Verified by trying to break it: an unbalanced journal, a single split, a split
with both sides filled, and a negative credit faking a balance are all refused,
as are delete and update on posted rows.

`ledger_entry` is untouched and still drives owner statements. It answers "what
does this owner see"; the journal answers "does the company balance".

## Leases and e-signatures — `features/leases.js`

What makes an electronic signature defensible is being able to show which bytes
somebody agreed to. So:

- A document is compiled **once** and frozen. The template can change tomorrow;
  the document cannot.
- A document with unresolved `{{tokens}}` **cannot be sent**. A lease that still
  says `{{rent_amount}}` is not a lease.
- Every signature stores the document hash it was applied to, and the page
  recomputes that hash on every read. Altering stored text is detected rather
  than silent — verified by tampering with a signed document and watching the
  check fail.
- Signatures are immutable in the database. A document that should not stand is
  voided, which leaves the signatures visible.

The trail per signature: party type, typed name, email, timestamp, IP,
user-agent, ESIGN consent recorded as its own field, and a mark hashing all of
it together with the document.

Markdown renders through an escape-first pipeline, so a tenant name containing
`<script>` becomes text, not markup, inside a signed instrument.

## Bank feeds — `features/banking.js`, `lib/plaid.js`

Access tokens are sealed with AES-256-GCM (`lib/crypto.js`) before they touch
the database and unsealed only inside the Plaid boundary. GCM authenticates as
well as encrypts, so a tampered ciphertext refuses to open rather than
decrypting to something plausible.

Syncing is idempotent at the database: provider transaction ids and webhook
delivery ids both carry unique indexes, so a replayed webhook does nothing.

The matcher **proposes and a person decides**. Amounts must match to the cent;
the score only separates equals, by date proximity and whether any word of the
internal record appears in the bank's clearing string. A wrong automatic match
in a trust ledger is worse than no match, because it looks reconciled.

**Nothing here has run against Plaid's live API** — this project has no Plaid
credentials. The request shapes follow the documented API; treat the first live
call as the test. Everything that does not need Plaid — sealing, storage,
matching, webhook idempotency — is exercised and does not depend on it.

## Syndication feed — `/feeds/listings.xml` and `api/feeds/listings.xml.js`

Public, unauthenticated, cached 15 minutes. Served at both paths from one
builder so the two cannot drift; the `api/` file exists because `vercel.json`
rewrites everything except `/api/*` into the main handler.

Syndication is **opt-in per listing and off by default**. Publishing an address
to every aggregator on the internet is a decision somebody makes on purpose.

There is no single "ILD" schema every aggregator accepts — Zillow,
Apartments.com and the ILS networks each take a dialect. This produces the
common shape (provider envelope, one `Property` per address, nested `ILS_Unit`)
with correct escaping and stable identifiers. Expect to map field names when
onboarding a specific network.

## Vendor compliance — `features/vendors.js`

The barrier is the point. `complianceState()` is called from the work-order
dispatch path and from every payout path, so an expired certificate refuses
rather than warning on a dashboard nobody reads on a Tuesday.

- **Expired workers compensation blocks payment.**
- **Expired liability or licence blocks dispatch.**
- The split is deliberate: refusing to pay for completed work because a
  certificate lapsed afterwards creates a dispute, not compliance.

An invoice from a lapsed contractor is still **recorded and accrued** —
`Dr Repairs / Cr Payable` — because the liability is real whether or not the
paperwork is. What is withheld is the money.

1099 extraction returns data, not a file, because filing formats differ by
transmitter. Vendors under the $600 threshold are returned too, marked, so the
filer can see what was excluded and why. Taxpayer IDs are sealed; only the last
four ever leave the function.

## Roles and the late-fee sweep

`lib/auth.js` holds capabilities, not role names. `role === "admin"` scattered
through a codebase is how a new role silently acquires permissions nobody
granted it.

Enforced **once**, in `app.js`, before any handler runs. Asking each handler to
check its own role is how authorisation models fail: correct in twenty handlers
and missing in the twenty-first, with nothing to tell you which. Verified over
real HTTP — leasing and maintenance accounts get 403 on accounting, banking,
owners, rent and 1099.

The nav hides what a role cannot open. That is cosmetic; the gate is the
enforcement.

### The lock, and why it is not an advisory lock

Advisory locks cannot do this job through Supabase's pooler on port 6543, which
is pgbouncer in transaction mode. A session-scoped `pg_advisory_lock` is taken
on a backend connection the next statement may not be given; a transaction-
scoped one is released the instant its statement ends. Either way you get a
no-op that reads like a guarantee. **The first version of this file made exactly
that mistake.**

What is there instead: a partial unique index allowing one unfinished `job_run`
per job name, plus a stale-run reclaim for a function killed mid-sweep.

The real protection against a double charge is `UNIQUE (lease_id, period)` on
`late_fee`. The sweep inserts and lets the database refuse a duplicate rather
than checking first — a check-then-insert has a window between the two, and
that window is where the double charge lives.

Nothing is charged without a policy. A lease with no late-fee terms gets no
fee; inventing a charge because a field was blank is how a company ends up
refunding a year of them.

## What you have to do

**Set `APP_ENCRYPTION_KEY`** in every environment, or bank linking and taxpayer
IDs refuse to store. Generate one with:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

Losing this key makes sealed fields unrecoverable. It belongs in a secret
manager, not in the repository.

**Plaid, when you want it:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`,
and `PLAID_WEBHOOK_SECRET` for the testable webhook verification path.

**Cron is not scheduled.** `api/cron.js` runs both sweeps and reports each
separately — a failure in the housekeeping tick can no longer silently skip the
billing. It is left unscheduled because a cron block broke the deploy before.
To turn it on, add to `vercel.json` (Hobby allows daily granularity):

    "crons": [{ "path": "/api/cron", "schedule": "0 9 * * *" }]

and set `CRON_SECRET`, without which the handler refuses to run on Vercel.

---

# Polish pass

A walk through every screen, finding what was broken rather than guessing.

## Things that were actually broken

**The lease document had no styling at all.** `.doc` was referenced in
`features/leases.js` and defined nowhere, so a compiled lease rendered with
browser-default headings — an `h1` twice the size of anything else in the app,
headings jammed against the paragraph above, no measure. It looked like a
broken web page, which is a poor thing for a legal instrument to look like at
the moment somebody decides whether to sign it. Now it uses the app's own type
scale with a 44rem measure.

**The column carrying the answer fell off the edge.** `table.data` sets
`min-width: 46rem`, sized for the seven-column queue tables. The trial
balance's Balance column and the contractor list's State column were both cut
off. Fixed twice over: fewer columns (6→4 and 7→5, by folding type and trade
into the cell they describe), and `.tablewrap--narrow` on the tables that do
not need the wide minimum. `.tablewrap` also grew a scroll shadow, so a table
that *is* wider than its column now says so instead of just looking truncated.

**Signature records were unreadable.** Seven facts per signature rendered as a
`.dl` in a sidebar: a 9rem label column against a 6rem value column, with a
64-character hash overflowing it. Replaced with a stacked record, and long
values (signing URLs, hashes) now use `.longval`, which wraps instead of
pushing the panel wider than the page.

**Banking had no entry point.** `storeItem()` existed and nothing called it.
Plaid Link is a browser widget needing client-side JavaScript, which this app
deliberately does not ship — so the aggregator could never have been the only
way in. Statement import fixes that: paste lines from a CSV export or online
banking, in whatever date format the bank uses, and get the same `bank_txn`
rows the sync would write. Same matcher, same journals, same audit trail. The
line's own content is hashed into its id, so importing the same statement twice
changes nothing.

**Every contractor was blocked.** Migration 009 added the insurance columns as
NULL, so all eight seeded vendors came out with no cover on file and the list
read "8 contractors cannot be used". The barrier was right; the data was
missing. `seed.js` now records compliance, and the existing rows were
backfilled — two are lapsed on purpose, so the barrier is visible doing its job
rather than only described here.

**A dropped database connection killed the process.** A pool error arrives
attached to no particular request, so Node saw an unhandled rejection and
exited. A connection dropping is normal — a pooler recycling, a laptop waking
up — and has to degrade into a failed request, not a dead server.

**`.input` was a dead class** on the sign-in fields, styled by `.field input`
all along.

## Smaller things

- Five new nav items shared two icons, which made the sidebar unscannable.
  `cash`, `loop`, `wrench`, `key` and `doc` already existed and are now used.
- The accounting date filter was a full panel above the data it filters,
  pushing the table below the fold. It is one row on the panel it belongs to.
- "Paid this year" read `$0.00` for anyone paid in a previous year, which looks
  like a bug rather than a date range. The column names the year.
- Both banking empty states were dead ends. They now offer the next step.

## Verified

33 routes green, no 500s, ledger balanced, no undefined CSS classes left in the
app. Checked at 1440px, 1024px and 375px.
