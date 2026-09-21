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

Sign in at `/app` with `dana@leafridgepm.test` / `columbus2026`.

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
