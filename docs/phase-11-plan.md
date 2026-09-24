# Phase 11 — recurring charges

Item D in `docs/OPEN-ITEMS.md`. A lease here has one rent and one due day.
AppFolio, Buildium and Rent Manager bill several lines against a lease, so an
export where a tenant pays $1,450 rent, $50 for the dog and $75 for a space
imports as $1,450 and loses $125 a month, on every lease, for ever.

The importer already knows. `RECURRING_MONEY` in `lib/import/mappings.js` is a
curated list of thirty column names — pet rent, parking, storage, RUBS, valet
trash, amenity fee — and the preview says in its own words that the money will
not come across. This phase is the other half of that sentence.

---

## What I read first

`lib/rentcharge.js`, `lib/latefees.js`, `lib/ledger.js`, `lib/proration.js`,
`lib/payments.js`, `lib/reports/receivable.js`, `features/owners.js`,
`lib/import/mappings.js` and `validate.js`, and the `lease` schema.

## The defect I found before writing any of this

**Nothing ever credits `1200 Rent receivable`.** Late fees debit it and the
`other` posting debits it, and no path in the application clears it.

Demonstrated rather than reasoned about — a $50 fee charged, then $50 paid:

```
after charging a $50 fee:   1200 = 5000   1300 = 0
after the tenant pays $50:  1200 = 5000   1300 = 0   2300 prepaid = 5000 cr
```

Two things are wrong at once. The fee stays outstanding for ever, and the
tenant's payment is recorded as **prepaid rent held for the owner** — so money
the manager earned inflates what the owner is owed, and `2300` is inside the
`2200 + 2300` total the trust reconciliation checks. Aged receivables reads
only `1300`, so the fee is also never reported and never chased.

This matters here because it is the hole recurring charges would fall into. A
late fee is occasional; pet rent is every month on every lease with a dog. I
would be multiplying an existing defect by a thousand.

**So fixing payment allocation is a prerequisite, and step one of this phase,
committed on its own before any new feature lands.**

---

## The design

### Whose money is it

The central question, and the schema turns on it. The chart already answers it
for everything else:

| | Receivable | Income | Example |
|---|---|---|---|
| The owner's | `1300` → `2400`, then `2200` on receipt | the owner's | rent, pet rent, parking, storage, RUBS |
| The manager's | `1200` → `4100` | the manager's | late fees, admin fees, convenience fees |

So a recurring charge carries a `payee` of `owner` or `manager`, and that one
field picks the posting. Pet rent belongs to the owner because the owner owns
the property the dog lives in; a monthly administration fee belongs to the
manager because the manager performs the administration. Getting this wrong
puts the manager's income into the trust account, or takes the owner's income
out of it — the first is a trust violation and the second is theft, so the
field is required and has no default.

### Schema — migration `048_recurring_charges.sql`

```
recurring_charge
  id, company_id, lease_id
  label            what the tenant sees: "Pet rent"
  category         from a fixed set, mapped from the importer's list
  amount_cents
  payee            'owner' | 'manager'      -- required, no default
  frequency        'monthly'                -- only value in v1
  start_date, end_date (nullable)
  prorate          whether a partial month is prorated
  active
  source_system, source_id   -- import idempotency, same shape as lease
  created_at, created_by
```

A partial unique index on `(company_id, source_system, source_id)` where
`source_id is not null`, matching `lease_source_idx`, so a re-run of an import
updates rather than duplicates.

### Posting, and never twice

The same guarantee rent already has, for the same reason: the database
refuses it, not a check in the job. `source_type = 'recurring_charge'` with
`source_id = '<chargeId>:<period>'` under a partial unique index, so two
overlapping ticks cannot both post.

Dated the first day of the period, like rent — the reasons in `rentcharge.js`
about aging buckets apply unchanged. Due on the lease's own rent day.

Prorated through the existing `prorate()` and `occupancyIn()` when
`prorate` is set, so a tenant who moves in on the 20th pays eleven days of
pet rent, on the company's own proration basis. A charge that should not
prorate — a flat monthly admin fee — sets the flag off.

---

## Payment allocation, which is a decision and not a detail

Once a lease can owe several things, a payment has to be applied to them in
some order, and the order has consequences.

I propose **rent first, then other owner charges oldest-first, then manager
fees oldest-first.**

The reason is not accounting neatness. Applying a payment to fees before rent
turns a tenant who paid their rent in full into a tenant in arrears *on rent*,
and arrears on rent is the ground for eviction. Several states prohibit
exactly this. A default that can manufacture an eviction out of a $50 pet
charge is the wrong default, and "the software did it" is not a defence.

The alternative — strict oldest-first across everything — is simpler to
explain and is what some ledgers do. I have not chosen it, and **I would like
your decision**, because it is a policy with legal weight rather than a
technical preference.

---

## Where it has to surface

| Place | What changes |
|---|---|
| `lib/payments.js` `balanceFor` | reads `lease.rent_cents` + late fees today; must include active recurring charges, or the portal tells a tenant to pay less than they owe |
| The tenant portal and pay page | an itemised list, not one number — a tenant who cannot see what the $75 is will ring about it |
| `features/owners.js` `computeStatement` | owner-payee charges are owner income and need their own line rather than being folded into `other` |
| `lib/reports/receivable.js` | reads only `1300`; manager-payee arrears on `1200` are invisible. Both belong, labelled separately |
| The lease screen | add, edit, end a charge — ending is not deleting, because a charge that was billed for six months is history |
| `lib/import/` | map the thirty known columns into real rows, and turn the warning into an offer |

### Late fees

A late fee is charged on rent, not on the total. Charging a late fee because
somebody was late on $50 of pet rent is not what most late-fee clauses say and
not what most statutes allow. Default: **the late fee base stays rent only**,
and I will not add a setting for it in this phase unless you want one.

---

## What I will test

- The posting for each payee, line by line, as `deposits.test.js` does
- That the trust reconciliation stays at zero across a full cycle: charge,
  partial payment, overpayment, move-out mid-month
- That a second run in the same period charges nothing, and that two
  concurrent runs produce one charge
- Proration on move-in and move-out, against the company's basis
- Allocation order, including the case the rule exists for: a tenant who pays
  exactly their rent while owing a fee is **not** in arrears on rent
- That `1200` reaches zero when a fee is paid — the prerequisite fix
- Round-trip through the importer and the portable export
- A recurring charge on an ended lease stops billing

## What I will not do

- Frequencies other than monthly. Quarterly and annual are real but they are
  not what a migration loses.
- Usage-based utility billing. RUBS as a fixed monthly amount is in; metered
  billing with reads is a different feature.
- Automatic escalation — a rent increase schedule — which is its own item.
- Anything to the design beyond the existing components, per your standing
  instruction.

---

## Decisions I need from you

1. **Payment allocation order.** Rent first (my recommendation, above), or
   strict oldest-first?
2. **Late fee base.** Rent only (my recommendation), or the full amount owed?
3. **The import offer.** When an import finds pet rent columns, should it
   create the charges automatically, or list them and let somebody tick?
   I lean towards listing — this is money on somebody's lease and a silent
   creation is how a tenant gets billed for something nobody checked.

## The order I would build it

1. Fix payment allocation so `1200` is settled — on its own, with tests,
   before anything new
2. Migration 048 and the model
3. The charge run and its idempotency
4. Allocation across several charge types
5. The surfaces: portal, pay page, statement, receivables, lease screen
6. Import mapping and the export round trip
7. Report

**Stopping here for your approval, per the roadmap's own rule.**
