/* Posting the rent charge.

   The half of rent accounting that was missing. Rent was received and never
   charged, so income was never recognised and the tenant receivable ran
   negative. This is the other half.

   ## What it posts

       Dr 1300 Tenant receivable      the tenant owes it
       Cr 2400 Rent due to owners     and it is the owner's when it arrives

   Not `2200 Owner funds held`. That is a trust liability, and crediting it on
   a charge would say you are holding money you have not been given — the
   three-way reconciliation would fail by exactly the arrears, permanently.
   Receipt is what moves it into trust.

   ## It never charges twice

   Not because the job checks first — two ticks overlapping would both pass a
   check — but because the database will not have it. `source_id` carries
   `<leaseId>:<period>` under a partial unique index, so a second charge for a
   month already charged is refused by Postgres. The job catches that and
   counts it, which is the same shape as every other idempotent job here:
   safe to run twice in a minute and safe to run after a week down.

   ## It does not touch the owner's ledger

   `ledger_entry` is what an owner is shown, and it is a record of money that
   moved. A charge is not money that moved. Writing one would inflate every
   owner statement by the amount charged on top of the amount received. */
import { all, get, one } from "./db.js";
import { today, monthKey, monthRange } from "./dates.js";
import { usd } from "./money.js";
import { log } from "./logger.js";
import { prorate, occupancyIn, basisOf } from "./proration.js";

/* Leases that could owe rent for a period: active, or ended inside it. A lease
   that ended last month still owes for the days it ran. */
async function chargeableLeases(companyId, period) {
  const { start, end } = monthRange(`${period}-01`);
  return await all(
    `SELECT l.*, u.label, p.line1, p.id AS property_id, p.owner_id
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.company_id = ?
        AND l.rent_cents > 0
        AND l.start_date <= ?
        AND (l.status = 'active'
             OR COALESCE(l.moveout_date, l.end_date) >= ?)
      ORDER BY p.line1, u.label`,
    companyId, end, start);
}

/* What would be charged, without charging it. The screen and the dry run both
   read this, so what a person is shown is what the job will do. */
export async function planCharges(companyId, { period = monthKey(today()) } = {}) {
  const company = await one("SELECT id, name, proration_basis FROM company WHERE id = ?", companyId);
  const basis = basisOf(company.proration_basis);
  const leases = await chargeableLeases(companyId, period);

  const rows = [];
  for (const lease of leases) {
    const window = occupancyIn(lease, period);
    if (!window) continue;

    const charge = prorate({
      rentCents: lease.rent_cents, basis, period,
      occupiedFrom: window.from, occupiedTo: window.to,
    });
    if (!charge.charge || charge.cents <= 0) continue;

    rows.push({
      leaseId: lease.id, ownerId: lease.owner_id, propertyId: lease.property_id,
      unitId: lease.unit_id, where: `${lease.line1}${lease.label ? ` unit ${lease.label}` : ""}`,
      rentCents: lease.rent_cents,
      cents: charge.cents,
      prorated: charge.prorated,
      days: charge.days, daysInPeriod: charge.daysInPeriod,
      basis: charge.basis, explain: charge.explain,
      already: await alreadyCharged(companyId, lease.id, period),
    });
  }

  return {
    period, basis, company: company.name,
    rows,
    totalCents: rows.reduce((n, r) => n + (r.already ? 0 : r.cents), 0),
    toCharge: rows.filter((r) => !r.already).length,
    alreadyCharged: rows.filter((r) => r.already).length,
  };
}

async function alreadyCharged(companyId, leaseId, period) {
  const row = await get(
    `SELECT id FROM journal
      WHERE company_id = ? AND source_type = 'rent_charge' AND source_id = ?
        AND reverses_id IS NULL AND reversed_by IS NULL`,
    companyId, `${leaseId}:${period}`);
  return Boolean(row);
}

/* --- posting ---------------------------------------------------------------- */

export async function chargeRent(companyId, { period = monthKey(today()), postedBy = "system" } = {}) {
  const { postJournal, ACCT, PeriodClosed } = await import("../features/accounting.js");
  const plan = await planCharges(companyId, { period });
  const { end } = monthRange(`${period}-01`);

  /* Dated the last day of the period it covers, not the day the job happened
     to run. A charge for September belongs in September, and a catch-up run in
     November must not move three months of income into November. */
  const date = end;

  let charged = 0, skipped = 0, closed = 0, cents = 0;

  for (const row of plan.rows) {
    if (row.already) { skipped += 1; continue; }

    const memo = row.prorated
      ? `Rent ${period} — ${row.where} (${row.explain}, ${row.basis})`
      : `Rent ${period} — ${row.where}`;

    try {
      await postJournal({
        companyId, date, memo,
        source: "rent", sourceType: "rent_charge", sourceId: `${row.leaseId}:${period}`,
        postedBy,
        splits: [
          { code: ACCT.TENANT_RECEIVABLE, debit: row.cents,
            ownerId: row.ownerId, propertyId: row.propertyId,
            unitId: row.unitId, leaseId: row.leaseId, memo: "rent charged" },
          { code: ACCT.RENT_DUE_OWNERS, credit: row.cents,
            ownerId: row.ownerId, propertyId: row.propertyId,
            unitId: row.unitId, leaseId: row.leaseId, memo: "owed to owner when collected" },
        ],
      });
      charged += 1;
      cents += row.cents;
    } catch (err) {
      /* A company that has closed the period is not a fault. It is a
         deliberate choice, and the run reports it rather than failing. */
      if (err?.periodClosed) { closed += 1; continue; }

      /* The unique index doing its job — another tick got there first. Also
         not a fault, and the whole reason the guarantee is in the database
         rather than in the check above. */
      if (/journal_one_rent_charge_per_period/.test(String(err.message))) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return { period, date, charged, skipped, closed, cents, basis: plan.basis };
}

/* Every company, for one period. Called by the scheduler. */
export async function runRentCharges({ period = null, postedBy = "system" } = {}) {
  const companies = await all("SELECT id, timezone FROM company ORDER BY id");
  let charged = 0, skipped = 0, closed = 0, cents = 0;

  for (const company of companies) {
    /* The period is the company's, not the server's. A company in Honolulu is
       still in last month when a UTC server has rolled over. */
    const { todayIn } = await import("./timezone.js");
    const forPeriod = period || monthKey(todayIn(company.timezone));

    try {
      const res = await chargeRent(company.id, { period: forPeriod, postedBy });
      charged += res.charged; skipped += res.skipped;
      closed += res.closed; cents += res.cents;
    } catch (err) {
      /* One company's broken data must not stop every other company being
         charged. */
      log.error("rent charge run failed for a company", {
        companyId: company.id, reason: String(err.message).slice(0, 200),
      });
    }
  }

  return { rentCharged: charged, rentChargesSkipped: skipped,
           rentChargesClosed: closed, rentChargedCents: cents };
}
