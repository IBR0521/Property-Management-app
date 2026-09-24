# Phase 10 — Launch hardening

Plan. **Not started. The last phase, and it needs your approval.**

Six items on the roadmap:

    Load test at 2,000 units and five years of history
    Backups, and a restore procedure that has been run
    Security pass
    Accessibility pass on the portals
    Rewrite the pre-launch checklist and run it
    Final report: an honest comparison against the four incumbents

This phase does not add features. It is the one where the things that have
been true only in a nine-unit seed get tested at a size somebody would
actually run, and where everything I have said "unverified" about gets
either verified or written down as still unverified with the reason.

---

## 1. The load test

**Seed a company with 2,000 units and five years of history**, then measure
every screen.

That is a real amount of data: 2,000 tenancies charged monthly for sixty
months is 120,000 rent charges, each posting a journal with four splits and a
ledger entry, so roughly **half a million journal splits** before anything
else. Work orders, payments, obligations and messages on top. Generating it
has to be bulk inserts rather than the ordinary write path, or the seed takes
longer than the phase.

**The measurement has to mean something.** Two numbers per screen:

- **wall time**, co-located with the database, which is the roadmap's under-one-second test
- **queries issued**, which is the number that finds the actual problem

Wall time on my machine against local Postgres is not wall time on Vercel
against Supabase's pooler, and I would rather not pretend otherwise. But an
N+1 is an N+1 on any machine, and a page that issues four hundred queries is
broken whatever the clock says. So `db.js` gains a per-request counter that is
off unless asked for, and the test asserts a **budget per screen** — a number
that cannot grow quietly.

Expected findings, from having written these screens: the owner statement, the
trust reconciliation and the applications list all do work per row that could
be one query. I will find out rather than guess.

**Not verified by this:** behaviour on Supabase's transaction pooler under
concurrency, which needs the deployment that still runs old code.

## 2. Backups, and a restore that has been run

Two halves, and only one of them can be tested from here.

**Documented:** Supabase's point-in-time recovery — what it covers, the
retention on the plan you are on, and exactly which buttons restore to a
timestamp. Plus what PITR does **not** cover, which is Vercel Blob: the
photographs, receipts and signed documents live somewhere else and are not in
any database snapshot. A restore that brings back rows pointing at files that
were deleted is a restore that looks complete and is not.

**Tested:** a restore drill against local Postgres. `pg_dump`, drop, restore,
and then a **verification script that says whether the restored database is
actually sound** rather than merely present:

    every ledger entry still has a journal behind it
    every journal still balances
    the trial balance still balances
    the trust reconciliation still reconciles
    row counts match the dump's manifest

That script is the deliverable. Running it after a real Supabase restore is
what turns their documentation into your procedure, and it is the part that is
worth having.

## 3. The security pass

**Authorisation on every route, as a test rather than a habit.** `app.js`
already exports `registeredRoutes()`; there are about 300 registrations now.
The test enumerates them and requires each to be one of:

- gated by a capability in the table, or
- listed as deliberately public **with the reason written beside it**

A route added in a later phase is then either covered or it fails. This is the
same shape as the export's "every table has a decision" test and the sidebar
one from Phase 7b, and it is worth more than any amount of reviewing: those
two both caught real holes.

**Dependency audit.** Two advisories, both reaching us through
`@vercel/blob@0.27`'s bundled `undici@5`. `npm audit fix --force` would move
to `@vercel/blob@2.8`, flagged breaking. We use exactly two of its functions,
`put` and `del`, with arguments that have been stable across those versions —
so the plan is to **try the upgrade and run the suite**, rather than leaving
"your call" in OPEN-ITEMS for another phase. If it passes, the advisories are
gone; if it does not, that is a finding with a reason.

**CSP review.** The roadmap says "after the JS additions". There were none —
Plaid Link was the only thing that would have needed client-side JavaScript
and you deferred it, so the policy is unchanged and `script-src 'self'` still
has nothing to execute. What is worth doing instead is confirming that: a test
that asserts no rendered page carries an inline `<script>` or an external one
outside the policy.

**Webhook replay.** Inbound provider webhooks are already idempotent on the
provider's message id and tested. What is not tested is the outbound side from
a receiver's point of view: that a delivery replayed inside the timestamp
window is recognisable as the *same* delivery by its id, which is why the id
is in the signed material. That is a test I can write against the verifier
that is already in `sign.js`.

