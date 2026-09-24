# Phase 9 — Finishing the partial features. What was built, and what it found.

Three commits of substance. Six test files added.

The phase was approved with the order changed, because looking for what the
roadmap's third item would connect to turned up something bigger than the item
itself.

---

## The finding that reordered the phase

The roadmap's inspections item ends "and a link to deposit deductions". I went
looking for what it would link to.

**`deposit_held` and `deposit_returned` had been in the posting table since
Phase 1, and nothing in this application had ever invoked either.** A deposit
was a number on a lease row that the books did not know about. There was no
screen that took one, none that returned one, and no way to record a
deduction. The compliance engine had been counting forward from every move-out
to a deadline it warned usually carries a statutory penalty — with nothing for
it to be a deadline *for*.

That is the same shape as the Phase 6 rent-charging finding: a rule that looks
complete, that nothing calls. It is also why `$8,435.00 of deposits recorded on
leases and posted nowhere` has been sitting in the Phase 6 report waiting for a
decision, and why the trust reconciliation has reported `deposits_vs_leases` as
a variance on every company, every month, correctly.

So deposits came first. An inspection that produces a list of damage with no
way to charge for it is a checklist app.

---

## 1. The deposit ledger

**Taking one** posts `Dr 1010 Trust cash / Cr 2100 Deposits held` through
`postMoney`, like every other movement of somebody else's money. A deposit is
the tenant's money held — not income to the owner, which is the classic trust
failure.

**A return opens with the move-out**, in the same transaction, so a tenancy
cannot end without one. It reads what is held **from the journal** rather than
from `lease.deposit_cents`: a return that disagreed with the books would be
paying out money the books do not think exists. Its deadline comes from the
company's own compliance rule, with the basis they recorded. No rule means no
deadline — this application does not supply a statutory date it was not given.

**Settling**, and this was settled with you before a line of it was written:

    Dr 2100 Deposits held        the whole deposit stops being held
    Cr 1010 Trust cash           what goes back to the tenant
    Cr 2200 Owner funds held     every deduction

A deduction reimburses whoever paid to put the damage right, which is the
owner. Booking it as management income would be the Phase 6 mistake again —
an owner's money on the manager's books, invisible for months.

Every deduction needs a reason in the words the tenant reads, and the deposit
cannot be overdrawn: anything beyond it is a debt to pursue, not a deduction.
The itemisation is rendered **before** settling so somebody can read it first,
frozen at settlement, and carries the outbox row that delivered it — the table
never claims a delivery the delivery system did not make.

### A second variance the deposit work exposed

The reconciliation's deposits leg compared `2100` against the deposits on
**active** leases. A tenant who moved out on the 30th has left, and their money
is still in the trust account until somebody pays it back — so every unsettled
return read as a variance for exactly the period somebody is most likely to be
looking at that report. It now counts what is still held: active tenancies plus
ended ones with an open return.

### The conversion

`npm run deposits:plan` and `npm run deposits:commit`, in the shape of
`correct.js`. It never posts behind a close, and a lease with *part* of a
deposit posted is **named and not touched** — guessing at the difference is how
a conversion makes things worse. Recorded in OPEN-ITEMS as A4; it posts
journals against your books, so it is your call.

---

## 2. Inspections

A move-out asks **what changed**, never what the condition is — only the first
can justify keeping somebody's money. So a move-out inspection is *made from*
the move-in: same rooms, same lines, same order, each pointing back at the line
it is compared with. The screen shows both and marks what got worse.

**A condition is a word, not a number** — good / fair / poor / damaged / not
there, exactly as `application_check.result` is pass / fail / na / pending. A
number is what a model would produce and a number is what somebody would later
threshold, and neither belongs in a judgement about somebody's home. It also
means this needed no exception in the sweep that guards the
no-automated-scoring rule, which is worth more than the convenience of a
five-point scale.

**The move-in is signed in person**, on the device in somebody's hand at the
walkthrough — no emailed link and no token, because the agent and the tenant
are standing in the same room looking at the same thing. The record is frozen
with a hash over it, the staff member witnessing it is recorded, and a signed
inspection cannot be edited.

`worsened()` is asserted at its edges, because it is the function a deduction
rests on: nothing to compare with is not damage, an item that was never there
and still is not has not changed, and something that appeared is not damage.

### The payoff

