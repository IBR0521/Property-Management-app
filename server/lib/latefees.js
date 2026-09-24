/* The daily late-fee sweep.

   Three things make this safe to run twice, which matters because cron
   delivery is at-least-once and a retry after a timeout is normal.

   The real guarantee is the unique index on (lease_id, period). The sweep
   inserts and lets the database refuse a duplicate, rather than checking first
   and then inserting — a check-then-insert has a window between the two, and
   that window is exactly where a double charge lives.

   The coarse guard is a partial unique index on job_run, not an advisory lock.
   Postgres advisory locks cannot do this job through Supabase's pooler on port
   6543, which is pgbouncer in transaction mode: a session-scoped lock is taken
   on a backend connection the next statement may not be given, and a
   transaction-scoped one is released the instant its statement ends. Either
   way you get a no-op that reads like a guarantee. One unfinished job_run row
   per job name is enforced by the database, is visible to every connection,
   and is released by the update that finishes the run.

   And nothing is charged without a policy. A lease with no late-fee terms gets
   no fee — inventing a charge because a field was blank is how a company ends
   up refunding a year of them. */
import { all, get, one, run, insert, tx } from "./db.js";
import { todayIn } from "./timezone.js";
import { id } from "./ids.js";
import { stamp, today, monthKey, daysBetween, dueDateFor, prevMonthRange, monthRange, addDays }
  from "./dates.js";

const JOB_NAME = "late-fee-sweep";

/* How long a run may be unfinished before it is presumed dead. A serverless
   function that is killed mid-sweep never writes its finished_at, and without
   this the job would be locked out forever by a process that no longer
   exists. Comfortably longer than the function's own timeout. */
const STALE_AFTER_MS = 30 * 60 * 1000;

export function feeFor(lease, { rentCents, daysLate, graceDays }) {
  const beyondGrace = daysLate - graceDays;
  if (beyondGrace <= 0) return null;

  const flat = lease.late_fee_cents;
  const percent = lease.late_fee_percent;

  let base = null;
  let basis = "";
  if (flat != null && flat > 0) {
    base = flat;
    basis = `flat ${(flat / 100).toFixed(2)}`;
  } else if (percent != null && percent > 0) {
    base = Math.round(rentCents * (percent / 100));
    basis = `${percent}% of rent ${(rentCents / 100).toFixed(2)}`;
  } else {
    // No policy on this lease. Deliberately nothing, not a default.
    return null;
  }

  let amount = base;
  if (lease.late_fee_daily) {
    amount = base * beyondGrace;
    basis += ` per day × ${beyondGrace} day(s) past grace`;
  } else {
    basis += ` once, ${beyondGrace} day(s) past grace`;
  }

  const cap = lease.late_fee_max_cents;
  if (cap != null && cap > 0 && amount > cap) {
    amount = cap;
    basis += `, capped at ${(cap / 100).toFixed(2)}`;
  }
  return amount > 0 ? { amount, basis } : null;
}

/* Which leases are late and unpaid, with everything the calculation needs. One
   query rather than a loop of them: a serverless function pays a round trip for
   each, and this runs over the whole portfolio. */
/* Every active lease, with the timezone of the company that manages it.

   The date filtering that used to happen here now happens per lease, because
   "today" is not one date. A sweep running at 09:00 UTC is at 04:00 in
   Columbus — still the previous day — and on the first of the month that is
   the difference between a fee charged a day early and one charged correctly.
   Rent is due on a calendar date where the building is. */
async function candidates() {
  return await all(
    `SELECT l.*, u.id AS unit_id2, p.owner_id, p.id AS property_id,
            l.company_id AS cid, c.timezone AS company_timezone
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN company c ON c.id = l.company_id
      WHERE l.status = 'active'`);
}

/* Rent recorded against this lease for the period it is being judged on. Per
   lease rather than in the sweep query, because each lease's period is derived
   from its own company's calendar. */
