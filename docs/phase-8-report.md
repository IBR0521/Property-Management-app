# Phase 8 — Tenant screening. What was built, and what it deliberately is not.

Four commits. Two test files added.

The phase was approved with one decision taken out of it: **the platform does
not become a consumer report reseller.** What follows is what that meant in
practice, and it turned out to be most of the work rather than a way of
avoiding it.

---

## Why there is no provider integration, in one paragraph

Pulling a consumer report means certifying permissible purpose to the
reporting agency, which is a credentialing process rather than a checkbox —
and since November 2015 all three bureaus also require an on-site inspection
of the physical business premises. A platform in the middle is a **reseller**:
it takes on a reporting agency's own obligation to follow "reasonable
procedures to assure maximum possible accuracy" (15 U.S.C. § 1681e(b)) toward
every applicant whose file passes through it, and it must establish identity
and permissible purpose for **each end-user landlord** separately. That is a
legal programme with a site visit in it, for a company that does not exist
yet.

So the company brings their own screening account, and everything the law asks
of *them* lives here.

The seam is `server/lib/screening/providers.js`. A real provider implements
four operations, and the fourth is the one that is easy to skip: `describe()`,
which answers **who the agency is** — legal name, postal address, telephone
number. An adverse action notice is required to carry all three, so a provider
that cannot answer that cannot be used lawfully, and it belongs in the
interface rather than in a note.

`manual` implements all four by asking the manager. It is not a stub. It is
the correct implementation for a company that screens on somebody else's site,
which is nearly all of them.

**Nothing was built about the screening fee**, and that is the decision
working rather than an omission: the applicant pays the agency, on the
agency's own site. No fee passes through this platform, which is the standing
rule about client money holding on the one screen where it would have been
easiest to break.

---

## The structural defence of the oldest invariant

*No automated applicant scoring, no automated decision.* It has been in
`applications.js` since Phase 1, and this is the first phase that puts a number
in front of a human.

**There is no score column anywhere**, and I got that wrong first and was
caught by a test I wrote in Phase 1.

Migration 042 gave the adverse action notice five of them — score, source,
date, range, factors — on the reasoning that the law requires those things to
appear on the notice when a credit score influenced a decision. That reasoning
is correct. The conclusion was not, and `invariants.test.js` failed within the
hour: it has asserted since Phase 1 that **no score column may exist anywhere,
full stop**, and it does not make exceptions for good reasons. Good reasons
are how a rule like that dies.

It did not need them. `rendered_body` **is** the notice — frozen when it was
written, identical to what went into the outbox — and the score is in it, in
prose, where the law wants it. Storing it a second time as a field bought
exactly one capability: querying by it. Migration 043 took them off, and the
invariant is still absolute rather than nearly absolute.

What is left is a test that sweeps every column in the database for anything
score-shaped and fails on one that is not on a two-item allow-list: the `rank`
that orders contractors for a category, and the `rank` that orders photographs
on a listing.

The reasoning, written into the migrations so it survives me: the day a score
column exists, somebody adds "decline below 620", and the rule is gone without
anybody having decided to remove it. A note in a file does not prevent that.
A missing column does.

---

## Consent is a record, not a checkbox

The applicant sees a page at the link they already have, reads what is
actually being asked, and types their name.

What is kept is the **wording they were shown, verbatim, with a SHA-256 over
it** — the same shape as a signed lease document. What matters when somebody
asks about this in a year is not that a box was ticked; it is which agency was
named, what they were told would be looked at, and what they were told would
happen if it went against them. An altered record stops matching its own hash,
and the screen says so rather than carrying on.

**Nothing may be ordered without one**, enforced in the code and by a NOT NULL
on `screening_request.consent_id` — the version that cannot be forgotten is
the one in the database.

Withdrawing keeps the row. Somebody consenting and later changing their mind
is part of the record; deleting it would leave a report that was pulled with
no visible basis for having pulled it, which is worse for everyone including
the applicant.

---

## The adverse action notice

Required when information in a consumer report contributes to a decline, or to
less favourable terms — **even as a minor factor**, which is the test the FTC
sets and which the screen asks in those words.

Four things, and three of them are built from the record rather than typed:

1. the name, address and telephone number of the agency that supplied it;
2. that the agency did not make the decision and cannot give the reasons;
3. the right to dispute accuracy or completeness, and to a free copy if asked
   for within 60 days;
4. where a score was used: the score, its source, date, range, and key
   negative factors in the order the person entered them.

**A company that edits the token out of its template still gets 1 to 3.** The
required paragraphs are appended if the rendered notice does not already
contain them, because a company's template editor is not where that decision
should be made.

It renders through the same `notice_template` machinery as every other notice,
so the standing rule holds: **an unapproved template is never sent.** The
starting wording ships unapproved and the Setup screen says why.

It goes out through the outbox, so delivery honesty applies — the record
carries the outbox id rather than a `sent_at` of its own, and nothing here can
claim a delivery the delivery system did not make. An applicant with no email
gets a notice that is written and not claimed sent, to be printed and posted.

**A decline with a report behind it and no notice is shown on the applications
list**, not only inside the record. A compliance obligation visible only if
somebody happens to open the right page is not much of a reminder.

### One thing the system cannot be sure about, and says so

"Less favourable terms" — a higher deposit, a guarantor, a shorter term,
decided partly on the report — needs a notice exactly as a decline does. There
is no status here for *approved on different terms*, so the system cannot
know. It therefore **insists where it can be sure** (a decline with a report
behind it is flagged as outstanding) and **makes it possible where it cannot**
(the form is offered on an approval too, with the question put plainly and no
nagging).

That is a gap in the data model rather than in the feature, and it is worth
knowing about: if conditional approvals become a real workflow, this should be
revisited so the prompt can be as firm as it is for a decline.

---

## Retention

A tenant screening report is the most sensitive thing this database would ever
hold — somebody's credit file, their addresses, possibly criminal history.
Short retention is worth more than any amount of care elsewhere: the report
that is not there cannot leak.

- Configurable per company, defaulting to **90 days after the decision**, with
  a ceiling so "keep it for ever" is not a value somebody can type into a box.
- Counted **from the decision, not from the report** — an application still
  being decided needs its report, and one that is never decided keeps it,
  which is a thing worth seeing rather than quietly cleaning up.
- What goes: the file. What stays for ever: that screening happened, the
  consent it was made under, the reader's own words about it, the decision and
  its reason, and the notice. Those are what makes a decision defensible, and
  a company that has deleted them cannot answer for it.
- **A file that cannot be deleted is not marked as deleted.** The whole value
  of this is that "deleted" means deleted.

The export carries all three tables and **deliberately does not carry the
report file**. The company has a retention rule; copying somebody's credit
file into an archive that leaves the platform would quietly outlive it.

---

## What I could not verify

- **Anything involving a real consumer reporting agency.** No report was
  pulled, because no account exists and no premises have been inspected. That
  is the approved shape of the phase rather than a gap in it.
- **The notice against a particular state's requirements.** The four federal
  elements are from the FTC's own guidance and are asserted element by
  element. What a given state adds on top is counsel's, which is why the
  template ships unapproved.
- **Blob deletion.** Locally the retention sweep removes a file from disk and a
  test asserts the removal was asked for. The blob branch is a `del` against a
  URL the database already holds and has not run against Vercel Blob.
- **Anything on the deployed instance**, which still runs old code — diagnosed
  in Phase 4, still in OPEN-ITEMS.

---

## What I need from you

**Your solicitor, before the first notice goes out.** The adverse action
template ships unapproved and cannot be sent until somebody approves it. That
is the same pattern as the eviction notices and it means this feature is not
usable on day one without a legal review — which you knew from the plan, and
which is worth repeating here.

Everything else is unchanged: the security items in OPEN-ITEMS remain the most
overdue thing in the project.

---

## Sources

- [Using Consumer Reports: What Landlords Need to Know](https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-landlords-need-know) — FTC, the four required elements
- [What Tenant Background Screening Companies Need to Know About the FCRA](https://www.ftc.gov/business-guidance/resources/what-tenant-background-screening-companies-need-know-about-fair-credit-reporting-act) — FTC, the reseller's obligations
- [Navigating Credit Bureau Onsite Inspection Requirements](https://blog.trendsource.com/navigating-credit-bureau-onsite-inspection-requirements-a-universal-solution-for-compliance-officers/) — the site inspection
