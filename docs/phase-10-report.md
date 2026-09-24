# Phase 10 — launch hardening

**1,896 tests, 400 suites, 0 failing.** 321 routes, every one gated or
deliberately public with a written reason. 0 npm vulnerabilities.

The phase was meant to be the boring one: check the locks, write the runbook,
make the checklist. Two of the checks found real defects, and one of them had
been wrong since Phase 6 in a way no test would ever have caught — which is
the argument for this kind of phase existing.

---

## What was built

### The route audit

`test/routes.test.js` enumerates every route the application registers and
requires each one to be gated by a capability, be under `/portal` or `/api`
where a different gate applies, or appear in a `PUBLIC` / `SIGNED_IN_IS_ENOUGH`
table with a reason longer than twenty characters that is not a placeholder.

**It found no holes.** That is worth saying plainly, because the four holes
this check exists to catch were found in Phase 7a — `/app/company`,
`/app/billing`, `/app/company/access` and `/app/messages` were reachable by
any signed-in account — and the value of the test now is that they cannot come
back. 22 tests, including 14 live HTTP capability refusals.

### Uploads, CSP, and webhook replay

13 tests on upload bypasses, 8 on the content security policy, and webhook
replay coverage added to `test/outbound.test.js`. `@vercel/blob` upgraded
0.27 → 2.8, which closed the two advisories in its bundled `undici` and was
the one open item that needed a breaking upgrade. `npm audit` is clean.

### The load test, at 2,000 units

A seeded portfolio of 2,000 units over five years: 230,000 journals, 676,000
splits, 110,000 ledger entries. Six screens were far too slow and are not any
more.

| | Before | After |
|---|---:|---:|
| Balance sheet | 10,494ms | 474ms |
| Trial balance | 5,092ms | 377ms |
| Trust reconciliation | 1,745ms | 162ms |
| Rent | 726ms | 60ms |
| Accounting | 607ms | 90ms |

Most of it came from migration 046, which copies each journal's date onto its
splits so the reports stop joining back to `journal` to filter. Aged
receivables had a genuine N+1 — 613 queries at 600 tenancies — now within
budget and held there by a query counter that runs in the test.

### Backups, and a drill that proves them

`scripts/restoredrill.sh` dumps a database, restores it into a separate one,
and asks whether what came back is **sound** rather than merely present.
`server/lib/verify.js` answers that: every journal balances, the trial balance
nets to zero per company, every ledger entry has a journal behind it, every
split's date matches its journal's, owner funds agree with the owners' own
ledgers, nothing references a row that is gone, and — with `--files` — every
uploaded file the database names is readable.

Two design decisions worth recording.

**It compares rather than just checking.** The drill verifies the source
first and fails only on problems the restore *introduced*. A backup's job is
to bring back what was there, problems included; a drill that failed every run
because of a pre-existing bookkeeping backlog is a drill nobody reads after
the first month. Pre-existing findings are printed anyway, and a problem
present in the source but absent from the copy fails it too — that means the
two disagree and the copy is the one that changed.

**It says what it did not prove.** It does not prove Supabase's
point-in-time recovery works; it proves `pg_dump` and `pg_restore` round-trip
this schema. And it does not cover the blob store unless asked.

`test/verify.test.js` shows the verification each kind of damage in turn and
requires it to find it — disabling triggers to inject what the application
itself refuses to do. A verification that has never failed is not yet known to
detect anything.

**Drilled at volume:** the 2,000-unit portfolio, 32MB dump, 26 seconds end to
end, row counts matching, no new problems.

### Accessibility

`test/accessibility.test.js` fetches the pages the application actually serves
— signed in, through the router, following redirects the way a browser does.
The staff page list comes from `NAV` itself, so a page added to the sidebar is
covered the day it appears.

Three real defects, all fixed without changing a pixel:

- `/app/setup` had three inputs carrying only a placeholder, which is not a
  label: it disappears on focus and is announced inconsistently, so a screen
  reader reads "edit text, blank". The two in the owners table now name their
  row — "Approval threshold for Dana Reyes" — because a screen reader reads
  the control, not the row around it.
