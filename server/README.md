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

Locally it uses a SQLite file at `data/app.db` and needs no configuration.

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
| SQLite file at `data/app.db` | Turso (libSQL) over HTTP |
| `data/uploads/` on disk | Vercel Blob |
| `setInterval` every 10 minutes | Vercel Cron hitting `/api/cron` |

libSQL was chosen over Postgres deliberately: it *is* SQLite, so the schema and
every query in this codebase are byte-identical either way. A Postgres port
would have meant rewriting `group_concat`, `date(?, '+N day')` and several
hundred statements, which is where a silent bug would have hidden.

## 1. Create the database

```bash
turso db create property-ops
turso db show property-ops --url        # libsql://...
turso db tokens create property-ops     # the auth token
```

## 2. Set the environment variables

In the Vercel project settings:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `libsql://<your-db>.turso.io` |
| `DATABASE_AUTH_TOKEN` | the token from above |
| `CRON_SECRET` | any long random string — the cron endpoint refuses to run without it |
| `BLOB_READ_WRITE_TOKEN` | created for you when you add Vercel Blob to the project |

Without `BLOB_READ_WRITE_TOKEN` the app falls back to local disk, which on
Vercel means uploads vanish after the request. Add the Blob store before
anyone uploads a photo.

## 3. Seed the database once

Point your local machine at the hosted database and run the seed:

```bash
DATABASE_URL="libsql://<your-db>.turso.io" \
DATABASE_AUTH_TOKEN="<token>" \
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

**The cron schedule is hourly, not every ten minutes.** Tighten it in
`vercel.json` if you want faster reminders — every job is idempotent, so
running it more often is safe and running it less just means a delay.

**`maxDuration` is 15s for the app and 60s for the cron.** The cron does more
work per invocation than any single request, and a large portfolio will need
the headroom.

**The free Vercel plan allows one cron per day.** On Hobby you will need a paid
plan for hourly, or call `/api/cron` from an external scheduler with the same
`CRON_SECRET` header.
