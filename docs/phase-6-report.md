# Phase 6 — Reporting and exports. What was built, and what it found.

Nineteen commits, `0160989` to `667d835`. Fourteen test files added; **1278
green**, from 1074 at the end of Phase 5.

**This phase changed accounting, not only reporting.** That was not the plan's
intention and it is the most important thing in this report. Reading the books
before building anything on them turned up defects that would have made every
financial report confidently wrong, and roughly half the work went into the
postings rather than the reports.

---

## What the books said before

The seeded company's trial balance, at the start of the phase:

| | | |
|---|---|---|
| 1010 | Trust cash | $13,436.50 |
| 1300 | Tenant receivable | **−$13,710.00** |
| 2200 | Owner funds held | **−$759.15** |
| 4000 | Rent income | **absent — never posted** |

Debits equalled credits. The database enforces that and it was doing its job.
The book balanced and it was not true.

**Rent was received and never charged.** `4000 Rent income` was credited by
exactly one posting rule that nothing in the application ever invoked, so the
largest income line in a property business was zero, and `1300` accumulated
credits clearing charges that were never made.

**An owner's repair was booked as the manager's expense.** It debited `5000
Repairs`, so your P&L carried costs you never bore and owner funds were never
reduced by money that had genuinely left them.

**Deposits were recorded on leases and posted nowhere.** $8,435.00 across seven
leases — other people's money the books did not know existed. Found by the
reconciliation, not by reading.

**A repair could be booked twice.** `vendor_invoice.work_order_id` links a bill
to a job whose close-out records a cost independently. Nothing stopped a
manager doing both, and no seeded row ever had — so it had never been seen. It
would have surfaced as inflated expenses on the first P&L by property, against
an owner charged twice for one repair.

`parity()` caught none of it, because it asks whether every ledger entry *has*
a journal, not whether the two agree about anything.

## What they say now

    1010 Trust cash        $13,436.50
    1300 Tenant receivable  $7,129.67
    2200 Owner funds held  $12,677.35
    2400 Rent due            $7,129.67
    4200 Fee income            $759.15
    5000 Repairs                  gone

Clients equals the subsidiary ledger to the cent. Book exceeds clients by
$759.15 — the management fee earned and not yet swept out of trust, which is a
real and explainable variance and exactly what the plan predicted.

---

## The decisions, and why

**Rent is charged per lease per period**, posted on the first day of the period
with the due date derived from the lease's own rent day. It cannot charge twice
because a partial unique index will not have it — not because the job checks
first, which two overlapping ticks would both pass.

**A charge credits `2400`, not `2200`.** You do not owe an owner money you have
not collected. Crediting the trust liability would have made the three-way
reconciliation read every unpaid charge as a trust shortfall — the finding a
regulator looks for — permanently, against a company that had done nothing
wrong.

**Proration defaults to daily on the actual length of the month**, with
thirtieths and full-month available per company. A full period is never
prorated: on a 31-day month the thirtieths basis would charge 103% of the rent.

**A tenant paying ahead is held as prepaid rent** and the next charge draws it
down. Crediting owner funds instead would say the owner is owed rent for a
month nobody has billed, and credit them twice when the charge lands.

**The contractor's invoice is the truth when there is one.** Closing a job
already billed records the figure and posts nothing, and says so on screen.
An invoice arriving after a close-out supersedes it — reversed, not edited,
with the owner's ledger mirrored so the two books cannot drift.

**Books can be closed.** `books_closed_through`, null by default, enforced in
both journal writers — `reverseJournal` inserts directly and a guard in one
place would have let a back-dated reversal through. Closing is refused while
the trust account does not reconcile; it can be forced, and that is recorded as
an exception rather than as a close.

**Aging runs from the due date and grace is a flag.** Rent is billed in
advance, so aging from the charge date would put every tenant a day overdue on
the day their rent falls due. Grace is a fee-waiver window, not a change to
when money is owed — so the accounting view stays correct and the operational
view is one column away.

**One balance sheet**, with client money marked restricted inside it. You are
the account holder at the bank, so trust cash is your asset with an offsetting
liability. A second statement would be one of a legal entity that does not
exist. What regulators want separately is the reconciliation, which is its own
report.

**Scheduled reports send a link, never a file.** An emailed PDF of somebody's
finances sits in an inbox for ever and gets forwarded. A schedule stores a
period *rule*, never dates — one holding January would email January's figures
every month for ever and nobody would notice the numbers had stopped changing.