- The portal and public pages had no `main` landmark, which is what "skip to
  content" skips to. Fixed with `role="main"` on the container already there,
  because `.pub > p.lede` is a direct-child selector and a `<main>` wrapper
  would have restyled the lede on every portal page.
- `/app/listings` had a two-row label/value table announced as tabular data;
  it is `role="presentation"` now.

This does not claim WCAG conformance. It checks a specific list. Conformance
is a judgement a person makes with a real screen reader.

### Colour contrast

`test/contrast.test.js` computes WCAG 2.1 ratios from the stylesheets, with
the sRGB linearisation the naive version omits — the step whose absence
flatters exactly the mid-tone greys this palette uses.

**Everything WCAG governs now passes.** Fifteen pairs, including every
control boundary. Two entries remain in the accepted table and both are
decorative borders that 1.4.11 exempts.

Two palette changes got it there, both at your direction.

`--ink-soft` was 4.49:1 on white against a 4.5 requirement — missing by a
hundredth, at the 12px size where it matters most. It is `#6a7079` now: 4.99:1
on white, 4.54:1 on the page background.

The borders needed splitting rather than darkening. `--hairline` was doing two
jobs at 1.22:1 — the outline that tells you where a field is, which 1.4.11
requires to reach 3:1, and the panel edges and table row rules it does not
govern at all. A single darkened token would have made the fields findable at
the cost of putting a heavy grey line between every row of every table, in an
application that is mostly dense tables of money. So there is now a
`--control-edge` at `#858c9a` — 3.38:1 on white, 3.07:1 on the page
background — carried by the ten places that are genuinely controls: the field,
select, textarea and radio-tile rules, the outline arrow button, and six
inline borders in the setup, turns and applications screens. `--hairline`
stays where it was, decorative.

Verified in the browser rather than asserted: signed in, the rendered input
border computes to `rgb(133,140,154)` and the panel border to
`rgb(230,232,236)`, and a screenshot of the trial balance shows the date
fields outlined and the row rules unchanged.

A third entry disappeared on inspection. `--ghost` was listed as a disabled
control's edge; it is nothing of the sort, and the only two rules that use it
— `.gword` and `.cdots` — appear in no markup this application serves.

---

## The defect this phase existed to find

`clients_vs_subledger` — the trust reconciliation leg that asks whether owner
funds held agree with the statements each owner is shown — **was wrong for
every company holding a security deposit**, and had been since Phase 6.

The comparison is `2200 + 2300` against the sum of each owner's ledger
entries. The control-account side was corrected once already: `2100` was split
out so tenant deposits stopped being measured against the owners' ledgers. The
subsidiary-ledger side went on summing *every* entry an owner had, which let
the deposits straight back in through the other door.

A deposit writes an owner ledger entry on purpose — the owner should see that
money arrived in the trust account their funds sit in — but it credits `2100`,
the tenant's liability, and never touches `2200`. So every deposit taken
through the ordinary path pushed the leg out by exactly the deposit. Rent
charged and the `other` kinds did the same.

It survived ten phases because the fixtures post rent and little else. The
load portfolio posted two thousand deposits, and the verification at the end
of the restore drill read the result as a control account disagreeing with its
own subsidiary ledger by **$2,399,550**.

The set of kinds that belongs in that total is now derived from the postings
table itself rather than kept by hand in the report — the hand-kept version is
what drifted. Established by measurement, not reasoning: posting one of each
kind with the sign convention the real callers use shows `rent_payment`,
`expense` and `management_fee` agreeing with the accounts, and `rent_charge`,
`deposit_held`, `deposit_returned` and `other` moving them by nothing.

The 2,000-unit database verifies clean after the change.

**Why this matters more than the number.** This is the report a manager hands
to a state auditor. A trust reconciliation that reports a variance where none
exists trains its reader to ignore it, and the month it reports a real one it
will be ignored too.

---

## How this compares to what it competes with

Researched rather than recalled, September 2026. Published pricing varies
between third-party sources and none of these vendors publish a complete
public rate card, so treat the figures as indicative.

