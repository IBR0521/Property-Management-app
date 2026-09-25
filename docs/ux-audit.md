# What is hard to understand, and why

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
so all 21 menu items render above the content. A technician opening a repair
on site scrolls past Accounting, Banking, Deposits, Payments out and Lease
documents — none of which they can even open — to reach the job they came for.

This is the user the accessibility work was written for: *"a maintenance
technician using the mobile screens one-handed in bad light."* They currently
cannot use the first screen at all.

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

1. **A phone navigation.** Nothing else on this list matters to a technician
   who cannot get past the menu.
2. **Name things once.** Rename one of the two "People", and make each menu
   item and the page it opens agree. This is wording, not design.
3. **Give the queue a first thing to do.** 2,200 is a wall; the page already
   knows severity and age.
4. **Paginate the long lists.**
5. The small ones above, which are an afternoon.

Everything here is structure and language. None of it needs a new visual idea,
and I have not proposed one.

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
