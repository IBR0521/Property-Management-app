/* What tenants owe, and how far behind it is.

   ## What "current" means here, and why

   **Rent is billed in advance.** A commercial invoice is raised after the work
   is done; rent for October is charged before October happens. Aging from the
   charge date would put every tenant a day overdue on the day their rent falls
   due, so aging runs from the **due date** — `rent_due_day` of the period the
   charge is for.

   So *current* means charged and not yet due. Money genuinely owed in the
   future, not money nobody has got round to collecting.

   **Grace is a fee-waiver window, not a change to when money is owed.** A
   lease with five days' grace still has rent due on the first; what grace buys
   is that no late fee attaches until the sixth. An accountant ages from the
   due date and would not recognise a report that did otherwise.

   But a manager must not chase somebody on day three of their grace. Those are
   two different questions of the same report, and folding grace into the
   buckets answers one by ruining the other — so every row carries `inGrace`
   alongside its bucket. The accounting view is correct and the operational
   view is one column away.

   ## Payments settle the oldest charge first

   Nothing records which month a payment was for, and the tenant did not say.
   Oldest first is the near-universal convention, it is what a court would
   assume, and it is the only rule that does not require guessing intent.

   ## Money paid ahead is a credit, never a negative bucket

   A tenant in credit is not "minus thirty days late". They are paid up and
   holding a balance, which is a different fact and belongs in its own column.

   ## What it does not do

   It does not decide anybody is delinquent. That is the ladder's job, it has
   its own rules and a written policy behind it, and a report that quietly
   started making that call would be a second opinion nobody asked for. */
import { all, get } from "../db.js";
import { today, dueDateFor, daysBetween, addDays, monthKey } from "../dates.js";

/* The conventional commercial buckets. Kept conventional on purpose: an
   accountant reading this expects these five and nothing else, and a report
   that invents its own is one nobody can compare against last year's. */
export const BUCKETS = [
  { key: "current", label: "Current", from: null, to: 0 },
  { key: "d1_30", label: "1–30 days", from: 1, to: 30 },
  { key: "d31_60", label: "31–60 days", from: 31, to: 60 },
  { key: "d61_90", label: "61–90 days", from: 61, to: 90 },
  { key: "d90_plus", label: "Over 90 days", from: 91, to: null },
];

const bucketFor = (daysLate) => {
  if (daysLate <= 0) return "current";
  if (daysLate <= 30) return "d1_30";
  if (daysLate <= 60) return "d31_60";
  if (daysLate <= 90) return "d61_90";
  return "d90_plus";
};

const emptyBuckets = () =>
  Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));

/* Every movement on the tenant receivable, per lease, with enough of the
   journal attached to work out what each charge was for. */
async function receivableLines(companyId, asOf) {
  return await all(
    `SELECT s.lease_id, j.date, j.source_type, j.source_id, j.memo,
            s.debit_cents::bigint AS debit, s.credit_cents::bigint AS credit
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.company_id = ? AND a.code = '1300'
        AND s.lease_id IS NOT NULL
        AND j.date <= ?
      ORDER BY s.lease_id, j.date, j.created_at`,
    companyId, asOf);
}

/* When a charge fell due.

   A rent charge carries `<leaseId>:<period>` as its source id, so the period
   is known exactly and the due date comes from the lease's own due day. A
   charge that is not rent — a late fee, something entered by hand — has no
   period, and falls due the day it was raised. */
function dueDateOf(line, lease) {
  if (line.source_type === "rent_charge" || line.source_type === "rent_prepaid_applied") {
    const period = String(line.source_id || "").split(":")[1];
    if (/^\d{4}-\d{2}$/.test(period)) {
      return dueDateFor(period, lease.rent_due_day || 1);
    }
  }
  return line.date;
}

