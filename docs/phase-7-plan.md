# Phase 7 — Migration, integrations and API

Plan. **Approved, split in two, with QuickBooks dropped.**

    7a   the import wizard and the full data export
    7b   the public API and outbound webhooks

QuickBooks is not built. It needs an Intuit developer account, an OAuth client
and a sandbox company — credentials that do not exist here — and building an
integration that cannot be exercised against the thing it integrates with
produces confidence rather than evidence. Recorded in OPEN-ITEMS as work, not
as a gap that was overlooked.

---

## What this phase actually is

Five items on the roadmap, but they are not five equal things. Two of them —
the import wizard and the public API — are where this application first meets
data and callers it did not create. Everything before now has been the product
talking to itself.

That changes what the risks are. A bug in a report shows somebody a wrong
number. A bug in the import writes a wrong portfolio into their books, and a
bug in the API lets a caller do something no screen would have allowed.

So the plan leads with the four decisions that shape it, then the work.

---

## The four decisions

### 1. A half-finished import is worse than a failed one

An import creates relationships: a lease points at a unit, which points at a
property, which points at an owner. If owners land and leases fail, a customer
has half a portfolio and no way to tell which half.

So **one transaction for the whole import**, and a dry run that is a real dry
run — every row validated against the same rules the commit will use, with
row-level errors, before anything is written.

**[default] An import is idempotent by a batch key.** Somebody will upload the
same file twice; somebody's browser will retry a POST. Each row carries the
source system's own id where it has one, and `(company_id, source_system,
source_id)` is unique. A second upload of the same file reports "already
imported" rather than creating a second portfolio.

**The transaction is genuinely large.** Two thousand units with leases and
tenants is perhaps 10,000 rows in one transaction. Postgres will do that
comfortably; it is worth stating because the obvious alternative — commit per
table — is exactly the half-finished import this is avoiding.

### 2. Opening balances are a conversion, not history

The roadmap says opening balances post through `postJournal()` with a clear
conversion memo, and `convert.js` already did this once in Phase 3. Its
argument holds and is worth repeating: back-dating a journal per historical
transaction asserts detail — which account, which side, on which date — that is
being inferred now from a spreadsheet, not recorded then.

So: **one opening journal per company, against `3100 Opening balance
conversion`**, dated the conversion date, with per-owner and per-lease splits
so the carried-in position is a fact about each of them rather than a single
number.

Security deposits carry in the same way, against `2100 Tenant deposits held` —
which will also close OPEN-ITEMS' finding that deposits exist on leases and in
no account.

### 3. An API key is an actor, not a bypass

This is the decision I feel strongest about. Every invariant in this
application is enforced in one place: spend over an owner's threshold cannot
be dispatched without approval, an unapproved notice cannot be sent, the
journal is append-only, no applicant is scored automatically.

An API that reached the tables directly would be a hole in every one of them,
and it would be a hole nobody notices until a customer's integration has been
writing through it for a year.

So **the API calls the same functions the screens call** — `postJournal`,
`postMoney`, `closeOut`, `recordInvoice` — and an API key is checked against
the same capability table as a member of staff. A key cannot do something a
person could not. Where the API needs something no screen does, that is a new
function with its own rules, not a raw insert.

**[default] Keys are scoped and read-only by default.** A key is created with
explicit scopes; the absence of a scope is a refusal. Hashed at rest with
SHA-256, shown once, never again — the same shape as the portal's magic-link
tokens, which already work this way.

### 4. A webhook URL is attacker-controlled

A customer types the URL. On a cloud host, `http://169.254.169.254/` is the
metadata service and `http://localhost:5432` is the database, and a webhook
that posts to either is a server-side request forgery with a signature on it.

So: **https only, public addresses only**, with the resolved IP checked against
private and link-local ranges at send time rather than at save time — because
DNS can be re-pointed after a URL is saved, and checking once is checking the
wrong moment.

Signed with HMAC over `timestamp.body`, the same construction
`server/lib/stripe.js` already verifies on the way in, so replay has a window
rather than being unbounded. Retried through the existing backoff in
`delivery/retry.js`.

---

## The work

### Import wizard

| | |
|---|---|
| Parse | CSV, reusing the money and date readers in `banking.js` — they already handle `$1,450.00`, `(250.00)` and US slash dates, which is most of what a competitor's export contains |
| Map | Column mappings per source: AppFolio, Buildium, DoorLoop, Rent Manager, plus a generic template |
| Validate | Every row, against the same rules the commit uses. Row number, column, and what is wrong |
| Preview | What would be created, what would be skipped, and what the opening journal would post |
| Commit | One transaction, one `import_batch` row, idempotent by source id |

