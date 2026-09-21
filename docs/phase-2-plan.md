# Phase 2 — Multi-company SaaS foundation

Plan. Building straight after, per your instruction to keep going and settle
the things only you can supply at the end. Decisions I have defaulted are
marked **[default]** and are reversible.

---

## The finding that shapes this phase

Five places resolve "the company" by taking whatever row comes back first:

    server/features/maintenance.js:48    /report
    server/features/maintenance.js:117   POST /report
    server/features/applications.js:37   /apply
    server/features/applications.js:120  POST /apply
    server/features/session.js:11        /app/sign-in branding

Four are **public** routes, where there is no session to say which company the
visitor belongs to. I seeded two companies and drove them:

| | With two companies |
|---|---|
| Bravo's tenant scans **Bravo's own** QR sticker | Sees **"Alpha Management"**, and the lookup fails — every sticker outside the first company is dead |
| Anyone opens `/apply` | Gets **Alpha's** vacant units, whoever they are |
| Anyone opens `/app/sign-in` | Sees **Alpha's** name |

The unit lookup is correctly scoped by `company_id` — which is why the sticker
does not leak Bravo's data to Alpha. It simply finds nothing, and the tenant is
told their address is not one we manage. The QR feature, which I built two
phases ago, works for exactly one company.

**Phase 0's isolation test did not catch this** because it drives every route
*as company A's staff*. A public page has no "acting as", so the whole public
surface fell outside the test. That is a real gap in the suite and it gets
fixed here.

## How public pages learn their company

Most already know and the code ignores it. Six of the eight public entry points
carry a token that identifies exactly one record, and therefore one company:

    /t/:token    /a/:token    /o/a/:token    /o/s/:token    /r/:token    /sign/:token

For those, the company comes **from the token**, and `LIMIT 1` disappears.

Only two entry points have no identifier at all:

- **`/report`** with no sticker scanned, where the tenant types an address.
- **`/apply`**, which lists a company's vacancies.

Those get a company slug in the path:

    /c/:slug/report
    /c/:slug/apply

**[default]** Path prefix rather than subdomain, for now. A subdomain needs
wildcard DNS and a wildcard certificate on a domain that does not exist yet
(item E on the open list). The slug is stored on the company, so moving to
`acme.yourdomain.com` later is a routing change and not a data migration.
Custom domains stay a later premium feature.

Bare `/report` and `/apply` keep working while there is exactly one company —
that is the development and single-customer case, and breaking it would be
gratuitous. With more than one they **must not guess**: they render a short
"which company are you looking for" page rather than silently picking.

---

## What gets built

### 1. Signup and onboarding

`/signup` creates a company and its first admin together, in one transaction —
a company with no way to sign in is an orphan row, and an admin with no company
cannot be scoped to anything.

Email verification before the account is usable, using the delivery layer from
Phase 1. **[default]** Verification is required but the company is created
immediately and marked unverified, rather than holding the signup in limbo:
sign-in works, and anything that sends on the company's behalf is blocked until
the address is confirmed. A dead signup is worth less than a slightly
restricted one.

A guided checklist on the dashboard until complete: company details, first
owner, first building, delivery test, payments connect. Each item links to the
screen that satisfies it and disappears when it does.

**[default] SMS is a checklist item, not a prerequisite.** Per the earlier
discussion: email works for everyone from day one; US SMS needs per-business
carrier registration that takes days to weeks. A company that has not done it
sees the item as pending, and the emergency path records that the on-call alert
could not go by SMS — the tenant still gets the stop card telling them to
phone, which is the guarantee that holds.

### 2. Staff

Invite by email, assign a role, deactivate, resend. Invites are tokenised links
with an expiry, the same pattern as every other tokenised page here.

A **maintenance technician** role joins the five that exist. The capability
model in `lib/auth.js` already supports this; what it needs is the role, its
capability set, and the widened CHECK constraint.

The existing capability gate in `app.js` needs no change, which is the point of
having built it that way.

### 3. Company settings

Legal name, trading name, logo, timezone, currency formatting, business hours,
and the sender identity columns migration 013 added and **nothing currently
reads** — `from_email`, `from_name`, `reply_to`, `sms_from`. That gap is real
today: every company's mail would go out from one platform address.

Timezone matters more than it looks. `company.timezone` has existed since 001
and is used nowhere: every date in the app is computed in the server's zone. A
rent due date is a calendar fact in the property's local time, and a nightly
sweep running at 09:00 UTC is running at 04:00 in Columbus and 01:00 in Los
Angeles. **[default]** I will make the sweep and the due-date maths timezone
aware for the company, and say plainly in the report if any existing data is
affected.

### 4. Two-factor authentication

