# The roadmap

Pasted into the chat at the start of Phase 0 and reproduced here verbatim.

It lived only in a conversation until now, which meant that after one context
compaction nobody in the room could say what Phase 4 was. A plan that exists
only in a transcript is a plan with a half-life. Nothing below is edited —
where it and the code disagree, this is the record of what was asked for and
the phase plans in this directory are the record of what was decided.

---

Roadmap: take property-ops from single-firm back office to a sellable platform
You are working in the `property-ops` repository: a Node 20+ property management app with no framework, a hand-rolled router over `node:http`, Postgres on Supabase through the transaction pooler, Vercel Blob for files, deployed on Vercel. Read `README.md` and `server/README.md` in full before doing anything. They document why the code is the way it is, and most of those decisions are correct.
The goal is to close every gap between this app and AppFolio, Buildium, DoorLoop and Rentvine, so it can be sold to property management companies as a multi-company SaaS product. The work is split into phases below. Work one phase at a time.
How to work

1. At the start of each phase, read the relevant code, then write a short plan to `docs/phase-N-plan.md`. The plan covers the files you'll touch, the new migrations, the new env vars and the risks. Then stop and wait for my approval before writing code.
2. At the end of each phase, stop and report four things: what was built, how it was verified, what you could not verify (for example, a provider needed real credentials), and the exact list of things I need to supply (API keys, accounts, decisions). Update `server/README.md` in the same style it's written in now: explain why, not just what.
3. Never mark something done that you haven't exercised. If something needs a live credential you don't have, build it against the provider's sandbox/test mode or a documented mock, and say so plainly. Don't write "should work."
4. Never commit secrets. New config goes in env vars, documented in the README's env table, and read in one place (`server/lib/config.js`, created in Phase 0).
5. Keep migrations numbered and forward-only, starting at `013_`. Every new table carries `company_id` and gets the same RLS and grant lockdown as `002_lockdown.sql` (the `migrate()` sweep should already cover this, so confirm it).
6. Commit per logical step with clear messages, so any step can be reverted.

Invariants — do not break these
These are the reasons this product is better than the incumbents. Every phase must preserve them, and the test suite (Phase 0) should prove they still hold.

* An emergency is never queued. Emergency answers escalate during the request.
* Spend over an owner's threshold cannot be dispatched without a recorded approval.
* An unapproved notice template cannot be sent. Editing the text clears the sign-off.
* No automated applicant scoring or decisions. Screening reports inform a human who records the decision per criterion. This holds even after Phase 8 adds real screening reports.
* The double-entry journal is append-only, and `postJournal()` is the only writer. Debits equal credits, enforced by the database.
* Vendor compliance barriers: lapsed liability or licence blocks dispatch; lapsed workers' comp blocks payment.
* Late fees only under a written policy, deduplicated by the database.
* The platform never holds client or tenant money. When Phase 3 adds payments, funds flow from the tenant directly to the property management company's own processor account and bank (their trust account). This app orchestrates and records; it is never the custodian. This matters legally, for trust-account rules and money-transmitter licensing, so do not design around it.
* Authorization is enforced once, in the app-level capability gate, never per-handler.
* Delivery honesty: the UI never claims a message was sent unless the provider accepted it.
* Transparent pricing: no hidden per-transaction markups that the PM company can't see and configure.

Dependencies and client-side JavaScript
The "zero dependencies" rule is relaxed, but not abandoned:

* Call providers (email, SMS, Stripe, Plaid, screening, QuickBooks) with plain `fetch`, not their SDKs, unless an SDK is truly required. Verify webhook signatures yourself using `node:crypto`.
* A small number of vetted dependencies is acceptable where writing them yourself would be reckless. PDF generation (`pdf-lib`) is an example. Justify each one in the phase plan.
* Client-side JavaScript is now allowed, because the portals, Plaid Link, Stripe payment elements and the PWA need it. The rules:
   * Put it in external files under `app-assets/js/`. No inline scripts, so `script-src 'self'` stays in the CSP. Add only the exact third-party origins required (`js.stripe.com`, `cdn.plaid.com`) and document why.
   * No framework and no build step unless you make a strong case in a plan.
   * Progressive enhancement: every staff workflow must still work with JavaScript disabled.

Phase 0: Baseline, tests and hygiene
There is no automated test suite. Build one before changing anything.

