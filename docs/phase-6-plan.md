# Phase 6 — Reporting and exports

Plan. Per the roadmap's process rule, nothing is written until you approve it.

**This plan opens with something I found while reading, not with reports.** The
books do not currently say what you would want a report to say, and building
twelve reports on top of them would produce twelve confident wrong numbers.

---

## What I found

I read the accounting layer first, because every report in this phase either
ties out to the journal or does not. Then I re-seeded and looked at the trial
balance the seeded company actually produces:

| Account | | Balance |
|---|---|---|
| 1010 | Trust cash — client funds | **$13,436.50** |
| 1300 | Tenant receivable | **−$13,710.00** |
| 2200 | Owner funds held | **−$759.15** |
| 4200 | Management fee income | $759.15 |
| 5000 | Repairs and maintenance | $273.50 |
| 4000 | Rent income | **absent — never posted** |

Debits equal credits. The database enforces that and it is doing its job. The
book balances and it is not true.

Three things are wrong, and they are two defects with one cause.

### Rent is received but never charged

`4000 Rent income` is credited by exactly one posting rule — `rent_charge` —
and nothing in the application ever invokes it. The only way to reach it is a
manual dropdown on the owner ledger screen. So:

- **Rent income is never recognised.** The largest income line in a property
  business is zero on the company's P&L.
- **`1300 Tenant receivable` accumulates credits with no debits**, because
  `rent_payment` credits the receivable to clear a charge that was never made.
  An asset account sitting at minus thirteen thousand dollars.

### An owner's repair is booked as the manager's expense

A repair paid on an owner's behalf posts `Dr 5000 Repairs / Cr 1010 Trust
cash`. That takes the money out of trust correctly and then records it as a
cost of *your* business. It is the owner's cost. The effect is that
`2200 Owner funds held` is never reduced by it, and your own P&L carries
repair costs you did not bear.

### They reconcile exactly

The owner-visible ledger says owners are owed **$12,677.35**. The book says you
hold $13,436.50 in trust and owe owners **minus $759.15**. Both cannot be true,
and the gap is not mysterious:

```
  missing rent charges                    +$13,710.00
  owner repair misposted to your P&L         −$273.50
  management fee (correctly taken)           −$759.15
                                         ─────────────
  what 2200 should read                   $12,677.35   = the owner ledger
```

The owner ledger is right. The journal is wrong by precisely those two
postings. `parity()` did not catch it because it asks whether every ledger entry
*has* a journal, not whether the two agree about anything.

**A three-way trust reconciliation — which this phase is meant to build — is
exactly the report that would have caught this.** It is worth saying plainly
that this went unnoticed through three phases of accounting work, mine
included.

### And a third, smaller one

`deposit_held` and `deposit_returned` posting rules exist and nothing calls
them either. `lease.deposit_cents` holds an amount; `2100 Tenant deposits held`
has never been posted to. A "security deposits held" report would read zero
from the books and a real number from the lease. Same class of defect: a field
recorded, never posted.

---

## The decision I need from you

**How should rent and owner costs be recorded?** This is not a detail I should
settle on your behalf — it decides what a P&L *means* in your product, and it
is very expensive to change after customers have data.

### Option A — receipt basis (smaller change)

Rent received credits owner funds directly. No tenant receivable on your book,
no rent income on your P&L.

```
  rent received       Dr 1010 Trust cash      Cr 2200 Owner funds held
  management fee      Dr 2200                 Cr 4200 Mgmt fee income
  owner repair        Dr 2200                 Cr 1010 Trust cash
  distribution        Dr 2200                 Cr 1010 Trust cash
```

Your P&L shows fee income and your own costs — which is what an agent's P&L
should show. `1300` and `4000` retire.

**Cost:** AR aging is computed from leases and payments rather than from posted
charges, so it cannot tie to the balance sheet, and the report has to say so.
Partial payments, mid-month move-ins and prorations get harder to age
correctly.

### Option B — accrual with posted charges (what the competition does)

Rent is charged on a schedule, per lease per period, and the charge is a real
journal.

**Corrected after you asked about the balance sheets.** My first version of this
had the charge credit `2200 Owner funds held`. That is wrong, and wrong in a way
that would have been permanent: `1300` is a **non-trust** asset and `2200` is a
**trust** liability, so every unpaid charge would push trust liabilities above
trust assets and the three-way reconciliation would fail by exactly the arrears,
every day, by design.

The real point underneath it: **you do not owe an owner money you have not
collected.** Charging rent creates a claim on a tenant, not an obligation to an
owner. So the charge lands on a new non-trust liability, and only receipt moves
it into trust:

```
  rent charged     Dr 1300 Tenant receivable      Cr 2400 Rent due to owners
                      (asset, non-trust)             (liability, non-trust)

  rent received    Dr 1010 Trust cash             Cr 1300 Tenant receivable
                   Dr 2400 Rent due to owners     Cr 2200 Owner funds held
                                                     (trust liability)

  management fee   Dr 2200                        Cr 4200
  owner repair     Dr 2200                        Cr 1010