TOTP with `node:crypto` — HMAC-SHA1 over a time counter, base32 secret, the
standard six digits. It is about sixty lines and needs no dependency.

Optional per staff member; an admin can require it for the whole company.
Recovery codes, single-use, hashed at rest like passwords — because the failure
mode of 2FA without them is a locked-out administrator and a support request
you cannot satisfy.

### 5. Subscription billing

Stripe Billing, called with `fetch`. **[default]** Flat monthly price by unit
band, trial period, self-serve billing page — the transparent-pricing invariant
means the band boundaries and the price are on the page, not derived from
something the customer cannot see.

A lapsed subscription makes the company **read-only**. Never deleted, never
hidden: their data stays theirs, every screen loads, and writes are refused
with an explanation and a link to pay. Read-only is enforced in the same gate
as capabilities, for the same reason — one place rather than every handler.

Built against Stripe **test mode**. Webhooks signature-verified with
`node:crypto` exactly as Phase 1's are, and idempotent on the Stripe event id.

### 6. Platform admin

Restricted to one address from an env var (item D). Lists companies, usage,
subscription state.

Impersonation is audit-logged and **visible to the company being impersonated**
— a banner while it is happening and an entry in their own audit log
afterwards. Support access that the customer cannot see is the kind of thing
that ends up in a breach disclosure.

### 7. seed.js

The demo password is printed by the seed. It is development-only, but the file
is in a public repository and a reader cannot tell that from the code. It gains
a loud refusal to run against anything that looks like production, and the
README stops implying it is a deployment step.

---

## Files

**New**

    server/features/signup.js          public signup, verification, onboarding checklist
    server/features/staff.js           invites, roles, deactivation
    server/features/company.js         settings, branding, sender identity
    server/features/billing.js         Stripe Billing, plans, read-only state
    server/features/platform.js        cross-company admin, impersonation
    server/lib/totp.js                 TOTP and recovery codes, node:crypto
    server/lib/tenancy.js              company resolution for public routes
    server/lib/stripe.js               provider boundary, fetch
    server/lib/timezone.js             company-local calendar maths
    api/webhooks/stripe.js
    test/tenancy.test.js               the public-route gap Phase 0 missed
    test/signup.test.js
    test/totp.test.js
    test/billing.test.js

**Changed**

    server/features/maintenance.js     company from token or slug, not LIMIT 1
    server/features/applications.js    same
    server/features/session.js         same
    server/lib/auth.js                 the technician role, 2FA in the session
    server/app.js                      slug routing, read-only gate, impersonation context
    server/lib/delivery/*.js           per-company sender identity (the 013 gap)
    server/lib/scheduler.js            company-local time
    server/seed.js                     refuse to run against production
    test/isolation.test.js             public routes added to the sweep

---

## Migrations

    014_tenancy.sql       company.slug (unique), verified_at, onboarding state,
                          legal_name, logo, business hours, currency
    015_staff_invites.sql staff_invite, the technician role in the CHECK,
                          totp_secret and recovery codes on staff
    016_billing.sql       subscription, plan, stripe ids, read-only flag,
                          stripe_event for webhook idempotency
    017_platform.sql      platform_admin, impersonation_log

Every new table carries `company_id` except `stripe_event` and
`platform_admin`, for the reasons the isolation test's parent-scoped list
already records for `delivery_event`. The `migrate()` sweep covers RLS; the
lockdown's default privileges cover grants. Both are asserted by the suite.

---

## Risks

**This phase touches the authentication path.** Signup, invites, 2FA and
impersonation all modify how a session comes to exist. The Phase 0 suite covers
the current behaviour, which is what makes this safe to attempt; every change
here lands with its test in the same commit.

**Timezone changes affect existing data.** Making due dates company-local
changes what "overdue" means for rows computed under the old assumption. I will
check whether any seeded or live data shifts and report it rather than silently
recompute.

**Read-only is a new cross-cutting state.** Enforced in the gate, but a missed
write path means a lapsed customer can still write. The test drives every POST
route against a lapsed company, the same way isolation drives every route
against another company's ids.

**Impersonation is a backdoor by design.** Scoped to one env-var address,
logged both sides, banner visible throughout. It cannot be used to change a
password or disable 2FA — support access should let you see what a customer
sees, not become them.

---

## What will be verified, and what will not

Verified: signup and verification end to end, invite acceptance and expiry, the
role gate with the new role, TOTP against generated codes including clock skew
and replay, recovery codes being single-use, read-only refusing every write,
impersonation logging, and the whole public surface resolving to the right
company with two companies seeded.

Not verified without your input: that Stripe's live webhook signature matches
my reading of their spec (built and tested against generated vectors and test
mode), and real card flows. Recorded in `docs/OPEN-ITEMS.md`.
