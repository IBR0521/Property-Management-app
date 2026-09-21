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
import { id } from "./ids.js";
import { stamp, today, monthKey, daysBetween } from "./dates.js";

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
async function candidates(asOf) {
  const period = monthKey(asOf);
  return await all(
    `SELECT l.*, u.id AS unit_id2, p.owner_id, p.id AS property_id,
            l.company_id AS cid,
            COALESCE((SELECT SUM(e.amount_cents) FROM ledger_entry e
                       WHERE e.lease_id = l.id AND e.kind = 'rent_payment'
                         AND e.date >= ?), 0)::bigint AS paid
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.status = 'active'
        AND l.start_date <= ?
        AND NOT EXISTS (SELECT 1 FROM late_fee f WHERE f.lease_id = l.id AND f.period = ?)`,
    `${period}-01`, asOf, period);
}

/* Runs the sweep. Returns counts; the caller decides what to do with them.

   `postJournal` is imported lazily because features/accounting.js imports from
   lib/*, and importing it at module scope here would close the loop. */
export async function sweepLateFees({ asOf = today(), postedBy = "system" } = {}) {
  const period = monthKey(asOf);
  const out = { period, considered: 0, charged: 0, amountCents: 0, skipped: 0, duplicates: 0, noPolicy: 0 };

  const rows = await candidates(asOf);
  out.considered = rows.length;
  if (!rows.length) return out;

  const { postJournal, ACCT } = await import("../features/accounting.js");

  for (const lease of rows) {
    const dueDay = Math.min(Math.max(Number(lease.rent_due_day) || 1, 1), 28);
    const dueDate = `${period}-${String(dueDay).padStart(2, "0")}`;
    if (asOf <= dueDate) { out.skipped++; continue; }

    const daysLate = daysBetween(dueDate, asOf);
    const outstanding = Number(lease.rent_cents) - Number(lease.paid);
    if (outstanding <= 0) { out.skipped++; continue; }

    const fee = feeFor(lease, {
      rentCents: Number(lease.rent_cents),
      daysLate,
      graceDays: Number(lease.grace_days) || 0,
    });
    if (!fee) { out.noPolicy++; continue; }

    try {
      /* One transaction per lease: the fee, the owner-visible ledger line and
         the journal either all land or none do. A fee charged without its
         accounting is a number on a statement that reconciles to nothing. */
      await tx(async () => {
        const feeId = id();
        const entryId = id();

        await insert("late_fee", {
          id: feeId, company_id: lease.cid, lease_id: lease.id, unit_id: lease.unit_id,
          period, assessed_date: asOf, amount_cents: fee.amount, basis: fee.basis,
          rent_cents: lease.rent_cents, days_late: daysLate, created_at: stamp(),
        });

        await insert("ledger_entry", {
          id: entryId, company_id: lease.cid, owner_id: lease.owner_id,
          property_id: lease.property_id, unit_id: lease.unit_id, lease_id: lease.id,
          date: asOf, kind: "other", amount_cents: fee.amount,
          memo: `Late fee ${period} — ${fee.basis}`,
          source: "system", created_at: stamp(),
        });

        const jid = await postJournal({
          companyId: lease.cid, date: asOf,
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
