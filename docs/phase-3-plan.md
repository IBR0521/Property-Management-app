# Phase 3 — Payments, without ever holding funds

Plan. Building straight after, per your instruction to keep going and settle
credentials at the end. Defaults I have taken are marked **[default]** and are
reversible.

---

## The finding that reframes this phase

Before any Stripe work: **there are two books and they already disagree.**

`ledger_entry` is the single-entry record that drives owner statements.
`journal` is the double-entry book the accounting module owns. Only one path
writes to both — the late-fee sweep. Everything else writes to `ledger_entry`
alone:

    server/features/rent.js           ledger_entry, no journal
    server/features/owners.js         ledger_entry, no journal
    server/features/maintenance.js    ledger_entry, no journal
    server/seed.js                    ledger_entry, no journal

On the live database right now:

    rent_payment entries in ledger_entry:   12, totalling $13,710.00
    journal splits with source 'rent':      $0.00

So recording rent tells the owner's statement and tells the company's books
nothing. The trial balance is internally consistent — the database enforces
that — and it is *incomplete*, which is a quieter kind of wrong.

This matters now rather than later for two reasons. The roadmap requires that
every payment, fee and return posts through `postJournal()`; adding Stripe on
top of a path that does not would mean building a correct new route alongside
an incorrect old one, with the same button on both. And Phase 6 requires the
P&L and balance sheet to tie out to the trial balance, which cannot be true
while thirteen thousand dollars of rent is missing from it.

**So the first commits of this phase are not about Stripe.** They bring the
existing manual paths through `postJournal()` and reconcile the history.

### What to do about the twelve existing entries

**[default]** Post an opening journal per company, dated the earliest
`ledger_entry` date, with the memo `Conversion: pre-double-entry ledger
balance`. Not twelve retrospective journals — inventing individual entries for
history whose detail we cannot reconstruct is worse than one honest summary
with a name that says what it is. The same treatment Phase 7's import wizard
will use for opening balances.

I will report exactly what it posts before it goes anywhere near the live
database.

---

## Stripe Connect: Standard, not Express

The brief asks for a comparison. It is not close, and the deciding factor is
the invariant rather than the developer experience.

|  | Standard | Express |
|---|---|---|
| Merchant of record | The PM company | The PM company, nominally |
| Onboarding | Stripe's full flow, their own account | Lighter, platform-branded |
| Dashboard | Theirs, complete | Limited |
| Disputes and chargebacks | Theirs | Theirs, but **the platform is liable for negative balances** |
| Platform liability | None | Real |
| Payout control | Theirs | Platform's |

**Express is the better product and the wrong answer.** Stripe holds the
platform responsible for losses on Express accounts — if a PM company takes
$40,000 of rent, refunds it, and their balance goes negative, that is our
money. That is precisely the custodial exposure this design exists to avoid,
reintroduced through the back door of a nicer signup flow.

Standard makes the PM company unambiguously the merchant. They complete
Stripe's own onboarding, they hold the relationship, they carry their own
chargebacks, and we orchestrate. The cost is a longer onboarding — which is
the same trade the roadmap already accepted for trust-account reasons.

**[default] Standard**, connected by OAuth, with the account id stored per
company. Payments are created **on behalf of** the connected account
(`Stripe-Account` header), so funds never enter a platform balance at any
point.

---

## What gets built

### 1. Connecting an account

`/app/payments` → connect via Stripe OAuth → store `stripe_account_id`.
Onboarding status is read from Stripe rather than assumed, because a connected
account that has not finished verification cannot accept payments and the
screen must say so before a tenant is shown a pay button.

### 2. Tenants paying

ACH debit first, card optional per company. ACH because rent is large and
card fees on $1,450 are absurd; card because some tenants will insist.

**[default]** Stripe Financial Connections for bank verification rather than
micro-deposits. Micro-deposits take days, and a tenant setting up autopay on
the 28th needs it working on the 1st.

The fee model is per company: **absorb**, **pass through**, or **split**. The
amount is shown to the tenant *before* they authorise, itemised, with the total
they will actually be charged.

On surcharging: card-network rules restrict it, several US states restrict it
further, and the limits differ between credit and debit. **[default]** The
config allows it and the UI warns that it needs legal review for the
jurisdictions a company operates in, in the same style as the notice templates.
I am not going to encode fifty states' surcharge law from training data.

