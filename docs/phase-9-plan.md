# Phase 9 — Finish the partial features

Plan. **Approved, with Plaid Link deferred and the deduction posting settled.**

Two decisions were put to you and answered:

- **Plaid Link is not in this phase.** Deferred to the end, with the other
  third-party connections, so the CSP exception and the sandbox credentials
  are dealt with together rather than one at a time.
- **A deduction credits the owner.** `Dr 2100 Deposits held / Cr 2200 Owner
  funds held` — the owner bore the repair cost, so the deduction reimburses
  them. Not management income.

Three items on the roadmap, and the order below is not the order they are
written in — see the finding.

    Listing syndication to Zillow and Apartments.com, plus public listing pages
    Inspections: move-in and move-out, with a link to deposit deductions
    Plaid Link in the browser  — deferred

---

## The finding: deposit deductions do not exist

The inspections item ends "and a link to deposit deductions". I went looking
for what it would link to.

`deposit_held` and `deposit_returned` are both in the posting table in
`ledger.js`, and **nothing in this application has ever posted either of
them.** There is no screen that takes a deposit, no screen that returns one,
and no way to record a deduction. The compliance engine has a
`deposit_return` rule that counts forward from the move-out date and warns
that missing the window usually carries a statutory penalty — and there is
nothing for it to be a deadline *for*.

This is the same shape as the Phase 6 finding about rent charging: a posting
rule that looks complete, that nothing ever invokes. It is also why the Phase
6 report has `$8,435.00 of deposits recorded on leases and posted nowhere`
sitting in OPEN-ITEMS waiting on your decision — the money is on the leases
and the books have never known about it.

**So inspections cannot be the third item; deposits have to be the first.**
An inspection that produces a list of damage with no way to charge for it is a
checklist app. The order below reflects that.

---

## 1. The deposit ledger

Where the money actually is, and what happens to it.

**Taking one.** A deposit posts `Dr 1010 Trust cash / Cr 2100 Deposits held`
through `postMoney`, the same as everything else. Today `lease.deposit_cents`
is a number on a row that the books do not know about, and the trust
reconciliation reports exactly that as a variance — correctly, and every month.

**Returning one.** A move-out opens a return with the statutory clock the
compliance rule already knows. Against it:

- **deductions**, each with a reason, an amount, and — this is the part
  inspections feeds — a link to the evidence.
- **the balance**, returned to the tenant.

**Posting, settled with you before a line of it was written:** `Dr 2100` for
the whole deposit, `Cr 1010` for what is paid back, and every deduction
crediting `2200 Owner funds held`. A deduction for damage is not the manager's
income — it reimburses whoever paid to fix it, which is the owner. Getting that
wrong is the Phase 6 mistake again, an owner's money landing on the manager's
books, and it is the kind of mistake that is invisible for months.

**The itemised statement.** Most states require the tenant to be given a
written itemisation within the deadline, and several require it whether or not
anything was deducted. It renders through the same notice machinery as every
other notice, which means the same rule holds: **an unapproved template is
never sent.**

**What this fixes as a side effect:** the trust reconciliation's
`deposits_vs_leases` variance stops being permanent, and your $8,435 becomes a
one-off conversion rather than a standing question.

## 2. Inspections

Now they have somewhere to go.

Move-in and move-out checklists **by room**, each item carrying a condition
and a note, with photographs. At move-out the two are shown **side by side**,
because the question is never "what is the condition" but "what changed", and
a screen that shows one without the other is asking somebody to remember.

The tenant signs the move-in one — the same frozen-document-and-hash shape as
a lease signature and a screening consent, because it is the same kind of
record and it is the one a deposit dispute turns on.

A move-out item marked as changed can become a deduction, carrying its
photographs with it. That is the link the roadmap asks for, and it only means
anything because item 1 exists.

**One thing to decide now rather than later:** a condition rating is a number
on a thing, not a number on a person, so it does not touch the
no-automated-scoring rule. But the test that guards that rule sweeps the whole
schema for anything score-shaped and will fail on it — deliberately, so the
decision gets made out loud. The plan is to add it to that test's allow-list
with the reason written down, the way `routing_rule.rank` is.

## 3. Listing syndication

The good news first: **both networks take the same format.** Apartments.com's
feed programme is MITS-based, and Zillow accepts MITS alongside its own guide.
MITS is a published XML standard from RETTC with public sample documents.