```

Receipt is one four-split journal, balanced on both sides, so the two halves
can never come apart. `2400` is a new account and the code is free.

The effect is that the trust reconciliation covers only money that actually
exists — trust cash and payments in transit against deposits, owner funds and
prepaid rent — and arrears live outside it, which is where they belong.

**Gains:** tenants have a real running balance, late fees attach to a charge
rather than to a computed expectation, and AR aging is a balance-sheet number
that ties out. This is what AppFolio and Buildium do, and it is what an
accountant reviewing your books will expect.

**Cost:** a new scheduled job that must be idempotent and must handle
proration, mid-period move-ins and move-outs, and write-offs. More moving
parts, and the parts are the ones that generate support tickets.

### One balance sheet, with client funds restricted inside it

An earlier draft of this plan proposed two balance sheets, a trust one and a
company one. That was wrong and you were right to question it.

A balance sheet covers one reporting entity. You are the account holder at the
bank, so trust cash is genuinely your asset with an exactly offsetting
liability to your clients — it belongs **on** your balance sheet, not beside
it. Splitting it in two would mean publishing a statement of a legal entity
that does not exist.

What regulators actually require separately is not a second balance sheet; it
is the **trust reconciliation**, which is already its own report in your
roadmap and is a different kind of statement altogether — it proves that three
independent records agree, rather than that assets equal liabilities.

So: one balance sheet, with a clearly marked restricted section.

```
  ASSETS
    Unrestricted
      1000  Operating cash                     your money
    Restricted — client funds
      1010  Trust cash
      1020  Payments in transit
    Receivable
      1300  Tenant receivable                  owed by tenants

  LIABILITIES
    Restricted — owed to clients
      2100  Tenant deposits held
      2200  Owner funds held
      2300  Prepaid rent
    Company
      2000  Accounts payable
      2400  Rent due to owners (uncollected)

  EQUITY
      3000  Retained earnings
