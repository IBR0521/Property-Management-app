# Property operations

Back-office application for a property management company: maintenance intake
and dispatch, owner reporting and approvals, compliance deadlines, rent and the
delinquency ladder, unit turns, and application intake.

Runs on Vercel, or anywhere Node 20+ runs.

## Local

```bash
npm install
export DATABASE_URL="postgresql://postgres.<ref>:<pw>@<host>.pooler.supabase.com:6543/postgres"
npm run seed     # demo company and portfolio (once)
npm start        # http://localhost:4300
```

Sign in with the credentials the seed prints. `DATABASE_URL` is the Supabase
**transaction pooler** string; keep it in `.env.local`, which is gitignored.

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

- `postgres` — the database driver, talking to Supabase through its
  transaction pooler.
- `@vercel/blob` — tenant photos and applicant documents.

Everything else is Node built-ins. No build step, no framework, no CDN.

**Nothing here costs money to run.** There is no payment API and no metered
third-party call anywhere in the code — the app deliberately never moves funds.

## Deploying

Four environment variables, one seed, one deploy. Full instructions, the
architecture, and the pre-launch checklist are in
**[server/README.md](server/README.md)**.

The database lives in Supabase. Nothing in `data/` is tracked.
