# Phase 4 — Tenant and owner portals, and messaging

Plan. Per the roadmap's process rule, nothing is written until you approve it.

The roadmap is now in `docs/ROADMAP.md`. It existed only in the chat until
today, which meant that after one compaction nobody could say what this phase
was — I had to recover it from the session transcript. That is fixed.

---

## The finding that shapes this phase

**There is no such thing as a person here.**

`tenant` is a row per tenancy, not a row per human. The move-in path at
`server/features/portfolio.js:319` inserts a fresh `tenant` every time, so a
tenant who moves from unit 1 to unit 3 in the same building becomes two
unrelated rows with the same name and email. `owner` is similar: it is the
counterparty on a set of properties, not an identity.

That is fine for a back office where staff look people up by unit. It is
fatal for a portal, because the roadmap's last bullet — *"several leases over
time, and owners several properties, under one login"* — is asking for
exactly the thing the schema cannot express. Building login on top of `tenant`
would give a returning tenant a fresh empty portal and no history, which is
worse than no portal.

So the first migration of this phase introduces identity, and the rest builds
on it.

### The shape

    person            one human, identified by a verified email
      ↓ person_link
    tenant / owner    their role in one company, on one tenancy or portfolio

`person` is **platform-level**: one row per verified email across the whole
platform, because the same landlord genuinely can own property managed by two
different companies on here, and forcing them to hold two logins to see two
statements is the kind of thing that makes people ring the office.

**Access is never platform-level.** The gate resolves *"which records does
this person hold in this company"* on every request. A person with links in
two companies sees two companies listed and picks one; they never see a merged
view, and nothing in a portal query is ever scoped by `person_id` alone. This
is the Phase 2 tenancy boundary applied to a new kind of actor, and the
isolation test gets a portal section that tries to cross it.

---

## Passwordless login

**[default]** Email magic link as the primary path, optional SMS code as the
second. Both land on the same session.

- Single use, 15-minute expiry, invalidated when a newer one is issued.
- Rate limited per email *and* per IP. An unauthenticated endpoint that sends
  email is an open relay for harassment if it is not.
- The link says what it will sign you into before you click, and the page it
  lands on names the company.
- **The response never reveals whether the address is known.** "If that
  address is on an account, a link is on its way" either way, because the
  alternative turns the login form into a tenant-list oracle.

**The existing one-time links keep working.** `/pay/:tok`, `/o/s/:tok`,
`/r/:tok`, `/sign/:tok` are unchanged and untouched — the roadmap says so
explicitly and it is right: they are the fastest path for an owner opening a
statement, and a portal that replaces them makes the product worse.

A portal session is a **separate table** from `session`. Widening the existing
one is tempting and wrong: a staff session carries capabilities and a portal
session carries records, and the moment they share a table, one missing
`WHERE` makes a tenant a member of staff. Different table, different cookie
name, different gate branch.

---

## What the portals contain

Almost all of it already exists and is reachable only by token. The portal is
a signed-in shell around existing views, not new features:

| Tenant portal | Where it comes from |
|---|---|
| Balance and full ledger | `balanceFor`, `ledger_entry` — exists |
| Pay now, autopay, receipts | `/pay/:token` — exists, Phase 3 |
| Maintenance with photos and status | `/report`, `work_order_event` — exists |
| Lease and signed documents | `lease_document`, `/sign/:tok` — exists |
| Notices received | `notice_log` — exists |
| Renters insurance upload | **new**, small: a document type and an expiry |
| Contact details | **new**, small: writes `tenant` + `contact_consent` |

| Owner portal | Where it comes from |
|---|---|
| Statements | `owner_statement` — exists |
| Distribution history | `payout_item` — exists, Phase 3 |
| Pending approvals | `owner_approval` — exists |
| Per-property dashboard | **new**: occupancy, rent collected vs due, open jobs |
| Documents | `lease_document`, files — exists |
| Reports | **Phase 6.** Linked, not built here. |
| Year-end tax documents | **Phase 6/9.** 1099s exist for vendors, not owners. |

The two marked Phase 6 are stated as such rather than half-built.

---

## Two-way messaging

The largest genuinely new piece. One shared inbox for staff, threaded per
tenant/owner/vendor, spanning portal, email and SMS.

    thread          company, subject, the record it is about, state, assignee
    message         thread, direction, channel, body, provider ids, delivery state

Threading rule, in order of reliability:

1. A reply token in the outbound address (`reply+<token>@…`) — the only one
   that is certain.