---

## What was built

**Twenty-one reports**, all of which run, export to CSV and PDF, and can be
saved and scheduled:

| Group | |
|---|---|
| Financial (7) | trial balance, P&L, P&L by property, balance sheet, cash movement, general ledger detail, trust reconciliation |
| Rent (1) | aged receivables |
| Portfolio (5) | rent roll, vacancy, lease expirations, deposits held, repair spend |
| Lists (7) | owners, properties and units, work orders, contractors, payments out, bank lines, lease documents |
| Tax (1) | 1099 summary |

Plus: the correction runner, the close/reopen machinery, saved views,
schedules, and owner statements as branded PDFs.

---

## How it was verified

**The roadmap's test for this phase** — that the P&L and balance sheet tie out
to the trial balance — is asserted against books built inside the test rather
than against whatever the application produces, because a report agreeing with
the application only proves both were written by the same person on the same
afternoon. The figures are also checked against the numbers the test book was
written from: a tie-out between two things that are both wrong is still a
tie-out.

**The trust reconciliation was built first**, deliberately, so the correction
had something independent that could say whether it worked. Its tests build
both a broken book and a sound one by hand.

**Every report is covered by loops rather than one test each.** The failure
being guarded against is not one report being wrong; it is the nineteenth being
added next month with a capability nobody checks, a column with no label, or a
totals row keyed to columns that no longer exist. When the four list reports
were added, the loops covered them the moment they landed.

**Rendered and looked at.** The reports index, a report page, the saved screen,
a 140-row PDF and a real August statement were each rendered in a browser and
inspected. Four bugs were only visible that way: column headings printing on
top of the subtitle, a filename with a double hyphen in it, a download button
that rendered nowhere, and a PDF that failed on an owner called Đurađ.

---

## What could not be verified

**That the figures are the ones your accountant expects.** The books are
internally consistent and that is proved. Whether your state's trust accounting
rules are satisfied is not something I can tell you, and I will not imply
otherwise.

**Performance at scale.** A general ledger over a year reads every split. The
queries are indexed — `journal_split(property_id)` was added because a P&L by
property scanned without it — and the GL report pages and says when it has
truncated. Nothing here has been run against a company with years of data, and
I have not timed any of it.

**Scheduled delivery end to end.** The outbox rows are queued and asserted; the
email arriving depends on the provider being configured, which is OPEN-ITEMS
M1–M2.

---

## Being straight about "every table"

The roadmap asks that every table in the application can be exported as CSV.
What is true is narrower than that sentence, so here is the actual state.

**Has an export**, via the report of the same data: rent roll, aged
receivables, trial balance, general ledger, trust position, deposits, 1099,
repair spend, owners, properties and units, work orders, contractors.

Payout runs, bank reconciliation and lease documents were added after the
first draft of this report named them as the gap.

**Has no export**: the queue, the inbox and its templates, messages (sent and
dead letters), lease templates, listings, staff, company settings, billing, and
platform administration.

Those are not tables of records and mostly never will be — the queue is a list
of things to do, the inbox is a conversation, and staff and settings are a
handful of rows on a screen somebody is already looking at.

---

## What you need to supply

| | |
|---|---|
| 1 | **Run `npm run correct:plan` against the live database and read it**, then `npm run correct:commit`. It reports unless told to commit. Your company has never closed a period, so corrections will land on the original dates and your history comes out right. |
| 2 | **Post the deposits**, or tell me to. $8,435.00 sits on seven leases and in no account. It is somebody else's money and the books do not know it exists. I did not post it because a deposit journal asserts a date and an amount that nobody recorded at the time. |
| 3 | **Decide what to do with `4000 Rent income` and `5000 Repairs`** (OPEN-ITEMS A2, A3). Under agency neither carries owner-borne amounts any more. Leaving accounts nobody posts to is a trap for whoever reads the chart next. |
| 4 | **Decide whether to close periods**, and from when. Nothing is closed on anybody's behalf. It is worth doing once the correction has run. |
| 5 | **Check one scheduled report actually arrives**, once a delivery provider is configured. |

---

## What I would do next

A1's sibling is now settled. A job with a contractor assigned says, before
anybody types a figure, that the bill will replace it; a job already billed
says the figure will be recorded and not posted; and when an invoice does
supersede a close-out, the job's own history records what was entered and what
was billed. Being told afterwards reads as the application losing your work.
Being told at the time reads as it knowing what it is doing.