async function paidInPeriod(leaseId, period) {
  const row = await get(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid FROM ledger_entry
      WHERE lease_id = ? AND kind = 'rent_payment' AND date >= ?`,
    leaseId, `${period}-01`);
  return Number(row?.paid || 0);
}

/* Runs the sweep. Returns counts; the caller decides what to do with them.

   `postJournal` is imported lazily because features/accounting.js imports from
   lib/*, and importing it at module scope here would close the loop. */
/* Which periods this lease can be judged on today.

   Always the current one. The previous one *only* when it could never have
   been judged inside its own month.

   The sweep used to look at `monthKey(today)` and nothing else, which gave a
   period a window running from the day after it fell due to the end of that
   same month. Rent due on the 1st has most of the month; nothing was wrong.
   Rent due late in the month can have no window at all — rent due on the 31st
   is first overdue on the 1st, by which time the sweep had moved to the next
   period and would never look back. It was never only the last day either:
   the 28th with five days grace needs the 34th of January, and there isn't
   one. Those leases were allowed all along and silently never charged.

   The condition is exact rather than "always look back one month", and the
   difference matters. An unconditional lookback would, on its first run after
   this ships, charge a back-dated fee against every lease that happened to be
   behind last month — periods the manager had already passed over. Only the
   periods whose window did not exist are reopened; a lease due on the 1st is
   assessed exactly as it was before. */
function assessablePeriods(lease, localToday) {
  const current = monthKey(localToday);
  const dueDay = Math.min(Math.max(Number(lease.rent_due_day) || 1, 1), 31);
  const grace = Number(lease.grace_days) || 0;

  const prev = monthKey(prevMonthRange(localToday).start);
  /* The first day the fee could be charged for that period, and the last day
     the old sweep would still have been looking at it. */
  const firstChargeable = addDays(dueDateFor(prev, dueDay), grace + 1);
  const prevMonthEnd = monthRange(`${prev}-01`).end;

  return firstChargeable > prevMonthEnd ? [prev, current] : [current];
}

/* `asOf` overrides every company's local date, which only a test wants. Left
   undefined in production so each lease is judged on its own calendar. */
export async function sweepLateFees({ asOf = null, postedBy = "system", now = new Date() } = {}) {
  const out = { charged: 0, amountCents: 0, skipped: 0, duplicates: 0, noPolicy: 0, considered: 0 };

  const rows = await candidates();
  out.considered = rows.length;
  if (!rows.length) return out;

  const { postJournal, ACCT } = await import("../features/accounting.js");

  for (const lease of rows) {
    /* The company's date, not the server's. */
    const localToday = asOf || todayIn(lease.company_timezone, now);

    if (lease.start_date > localToday) { out.skipped++; continue; }

    const periods = assessablePeriods(lease, localToday);

    for (const period of periods) {
      if (period < monthKey(lease.start_date)) { out.skipped++; continue; }

      const already = await get(
        "SELECT id FROM late_fee WHERE lease_id = ? AND period = ?", lease.id, period);
      if (already) { out.skipped++; continue; }

      /* Through `dueDateFor`, which resolves the day against the real length
         of the month. Built by string concatenation before, which was safe
         only while the day could not exceed 28: `2026-02-31` is not a date,
         and no day is ever greater than it, so a tenant due on the 31st was
         silently never late. */
      const dueDay = Math.min(Math.max(Number(lease.rent_due_day) || 1, 1), 31);
      const dueDate = dueDateFor(period, dueDay);
      if (localToday <= dueDate) { out.skipped++; continue; }

      const daysLate = daysBetween(dueDate, localToday);
      const outstanding = Number(lease.rent_cents) - await paidInPeriod(lease.id, period);
      if (outstanding <= 0) { out.skipped++; continue; }

      const fee = feeFor(lease, {
        rentCents: Number(lease.rent_cents),
        daysLate,
        graceDays: Number(lease.grace_days) || 0,
      });
      if (!fee) { out.noPolicy++; continue; }

      try {
        /* One transaction per fee: the fee, the owner-visible ledger line and
           the journal either all land or none do. A fee charged without its
           accounting is a number on a statement that reconciles to nothing. */
        await tx(async () => {
          const feeId = id();
          const entryId = id();

          await insert("late_fee", {
            id: feeId, company_id: lease.cid, lease_id: lease.id, unit_id: lease.unit_id,
            period, assessed_date: localToday, amount_cents: fee.amount, basis: fee.basis,
            rent_cents: lease.rent_cents, days_late: daysLate, created_at: stamp(),
          });

          await insert("ledger_entry", {
            id: entryId, company_id: lease.cid, owner_id: lease.owner_id,
            property_id: lease.property_id, unit_id: lease.unit_id, lease_id: lease.id,
            date: localToday, kind: "other", amount_cents: fee.amount,
            memo: `Late fee ${period} — ${fee.basis}`,
            source: "system", created_at: stamp(),
          });

          const jid = await postJournal({
            companyId: lease.cid, date: localToday,
            memo: `Late fee ${period}`,
            source: "late_fee", sourceType: "late_fee", sourceId: feeId, postedBy,
            splits: [
              { code: ACCT.RENT_RECEIVABLE, debit: fee.amount, leaseId: lease.id,
                unitId: lease.unit_id, ownerId: lease.owner_id, memo: fee.basis },
              { code: ACCT.LATE_FEE_INCOME, credit: fee.amount, leaseId: lease.id,
                ownerId: lease.owner_id, memo: `late fee ${period}` },
            ],
          });

          await run("UPDATE late_fee SET journal_id = ?, ledger_entry_id = ? WHERE id = ?",
            jid, entryId, feeId);
          /* The sweep already posted both books; this links them so the parity
             check sees a fee as posted rather than as an orphan. */
          await run("UPDATE ledger_entry SET journal_id = ? WHERE id = ?", jid, entryId);
        });

        out.charged++;
        out.amountCents += fee.amount;
      } catch (err) {
        /* Another run got there first. That is the unique index doing its job,
           and it is the expected outcome of an overlapping retry, not an error. */
        if (String(err.message).includes("duplicate key")) { out.duplicates++; continue; }
        throw err;
      }
    }
  }
  return out;
}

/* The entry point cron calls. Claims the job, runs it, releases it.

   Claiming is an insert that the database refuses if a run is already in
   flight — the same insert-and-let-it-fail pattern the charges themselves use,
   and for the same reason: a SELECT-then-INSERT has a window between the two,
   and that window is where the double run lives. */
export async function runLateFeeSweep({ asOf = today(), postedBy = "system" } = {}) {
  /* Reclaim a run whose process died before it could finish. Bounded by time
     rather than by a heartbeat, because a serverless function cannot promise
     to send one. */
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  await run(
    `UPDATE job_run SET finished_at = ?, outcome = 'abandoned',
            detail = 'no completion recorded; presumed killed mid-run'
      WHERE name = ? AND finished_at IS NULL AND started_at < ?`,
    stamp(), JOB_NAME, cutoff);

  const runId = id();
  try {
    await insert("job_run", { id: runId, name: JOB_NAME, started_at: stamp() });
  } catch (err) {
    if (String(err.message).includes("duplicate key") ||
        String(err.message).includes("job_run_one_active_idx")) {
      return { skipped: true, reason: "another sweep is already running" };
    }
    throw err;
  }

  try {
    const result = await sweepLateFees({ asOf, postedBy });
    await run("UPDATE job_run SET finished_at = ?, outcome = ?, detail = ? WHERE id = ?",
      stamp(), "ok", JSON.stringify(result), runId);
    return result;
  } catch (err) {
    // Released even on failure, or one bad day locks the job out for good.
    await run("UPDATE job_run SET finished_at = ?, outcome = ?, detail = ? WHERE id = ?",
      stamp(), "failed", String(err.message).slice(0, 400), runId);
    throw err;
  }
}
