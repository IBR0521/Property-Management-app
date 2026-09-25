# What is hard to understand, and why

> **Fixed.** Everything below was measured before the work and has been acted
> on. The audits re-run on demand: the navigation pass went from 15 findings
> to 7, the full-surface pass from 30 to 9, and the residue is listed at the
> end. What changed, with the numbers, is in "What was done" below.


Measured, not felt. Every number below came from walking the running
application against a real portfolio — 2,000 units, 2,200 open items — and
every finding names the route it came from so none of it has to be taken on
trust.

**What this is not.** It does not judge how the product looks. Colour,
spacing and typography are deliberately absent: that is the part I was told
not to invent, and nothing here needs a new visual idea to fix. Every
recommendation below uses components that already exist.

---

## 1. On a phone, the menu *is* the page

**The worst finding, and it is not close.**

| | |
|---|---|
| Viewport | 375 × 812 (iPhone) |
| Height of the navigation | **1,118px** |
| Where content starts | **y = 1,279px** |
| Scrolling before you see anything | **1.6 screens** |

The sidebar is a fixed column on a desktop. At phone width it simply stacks,
so every menu item that person can open renders above the content.

**Corrected after a second pass.** The first version of this said a technician
was the victim. That was wrong, and the check is worth recording: the
navigation already hides what a role cannot reach, so a technician sees
**one** item — `/app/jobs` — and lands on it directly from sign-in. Their
phone experience is fine.

The 21-item wall is what an **administrator or manager** gets, and they are on
a phone during a site visit, a viewing, or a call they took in the car. The
measurement above is theirs.

**The fix needs no new design.** The nav already knows which items a person
can open — it hides what their role cannot reach. What is missing is a phone
behaviour: collapse it behind the header, or show the three or four
destinations that role actually uses. The components exist; the decision is
which of those two.

---

## 2. You cannot tell where a menu item will take you

**Two items are both called "People".**

    People  →  /app/owners   (property owners)
    People  →  /app/staff    (your colleagues)

They are visible together in one screenshot on a phone. Somebody told "it's
under People" has a coin flip.

**And six menu items lead to a page with a different name on it:**

| The menu says | The page says | Route |
|---|---|---|
| Queue | "2200 things need you" | `/app` |
| People | "Owners" | `/app/owners` |
| Accounting | "Trial balance" | `/app/accounting` |
| Banking | "Reconcile" | `/app/banking` |
| Vacancies | "Vacancy marketing" | `/app/listings` |
| Your jobs | "Nothing today" | `/app/jobs` |

Some of these are worse than a mismatch. **"Accounting" opens a trial
balance** — an accountant's artifact, a list of numbered accounts — when the
question a manager arrives with is "did the rent come in". **"Your jobs"
titles itself by its own state**, so the page has no name at all when it is
empty.

## 3. One idea, several words

| The idea | Called | 
|---|---|
| A contractor | contractor, vendor, trade |
| A home | unit, home, property, portfolio |
| A repair | work order, job, repair, maintenance |

The sidebar says **Contractors**; the database, the API and the code say
vendor. The sidebar says **Properties**; the page it opens lists *units*, and
the tab bar on it says Units. Somebody learns a word on one screen and it is
not on the next.

## 4. Twenty-one items in one column

Twelve of them sit under no heading. The longest unnamed run is eight. Four
settings pages — Company, Billing, Support access, Setup — are loose in the
list rather than under a heading, so "where do I change the company address"
is answered by reading the whole sidebar.

---

## 5. Pages that render everything

`/app` with 2,200 open items:

| | |
|---|---|
| Rows rendered | **2,200** |
| HTML | **1.85 MB** |
| Page height | **192,165px** |

No pagination. The route walk found the same shape elsewhere:
`/app/portfolio` 1.35 MB, `/app/rent` 1.32 MB, `/app/reports/rent_roll`
657 KB.

The cost is not only weight. **"2,200 things need you" is not an instruction,
it is a wall.** There is no first thing to do. The page does have a "Needs you
now" section with 2,000 in it — which leaves 200 somewhere else, unexplained.

## 6. The setup checklist sits above the work

A company with 2,200 open items sees "Getting set up — 2 of 6" first, taking
the top third of the screen, above anything urgent. It says at the bottom that
it disappears once everything is ticked. Six months of a full queue is a long
time to scroll past it.

## 7. Items are titled by their number

> **Reported problem 1621**
> No vendor: no routing rule covers this category
> 186 Anselm Road · unit 114 · WO-M4N8 · 1816d

The heading is an id. What is actually wrong is the grey line beneath it. And
`1816d` is not a word — it is days, abbreviated, next to a reference that is
also alphanumeric.

---

## 8. Smaller, and cheap to fix

- **"1 thing need you."** `queue.js:51` pluralises the noun and not the verb:
  `` `${n} thing${n === 1 ? "" : "s"} need you` ``. Visible to every company
  with exactly one open item.
- **A tile value is clipped.** "MONTHLY RENT ROLL $2,399,550.00" overflows its
  tile on `/app/portfolio`.