A worsened line is offered on the deposit return with the room, both
conditions and the photographs behind it, and the reason is filled in from the
inspection. The tenant's itemisation then reads:

    Kitchen — Worktops                         $450.00
      Kitchen — Worktops: good at move-in, damaged at move-out

A deduction like that survives being disputed. One that says "damages" is the
thing this feature exists to prevent.

---

## 3. Syndication, and a second cross-tenant finding

**The feed served every company on the platform in one document**, labelled
with whichever company sorted first. A manager who handed that URL to Zillow
would have been publishing their competitors' listings under their own
management id — and the network would have been right to believe them.

Found by writing the MITS `Management` block, which is precisely the element a
feed agreement is matched against. Feeds are now per company, and the
platform-wide URL still answers and carries no listings, because somebody will
hand a network the obvious address and the obvious address should not publish
everybody.

**One standard, not two dialects.** Apartments.com's feed programme is
MITS-based and Zillow accepts MITS alongside its own guide, so there is one
document rather than two that drift apart the first time either network adds a
field. The builder gained the management block, per-property identification
keyed on the property rather than its address (two companies can manage
buildings on the same road), unit counts, absolute URLs for every photograph
and every listing page, and amenities only where somebody filled them in.

**What neither of us can shortcut:** Zillow requires an integration request
approved by their Rentals Integrations team *before* a feed is worth building,
then four to six weeks of their own feed testing. Apartments.com sends their
guide on request and takes the XML by URL. Both are free. Neither will look at
a feed from a platform that has not asked — so the vacancies screen says that
plainly rather than implying the feed does something today.

### Public listing pages

The half that needs nobody's approval and is worth more on day one. A page per
company on its own address, each listing with what somebody needs in order to
decide whether to ask, and an enquiry that lands in the inbox **attached to the
listing** — so a conversation that started from a vacancy stays attached to it,
the same rule as one that started from a repair.

**A viewing request is a request.** Nothing tells anybody a time is confirmed,
because nothing here can confirm one. That is the same rule that stops the
outbox claiming a message was sent, applied to a calendar.

This is the first page this application serves to strangers at scale —
everything public before it was behind a token somebody was given. So the
enquiry form is rate limited like every other public form, the page shows one
company's listings and cannot be walked to enumerate a portfolio, and an
address matching no company names none of them.

---

## 4. Plaid Link — deferred, by your decision

Not built. Grouped with the other outside connections to be dealt with when
there are credentials to deal with them against.

Recorded so the reasoning is not lost: `plaid.js` is already written against
Plaid's documented API and has never run, and `storeItem()` is ready for the
public token Link produces. The missing half is the browser one, and **Plaid
Link cannot work without client-side JavaScript** — it is a hosted widget.
That means one external script from Plaid's CDN, CSP-allowed by name, on the
screen that links a bank account. Reconciliation works today without it: the
manual statement paste produces exactly the same `bank_txn` rows, so the
matcher, the journals and the audit trail are identical whichever way the data
arrived.

---

## What I could not verify

- **Acceptance by Zillow or Apartments.com.** Their test process, not mine.
  What is verified is that the document is well formed and carries what the
  standard specifies.
- **A real deposit return paid through a bank.** The posting is asserted line
  by line and the itemisation is asserted word for word; what has not happened
  is money actually leaving an account.
- **Photographs on a real device at a walkthrough.** The inspection screens
  take a camera capture on a phone and the upload path is the same one the
  tenant repair form uses, which is exercised — but nobody has walked a
  property with this.
- **Anything on the deployed instance**, which still runs old code — diagnosed
  in Phase 4, still in OPEN-ITEMS.

---

## What I need from you

**A decision on the deposit conversion (OPEN-ITEMS A4).** `npm run
deposits:plan` will show you exactly what it would post. It is the oldest open
question in the project and it now has a safe way to answer it.

**An email to Zillow and to Apartments.com**, if syndication matters. Neither
will look at a feed until you ask, and Zillow's testing takes four to six weeks
from the day they say yes.

Everything else is unchanged: the security items in OPEN-ITEMS remain the most
overdue thing here.

---

## Sources

- [Zillow rentals feed integrations](https://www.zillowgroup.com/developers/api/rentals/rentals-feed-integrations/)
- [Apartments.com listings feed programme](https://ecom.apartments.com/advertise/resources/listings-feed-program)
- [MITS data models](https://rettc.org/mits-data-models)