So the work is to emit correct MITS rather than to write two bespoke dialects
and watch them drift. `feedRows()` and the escaping already exist; what is
missing is the envelope, the property/unit nesting the standard specifies, and
the fields each network requires on top.

**What neither of us can shortcut:** Zillow requires you to submit an
integration request and be approved by their Rentals Integrations team
*before* a feed is worth building, and their feed testing process takes four
to six weeks. Apartments.com wants the XML by FTP or URL and will send their
own guide on request. Both are free. Neither will look at a feed from a
platform that has not asked.

So this half ships as: a MITS document that validates against the published
structure, served at a URL, with the differences each network is documented as
wanting called out in the code. Whether they accept it is a four-to-six-week
conversation that starts with an email, not with a commit.

**Public listing pages** are the part that needs nobody's approval and is
worth more day one: a page per listing on the company's own slug, an inquiry
form that lands in the existing inbox, and a showing scheduler that writes to
the calendar the queue already reads. A manager with no syndication at all can
send somebody a link.

## 4. Plaid Link — deferred to the end, by your decision

Not in this phase. It is grouped with the other outside connections — the
payment provider's live keys, the delivery domain, QuickBooks — to be dealt
with when there are credentials to deal with them against.

Recorded here so the reasoning is not lost: `server/lib/plaid.js` is already
written against Plaid's documented API and has never run, and `storeItem()` is
ready for the public token Link produces. What is missing is the browser half,
and **Plaid Link cannot be done without client-side JavaScript** — it is a
hosted widget. That means one external script from Plaid's CDN, allowed in the
CSP by name, on the screen that links a bank account. It is a real widening of
the attack surface on the most sensitive screen in the application, which is
why it is a decision rather than a task.

Reconciliation works today without it. The manual statement paste produces
exactly the same `bank_txn` rows the sync would, so the matcher, the journals
and the audit trail are identical whichever way the data arrived.

---

## Files

**New**

    server/migrations/044_deposits.sql       deposit_return, deposit_deduction
    server/migrations/045_inspections.sql    inspection, inspection_item, inspection_photo
    server/lib/deposits.js                   take, return, deduct, and the postings
    server/lib/inspections.js                the checklist, the comparison, the signature
    server/lib/listings/mits.js              the standard, properly
    server/features/deposits.js              the return screen and the itemisation
    server/features/inspections.js           the checklists
    server/features/publiclistings.js        the public page, inquiry, showings
    test/deposits.test.js
    test/inspections.test.js
    test/mits.test.js
    test/publiclistings.test.js

**Changed**

    server/features/listings.js              the feed becomes MITS
    server/features/portfolio.js             move-out starts a return
    server/lib/reports/trust.js              deposits stop being a standing variance
    test/screening.test.js                   the condition-rating allow-list entry

---

## New environment variables

**None.** Plaid's credentials are deferred with Plaid. Everything else in this
phase is a company setting.

---

## What will and will not be verified

**Verified:** that a deposit posts to `2100` and the trust reconciliation stops
reporting it as a variance; that a deduction credits the owner rather than the
manager; that a return cannot exceed the deposit held; that the itemisation
cannot be sent from an unapproved template; that a move-out comparison shows
the move-in record beside it; that a tenant's signature is frozen and its hash
checks; that the MITS document is well-formed and carries the elements the
published structure requires; that a public listing page shows only listings
the company marked publishable.

**Not verified:** acceptance by Zillow or Apartments.com, which is their test
process rather than mine. Plaid Link is not in this phase at all.

---

## Risks

**The deposit work touches the books.** It is the fourth thing in this project
to post journals, and the Phase 6 corrections are what happen when a posting
is wrong for a few months. The deduction-credits-the-owner decision is the one
to look at hardest, and I would rather you looked at it in this plan than in a
report afterwards.

**Statutory deposit rules vary more than almost anything else** — the
deadline, whether interest is owed, whether an itemisation is required when
nothing is deducted, and what happens if the deadline is missed. The deadline
is already a company setting in the compliance engine. The rest ships as
templates that need approval, and I am not going to encode fifty states'
rules in a switch statement.

**The public listing page is the first page this application serves to
strangers at scale.** Everything public so far has been behind a token that
somebody was given. A listing page is meant to be found, which makes it the
first thing worth pointing a scraper at — so the inquiry form needs the rate
limiting the other public forms have, and the page must not become a way to
enumerate a portfolio.
