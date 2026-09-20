# Property operations

Back-office application for a property management company: maintenance intake
and dispatch, owner reporting and approvals, compliance deadlines, rent and the
delinquency ladder, unit turns, and application intake.

**Zero runtime dependencies.** Node 22 built-ins only — `node:http`,
`node:sqlite`, `node:crypto`. No install, no build step, no CDN.

```bash
npm run seed     # demo company and portfolio (once)
npm start        # http://localhost:4300
```

Full documentation, architecture and the pre-deployment checklist:
**[server/README.md](server/README.md)**

## What is in this repository

```
index.html            public marketing site, served at /
assets/               its stylesheet and script
                      (assets/css/styles.css is also the app's design system)
app-assets/app.css    back-office layout
server/               the application
```

One server, one origin:

| | |
|---|---|
| `/` | marketing site |
| `/report` `/t/:token` | tenant repair intake and status — no account |
| `/apply` `/a/:token` | rental application and document upload |
| `/o/a/:token` `/o/s/:token` | owner approval and monthly statement |
| `/app/*` | back office, staff session required |

The runtime database in `data/` is not tracked — it is the system of record,
so back it up rather than committing it.
