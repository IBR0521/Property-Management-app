# Phase 0 — Baseline, tests and hygiene

Plan only. No code until you approve it.

---

## What I read, and what it changed about this plan

`README.md` and `server/README.md` in full, the 42 JS files under `server/` and
`api/` (11,651 lines), and all twelve migrations. Four findings moved the plan
away from what I would otherwise have written.

### 1. Cross-company isolation holds today, but by convention, not by structure

I audited every query keyed on an id against the 54-table schema. 28 statements
select or update by a bare `id` with no `company_id` in the same statement. I
read each one:

- **Safe, derived:** `criteria_set` in `applications.js:297,396` and `owner` in
  `owners.js:350,475` are fetched using an id taken from a row that was itself
  already scoped (the application) or reached through a 32-byte token (the
  statement, the approval). The id never comes from the URL.
- **Safe, session-derived:** `staff` in `account.js` comes from the session.
- **Safe, deliberately company-wide:** the scheduler and late-fee sweep operate
  across all companies by design.
- **Safe, parent-scoped:** `turn_task` is scoped by `turn_id`.

So there is no leak I can find today. The problem is *why* there is no leak: it
holds because roughly two hundred call sites each remembered to scope their
parent. Nothing in the database or the framework would stop the two hundred and
first from forgetting, and Phase 2 turns that from a latent bug into a
disclosure between paying customers.

The roadmap's answer — a cross-company test that hits every route as company A
with company B's ids — is the right first move and is what I will build. I also
want to raise a structural option for Phase 2, not Phase 0: connect as a
non-superuser role with RLS policies keyed to `current_setting('app.company_id')`
and `SET LOCAL` per transaction. `SET LOCAL` is transaction-scoped so it is safe
through pgbouncer in transaction mode, which is the constraint that usually
kills this approach. It would make leakage impossible rather than merely
tested-for. It is a large change and belongs in its own phase; I mention it now
because the Phase 0 tests should be written so they would still be meaningful
afterwards.

### 2. `db.js` cannot currently be pointed at a test database

`server/lib/db.js` reads `process.env.DATABASE_URL` and constructs the pool **at
module load**, throwing if it is unset. Any test that imports anything that
imports `db.js` — which is everything — gets the production pool.

This is the single blocking issue for Phase 0, and it is why `config.js` has to
land before the first test, not alongside it. `db.js` will read its URL from
`config.js`, which resolves `TEST_DATABASE_URL` when `NODE_ENV=test`.

### 3. One migration will not run on a plain Postgres

`004_unit_report_token.sql` calls `gen_random_bytes()`, which lives in
`pgcrypto`. Supabase preinstalls it, so this has never surfaced. A fresh
`postgres:16` container in CI would fail on migration 4 of 12.

`002_lockdown.sql` is already defensive about the Supabase-only `anon` and
`authenticated` roles (`IF EXISTS (SELECT 1 FROM pg_roles ...)`), so that one is
portable. Only pgcrypto needs fixing, and a guard is a one-line migration.

### 4. The RLS and grant sweep does cover new tables — confirmed live

The roadmap asked me to confirm this rather than assume it. Against the live
database:

    tables granting to anon / authenticated / PUBLIC:  0
    tables without RLS:                                0
    total tables:                                     54

Two mechanisms, and they are not the same one. `migrate()` runs
`enforceRowLevelSecurity()` after any migration applies, which only ever
*enables RLS*. Grants are handled separately, by the `ALTER DEFAULT PRIVILEGES`
statements in `002_lockdown.sql`, which is why tables created in migrations 5
through 12 arrived with no grants without anyone re-running the revoke.

One caveat worth recording: `ALTER DEFAULT PRIVILEGES` applies only to objects
created by the role that set it. Migrations run as `postgres`, which is that
role, so this holds — but a table created by any other role would not inherit
it. The Phase 0 test asserts the end state (zero grants, RLS everywhere) rather
than trusting the mechanism, so it would catch that.

---

## Scope

Everything in the roadmap's Phase 0, and nothing else. No feature work, no
behaviour changes except the two small fixes above that tests cannot run
without.

---

## Design decisions

### Where the test database comes from — I need your decision

Tests need a real Postgres with migrations run fresh. Three options:

| | Speed | Cost | Catch |
|---|---|---|---|
| **A. Postgres service container in CI, Docker locally** | Fast (~1ms/query) | Free | Needs Docker locally; not byte-identical to Supabase |
| **B. A second Supabase project as `TEST_DATABASE_URL`** | Slow (~250ms+/query from here) | Free tier | Identical environment; concurrent runs collide |
| **C. Schema-per-run on the existing database** | Slow | Free | Sharing a database with production data is a bad habit to build |

**My recommendation is A**, with the suite written so `TEST_DATABASE_URL` can
point at anything — so you can run it against B when you want to check something
Supabase-specific. GitHub Actions has a native `services: postgres` block, so CI
costs nothing and takes seconds. The differences that matter (pgcrypto, the
Supabase-only roles) are the two things I already found, and both are handled.

I will not pick this for you because it decides whether you need Docker on your
machine. Tell me A, B or C.

### Test isolation

Each run: drop and recreate the `public` schema, run all migrations, seed. Tests
that share state run in one file in series; independent files can run in
parallel. No test depends on another test's leftovers, because the failure mode
there is a suite that passes in the wrong order and lies.

### `config.js`

One module, read at boot, fails loudly on anything required and missing. It
replaces fourteen scattered `process.env` reads — four of which are already read
in two or three files each (`DATABASE_URL` in three, `BLOB_READ_WRITE_TOKEN`,
`DATABASE_CA_CERT`, `VERCEL` in two). It validates shape, not just presence:
`APP_ENCRYPTION_KEY` must decode to 32 bytes, `DATABASE_URL` must be a pooler
URL on 6543, and it will warn rather than throw when it sees port 5432, because
that is the mistake that produces exhausted-connection errors an hour later
rather than at boot.