* Add tests with `node:test` against a real Postgres. Use a separate `TEST_DATABASE_URL`, not production, and run migrations fresh each run. Add `npm test`.
* Write tests that pin down every invariant listed above, plus the existing security properties: CSRF, rate limits, the role gate returning 403, token-scoped public pages, and address lookup that never enumerates units.
* Add a cross-company isolation test. Seed two companies, then hit every route as company A's staff with company B's IDs, and assert 404/403 everywhere. Phase 2 depends on this, so audit every query for `company_id` scoping now and fix what you find.
* Create `server/lib/config.js` to validate env vars at boot and fail loudly on missing required ones.
* Add structured error logging with a request ID, and a hook for an error tracker (Sentry via its HTTP envelope API, or similar).
* Add a GitHub Actions workflow that runs the tests on every push.
* Remind me in your report to rotate the Supabase `sb_secret_` key and database password, to turn on "Enforce SSL", and to set `DATABASE_CA_CERT`. The README says these are still open.

Phase 1: Message delivery and scheduling (the current blocker)

* Implement `drainOutbox` in `lib/scheduler.js` behind a provider interface:
   * Email: Resend or Postmark via `fetch`.
   * SMS: Twilio via `fetch`.
   * Keep `DELIVERY_MODE=log` for development.
* Add retry with exponential backoff, using the existing `attempts` and `last_error` columns, and a dead-letter state visible in the UI.
* Record the provider's message ID on send. Add webhook endpoints for delivery status, bounces and complaints, all signature-verified and idempotent.
* The emergency path must send the on-call SMS during the request itself, not via the outbox. If the send fails, show the tenant the stop card anyway and log the failure loudly.
* Handle SMS opt-out (STOP/HELP) and store consent. Handle email unsubscribe for non-transactional mail.
* Add a "Send a test" button in Setup for each channel.
* Scheduling: re-add the Vercel cron block (daily on Hobby), document an external pinger as a fallback for hourly runs, and add a "last scheduler run" indicator on the dashboard that turns red when a run is stale.

Phase 2: Multi-company SaaS foundation

* Public signup at `/signup`: create a company plus its first admin user, with email verification. Include a guided onboarding checklist (company details, first owner, first building, delivery test, payments connect).
* Staff management UI: invite by email, assign role, deactivate, and resend invite. Keep the capability-based roles in `lib/auth.js`, and add a role for "maintenance technician."
* Company settings page: legal name, logo (used on statements, notices and portals), timezone, currency formatting and business hours.
* Optional TOTP two-factor authentication for staff, built with `node:crypto`. Admins can require it for the whole company.
* Subscription billing for my SaaS revenue using Stripe Billing: a flat, transparent monthly price by unit bands, a trial period, and a billing page. When a subscription lapses, the company goes read-only; never delete data.
* Platform admin area, restricted to me: list companies, impersonation (audit-logged and visible to the company), usage stats.
* Replace the demo password printing in `seed.js`. The seed is for development only.

Phase 3: Payments, without ever holding funds