2. `In-Reply-To` / `References` headers.
3. Sender's phone or email plus an open thread within a window.
4. Otherwise a new thread. **Never guess by subject line** — "Re: Rent" from
   two tenants is two threads, and merging them shows one tenant another's
   correspondence.

**Inbound email** needs the provider's parse webhook (Resend). **Inbound SMS**
already arrives at `server/lib/delivery/webhooks.js` but is only classified
for STOP/HELP keywords; it gets extended to thread, while keyword handling
stays exactly where it is and keeps precedence — an opt-out must never become
a chat message.

Outbound from the inbox goes through the existing outbox, so the delivery
honesty invariant holds without new work: the inbox shows *queued* until the
provider accepts.

---

## What I will not do in this phase

- **No portal-side automated decisions.** The tenant portal shows the
  delinquency ladder's notices; it does not negotiate, promise or waive.
- **No cross-company merged view**, as above.
- **No reports or owner tax documents** — Phase 6.
- **No new payment surface.** The portal links to `/pay/:token`.

---

## Files

**New**

    server/lib/identity.js            person, links, "what does this person hold here"
    server/lib/magiclink.js           issue, verify, rate limit
    server/features/portal.js         the gate-side shell, company picker, sign-in
    server/features/portal-tenant.js  the tenant's own pages
    server/features/portal-owner.js   the owner's pages
    server/features/inbox.js          shared inbox, threads, assignment, templates
    server/lib/threading.js           inbound → thread resolution
    api/webhooks/resend-inbound.js    inbound email parse
    test/identity.test.js
    test/magiclink.test.js
    test/portal.test.js
    test/inbox.test.js
    test/threading.test.js

**Changed**

    server/app.js                     a portal branch in the gate, beside the staff one
    server/lib/auth.js                portal session helpers; capabilities untouched
    server/features/portfolio.js      move-in links to a person instead of orphaning a row
    server/features/owners.js         owner pages link to their person
    server/lib/delivery/webhooks.js   inbound SMS threads as well as classifying
    server/views/layout.js            a portal shell; `publicPage` unchanged
    test/isolation.test.js            portal routes added to the cross-company sweep

---

## Migrations

    029_identity.sql      person, person_link, portal_session, backfill from tenant/owner
    030_messaging.sql     thread, message, thread_event, reply tokens

`029` backfills: every existing `tenant` and `owner` with an email becomes a
`person` (deduplicated on lower-cased email) plus a link. Rows without an
email get no person and keep working exactly as now — they are reachable by
token, which is how they are reachable today.

Every new table carries `company_id` except `person`, which is deliberately
platform-level and therefore carries none. That is the one exception to the
rule in the roadmap and I want it called out rather than slipped in: `person`
holds an email and a name and nothing else — no balances, no records, nothing
a leak would expose beyond "this address uses this platform". Everything
attached to it is scoped.

---

## New env vars

    RESEND_INBOUND_SECRET     verifies the inbound parse webhook
    PORTAL_REPLY_DOMAIN       where reply+<token>@… lands; falls back to disabling
                              token threading and using headers only

---

## Risks

**Identity backfill touches every tenant and owner.** It is additive — no
existing column changes meaning and no existing query changes — but it is the
first migration that infers something (that two rows with one email are one
person). I will print the dedup result before it runs anywhere real, the way
the Phase 3 conversion was printed.

**A portal is a new authenticated surface on data that was previously
staff-only.** This is the largest new attack surface since signup. It gets the
isolation sweep, and the gate is one branch in `app.js` rather than per-handler
checks, for the reason the roadmap already gives.

**Inbound email cannot be fully verified without a domain.** The parse webhook
will be built against Resend's documented payload and a recorded fixture, and
the first real inbound message is the real test. It goes in OPEN-ITEMS.

**This phase is bigger than Phase 3.** If you would rather land it in two
pieces — identity plus portals first, messaging second — say so and I will
split it. Otherwise I will do it in that order anyway, committing per step, so
the split exists whether or not we name it.

---

## What will and will not be verified

Verified: identity dedup and backfill; magic-link issue, single use, expiry,
rate limiting and the non-disclosure of whether an address exists; portal
session separation from staff sessions; cross-company isolation on every
portal route; a returning tenant seeing both tenancies under one login;
threading by token, by header, by contact, and the refusal to thread by
subject; STOP keeping precedence over threading; the inbox showing queued
rather than sent.

Not verified without your input: a real inbound email, a real magic link
arriving in a real inbox, and SMS codes reaching a real handset — all of which
need the credentials already listed in `docs/OPEN-ITEMS.md`.