Required vs optional is environment-dependent: `CRON_SECRET` is required on
Vercel and not locally, which the existing code already half-implements in
`api/cron.js`. That logic moves here.

### Request IDs and error tracking

A `requestId` (8 bytes, hex) generated per request, put on `ctx`, included in
every log line, returned as `X-Request-Id`, and shown on the 500 page so a user
can quote it. Logs become single-line JSON when `LOG_FORMAT=json`, staying
human-readable otherwise — Vercel's log drain wants JSON, a terminal does not.

Error tracking via Sentry's HTTP envelope API with `fetch`, no SDK, behind
`SENTRY_DSN`. Unset means no calls are made and nothing is imported. I will
build it against a local mock endpoint and verify the envelope shape and that
the DSN never appears in a log line; I cannot verify Sentry accepts it without a
real DSN, and I will say so in the report rather than claiming it works.

---

## Files

**New**

    server/lib/config.js          env validation, single read point
    server/lib/logger.js          request-id logging, JSON or human
    server/lib/errors.js          Sentry envelope over fetch, no-op when unset
    test/helpers/db.js            fresh schema + migrations per run
    test/helpers/http.js          in-process request driver (no network)
    test/helpers/factories.js     two-company seed for isolation tests
    test/invariants.test.js       the nine product invariants
    test/security.test.js         CSRF, rate limits, role gate, tokens, address lookup
    test/isolation.test.js        company A staff against company B ids, every route
    test/accounting.test.js       append-only journal, balance enforcement
    test/config.test.js           boot fails on bad env
    .github/workflows/test.yml    postgres service, node 20 + 22, npm test
    docs/phase-0-plan.md          this file

**Changed**

    server/lib/db.js              read url from config; export a reset for tests
    server/app.js                 requestId on ctx, structured logging, X-Request-Id
    api/cron.js                   CRON_SECRET check moves to config
    server/lib/files.js           BLOB token from config
    server/features/banking.js    VERCEL check from config
    package.json                  "test" script, node:test runner glob
    server/README.md              new env table, testing section

---

## Migrations

One, and only because tests cannot run without it:

    013_pgcrypto_guard.sql        CREATE EXTENSION IF NOT EXISTS pgcrypto

It is a no-op on Supabase, where the extension is already there. It is what lets
migration 004 run on a plain Postgres. Numbered 013 per the roadmap, forward
only.

No new tables in this phase, so no new RLS or grant surface. The test suite will
assert the invariant anyway (zero grants, RLS on every table) so that future
phases fail loudly rather than silently.

---

## New environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TEST_DATABASE_URL` | tests only | Database the suite drops and rebuilds. Never production; `config.js` refuses if it equals `DATABASE_URL`. |
| `NODE_ENV` | no | `test` switches the database URL source |
| `LOG_FORMAT` | no | `json` for a log drain, otherwise human-readable |
| `SENTRY_DSN` | no | Unset means no error reporting and no outbound calls |
| `APP_ENV` | no | `development` / `staging` / `production`, tags errors |

Existing variables are documented in the same table rather than left scattered:
`DATABASE_URL`, `DATABASE_CA_CERT`, `PG_POOL_MAX`, `CRON_SECRET`,
`BLOB_READ_WRITE_TOKEN`, `APP_ENCRYPTION_KEY`, `DELIVERY_MODE`, `PLAID_*`,
`PORT`.

---

## Risks

**The suite will find real bugs and the phase will grow.** Writing a test per
invariant against code that has never had one usually turns up two or three
genuine faults. I would rather report them than quietly fold fixes into Phase 0
and hand you a diff you cannot review. Anything I find, I will list separately
and fix in its own commit.

**`config.js` touches the boot path of every entry point.** A mistake here takes
the whole app down rather than one page. It is why it lands first, with its own
test, before anything depends on it.

**The isolation test is only as good as its route list.** A hand-written list
rots the moment a route is added. I will enumerate routes from the router's own
table instead, so a new route is covered the day it is registered and an
uncovered one fails the suite.

**Timing-sensitive tests are flaky tests.** The rate limiter works in windows and
the scheduler in dates. Both will be driven by injected clocks rather than real
sleeps.

**Postgres in CI is not Supabase.** Different extensions, no pooler, no
`anon`/`authenticated` roles. The two places that bite are already found and
handled, but a future Supabase-specific behaviour could pass CI and fail in
production. Mitigation: the suite runs against `TEST_DATABASE_URL` whatever it
points at, so it can be pointed at a Supabase project before a release.

---

## What I need from you

1. **Test database: A, B or C** from the table above. My recommendation is A.
2. **Sentry or something else** for error tracking, and a DSN when you have one.
   Unset is a valid answer for now — it stays a no-op.
3. Nothing else. Phase 0 needs no third-party credentials.

## And three things only you can do, still open from the last phase

These are in `server/README.md` already and are not blocked on me:

1. **Rotate the Supabase `sb_secret_…` service-role key.** It bypasses RLS by
   design — the lockdown does not defend against it — and it was pasted into a
   chat log.
2. **Rotate the database password**, for the same reason, then update
   `DATABASE_URL` in Vercel.
3. **Turn on "Enforce SSL on incoming connections"** in Supabase → Database
   Settings, and download the CA certificate into `DATABASE_CA_CERT`. Right now
   the pooler accepts plaintext connections and our TLS is encrypted but
   unverified; `/health` reports which mode is live.
