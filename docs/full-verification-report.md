# Full verification — 2026-09-24

Everything was run. Not described, not sampled — run, with the numbers below
taken from the runs themselves.

| | |
|---|---|
| **Tests** | **1,945 passing, 412 suites, 0 failing** |
| **Routes** | **321 of 321 exercised** — 160 GET fetched, 161 POST submitted |
| **Forms** | **137 found, 137 valid** — every action resolves, every one carries CSRF |
| **Crashes** | **0** — nothing returned 5xx, nothing threw |
| **Pages over 1s at 2,000 units** | **1 of 28** |
| **Dependencies** | **0 vulnerabilities** |

**Three real defects were found, and one of them was returning wrong money.**

---

## 1. Every test

```
# tests 1945    # suites 412    # pass 1945    # fail 0    # duration 451s
```

One caveat worth stating because it nearly misled me. An earlier run reported
38 failures and 28 cancelled. That run was **contaminated**: I had probe
scripts running against the same database, which drops and rebuilds its schema
on startup. Those 38 failures were my own collision, not the code. Every
number in this report comes from a run that had the database to itself.

## 2. Every route — `scripts/walk.js`

The suite proves behaviour; it cannot prove that a page renders. A route can
be covered by a unit test and still 500 because a template reads a column the
query stopped selecting.

So the walk builds a fixture containing a row of every kind a route can ask
for — application, lease document, statement, approval, invite, turn, turn
task, inspection, inspection item, listing, delinquency, deposit return,
deduction, journal, API key — resolves each `:id` and `:tok` **by what the
route is actually about**, then fetches all 160 GETs and submits all 161 POSTs
with deliberate rubbish.

| | GET | POST |
|---|---|---|
| 200 | 109 | — |
| 303 | 49 | 142 |
| 403 | 2 | 17 |
| 400 | — | 2 |
| **5xx** | **0** | **0** |

Every non-2xx is correct behaviour, verified individually:

- **17 POST 403s** — public forms (sign-in, apply, pay, report, signup, join,
  consent, enquire) refusing a CSRF token minted on `/app`. That is the
  protection working; a token from one form must not be accepted by another.
- **2 GET 403s** — `/app/platform` refusing an ordinary admin. Walked again as
  a platform operator: both return **200**.
- **2 POST 400s** — `/api/v1/work-orders` and `/api/v1/payments` rejecting an
  empty body. The API validating its input.

**Forms: 137 found, 0 problems.** Every `<form method="post">` points at a
route that exists and carries a `_csrf` field.

**Timing (small fixture): median 2ms, p95 5ms, max 28ms.**

Four routes were not walked, and each is named rather than hidden:

- `/app/sign-out` and `/app/account/sign-out-others` — they end the session
  the walk runs in, so they get a session of their own. Both **303**.
- `/app/platform/c/:id/impersonate` — deliberately not walked. It takes over
  the session, and impersonation is an audited, outward-facing action.
- `/api/v1/payments/:id` — no `tenant_payment` row in the fixture.

## 3. Every page, timed at 2,000 units — `scripts/pagespeed.js`

230,000 journals, 676,000 splits, 110,000 ledger entries. Median of 3 runs.

| ms | page |
|---:|---|
| 1,443 | `/app/reports/aged_receivables` |
| 912 | `/app/reports/balance_sheet` |
| 901 | `/app/reports/profit_and_loss` |
| 386 | `/app/reports/trial_balance` |
| 267 | `/app/reports/trust_reconciliation` |
| 104 | `/app/accounting` |
| 61 | `/app/reports/owner_list` |
| 46 | `/app` |
| ≤ 7 | the remaining 19 pages |

**One page over a second.** `aged_receivables` pulls 228,000 rows — every
movement on tenant receivable over five years — and buckets them in
JavaScript, sorting on disk (12MB external merge). It is not a missing index
and not an N+1; it is the design. 1.4s for that throughput is defensible, and
the fix is to aggregate in SQL, which means rewriting due-date rules that
differ per charge type. **I have not done it.** It is correct, it is the
heaviest analytical report, and rewriting it in the same session as a
correctness fix elsewhere is how a second bug gets shipped.

## 4. Coverage of exported names — `scripts/coverage.js`

612 exported functions. **402 (65.7%) named in a test**; 44 more are route
registrars exercised by the walk, giving **72.9% reached by name or by
request**. 19 are referenced nowhere else and are candidates for deletion.

This is a names count, not line coverage, and it is the honest gap between
"1,945 tests pass" and "every function is tested".

---

# What was found

## A. The owner list was reporting every balance multiplied by the unit count

**The worst of the three, and it was returning wrong money.**

`/app/reports/owner_list` took **15.2 seconds**. The slowness was the symptom.
The query joined `property`, `unit` and `ledger_entry` to `owner` and grouped.
Units and ledger entries are independent branches from the same owner, so the
join produced one row per combination — 51 units × 300 entries = 15,300 rows —
and aggregated over that.

The counts survived, being `COUNT(DISTINCT ...)`. The money did not:

```
Owner 1 Holdings LLC, 51 units
  reported   $171,666,000.00
  actual       $3,366,000.00      (exactly 51x)
```

Forty owners, forty wrong figures, on the report a manager reads to see what
each owner is owed.

It survived ten phases because `makeWorld` builds one property with one unit,
and **one times anything is itself**. Every existing test asserted a number
that was right for the only shape being tested.

Fixed with three scalar subqueries — the pattern the rest of that file already
uses, and `ownerList` was the only function in it joining this way.
**15,214ms → 58ms, forty wrong balances → none.** Three new tests give an owner
four units and three entries, the smallest arrangement in which it is visible.

## B. Two pages taken down by stored JSON of the wrong shape

`lease_document.required` is a text column holding a JSON array, read as
`required.filter(...)` behind a bare try/catch. **try/catch is not enough** —
`JSON.parse` is happy with `1`, `null` and `"tenant"`: all valid JSON, none an
array, the catch never fires, `.filter` is not a function. `/sign/:tok` and
`/app/leases/d/:id` both 500ed.

`/o/s/:tok` did a bare `JSON.parse` of a statement snapshot and read
`t.lines.length`. A statement filed before those list fields existed took the
page down. Its own PDF sibling had guarded this since it was written.

Both check shape now, not just parseability. An owner opening their own link
gets a sentence instead of a stack trace. 13 tests.

## C. `statement_day` described a behaviour that did not exist

On the owner form since Phase 2, stored, displayed — and read by nothing. A
manager setting "Statement day: 15" changed nothing at all.

It now drives a scheduler job that files the finished month's statement.
**It does not send** — generating is repeatable, emailing somebody's finances
is not, and a job that quietly began emailing every owner the day it shipped
is not one to switch on unasked. One line turns it on. 13 tests.

---

## Verified working, not assumed

- Every public form refuses a foreign CSRF token (17 routes)
- The API refuses an unauthenticated caller, and serves an authenticated one
  across all 20 endpoints
- `/app/platform` refuses an admin and serves an operator
- Document integrity: `/sign/:tok` returned 409 on a row whose body hash I had
  hand-made wrong. The tamper check caught my fixture.
- The schema-drop guard refused to run against a database not named `_test`

## Outstanding

1. **`aged_receivables` at 1.4s** — correct, the heaviest report, needs a SQL
   rewrite of per-charge-type due-date rules. Yours to schedule.
2. **19 functions referenced nowhere** — likely dead, listed by
   `scripts/coverage.js`.
3. **166 exported functions named in no test** — most are reached through the
   walk, but they are not asserted about.
4. **Owner statements do not send.** Deliberate. One line when you want it.
