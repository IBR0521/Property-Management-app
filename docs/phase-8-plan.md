# Phase 8 — Tenant screening

Plan. **Not started. This needs your approval, and one decision inside it is
yours rather than mine.**

---

## The decision I am asking you to make

The roadmap says:

> Build a provider interface. Implement one provider whose API allows a
> platform integration (TransUnion SmartMove or a comparable service); state
> in the plan which provider and what credentialing it requires.

I have looked at what that credentialing actually is, and I do not think we
should do it this phase. What follows is why, and what I propose instead.

### What a real provider integration requires

To pull a consumer report you need a **permissible purpose** and you must
**certify to the reporting agency that the report will be used only for
housing purposes**. That certification is not a checkbox in an API call; it is
a one-time credentialing process with an application and supporting
documentation.

Since November 2015 all three bureaus — Experian, Equifax and TransUnion —
also require an **on-site inspection of the physical business premises**
before an account is opened. An inspector visits, completes a questionnaire
and takes photographs of the office.

And a platform in the middle is a **reseller**, which means two further
things:

1. It carries a consumer reporting agency's own obligations, including
   "reasonable procedures to assure maximum possible accuracy" (15 U.S.C.
   § 1681e(b)) toward every applicant whose report passes through it.
2. It must establish the identity and the permissible purpose of **each
   end-user landlord** before supplying a report to them — not once for the
   platform, once per customer.

TransUnion's SmartMove in particular has no general property-management
integration; the integrations that exist are orchestration layers somebody
built between SmartMove's webhooks and a specific product.

So this is a legal and operational programme with a site visit in it, a
company that does not exist yet, and an office nobody has inspected. It is
not a sprint, and no amount of code here moves it forward.

### What I propose instead

**The platform does not become a reseller. The company brings their own
screening account.**

Everything that is legally required *whoever pulls the report* gets built, and
it is most of the work:

- capturing and recording the applicant's consent, before anything is ordered
- the screening workflow beside the company's own written criteria
- the **adverse action notice**, with the elements the FTC requires
- retention and deletion rules for consumer report data
- the provider seam, so a real integration is a file rather than a redesign

And a `manual` provider that works for everybody today: the manager runs the
screening wherever they run it now, and records the outcome and the report
here. That is what most small managers actually do, it needs no credentialing,
and it means the compliance trail is complete from day one rather than from
the day an inspector visits.

**If you would rather I built the SmartMove client anyway**, say so and I
will — but it would be written from documentation, never exercised, and
shipped unverified, which is the same call we made about QuickBooks in Phase
7 and for the same reason: an integration tested only against a fake of itself
produces confidence rather than evidence.

---

## The four decisions inside the phase

### 1. No score, no automated decision — and a report arrives with a score on it

The invariant is already in `applications.js` and it is the one most likely to
be eroded by this phase, because a screening report has a number on the front
of it and numbers want to be sorted.

**The score is part of the report document. It is not a column.**

Nothing in the database will hold a screening score in a field that anything
can filter, sort or threshold on — because the day it exists, somebody adds
"auto-decline below 620" and the invariant is gone without anybody deciding to
remove it. What the system holds is the report, the applicant's consent, and
the human's pass/fail mark against each of the company's own written criteria,
which is exactly what it holds today.

There is one exception and the law makes it: **if a credit score influenced
the decision, the adverse action notice must carry the score, its source, the
date it was created, the score range and the key negative factors in order of
importance.** So the score is captured at the moment of decision, from what
the person reading the report puts into the notice — and it lives on the
adverse action record, where the law requires it, and nowhere queryable.

### 2. Consent is a record, not a checkbox

Every screening provider's contract requires the applicant's consent, several
states require it in writing, and the FTC's guidance is that a separate signed
consent naming the screening agency is the standard to meet.

So consent is its own record: who consented, to what, naming which provider,
when, from what address, and the exact wording they were shown — frozen, the
way a signed lease document is frozen. An application cannot be moved to
`screening` without one.

The applicant already has a token URL for adding documents after they apply.
Consent goes there: they see the disclosure, they type their name, and the
record is written. No new login, no new email.

### 3. The platform never touches the screening fee

The standing invariant is that this platform never holds client or tenant
money, and screening is the easiest place to break it — a fee, an applicant,
a card.

**The applicant pays the provider directly.** SmartMove already works this
way: the applicant is sent to TransUnion and pays TransUnion. With the manual
provider, whatever the manager uses already has its own payment. Nothing about
the fee passes through here, and the roadmap's alternative — "or through the
PM's Connect account" — is available later if a provider needs it, but it is
not the default and should not be.

### 4. Consumer report data is the most sensitive thing this system would hold

A tenant screening report contains somebody's credit file, their addresses,
and possibly criminal history. It is worse than anything else in this database
and it should live here for the shortest time that is useful.

**Retention is configurable per company, defaults to 90 days after the
decision, and deletion is a scheduled job that says what it did.**

What is deleted: the report file, any uploaded copy of it, and the score.
What stays for ever: the record that screening happened, the consent, the
criteria marks, the decision and its reason, and the adverse action notice.
Those are the compliance trail, and a company that cannot show it later is a
company that cannot defend a decision.

