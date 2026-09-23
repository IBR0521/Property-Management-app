# Phase 7a — Migration in and out. What was built, and what it found.

Nine commits, `a8b058b` to `0030f5b`. Six test files added; **1452 green**, from 1361 at the end of Phase 6.

Two features, and they are the same promise from opposite ends: a company can
bring their portfolio in from somebody else's system, and take all of it out
again whenever they like. The second one is what makes the first one safe to
accept.

---

## The import

`/app/setup/import`. Upload, preview, commit.

**One transaction.** Owners, properties, units, tenants, leases, the tenancies
between them, vendors, and one opening journal — all of it or none of it. A
portfolio that is half here is worse than one that is not here at all, because
nobody can tell which half.

**Matching is by source id and only by source id.** A company with "1507 Brice
Rd" importing a file containing "1507 Brice Rd" might be re-importing the same
building or might have two on that road. Guessing wrong merges two real
properties and there is no undo. The uniqueness is a partial index in the
database rather than a check in code, for the same reason the rent charge's
is: two uploads at once would both pass a check.

**The preview is the validation, not a summary of it.** It is re-read from the
uploaded bytes every time the page is opened, and the commit runs it once more
before writing a row — so a preview approved on Tuesday cannot write against a
portfolio that changed on Wednesday. If it no longer passes, the commit
refuses and says so.

**What the screen shows before it will continue:** every column that was read
and what it became; every column that was **not** read, by name; every row with
a problem and its row number; and the three figures that become a journal —
what tenants owe, what they have paid ahead, what is held as a deposit.

**Confirmation is typed, not ticked.** `import my portfolio`, in full. A
checkbox gets the same reflex that clicks past a cookie banner, and this
creates a portfolio and posts a journal.

**The opening journal is a position, not a history.** One journal dated the
conversion date, against `3100 Opening balance conversion`. What a tenant owes
today is a fact the file knows; which account it hit on which date two years
ago is not, and recording an inference as though it were an observation is how
a migrated book stops being trustworthy.

**The trust balance is asked for and never invented.** The files say what is
owed; only a bank says what is held. Leave it blank and the screen says plainly
that the deposits will read as a shortfall on the reconciliation until a
statement is reconciled — which is true.

### The accounting bug the import found

The import posted a tenant in credit at conversion to `2300 Prepaid rent` and
to **no owner's ledger**. The trust reconciliation compares the owners' control
accounts against the sum of the owner ledgers, so every migrated company with
one tenant in credit read as having a control account that disagreed with its
subsidiary ledger by exactly that credit. It was right to say so.

The credit now reaches the owner's ledger as well, carried on the same journal
rather than posting a second one.

**I first went after this in the wrong place, and the wrong turning is worth
recording.** My reading was that money paid ahead of a charge is not the
owner's and should not reach their statement, so I changed `postMoney` to write
the owner only the earned part of a receipt. That breaks the identity the
reconciliation checks: `2200` and `2300` are *both* money the company holds for
that owner, the reconciliation compares their sum against the owner ledgers,
and splitting the receipt across the two while crediting the owner with only
part of it is precisely what makes them disagree. Reverted, and the real cause
— the import's own opening journal — fixed instead.

Verified on the seeded company after a real import through the browser:
`Owner funds against the owners' own ledgers — $0.00`.

### The product gap the import found

**A lease here has one rent and one due day.** No pet rent, no parking, no
storage, no monthly utility billing — the feature does not exist, and
"recurring charges" is still on the roadmap for this phase. So an AppFolio
export where a tenant pays $1,450 rent, $50 for the dog and $75 for a space
imports as $1,450 and loses $125 a month, on every lease.

The preview already lists every column it did not read, and that is not enough:
in a list of thirty unread headings it reads as things that did not matter.
Money somebody is contractually paying is not that. So a lease file carrying
`pet rent`, `parking`, `storage`, `RUBS` or any of about thirty other spellings
now gets its own warning, in its own words, with the consequence spelled out —
*that money will not be billed after the import* — before anybody commits. Not
an error: the import is still the right thing to do, and whether to fold it
into the rent or keep billing it elsewhere is theirs to decide.

Recorded in OPEN-ITEMS as item D. It needs a schema for the charge, a place in
the monthly charge run, and a line on the owner statement — which is a feature,
not a fix, and not this phase.

### What else the import screens do

A blank CSV template per file, headings only, for the company whose old system
has no export worth the name. No example row: an example row is a row, and
somebody will import it.

Column aliases cover AppFolio, Buildium, DoorLoop, Rent Manager and a
hand-made spreadsheet, written from published documentation. **Whether a
customer's actual 2026 export matches is unverified and cannot be verified
from here** — which is exactly why an unmatched required column is loud rather
than quiet.

Migration `038` holds the upload between the preview and the commit, and the
scheduler nulls it after a week. It holds a customer's whole portfolio in plain
text; a committed batch has no use for it and an abandoned one has no use for
it either. The batch row stays, because "what did that import do" is a question
asked afterwards.

---

## The export

`/app/setup/export`. One button, one archive, no ticket to raise.

**A ZIP written by hand** — local header, deflated data, central directory, end
record — because a customer's right to leave should not rest on a package I
have not read. It writes UTF-8 names marked as such, and **ZIP64** when the
archive passes 4GB, an entry passes 4GB, or there are more than 65,535 of them.
A portfolio with ten years of repair photos reaches all three eventually, and
the failure mode without ZIP64 is not an error: it is an archive that opens and
is quietly missing files.