* Use Stripe Connect. Each PM company connects its own Stripe account (Standard or Express; compare the two in the plan) so funds settle straight to their bank. The platform takes no custody.
* Tenants can pay by ACH debit (Stripe's US bank account payments with Financial Connections) and optionally by card. The fee model is configurable per company: absorb, pass through, or split. The fee is shown to the tenant before they pay, and card surcharges follow card-network rules.
* Autopay: tenants enroll, and payments run on due date minus N days. Failed or returned ACH payments reverse the journal and reopen the charge.
* Stripe webhooks: signature-verified and idempotent via unique event IDs. Every payment, fee and return posts through `postJournal()` and appears on the tenant ledger and owner statement.
* Block payments per lease (for example, cash-only after an NSF, or during an eviction) with a reason.
* Owner distributions and vendor payouts: generate a NACHA ACH file that the PM company uploads to its own bank, and printable checks (PDF, check-stock layout, with a positive-pay export CSV). Respect the vendor workers'-comp barrier on every payout path. Money still never touches the platform.
* Add a one-click deposit-to-bank reconciliation that matches Stripe payout batches to bank transactions using the existing matcher.

Phase 4: Tenant and owner portals, and messaging

* Passwordless login for tenants and owners: an email magic link plus an optional SMS code. Keep the existing one-time token links working, since they're still the fastest path for an owner opening a statement.
* Tenant portal: balance and full ledger, pay now, autopay setup, receipts, maintenance requests with photos and live status, the lease and signed documents, notices received, renters-insurance upload, and contact details.
* Owner portal: a dashboard per property (occupancy, rent collected versus due, open work orders, pending approvals), statements, reports from Phase 6, documents, distribution history, and year-end tax documents.
* Two-way messaging: one shared inbox for staff, threaded per tenant/owner/vendor, spanning the portal, email (inbound via the provider's inbound parse) and SMS replies. Assign threads, mark them resolved, and use templates. Every message is attached to the relevant record.
* Allow tenants to have several leases over time, and owners several properties, under one login.

Phase 5: Mobile (PWA first)

* Make the portals and the staff app an installable PWA: manifest, service worker, and offline caching of the app shell only (never cache financial data).
* Add web push notifications (VAPID, signed with `node:crypto`) for new work orders, approvals, messages and payment receipts.
* Build a technician view designed for a phone: today's jobs, directions link, check-in/check-out, photo capture, notes, parts used and completion.
* Audit every page at 375px wide. A native app is out of scope; say in your report whether a thin wrapper (Capacitor) is worth it later.

Phase 6: Reporting and exports

* Reports: rent roll, delinquency/AR aging, P&L and balance sheet (by property, owner, portfolio and period), cash flow, general ledger detail, trust reconciliation (three-way: bank, book and tenant/owner ledgers), vacancy and days-vacant, work order spend by vendor and category, lease expirations, security deposits held, and 1099 summary.
* Every report can be exported as CSV and PDF. Every table in the app can be exported as CSV.
* Saved reports with filters, and scheduled email delivery of a report to staff or owners.
* Owner statements as branded PDFs.
* Tests: the P&L and balance sheet must tie out to the trial balance, and the trust reconciliation must balance on seeded data.

Phase 7: Migration, integrations and API

* Import wizard: upload CSVs for owners, properties, units, tenants, leases, vendors, recurring charges, opening balances and security deposits. Validate everything, show a dry-run preview with row-level errors, then commit in a single transaction. Provide templates, plus column mappings that match the typical exports of AppFolio, Buildium, DoorLoop and Rent Manager. Opening balances post through `postJournal()` with a clear conversion memo.
* Full data export: a company can download all its data as CSVs plus files. No lock-in is a selling point.
* QuickBooks Online sync via OAuth: push journals as summarized entries. Make it one-way and idempotent, with a sync log.
* Public REST API: company-scoped API keys with scopes, hashed at rest, rate-limited and audit-logged. Include JSON endpoints for the core resources and OpenAPI docs.
* Outbound webhooks for key events, signed with HMAC and retried.

Phase 8: Tenant screening

* Build a provider interface. Implement one provider whose API allows a platform integration (TransUnion SmartMove or a comparable service); state in the plan which provider and what credentialing it requires.
* The applicant consents and pays the screening fee directly to the provider or through the PM's Connect account.
* Reports are shown to staff next to the company's written criteria. The human records a pass/fail per criterion. No score and no automated decision — the existing invariant stands.
* Adverse action flow: when an application is denied or conditioned on screening results, generate the FCRA adverse action notice, with the required provider details and dispute rights, and log that it was sent. Mark the template as needing legal review.
* Retention and deletion rules for screening data, configurable per company.

Phase 9: Finish the partial features

* Plaid Link in the browser (external JS file, CSP-allowed), wired to the existing `storeItem()`. Test in the Plaid sandbox end to end.
* Listing syndication: map the generic feed to the specific formats of Zillow Rental Network and Apartments.com/ILS. Add public listing pages per company, with an inquiry form and a showing scheduler.
* Inspections: move-in and move-out checklists by room, with photos and condition ratings, a side-by-side comparison at move-out, a tenant signature, and a link to deposit deductions. Also support periodic inspections scheduled by the compliance engine.
* Security deposit disposition: an itemized deduction letter generated from the move-out inspection, with the jurisdiction's deadline tracked as an obligation.
* Renters insurance tracking with expiry reminders; utility tracking per unit.
* Compliance rules and notice templates: keep the placeholders clearly marked as needing attorney review and blocked from use until approved. Add a per-jurisdiction rule pack structure so a company can pick its state.
* Replace `index.html` (currently a Columbus real-estate agent's site) with a product marketing site: features, transparent pricing, a migration offer, signup, plus legal pages (Terms, Privacy, DPA) as clearly marked drafts.

Phase 10: Launch hardening

* Load test: seed a company with 2,000 units and 5 years of history. Every page must render in under 1s co-located with the database. Fix any N+1 queries.
* Backups: document Supabase point-in-time recovery, and add a tested restore procedure.
* Security pass: dependency audit, CSP review after the JS additions, webhook replay tests, authorization tests on every new route, and file upload checks.
* Accessibility pass (WCAG 2.1 AA) on the portals.
* Update the pre-launch checklist in `server/README.md` and run it.
* Final report: a feature comparison table against AppFolio, Buildium, DoorLoop and Rentvine, listing honestly what is still missing.

Start now with Phase 0: read both READMEs and the code, write `docs/phase-0-plan.md`, and stop for my approval.