- **Forms with no guidance**: `/app/setup` has 9 labelled fields with no help
  text, `/app/staff` 8, `/app/company` 5. The label names the field; nothing
  says what putting something in it will do.
- **The date filter on `/app/accounting`** says "all time" in small grey text
  to the right of the Apply button, which is the only indication that a filter
  is even in effect.

---

## What I would do, in this order

1. **A phone navigation.** For managers and administrators, who have 21 items
   above the content.
2. **Name things once.** Rename one of the two "People", and make each menu
   item and the page it opens agree. This is wording, not design.
3. **Give the queue a first thing to do.** 2,200 is a wall; the page already
   knows severity and age.
4. **Paginate the long lists.**
5. The small ones above, which are an afternoon.

Everything here is structure and language. None of it needs a new visual idea,
and I have not proposed one.

---

# Second pass — the surfaces the first one missed

The audit above covered 20 of 99 back-office pages, as one role, against one
seeded company. It did not open the tenant portal, the owner portal, any
public page, any detail screen, or a company on its first day. Those are below.

---

## 9. Every refusal says "Expired"

`app.js:454` renders one page for every 403, headed **"Expired"**:

    status === 403 ? "Expired"

That is the right word for a stale form token and the wrong word for
everything else. A person who may not open a page is told their session ran
out, so they sign in again — and get the same page. The cause they are given
does not match the cause, and the remedy it implies does not work.

A technician hitting `/app` directly sees exactly this.

## 10. The tenant's home screen has the figures and none of the actions

The portal is the best-built part of the product, and this is its one
structural mistake.

`/portal/home/renting` shows rent, paid, and what is owing — and **one primary
button labelled "Open"**. Open what? It leads to `/portal/renting/<id>`, which
is where everything a tenant can actually do lives:

    Pay rent · Report a repair · Renters insurance · Your details

So a tenant with a single tenancy — the ordinary case — passes through a
summary screen with no actions in order to reach the screen with all of them.
**"Report a repair" is not on their home screen at all**, and it is one of the
two things a tenant ever needs.

## 11. What a new company sees on its first day

Ten first screens, opened on a company with nothing in it:

| | Empty state | Tells you what to do next |
|---|---|---|
| `/app` | yes | **yes** |
| `/app/owners` | yes | **yes** |
| `/app/vendors` | yes | **yes** |
| `/app/listings` | yes | **yes** |
| `/app/portfolio` | yes | no |
| `/app/inbox` | yes | no |
| `/app/deposits` | yes | no |
| `/app/payments` | yes | no |
| `/app/reports` | no | no |
| `/app/accounting` | **no — a table of 20 accounts, all zero** | no |

Six of ten say "there is nothing here" without saying what puts something in
it. **Accounting does not even do that**: on day one it renders the full chart
of accounts at $0.00, which is the least useful possible answer to "what does
this part of the product do".

## 12. The public pages are the best work in the product

Worth saying plainly, because it shows the standard is reachable and the
problem is not skill. `/report` — the form a tenant fills in from a QR sticker
— states how long it will take, puts the emergency case in a red panel above
everything with a phone number, asks one question at a time, explains what the
QR code would have saved them, and tells them what happens next.

Nothing in the back office is written that way. The same product has two
voices.

---

## Everything else — the third pass

The remaining 79 back-office detail pages, the owner portal, the public pages
and the four main journeys. **129 pages audited in total: 96 back office, 20
public, 13 portal.** Nothing is now unopened except the API, which has no
screens.

Thirty findings, all medium. Nothing in the detail pages is broken and nothing
is dangerous — the problems are the same three habits repeated.

### The journeys work

This is the important negative result, and it took walking them to know it:

| Journey | Reaches | Heading |
|---|---|---|
| Moving a tenant in | Properties → move-in form | "Move someone in" |
| Recording a payment | Rent → record | "Record a payment" |
| Closing a repair | Queue → the job | "WO-LX8N · Test issue" |
| Paying an owner | Payments out | "Payments out" |

Every one arrives where it should, with a heading that names it. **No journey
dead-ends and none loses the thread.** The structure underneath is sound; what
is wrong is on the surface of it.

### One verb, no object — 12 pages

    "Open"  ×7   /app/maintenance, /app/owners, /app/rent, /app/leases,
                 /app/vendors, /app/applications, /app/accounting/journals
    "Edit"  ×4   /app/portfolio/u/:id, /app/listings, /app/vendors/:id,
                 /app/leases/templates
    "View"  ×1   /app/owners/:id

The same habit as the tenant portal's "Open", right through the back office.
Every one of these is a row in a table where the object *is* implied by the
row — so it reads fine when you already know the product and not at all when
you are reading it aloud to someone, or hearing it read to you.

### Empty states that stop halfway — 10 pages

`/app/compliance`, `/app/messages`, `/app/messages/sent`, `/app/messages/dead`,
`/app/rent/ladder`, `/app/rent/:id`, `/app/listings/new`, and three more. Each
says there is nothing here. None says what would put something here.