| | Entry price | Monthly minimum | API |
|---|---|---|---|
| **AppFolio** | ~$1.40/unit | **$280** ($900 for Plus), 50-unit minimum | One-way export; rent payments, screening and renters insurance excluded from the integration programme |
| **Buildium** | from $62/mo | ~$62 | Available on higher tiers |
| **DoorLoop** | $69–$209/mo | none | Included |
| **Rentvine** | ~$1.50/unit | ~$199 | Bidirectional, included on every account |
| **this** | — | — | Bidirectional, included; full portable export |

**Where this project is genuinely different.**

*The platform never holds client or tenant money.* It is an agency model: the
manager is never custodian. Most of the market is built the other way.

*No automated applicant scoring, at all.* This is an invariant enforced by a
test that fails if a score column appears anywhere in the schema — and it did
fail, in this project, when migration 042 added five of them to
`adverse_action` for what seemed like good reasons. Migration 043 dropped
them. The grounding is *Louis v. SafeRent Solutions*: a $2.275M settlement
approved in November 2024 over a screening algorithm that scored Black and
Hispanic voucher holders lower by not counting the voucher — which pays, on
average, over 73% of the rent. The court held a screening company subject to
the Fair Housing Act and answerable for disparate impact. A scoring feature is
a liability this product declines to build.

*Portable export.* Every table has an explicit decision — exported, or skipped
with a written reason — and the export round-trips through the importer. The
industry's lock-in is the export you cannot get; this one is a supported path
out.

*Delivery honesty.* The UI never claims a message was sent unless the provider
accepted it.

**Where it is behind.** No mobile apps. No integration marketplace. One
syndication format (MITS 4.1, which both Zillow and Apartments.com read, but
the relationships are unbuilt). No live payment processing yet. Screening is
manual by design and by your decision, which is slower than the competition
and is the point.

---

## What I could not verify

- **Supabase point-in-time recovery.** The drill round-trips `pg_dump` and
  `pg_restore`. Supabase's restore is a different mechanism and has to be
  drilled against Supabase.
- **The blob store has no backup at all.** Every uploaded photograph, receipt
  and signed document has exactly one copy. `verify.js --files` will tell you
  when one goes missing; nothing will bring it back.
- **The Vercel deployment still runs old code.** Diagnosed in Phase 4, never
  fixed. Everything in this report is about the code in this repository.
- **`verify.js --files` has never run against production.** It is tested
  against a local upload directory, including a path traversal attempt, but
  the Vercel Blob branch is exercised only by unit tests.
- Nothing has been tested with a real screen reader.

---

## Decisions waiting on you

**Blocking a launch** — the full list is the checklist in `server/README.md`,
which was run on 2026-09-24 with results recorded. The security items are the
overdue ones: rotate the Supabase service-role key and the database password
(both were pasted into a chat log), enforce SSL, load the CA certificate.

**OPEN-ITEMS A4** — $8,435.00 of deposits recorded on leases and in no
account. `npm run deposits:plan` shows what would post. It is your call; it
posts journals against your books.

**The palette is done.** Both changes were yours to call and you called them:
`--ink-soft` to `#6a7079`, and the border split that put a `--control-edge` at
`#858c9a` on the things 1.4.11 actually governs while leaving the decorative
hairline alone.

Nothing WCAG requires is outstanding. The two entries left in the accepted
table are the panel edge and the table row rule, both exempt, both kept light
deliberately — and the test still fails if either gets worse.

---

## Sources

- [DoorLoop vs the field: pricing, features, data access](https://www.propertymanagerwebsites.com/blog/doorloop-vs-the-field-pricing-features-data-access)
- [Property Management Software Pricing Comparison, RenPro](https://renpro.com/property-management-software-pricing-comparison/)
- [Is AppFolio's API actually open?, Rentvine](https://www.rentvine.com/blog/appfolio-api-restrictions)
- [Rentvine Open API](https://www.rentvine.com/open-api)
- [Louis v. SafeRent Solutions, NCLC](https://www.nclc.org/resources/louis-v-saferent-solutions-llc/)
- [$2.28M Settlement Against SafeRent, Cohen Milstein](https://www.cohenmilstein.com/rental-applicants-reach-2-28m-settlement-agreement-for-discriminatory-ai-powered-screening-tool/)