```

The restricted lines net to the fee float — money that is yours but still
sitting in the trust account waiting to be swept. On your seeded data that is
**$759.15**, and being able to name that number is the whole point of
segregating rather than splitting.

**My recommendation: Option B, one balance sheet, and the correcting journal.**
Your roadmap lists AR aging as a first-class report and makes "the P&L and
balance sheet must tie out to the trial balance" the phase's test. Under
Option A that test passes while AR aging sits outside the books entirely.

### And what to do about the data already there

**The correcting journal's date is not one decision. It is one decision per
tenant, and the platform cannot currently tell them apart.**

Backdating to the original postings makes history correct — and silently
rewrites a month that a manager may have already closed, filed a trust
reconciliation for, sent owner statements against, or issued 1099s from. In
most US states a property manager holding client funds must reconcile the trust
account monthly and retain it for years. Backdating into a retained
reconciliation does not fix it; it makes a document that was signed as true
retroactively false.

Dating everything today never corrupts a closed period — and leaves every
historical report wrong for a company that has closed nothing and would much
rather have correct history.

Both answers are right for some tenants and wrong for others. On a platform
serving property managers across fifty states, picking one is picking wrong for
most of them.

#### What the platform is missing

**A close date.** Every accounting system has one — QuickBooks calls it a
closing date, Xero calls it a lock date, NetSuite closes periods. It is the
line before which the books are finished, and nothing may post behind it
without deliberate authority.

This application has no such concept. Any journal can be posted with any date,
forever. That is a gap worth closing regardless of this correction, and it is
far cheaper now than once tenants have years of data.

    company.books_closed_through   a date, nullable — null means never closed

Enforced in `postJournal()`, which is already the only writer. A post dated on
or before that line is refused with a message naming the date, and reopening a
period is an explicit, audited act rather than a field somebody edits.

#### Then the correction answers itself

    correction date = the later of:
      the date of the posting being corrected
      the day after books_closed_through

Which gives, per tenant, without anybody guessing:

| The tenant's state | What happens |
|---|---|
| Never closed a period | Corrections land on the original dates. History becomes correct. |
| Closed through last quarter | Corrections land in the current open period, with a memo naming the period they belong to. |
| Closed through last year | Same, and the prior year is left exactly as it was filed. |

**This is your situation too:** your live company has never closed a period,
because the concept does not exist yet. So your correction backdates and your
history comes out right. The machinery is for the tenants who come after.

#### How the correction is applied

Following `convert.js`, which did exactly this once in Phase 3 and is the right
precedent: **it reports unless told to commit.**

- **A dry run per company**, showing the trial balance before and after and
  every journal that would be written. Nothing is committed from a migration.
- **An open period is corrected properly** — the wrong journal is reversed and
  the right one posted. `reverseJournal` already exists, the original stays
  visible, and the pair nets to nothing, which is what an auditor expects.
- **A closed period gets one adjusting journal** in the earliest open period,
  carrying a memo that names the period the error belongs to.
- **A record per company** of what was done, so "why does this journal exist"
  has an answer in the product rather than in a commit message.

#### And one thing the reconciliation needs because of this

If a period can be closed, the trust reconciliation for that period has to be
**snapshottable** — stored as it read on the day it was signed, the same way
`owner_statement.totals` is snapshotted so a sent statement never changes. That
is what a regulator asks to see, and recomputing it later from current data
answers a different question than the one being asked.

That is a small table and it reuses a pattern already in the codebase.

---

## What the phase builds, once that is settled

### The reports

| | Ties to the books? |
|---|---|
| Rent roll, as of a date | subledger |
| Delinquency / AR aging | Option B: yes. Option A: no, and it says so |
| P&L — company, and by property / owner / portfolio / period | yes |
| Balance sheet — one, with client funds restricted inside it | yes |
| Cash flow | yes |
| General ledger detail | yes, it *is* the book |
| **Three-way trust reconciliation** — bank, book, tenant/owner ledgers | the point of it |
| Vacancy and days vacant | subledger |
| Work order spend by vendor and category | yes |
| Lease expirations | subledger |
| Security deposits held | only once deposits are posted |
| 1099 summary | exists; becomes exportable |

**Every dimensional report carries an explicit `Unallocated` row.** Some splits
legitimately carry no property — a bank charge belongs to no owner, and a
vendor invoice with no work order has no unit. A P&L by property that silently
drops those rows is worse than one that shows them, because the total stops
agreeing with the trial balance and nobody can tell why.

**Days vacant is derived and will say so.** There is no unit status history; the
best available answer is the last lease's move-out date. A unit that has never
been leased has no date, and will read "never leased" rather than a number I
invented.

### Exports

- **Every report as CSV and PDF**, and **every table in the app as CSV**. One
  export module, one escaping function. `checks.js` already has a private
  `csvCell` and a `printable()` that handles the non-WinAnsi problem that once
  killed a cheque run — both get extracted rather than re-written.
- **Owner statements as branded PDFs.** The statement already exists as HTML on
  a tokenised link and is snapshotted into `owner_statement.totals` so a sent
  statement never changes. The PDF renders that snapshot, not a fresh query —
  otherwise the PDF and the link an owner already has could disagree.
- `company.logo_path`, `legal_name`, `address` and `website` already exist, so
  "branded" has real fields behind it.

### Saved reports and scheduled delivery

A saved report is a name, a report key and a filter set. Scheduled delivery
goes through the existing `outbox` and scheduler, which means it inherits
delivery honesty: a report is marked sent when the provider accepted it and
not before.

**[default] A scheduled report to an owner sends a link, not an attachment.**
An emailed PDF of somebody's finances sits in an inbox forever and gets
forwarded. A tokenised link can be revoked, and we already have that machinery.
If you want attachments, say so and I will add them as an explicit choice.

---

## Files

**New**

    server/lib/reports/index.js       the report registry — key, params, runner
    server/lib/reports/financial.js   P&L, balance sheet, cash flow, GL detail
    server/lib/reports/operational.js rent roll, aging, vacancy, expirations
    server/lib/reports/trust.js       the three-way reconciliation
    server/lib/csv.js                 one escaping function, extracted
    server/lib/pdf/report.js          table-to-PDF, branded header
    server/features/reports.js        the screens
    server/migrations/034_*.sql       saved reports, scheduled deliveries,
                                      the split index the reports need
    test/reports.test.js
    test/trustrecon.test.js
    test/exports.test.js

**Changed** — depends entirely on which option you pick. Under B:
`server/lib/ledger.js` (postings), `server/lib/scheduler.js` (the charge run),
`server/features/vendors.js` and `server/lib/payments.js` (expense routing),
plus a one-off correcting journal.

---

## Migrations

    034_close.sql     books_closed_through, the audited reopen, and the
                      trust reconciliation snapshot
    035_reports.sql   saved_report, report_schedule, the 2400 account, and
                      an index on journal_split (property_id) — there is one
                      on owner_id and none on property, and a P&L by
                      property scans without it

---

## What will and will not be verified

**Verified:** that the P&L and balance sheet tie out to the trial balance, on
seeded data, as an assertion rather than a claim; that the three-way trust
reconciliation balances — and that it *fails loudly* on today's books, which is
the test that proves it works; that every CSV round-trips through a parser;
that a PDF opens and contains the numbers the HTML does; that a report with a
non-WinAnsi name in it does not kill the run.

**Not verified without you:** whether the numbers are the ones your accountant
expects to see. I can make the books internally consistent and prove it. I
cannot tell you that your state's trust accounting rules are satisfied, and I
will not imply that I can.

---

## Risks

**This phase changes accounting.** Not the reports — the postings underneath
them. That is a bigger change than "reporting and exports" sounds like, and it
is the reason this plan leads with a decision rather than a file list. If you
would rather I build the reports against the books as they stand and fix the
postings in a later phase, say so — I will do it, and every financial report
will carry a line saying what it does not include.

**Reports are where performance stops being free.** Every screen so far reads
tens of rows. A GL detail report over a year reads all of them. I will keep the
queries indexed and paged, and I will say in the report which ones I actually
timed rather than which ones I expect to be fine.
