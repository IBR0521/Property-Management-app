# Phase 11 — recurring charges

Item D in `docs/OPEN-ITEMS.md`, and the one thing on the list a prospective
customer would notice missing. A lease here had one rent and one due day;
AppFolio, Buildium and Rent Manager bill several lines against a lease. An
export where a tenant pays $1,450 rent, $50 for the dog and $75 for a space
imported as $1,450 and lost $125 a month, on every lease, for ever.

The importer has said so since Phase 7a — `RECURRING_MONEY` is a curated list
of thirty column names it warns it cannot read. This is the other half of that
sentence.

**38 tests. 1,985 in the suite, 0 failing.**

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

## What I did not build, and why

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

1. **Settle `1200`** — the trust-sweep liability, which unlocks manager-payee
   charges and fixes late fee collection at the same time. The bigger half of
   that work is a decision about where a tenant-paid fee should sit.
2. **Owner statements do not send** (Phase 10), still one line.
3. `aged_receivables` is now 629ms; nothing is over a second.