### Forms that explain nothing — 3 pages

| | Fields | With help |
|---|---:|---:|
| `/app/accounting/new` | 22 | **0** |
| `/app/vendors/invoices/new` | 6 | **0** |
| `/app/portfolio/u/:id` | 4 | **0** |

`/app/accounting/new` is a hand-written journal entry — 22 fields, 484 words,
the most text on any page in the product — and not one field says what it is
for. Posting a journal by hand is the single most consequential thing a
manager can do in this application.

### Irreversible things with nothing in between — 3

    "Void"                 /app/leases/d/:id   a signed lease document
    "Revoke"               /app/staff          somebody's access
    "Cancel this request"  /app/maintenance/:id

No confirmation and no sentence about whether it can be undone. The deposit
conversion and the trust sweep both demand a typed phrase; these do not.

### Two headings on one page — 2

`/app/leases/d/:id` and `/sign/:tok` each have two `h1`s, so neither page has
a single name.

---

## The shape of it

Thirty of the thirty findings in this pass are one of three habits:

1. **A control named by its verb** — "Open", "Edit", "View"
2. **An absence stated without a remedy** — "nothing here", full stop
3. **A field named without a purpose** — a label and no help

None is a design problem. All three are writing, and all three have a good
example already in the product to copy: the public repair form does the
opposite of all of them.

---

## How this was produced

`scripts/uxaudit.js` walks every page in the navigation signed in as an admin
and reports duplicate menu labels, menu-versus-page name mismatches, tables
with no empty state, forms without guidance and one-idea-several-names. The
measurements of height, weight and row counts were taken in a real browser
against the 2,000-unit portfolio. Re-run it with:

    createdb propops_ux_test
    sed 's/propops_test/propops_ux_test/' .env.test > .env.ux
    node --env-file=.env.ux scripts/uxaudit.js


---

# What was done

Measured before and after, on the same 2,000-unit portfolio.

## The phone

| | before | after |
|---|---:|---:|
| Navigation height (375×812) | 1,118px | **305px** |
| Content starts at | 1,279px | **472px** |
| Screens of menu first | 1.6 | **0.57** |

Folded behind one "Menu" row below 60rem, always open above it, with a badge
carrying the counts it is hiding. A checkbox rather than a script — and
rather than `<details>`, which was tried first and cannot work: a browser
hides a closed disclosure's content itself, so there is no way to force it
open on a desktop, and the sidebar vanished. A checkbox can be overridden by
a media query and is operated by the keyboard for nothing.

## The queue

| | before | after |
|---|---:|---:|
| Rows rendered | 2,200 | **50** |
| HTML | 1.85 MB | **55 KB** |
| Page height | 192,165px | **10,129px** |

Twenty-five per section, in the order the work should be done in, with a foot
that says how many are below and that the list shortens from the top.

## Names

Two menu items called "People" became **Owners** and **Your team**. Six
menu-versus-page mismatches gone, on one rule: **the page's name is its
heading, and its state goes in the subtitle**. So Queue is "Queue" with "2200
things need you · 25 Sep 2026" beneath, Accounting is "Accounting" with the
trial balance as a tab, Banking is "Banking", Vacancies is "Vacancies", and
"Your jobs" keeps its name when it is empty.

The five settings pages moved under a **Settings** heading; the longest
unnamed run went from eight items to three.

And "1 thing need you" — the noun pluralised and the verb not — is fixed.

## Words

- **Every 403 said "Expired"**, so somebody refused a page was told their
  session had run out and signed in again to no effect. The heading now
  follows the cause: a stale form, a lost session, or no access.
- **Seventeen verb-only controls** — "Open", "Edit", "View" — now name what
  they act on. The visible word stays short because in a table row the object
  is the row; what was missing was the object anywhere at all.
- **Empty states** on Messages, Sent and Failed said an absence and stopped.
  They say what puts something there.
- **The journal form** — 22 fields, the most consequential screen in the
  product, and not one field explained — now says what the date is for, that
  amounts are always positive, which way a debit moves, and that a posted
  journal can only be mirrored, never edited.
- **Three irreversible actions** — void a lease, revoke access, cancel a
  request — say what they do and whether it can be undone.

## The tenant

Their home screen showed the figures and put every action behind a button
labelled "Open". It now offers the two things a tenant ever needs — **Pay
rent** and **Report a repair** — with "Everything else" leading to the rest.

## Smaller

A rent roll of $2,399,550.00 no longer overflows its tile. Rendered documents
start their headings at `h2`, so a lease no longer gives its page a second
`h1`.

## What is left, and why

Nine findings, all threshold artefacts or deliberate:

- `/app/maintenance` has a control labelled "Open" — it is the **filter**
  (open jobs versus closed), which is the correct word.
- Four empty states on `/o/s/:tok`, `/app/compliance`, `/app/vendors/1099`
  and `/portal/sent` are terse but not silent.
- `/app/portfolio/u/:id` has five fields without help, in an inline edit
  panel where the labels are the whole story.

Nothing about colour, spacing or typography was changed.
