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
server/               the application
app-assets/app.css    back-office layout
assets/css/styles.css shared design tokens and components
```

The public marketing site is **not** tracked here — it is generated and owned
separately. The server serves it at `/` when the file is present and redirects
to `/app` when it is not, so this repository runs standalone.