---

## The work

### The provider seam

    server/lib/screening/providers.js   the interface, and what a real one must do
    server/lib/screening/manual.js      the one that exists

An interface with four operations: `order`, `status`, `report`, and
`describe` — the last one so the consent wording can name the provider
correctly and the adverse action notice can carry its address and telephone
number, which the notice is required to contain.

`manual.js` implements all four by asking the manager. It is not a stub: it is
the correct implementation for a company that screens on somebody else's site,
which is nearly all of them.

### Consent

    server/migrations/042_screening.sql   screening_request, screening_consent, adverse_action
    server/lib/screening/consent.js       capture, freeze, verify
    server/features/applications.js       the panel, and the applicant's page

The applicant sees the disclosure and types their name, and the record holds
the wording verbatim with a hash over it, the same shape as `lease_signature`.
An application cannot enter `screening` without one, enforced in one place.

### The screening panel

Beside the criteria, on the application the staff member is already looking
at. It shows the consent, the report, and the company's own criteria list with
its pass/fail marks — unchanged from today, because that part is already
right.

### Adverse action

    server/lib/screening/adverse.js     the notice, its required elements
    notice template key: adverse_action

Generated when an application is declined, or approved on conditions, **and a
consumer report contributed to it — even as a minor factor**, which is the
test the FTC sets and which the screen will ask in those words.

The notice carries the four things it must:

1. the name, address and telephone number of the agency that supplied the
   report
2. a statement that the agency did not make the decision and cannot give
   reasons for it
3. the applicant's right to dispute the accuracy or completeness of what the
   agency furnished, and to a free copy of the report if they ask within 60
   days
4. where a credit score was used: the score, its source, the date, the range
   and the key negative factors in order

It goes out through the existing outbox, so delivery honesty applies — the
screen will not say it was sent unless the provider accepted it — and it is
recorded whether or not it was.

The template ships pre-filled and **unapproved**, like every other notice
template here: an unapproved template cannot be sent, so a company's counsel
has to look at it before the first one goes. It will carry a plain line saying
it needs legal review.

### Retention

    server/lib/screening/retain.js      the sweep
    scheduler tick                      one more job

A company setting, a default of 90 days, a job that deletes report files and
scores after the decision, and a line in the tick's result saying how many.
The screening record keeps a note that it was deleted and when.

---

## Files

**New**

    server/migrations/042_screening.sql
    server/lib/screening/providers.js
    server/lib/screening/manual.js
    server/lib/screening/consent.js
    server/lib/screening/adverse.js
    server/lib/screening/retain.js
    server/features/screening.js          the panel and the applicant's consent page
    test/screening.test.js
    test/consent.test.js
    test/adverse.test.js

**Changed**

    server/features/applications.js       the panel, and the decision flow
    server/features/setup.js              provider, retention, the template
    server/lib/scheduler.js               the retention sweep
    server/lib/export/tables.js           three tables to decide about

---

## New environment variables

**None.** A company's screening account is a company setting, not a platform
secret. If a real provider is built later it will need credentials, and those
will be per company rather than per platform — which is itself an argument for
the shape above.

---

## What will and will not be verified

**Verified:** that an application cannot enter screening without a consent
record; that the consent wording is frozen and its hash checks; that no
column anywhere holds a sortable screening score; that a decline with a report
behind it cannot be recorded without an adverse action notice existing; that
the notice contains all four required elements; that an unapproved template
cannot be sent; that the retention sweep deletes reports and scores and leaves
the compliance trail; that a deleted report is gone from the export too.

**Not verified:** anything involving a real consumer reporting agency. No
report will be pulled, because no account exists and no office has been
inspected.

---

## Risks

**The legal text is not mine to write.** The adverse action notice has
required elements and I have them from the FTC's own guidance, but the wording
around them, and anything a particular state adds, is counsel's. The template
ships unapproved and says so. That is the same pattern as the eviction notice
templates and it is the right one, but it means the feature is not usable on
day one without somebody's lawyer, and you should know that before it is
built rather than after.

**"No automated decision" gets harder every phase.** This phase puts a number
in front of a human for the first time. The defence is structural — the score
is not a column — and structural defences survive; a note in a file does not.
If you ever want auto-decline, it should be a decision somebody makes out
loud, not something that becomes possible because the data happened to be
sitting there.

**Screening data is a breach magnifier.** Everything else in this database is
commercially sensitive. This is somebody's credit file. Short retention is the
main defence and it is worth more than any amount of care elsewhere.

---

## Sources

- [What Tenant Background Screening Companies Need to Know About the Fair Credit Reporting Act](https://www.ftc.gov/business-guidance/resources/what-tenant-background-screening-companies-need-know-about-fair-credit-reporting-act) — FTC
- [Using Consumer Reports: What Landlords Need to Know](https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-landlords-need-know) — FTC, and the source of the four required elements
- [Navigating Credit Bureau Onsite Inspection Requirements](https://blog.trendsource.com/navigating-credit-bureau-onsite-inspection-requirements-a-universal-solution-for-compliance-officers/) — the site inspection requirement
- [SmartMove Tenant Screening](https://www.transunion.com/product/smartmove) — TransUnion