**File uploads.** The magic-byte sniff exists. The tests to add are the
bypasses: a PHP file named `.jpg`, a file whose declared type disagrees with
its bytes, an SVG (which is a script delivery mechanism and is not in
`IMAGE_TYPES`), something over the size cap, and a filename that tries to
climb out of the upload directory.

## 4. Accessibility — WCAG 2.1 AA on the portals

Honest about what can and cannot be checked without a person and a screen
reader.

**Testable from the rendered HTML**, and therefore a test:

- every input has a label that is actually associated with it
- every image has an `alt`, and decorative ones have an empty one
- heading levels do not skip
- the page has a `lang`
- every form error is associated with its field rather than floating above it
- nothing conveys meaning by colour alone
- there is a way to skip to the main content

**Computable from the stylesheet:** contrast ratios for every foreground and
background pair in the design tokens, against the 4.5:1 AA threshold for body
text and 3:1 for large text. This will find something — the muted `--ink-soft`
on the panel background is the one I would bet on.

**Not testable here, and it will be said in the report:** screen reader
behaviour, keyboard traps in real use, and whether the reading order matches
the visual one on a phone.

The portals first, because a tenant or an owner did not choose this software
and cannot ask for a different one. The staff app after, if the same fixes
carry.

## 5. The pre-launch checklist

The one in `server/README.md` is badly out of date and that is a finding in
itself. It still says message delivery "is the blocker" — that was Phase 1,
and delivery was built with providers, retries and a delivery log in the same
phase. It still says to back up `data/app.db`, which has been Postgres since
Phase 4. It lists two dependencies; there are four.

So: rewrite it against what the application actually is now, mark every item
either done or yours, and **run it** — which means going through it line by
line and recording the answer, not ticking it.

## 6. The final report

A feature comparison against **AppFolio, Buildium, DoorLoop and Rentvine**,
listing honestly what is still missing.

Two rules for it, or it is marketing:

- **Where they have something and we do not, it says so plainly** — not
  "planned", not "by design" unless it genuinely is.
- **Where we do something differently on purpose**, the reason is given and
  the cost is stated. No automated applicant scoring is a feature to me and a
  missing feature to somebody comparing checklists, and the report should say
  both.

I will research what those four actually do today rather than writing from
memory, and cite it.

---

## Files

**New**

    server/lib/dev/querycount.js        per-request query counting, off by default
    scripts/loadseed.js                 2,000 units and five years, in bulk
    scripts/restoredrill.sh             dump, drop, restore
    server/lib/verify.js                is this database sound
    test/load.test.js                   query budgets per screen
    test/routes.test.js                 every route is gated or deliberately public
    test/uploads.test.js                the bypasses
    test/accessibility.test.js          what the HTML can be asked
    test/contrast.test.js               the tokens against 4.5:1
    docs/phase-10-report.md             including the comparison

**Changed**

    server/README.md                    the checklist, rewritten and run
    package.json                        @vercel/blob, if the upgrade holds
    whatever the load test finds

---

## New environment variables

**None.**

---

## What will and will not be verified

**Verified:** query counts per screen at 2,000 units; that a restored database
is sound, by a script that checks the invariants rather than the row counts
alone; that every registered route is gated or deliberately public; that the
upload sniff refuses the bypasses; that no page carries script the policy does
not allow; that the contrast ratios meet AA, or a list of the ones that do
not; that an outbound webhook replay is recognisable as the same delivery.

**Not verified:** wall-clock times on Vercel against Supabase, concurrency on
the transaction pooler, a real Supabase point-in-time restore, screen reader
behaviour, and anything at all on the deployed instance — which still runs old
code, diagnosed in Phase 4 and still in OPEN-ITEMS.

---

## Risks

**The load test will find things, and fixing them changes query shapes on
screens that are already tested.** That is the point, but it means this phase
touches a lot of code that currently works. The suite is what makes that safe,
and it is 78 files now.

**The `@vercel/blob` upgrade might not be clean.** If it is not, we are
choosing between two known advisories and a breaking change, and that is a
decision rather than a task.

**An accessibility pass that only reads HTML will pass things a person would
fail.** I will not claim WCAG 2.1 AA conformance on the strength of it. What I
can claim is that the mechanical failures are gone, which is where most of
them are.

**This is the last phase on the roadmap, and "launch hardening" is not the
same as "ready to launch".** The things outside this codebase — the rotated
keys, the sending domain, the Stripe account, the deployment that runs current
code — are still the gate, and the final report will say so rather than
implying a green suite means a live product.