**Every table in the database has a decision attached**, in
`server/lib/export/tables.js`, and a test fails when a migration adds one that
nobody has decided about. That test is the point of the file. An export that
silently stops being complete is worse than one that never existed, because
the customer believes they have taken everything.

**What is left out is credentials and nothing else.** Password hashes, TOTP
secrets, session tokens, recovery codes, the bank connection's access token,
the processor's payment-method token. No figure, no date and no record of
something that happened is withheld — the last four digits of an account stay,
because that is what a person uses to recognise it; the full number does not.
The README inside every archive lists the omissions and the reason for each,
and the same list is on the screen before the download.

**The files themselves are in it**, not just their names: photographs,
receipts, certificates of insurance, with `files/index.csv` mapping each one
back to the row it belongs to. A file that cannot be read becomes a note in the
archive saying what happened, and the README says so too — rather than being
silently absent.

**One snapshot.** The sixty-odd table reads run in a single repeatable-read,
read-only transaction. At the default isolation they would see sixty-odd
different moments, and a portfolio in use during an export would produce an
archive whose files do not agree — a lease naming a journal that is not in
`journal.csv` because it was posted between two queries. Nobody would notice
until they tried to load it somewhere.

The uploaded files are streamed one at a time with backpressure, so a thousand
photographs cost one photograph. And the download is recorded in the audit log
*before* it runs, because an export that timed out halfway is still somebody
having read the whole portfolio.

### Leaving and coming back are the same act

The archive carries the portfolio **twice**, on purpose.

`data/` is the record as it is held: database column names, amounts in cents,
every column of every table. That is what somebody mapping into a different
system needs, and it is deliberately not tidied. It is also, for exactly those
reasons, not importable by anything — `line1` is not a column name the importer
looks for, and `rent_cents` holding 120000 would read as a rent of one hundred
and twenty thousand dollars.

`import/` is the same six entities spelled the way this application's own
importer spells them, with money in dollars, read by exactly the code that
reads a customer's export from somewhere else. It is there so that **"no
lock-in" can be tested rather than asserted**: a test exports a company,
imports the archive into an empty one, and compares the rent, the deposit, the
unit, the address, the owner and the opening position, including the sign on a
tenant in credit.

Exercised on the seeded company as well as on a fixture. Its export validates
with zero problems — 3 owners, 5 properties, 8 units, 7 tenants, 7 leases, 7
contractors — and the carried position agrees with the journal to the cent:

    2300 Prepaid rent      $6,580.33 credit
    export "balance" column   sums to  −$6,580.33

The `import/` folder is **not** everything, and the README says so rather than
letting the name imply it. Work orders, journals, messages and documents are in
`data/`, and nothing in this application reads them back in.

**Where it stops working, said rather than discovered.** The table data is not
streamed — the single-snapshot guarantee is exactly the thing that requires
holding it. For a few thousand units that is tens of megabytes and fine. For a
portfolio with millions of journal splits it is not, and it would hit a
serverless timeout before it hit a memory limit. The fix there is a background
job that builds into blob storage and emails a link, which is a differently
shaped piece of code rather than a bigger buffer. OPEN-ITEMS item E.

---

## Three authorisation holes, found while building this

Not part of the phase, found by reading the capability table in order to put
the two new sections in the right place.

The sidebar has always declared that `/app/company`, `/app/billing` and
`/app/company/access` need `settings.manage`, and **the routing gate had no
entry for any of them**. The comment above the nav says the gate is the
enforcement and the nav only stops showing people doors that will not open.
That was true of every other entry and not of those three.

So any signed-in account — including a technician, whose whole design is that
they see their own jobs and nothing else — could open company settings and
`POST` to them: rename the company, change the emergency phone number, change
the address emails are sent from, and change the public handle that every
printed QR sticker points at.

`/app/messages` had neither a gate nor a `need`: every message to every tenant
and owner, with its body, and the buttons that discard or re-send them.

Fixed: four entries in the capability table, and a test that holds the sidebar
and the gate against each other for every role. The drift is silent in exactly
one direction — a hidden link nobody can open is a nuisance nobody reports; an
open path nobody is shown is a hole nobody finds — so it is now a test rather
than a habit.

---

## What I could not verify

- **That a real AppFolio, Buildium, DoorLoop or Rent Manager export imports
  cleanly.** The column aliases are from published documentation, exercised
  against files I wrote. The first real migration will find differences.
- **A portfolio large enough to need ZIP64.** The 64-bit path is exercised by
  lowering the thresholds in a test rather than by building four gigabytes.
  Both forms are checked by a reader written from the other end of the
  specification *and* by Info-ZIP's own `unzip -t`, which validates every CRC.
- **A round trip of anything but the six importable entities.** Work orders,
  journals and messages export and do not import, because there is nothing to
  import them into. Stated in the archive's own README.
- **The export against blob storage.** Locally the files come off disk. The
  blob branch is a `fetch` of a URL the database already holds and is
  structurally the same, but it has not run against Vercel Blob.
- **Anything on the deployed instance.** The Vercel deployment still runs old
  code — diagnosed in Phase 4, still unfixed, still in OPEN-ITEMS.

---

## What I need from you

Nothing new. The items from the Phase 6 report still stand, and the security
items in OPEN-ITEMS (rotate the service-role key and the database password,
enforce SSL, load the CA certificate) are still the most overdue thing here.

One thing to decide when you are ready: whether the import should be reachable
during sign-up as well as from Setup. Today a new company signs up, lands on an
empty queue, and has to find Setup. Putting it in the welcome flow is a small
change and a different decision about what the first five minutes should be.