### 3. Autopay

Enrol per lease, run on due date minus N days. A returned ACH payment
**reverses the journal** — a reversing entry, never a deletion, because the
ledger is append-only — and **reopens the charge and the delinquency**, because
a payment that bounced is a payment that did not happen.

Returns arrive days later, which is the whole difficulty: the tenant has been
told they paid, the owner statement says so, and then it unwinds.

### 4. Blocking payments per lease

Cash-only after an NSF, or during an eviction where accepting rent can waive
the proceeding. A reason is required and shown to the tenant, because "payment
unavailable" with no explanation generates a phone call.

### 5. Owner distributions and vendor payouts

Money still never moves through the platform. Two outputs the PM company uses
with their own bank:

- **A NACHA ACH file** they upload to their bank. Plain fixed-width text,
  written here — the format is published and a dependency for string padding
  would be silly.
- **Printable cheques** on cheque stock, plus a **positive-pay CSV** so the
  bank can reject anything that was not issued.

**The workers-comp barrier applies to every payout path**, including these. It
is the existing `assertPayable()`, called from the new code rather than
reimplemented.

**[default] One dependency: `pdf-lib`.** Cheque stock has a fixed geometry —
MICR line position, signature block, stub alignment — and a cheque printed 2mm
out is rejected by the bank. Writing a PDF generator to place text at exact
coordinates is reckless for something a bank machine-reads. The roadmap
pre-approved this.

### 6. Reconciling Stripe payouts to the bank

Stripe pays out in batches; the bank shows one line. The existing matcher in
`banking.js` already scores candidates — this adds payout batches as a target
type so a single bank deposit can be matched to the payments inside it.

---

## Files

**New**

    server/lib/connect.js            Stripe Connect: OAuth, on-behalf-of calls
    server/lib/nacha.js              ACH file format
    server/lib/checks.js             cheque PDF + positive-pay CSV
    server/features/payments.js      connect, settings, fees, tenant pay page
    server/features/autopay.js       enrolment, the run, returns
    server/features/payouts.js       owner distributions, vendor payments
    api/webhooks/stripe-connect.js   connected-account events
    test/ledgerparity.test.js        the two books agree
    test/payments.test.js
    test/autopay.test.js
    test/nacha.test.js
    test/checks.test.js

**Changed**

    server/features/rent.js          record → postJournal, not ledger_entry alone
    server/features/owners.js         same
    server/features/maintenance.js    same
    server/features/accounting.js     accounts for fees, returns, Stripe in transit
    server/features/banking.js        payout batches as a match target
    server/lib/scheduler.js           the autopay run
    server/seed.js                    seeded money posts both books

---

## Migrations

    020_ledger_parity.sql     journal_id on ledger_entry, so the two books point at each other
    021_connect.sql           stripe_account_id, onboarding state, fee model per company
    022_tenant_payments.sql   payment_method, payment, payment_attempt, autopay enrolment
    023_payouts.sql           payout_batch, payout_item, nacha_file, check_register

Every new table carries `company_id`. `ledger_entry.journal_id` is the column
that makes the parity test possible: an entry with no journal becomes a
findable fault rather than an invisible one.

---

## Risks

**The parity work touches money that already exists.** Twelve entries, $13,710.
I will print the exact journals before posting and will not run it against the
live database without showing you first.

**A returned ACH arrives after everyone believes the payment happened.** The
reversal has to unwind the journal, the tenant balance, the delinquency and the
owner statement, and it must be idempotent because Stripe retries the webhook.

**Surcharge law is jurisdictional.** Built configurable and marked for legal
review rather than encoded.

**Nothing can be verified against a real bank.** NACHA files are validated
against the published format and a hand-computed fixture; whether a specific
bank accepts one is unknowable from here. Cheque alignment is geometry I can
assert in the PDF and cannot confirm on paper.

---

## What will and will not be verified

Verified: the two books agreeing on every seeded and synthetic transaction; fee
arithmetic in all three models; the full autopay lifecycle including a return
reversing everything; payment blocks; NACHA field offsets and checksums against
a fixture; positive-pay CSV; the workers-comp barrier on every payout path;
webhook idempotency and signatures.

Not verified without your input: any call to Stripe, Connect onboarding, a real
ACH debit, and whether a bank accepts the NACHA file or the cheque alignment.
All recorded in `docs/OPEN-ITEMS.md`.
