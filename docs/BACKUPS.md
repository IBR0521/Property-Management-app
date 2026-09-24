# Backups, and the drill that proves them

A backup you have never restored is not a backup. It is a file you hope about.

This document says what is backed up, what is *not*, how to restore, and how
to prove a restore worked. The last part is the one that usually gets skipped,
so it is a script — `scripts/restoredrill.sh` — rather than a paragraph.

---

## What holds the data

Three systems, and only one of them is Postgres. This matters more than
anything else on this page, because a plan that covers the database and calls
itself finished leaves two holes.

| Where | What lives there | Backed up by |
|---|---|---|
| **Supabase Postgres** | Everything in the schema: the ledger, leases, tenants, journals, audit log | Supabase automated backups + PITR |
| **Vercel Blob** | Uploaded files — work-order photographs, receipts, vendor insurance certificates, inspection photographs, signed documents | **Nothing yet. See the gap below.** |
| **Provider systems** | Stripe payment records, email/SMS delivery logs at the provider | The provider's own retention; we hold references |

### The gap: uploaded files

Postgres stores the *path* to a photograph. The photograph is in Vercel Blob.
A point-in-time restore of the database brings back a row that names a file and
has no opinion about whether the file is still there.

That failure mode is quiet and it is expensive. A deposit dispute turns on the
move-out photographs; an insurance claim turns on the certificate; a chargeback
turns on the receipt. Rows without files look like a complete restore right up
until somebody opens the record.

`node server/lib/verify.js --files` reads every file the database names and
reports the ones that are gone. It is the only check here that crosses the
boundary between the two systems, and it is why the drill mentions the blob
store even when it passes.

**What is still owed:** Vercel Blob has no scheduled export. Until one exists,
the file store has exactly one copy. This is an open item, not a solved
problem, and it is written down as one in `docs/OPEN-ITEMS.md`.

---

## Supabase: what is on, and what to turn on

Check these in the Supabase dashboard under **Database → Backups**. The
settings differ by plan, and the free plan's retention is short enough that a
problem discovered on a Monday can be older than the oldest backup.

| Setting | What it should be | Why |
|---|---|---|
| Daily backups | On | The floor. |
| Point-in-time recovery | On, 7 days minimum | A bad migration or a wrong `UPDATE` is usually noticed hours later, not immediately. Daily backups alone mean losing up to a day; PITR means losing up to a minute. |
| Retention | 7 days minimum, 30 preferred | Long enough that a problem found after a weekend is still recoverable. |

PITR is a paid feature. If it is not enabled, say so plainly rather than
assuming it: the difference between "we have backups" and "we can recover to
the minute before the mistake" is the whole question.

---

## Restoring

### The whole database, to a point in time

In the Supabase dashboard: **Database → Backups → Point in time**, choose the
timestamp, confirm. Supabase restores into the same project.

Before doing this on production, know two things:

1. **Everything after that timestamp is gone.** Payments recorded, work orders
   raised, messages sent. There is no merge. If the problem is one bad row,
   fix the row; PITR is for damage broad enough that losing the afternoon is
   the cheaper option.
2. **The blob store does not roll back with it.** Files uploaded after the
   restore point stay; the rows that referenced them do not. Run
   `node server/lib/verify.js --files` afterwards and expect orphans.

### One table, or a few rows

Restore the dump into a scratch database and copy out what you need. Never
restore a production database in place to recover a handful of rows.

```bash
createdb propops_recovery
pg_restore --dbname=propops_recovery --no-owner --no-privileges backup.dump
```

Then read what you need out of `propops_recovery` and write it back through
the application, not with raw SQL — the journal is append-only and has
triggers that exist precisely to stop hand-written repairs.

---

## The drill

```bash
scripts/restoredrill.sh                 # against propops_test
scripts/restoredrill.sh propops         # against a named local database
SOURCE_URL=postgres://... scripts/restoredrill.sh   # against a remote
DRILL_FILES=1 scripts/restoredrill.sh   # read every uploaded file too
```

It dumps, creates a separate database, restores into it, and then asks whether
what came back is **sound** — not merely present. It never writes to the
source, and it drops the drill database when it finishes.

### What "sound" means

`server/lib/verify.js` asks the questions the application itself refuses to be
wrong about:

- every journal balances
- the trial balance nets to zero, per company
- every ledger entry has a journal behind it
- every split's date matches its journal's (migration 046 copied it; this
  checks the copy rather than assuming it)
- owner funds held agree with the owners' own ledgers
- nothing references a row that is gone
- with `--files`: every uploaded file the database names is readable

### Why it compares rather than just checking

The drill verifies the **source** first, then the restore, and fails only on
problems the restore *introduced*.

A backup's job is to bring back what was there — including the problems. The
live database is carrying a real one right now: deposits recorded on leases
that were never posted to the ledger (OPEN-ITEMS A4). A drill that failed on
that would fail every single time, for a reason that has nothing to do with
the restore, and within a month nobody would read the output.

So pre-existing findings are printed and do not fail the drill. New ones fail
it. And a problem that is in the source but *not* in the restore also fails
it, because that means the two databases disagree and the copy is the one that
changed.

### What the drill does not prove

Stated in its own output, because a drill that overclaims is worse than no
drill:

- **It does not prove Supabase's PITR works.** It proves `pg_dump` and
  `pg_restore` round-trip this schema. Supabase's restore is a different
  mechanism and has to be drilled against Supabase itself.
- **It does not cover the blob store** unless run with `DRILL_FILES=1`, and
  even then it checks that files the database names are readable — not that
  they are backed up anywhere.
- **It does not test the application against the restored data.** The schema
  and the books are checked; nothing signs in.

---

## Before launch

- [ ] PITR enabled on Supabase with at least 7 days' retention
- [ ] `scripts/restoredrill.sh` run against a **real Supabase PITR restore**,
      not just a local `pg_dump` round trip
- [ ] A backup of the Vercel Blob store exists at all — currently it does not
- [ ] Someone other than the author has run the drill and read the output
