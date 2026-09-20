# Property operations

Back-office application for a property management company: maintenance intake
and dispatch, owner reporting and approvals, compliance deadlines, rent and the
delinquency ladder, unit turns, and application intake.

Runs on Vercel, or anywhere Node 20+ runs.

## Local

```bash
npm install
npm run seed     # demo company and portfolio (once)
npm start        # http://localhost:4300
```

Locally it uses a SQLite file at `data/app.db` and needs no configuration at
all. Sign in with the credentials the seed prints.

## What is in this repository

```
index.html            public marketing site, served at /
assets/               its stylesheet and script
                      (assets/css/styles.css is also the app's design system)
app-assets/app.css    back-office layout
server/               the application
api/                  Vercel entry points: the app, and the cron scheduler
vercel.json           routing, function limits, cron schedule
```

One origin serves everything:

| | |
|---|---|
| `/` | marketing site |
| `/report` `/t/:token` | tenant repair intake and status — no account |
| `/apply` `/a/:token` | rental application and document upload |
| `/o/a/:token` `/o/s/:token` | owner approval and monthly statement |
| `/app/*` | back office, staff session required |

## Dependencies

Two, both forced by serverless, which has no local disk:

- `@libsql/client` — the database. libSQL *is* SQLite, so the schema and every
  query are identical whether it runs against a local file or hosted Turso.
- `@vercel/blob` — tenant photos and applicant documents.

Everything else is Node built-ins. No build step, no framework, no CDN.

**Nothing here costs money to run.** There is no payment API and no metered
third-party call anywhere in the code — the app deliberately never moves funds.

## Deploying

Four environment variables, one seed, one deploy. Full instructions, the
architecture, and the pre-launch checklist are in
**[server/README.md](server/README.md)**.

The runtime database in `data/` is not tracked — it is the system of record,
so back it up rather than committing it.