**What it will not do:** guess. A column it cannot map is an error, not a
best effort. A lease referencing a unit that is not in the file is an error. An
import that silently drops rows is how somebody discovers in March that eleven
tenancies were never created.

### Full data export

Every table the company owns as CSV, plus the uploaded files.

**[default] A ZIP, written by hand.** Node has `zlib` and no archive format.
A ZIP with deflated entries is a local header, the data, and a central
directory — about the same size as the NACHA writer and rather less fiddly
than the PDF one. The alternative is a folder of CSVs and a manifest of URLs,
which is a worse answer to "no lock-in".

**Files are streamed, not buffered.** A company with five years of repair
photos is gigabytes, and building that in memory on a serverless host is how
the export works in development and fails on the first real customer.

### QuickBooks Online — not built

Dropped when the phase was approved. It cannot be exercised against Intuit
from here, and an OAuth integration tested only against a fake of itself is
confidence rather than evidence. The journal already exports as CSV, which is
what an accountant actually asks for.

### Public REST API

    /api/v1/...          JSON, company-scoped by the key
    Authorization: Bearer <key>

Core resources read-first: properties, units, leases, tenants, owners, work
orders, payments, journals. Writes on the few where an integration genuinely
needs them — creating a work order, recording a payment — and each one calls
the same function the screen does.

Rate limited per key through `ratelimit.js`, audit-logged through `audit_log`,
both of which exist.

**OpenAPI is generated from a declaration, not written beside the code.** A
hand-written spec is a document that is wrong within two releases. Each route
declares its shape and the spec is built from that, so a route that changes
shape changes its documentation or fails a test.

### Outbound webhooks

Events worth sending: a work order raised or completed, a payment settled or
returned, a lease signed, an owner approval decided. Signed, retried, with a
delivery log a customer can see — because "did you send it" is the first
question every integration asks.

---

## Files

**New**

    server/lib/import/csv.js          reading, as against writing
    server/lib/import/mappings.js     the four competitors and a generic one
    server/lib/import/validate.js     row-level, shared by preview and commit
    server/lib/import/commit.js       one transaction, idempotent
    server/lib/export/archive.js      a ZIP writer
    server/lib/export/company.js      every table, plus files
    server/lib/api/keys.js            create, hash, scope, revoke
    server/lib/api/router.js          /api/v1, through the same functions
    server/lib/api/openapi.js         generated from the declarations
    server/lib/webhooks/sign.js       HMAC, and the address check
    server/lib/webhooks/send.js       delivery and retry
    server/features/import.js         the wizard
    server/features/apikeys.js        the screens
    test/import*.test.js
    test/export.test.js
    test/api*.test.js
    test/webhooks.test.js

**Migrations**

    037_import.sql     import_batch, and source ids on the imported tables
    038_api.sql        api_key, api_key_scope, api_request_log
    039_webhooks.sql   webhook_endpoint, webhook_delivery

---

## New environment variables

None. Both halves are built from what is already here.

---

## What will and will not be verified

**Verified:** that a dry run and a commit agree row for row; that a second
upload of the same file changes nothing; that a failed row aborts the whole
import; that opening balances post through `postJournal` and the trial balance
still balances afterwards; that the export round-trips — export a company,
import it into an empty one, and the trial balances match; that an API key
cannot do what its holder's role could not; that a webhook refuses a private
address at send time; that the OpenAPI spec matches the routes.

**Not verified:** whether a real AppFolio export matches the mapping. I have
their documented column names and no actual file.

---

## Risks

**The mappings are guesses until somebody supplies a real file.** I can write
the four column mappings from published documentation. Whether a customer's
actual export from AppFolio in 2026 matches is a different question, and the
first real migration will find differences. The mitigation is that the generic
template always works and an unmappable column is an error rather than a
silent skip — so the failure is loud on day one rather than quiet in March.

**The API is a permanent surface.** Everything else in this codebase can be
changed. A published endpoint with customers on it cannot, and `/api/v1` is a
promise. I would rather ship four resources I am sure of than twelve I am not.

**This phase is the largest so far**, which is why it is split. 7a is the half
that touches customer data; 7b is the half that opens a surface which cannot
later be closed.