export async function agedReceivables(companyId, { asOf = today() } = {}) {
  const leases = await all(
    `SELECT l.id, l.rent_cents, l.rent_due_day, l.grace_days, l.status,
            u.label, p.line1, p.city, p.id AS property_id, p.owner_id,
            (SELECT t.name FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
              WHERE lt.lease_id = l.id ORDER BY t.name LIMIT 1) AS tenant_name
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.company_id = ?
      ORDER BY p.line1, u.label`, companyId);

  const byLease = new Map(leases.map((l) => [l.id, l]));
  const lines = await receivableLines(companyId, asOf);

  /* Charges per lease, oldest first, each with what is still unpaid on it. */
  const charges = new Map();
  const credits = new Map();

  for (const line of lines) {
    const lease = byLease.get(line.lease_id);
    if (!lease) continue;

    const debit = Number(line.debit), credit = Number(line.credit);
    if (debit > 0) {
      if (!charges.has(line.lease_id)) charges.set(line.lease_id, []);
      charges.get(line.lease_id).push({
        due: dueDateOf(line, lease),
        raised: line.date,
        memo: line.memo,
        period: String(line.source_id || "").split(":")[1] || null,
        cents: debit, unpaid: debit,
      });
    }
    if (credit > 0) {
      credits.set(line.lease_id, (credits.get(line.lease_id) || 0) + credit);
    }
  }

  const rows = [];
  for (const lease of leases) {
    const own = (charges.get(lease.id) || []).sort((a, b) => a.due.localeCompare(b.due));
    let available = credits.get(lease.id) || 0;

    /* Oldest first. The tenant did not say which month they were paying and
       nothing recorded it, so this is the convention rather than a lookup. */
    for (const charge of own) {
      if (available <= 0) break;
      const applied = Math.min(available, charge.unpaid);
      charge.unpaid -= applied;
      available -= applied;
    }

    const buckets = emptyBuckets();
    const open = [];
    let oldestDue = null;

    for (const charge of own) {
      if (charge.unpaid <= 0) continue;
      const daysLate = daysBetween(charge.due, asOf);
      buckets[bucketFor(daysLate)] += charge.unpaid;
      open.push({ ...charge, daysLate: Math.max(0, daysLate) });
      if (!oldestDue || charge.due < oldestDue) oldestDue = charge.due;
    }

    const owedCents = Object.values(buckets).reduce((n, v) => n + v, 0);
    const overdueCents = owedCents - buckets.current;

    /* Held against this lease and not yet earned. Shown as a credit rather
       than as a negative bucket: a tenant in credit is not thirty days late
       by a negative amount, they are paid up and holding a balance. */
    const prepaid = await prepaidFor(companyId, lease.id, asOf);

    /* Not chased yet. The whole reason grace is a flag and not a bucket. */
    const graceEnds = oldestDue ? addDays(oldestDue, Number(lease.grace_days || 0)) : null;
    const inGrace = Boolean(overdueCents > 0 && graceEnds && asOf <= graceEnds);

    if (owedCents === 0 && prepaid === 0) continue;

    rows.push({
      leaseId: lease.id, status: lease.status,
      where: `${lease.line1}${lease.label ? `, unit ${lease.label}` : ""}`,
      city: lease.city, propertyId: lease.property_id, ownerId: lease.owner_id,
      tenant: lease.tenant_name || "—",
      buckets, owedCents, overdueCents,
      prepaidCents: prepaid,
      netCents: owedCents - prepaid,
      oldestDue, graceEnds, inGrace,
      open,
    });
  }

  const totals = emptyBuckets();
  for (const row of rows) {
    for (const b of BUCKETS) totals[b.key] += row.buckets[b.key];
  }
  const owedCents = Object.values(totals).reduce((n, v) => n + v, 0);

  return {
    kind: "aged_receivables", asOf,
    buckets: BUCKETS,
    rows,
    totals,
    owedCents,
    overdueCents: owedCents - totals.current,
    prepaidCents: rows.reduce((n, r) => n + r.prepaidCents, 0),
    /* Leases inside their grace period, so a manager can see at a glance how
       much of the overdue figure is not yet anybody's problem. */
    inGraceCents: rows.filter((r) => r.inGrace).reduce((n, r) => n + r.overdueCents, 0),
  };
}

async function prepaidFor(companyId, leaseId, asOf) {
  const row = await get(
    `SELECT COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.company_id = ? AND a.code = '2300' AND s.lease_id = ? AND j.date <= ?`,
    companyId, leaseId, asOf);
  return Math.max(0, Number(row?.cents || 0));
}

/* The aged total has to equal the receivable control account, or one of them
   is wrong. Returned rather than asserted, so the screen can show it. */
export async function agingTiesToLedger(companyId, { asOf = today() } = {}) {
  const aging = await agedReceivables(companyId, { asOf });

  const row = await get(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE a.company_id = ? AND a.code = '1300' AND j.date <= ?`,
    companyId, asOf);

  const control = Number(row?.cents || 0);
  return {
    agedCents: aging.owedCents,
    controlCents: control,
    /* Splits with no lease on them cannot be aged against a due date, so
       they are named rather than silently dropped. */
    differenceCents: aging.owedCents - control,
  };
}
