# Phase 11 — recurring charges

Item D in `docs/OPEN-ITEMS.md`, and the one thing on the list a prospective
customer would notice missing. A lease here had one rent and one due day;
AppFolio, Buildium and Rent Manager bill several lines against a lease. An
export where a tenant pays $1,450 rent, $50 for the dog and $75 for a space
imported as $1,450 and lost $125 a month, on every lease, for ever.

The importer has said so since Phase 7a — `RECURRING_MONEY` is a curated list
of thirty column names it warns it cannot read. This is the other half of that
sentence.

**54 tests. 2,001 in the suite, 0 failing.**

---

## What was built

**The record.** `recurring_charge` on a lease: a label the tenant sees, a
category, an amount, a start and optional end, and whether a partial month is
prorated. Ending one is not deleting it — a charge billed for six months is
part of what that tenant was asked to pay.

**The posting.** Owner charges post exactly as rent does:

    Dr 1300 tenant receivable / Cr 2400 rent due to owners

Not `2200`. Crediting owner funds on a charge would say money is held that has
not arrived, and the trust reconciliation would fail by the arrears for ever —
the same mistake the rent charge documents not making. The money moves to
`2200` when it arrives, through the payment path that already exists.

**The run**, in the scheduler immediately after the rent charge and before
anything reads a balance. Once per period, guaranteed by a partial unique
index on `<chargeId>:<period>` rather than by a check with a window in it —
tested with two overlapping runs producing one charge.

**Proration** through the same `prorate()` and `occupancyIn()` the rent uses,
on the company's own basis. A charge with `prorate = 0` bills in full: a flat
administration fee is not smaller because somebody moved in late.

**What the tenant is shown.** `balanceFor` was rent plus late fees; it is rent
plus these plus late fees now, **itemised**. A balance that left them out
would ask somebody for less than they owe and then call them behind.

**Aging.** A recurring charge falls due with the rent it sits beside. Without
that it would age from the day it was raised — the first — and a tenant whose
rent is due on the fifteenth would read a fortnight late on their pet rent
while being current on their rent.

**The screen**, on the home's own page, because that is where somebody is when
they find out the tenant has a dog. Existing components only.

**The import**, which is the reason the feature exists. The values behind
those thirty column names were always discarded with the headings; they are
read now, listed on the preview by name and amount, and created **only if the
box is ticked**. A column heading is not a decision to start billing somebody.
Re-uploading updates rather than duplicates.

---

## The three decisions in the plan

You said go without answering them, so I took the recommendations and am
naming them here rather than leaving them buried.

**1. Payment allocation — rent first.** In the event this turned out not to
matter yet: owner charges share the `1300` receivable with rent, so one
payment settles both and the existing cap does the right thing. There is a
test. The ordering rule only bites once manager-payee charges exist, which
they do not — see below.

**2. Late fees are charged on rent only.** Charging one because somebody was
late on $50 of pet rent is not what most late-fee clauses say. No setting
added.

**3. The import lists and offers; it does not create.** Off by default, and
the preview shows the figures so the decision is made against money rather
than headings.

---

## The `1200` hole, closed

Written up below as what was *not* built. It is built now, in the same
session, so the section that follows is history rather than an open item.

**Nothing had ever credited `1200 Rent receivable`.** Late fees were charged
to it from Phase 1 and no path cleared one, so two things were wrong at once
and both were silent: the fee stayed outstanding for ever, and the money that
paid it fell through to `2300 Prepaid rent` — recorded as rent held **for the
owner**. `2300` sits inside the `2200 + 2300` total the trust reconciliation
measures the owners' ledgers against, so the manager's own income inflated
what the owner appeared to be owed.

`rentPaymentSplits` settles it now, **after the rent and never before it**.
That order is the decision, not a detail: applying a payment to fees before
rent turns a tenant who paid their rent in full into a tenant in arrears *on
rent*, and arrears on rent is the ground for eviction. Several states prohibit
it. There is a test for exactly that case — rent 1,000, a 50 fee, the tenant
pays 1,000, and the rent must come out settled.

The money is in the trust account, because that is where the tenant sent it,
and it is the manager's. That shows as a surplus in `book_vs_clients`, which
this report has always read as *"fees you have earned and not yet moved to
your operating account… it should not grow month on month"* — a warning, not
an error, and the same thing a management fee has produced since Phase 6. No
new reporting was needed; the existing sentence was already the right one.

**Manager-payee recurring charges are unlocked** as a result: they post
`Dr 1200 / Cr 4100` exactly as a late fee does, on an account that now clears.
The screen asks whose income a charge is instead of assuming.

Still owed: **the sweep itself**. Moving earned fees out of trust to operating
is a bank transfer, and nothing in the application records one. That gap is
older than this work — management fees have sat in trust the same way — and
the reconciliation names it every month until somebody does it.

---

## What I did not build, and why *(written before the section above)*

**Manager-payee charges are refused, in words, at the boundary.**

The schema carries `payee` and allows both values, because whose income a
charge is decides its posting and that is the field this table exists for. But
only `owner` is accepted today.

A tenant paying a manager-income charge lands money in trust cash (`1010`)
against a non-trust receivable (`1200`): trust assets rise with no matching
client liability, and the three-way reconciliation would fail by the amount
every month. Settling it properly needs a liability for what the trust account
owes the manager and a sweep that moves it out.

**This is not new, and it is worth being plain about.** Nothing has ever
credited `1200`. Late fees have been charged to it since Phase 1 and no path
has ever cleared one — a tenant paying a $50 late fee leaves the fee
outstanding for ever and records the money as prepaid rent held for the owner.
That was written up in the Phase 11 plan as the prerequisite, and it remains
open. Recurring charges do not make it worse, because they do not use that
account.

Lifting the refusal is a code change and a test, not a migration.

**Also not built:** frequencies other than monthly, metered utility billing
(RUBS as a fixed monthly amount is in; meter reads are a different feature),
and automatic rent escalation.

---

## What is left

1. **The sweep.** Earned fees sit in the trust account until moved to
   operating, and nothing records that transfer. Older than this work — the
   reconciliation reports it as a warning every month.
2. **Aged receivables still reads `1300` only**, so fees owed on `1200` are
   collectable and chaseable but do not appear in the aging report.
3. **Owner statements do not send** (Phase 10), still one line.
