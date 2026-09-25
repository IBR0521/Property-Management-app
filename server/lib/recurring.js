/* Recurring charges — money a tenant pays every month that is not rent.

   Pet rent, parking, storage, utility billing, amenity fees. A lease here has
   had one rent and one due day since Phase 1, which is why importing a
   portfolio from AppFolio or Buildium has always quietly lost the difference.

   ## Whose income it is decides the posting

     owner     Dr 1300 tenant receivable / Cr 2400 rent due to owners
     manager   Dr 1200 rent receivable   / Cr 4100 fee income

   The first is the posting rent uses, because it is the same fact: the dog
   lives in the owner's property. The money moves from 2400 to 2200 when it
   arrives, through the payment path that already exists.

   Only `owner` is accepted today. `refuseManagerPayee` below says why, at the
   boundary, rather than posting something a reconciliation would catch three
   months later.

   ## Charged once per period, by the database

   `source_id` is `<chargeId>:<period>` under a partial unique index, so a
   second charge for a month already charged is refused by Postgres rather
   than by a check with a window in it. The run catches that and counts it —
   the same shape as the rent charge, and safe to run twice in a minute.

   ## Proration

   Through the same `prorate()` and `occupancyIn()` the rent charge uses, on
   the company's own basis, so a tenant moving in on the 20th pays eleven days
   of pet rent. A charge with `prorate = 0` is billed in full for any month it
   is active in: a flat administration fee is not smaller because somebody
   moved in late, the administration still happened. */
import { all, get, one, insert, update, run } from "./db.js";
import { id } from "./ids.js";
import { stamp, today, monthKey, monthRange, dueDateFor } from "./dates.js";
import { usd } from "./money.js";
import { log } from "./logger.js";
import { prorate, occupancyIn, basisOf } from "./proration.js";

export class ChargeRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ChargeRefused";
  }
}

/* The kinds the importer's column list maps onto. Kept short and general on
   purpose — a taxonomy nobody can remember is one everybody picks "other"
   from. */
export const CATEGORIES = {
  pet: "Pet rent",
  parking: "Parking",
  storage: "Storage",
  utility: "Utilities",
  insurance: "Insurance",
  amenity: "Amenity",
  admin: "Administration",
  other: "Other",
};

export const PAYEES = {
  owner: {
    label: "The owner",
    describes: "Income to the owner, like rent. Posts to the tenant receivable "
      + "and is held for the owner when it arrives.",
  },
  manager: {
    label: "You",
    describes: "Your own charge, like a late fee.",
  },
};

/* Manager-payee charges were refused when this file was written, and are not
   any more.

   The reason they were is worth keeping: nothing credited `1200`, so a fee
   charged to the tenant could never be collected, and the money that paid it
   fell through to `2300` and was recorded as rent held for the owner. Adding
   a charge that produced that every month would have multiplied a defect.

   `rentPaymentSplits` settles `1200` now — after the rent, never before it —
   so the account it posts to is one that clears. The money sits in the trust
   account until it is swept out, which shows as a surplus in
   `book_vs_clients`: "fees you have earned and not yet swept", the reading
   that report already offers and the same thing a management fee has always
   produced. */

/* --- the records ------------------------------------------------------------- */

export async function addCharge({
  companyId, leaseId, label, category = "other", amountCents, payee,
  startDate = null, endDate = null, prorate: doProrate = true, by = "system",
  sourceSystem = null, sourceId = null,
}) {
  const lease = await one(
    "SELECT * FROM lease WHERE id = ? AND company_id = ?", leaseId, companyId);

  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new ChargeRefused("A charge has to be a positive amount.");
  }
  const name = String(label || "").trim();
  if (!name) {
    throw new ChargeRefused("A charge needs a label — the tenant sees it on what they owe.");
  }
  if (!CATEGORIES[category]) throw new ChargeRefused("That is not a kind of charge.");
  if (!PAYEES[payee]) {
    throw new ChargeRefused("Say whose income this is: the owner's, or yours.");
  }

  const from = startDate || lease.start_date;
  if (endDate && endDate < from) {
    throw new ChargeRefused("A charge cannot end before it starts.");
  }

  const chargeId = id();
  await insert("recurring_charge", {
    id: chargeId, company_id: companyId, lease_id: leaseId,
    label: name, category, amount_cents: cents, payee,
    frequency: "monthly", start_date: from, end_date: endDate,
    prorate: doProrate ? 1 : 0, active: 1,
    source_system: sourceSystem, source_id: sourceId,
    created_at: stamp(), created_by: by,
  });
  return await one("SELECT * FROM recurring_charge WHERE id = ?", chargeId);
}

/* Ending a charge is not deleting it.

   A charge that was billed for six months is part of what that tenant was
   asked to pay, and the journals that came from it are append-only. Ending it
   stops the next one; it does not rewrite the last six. */
export async function endCharge({ companyId, chargeId, endDate = null, by = "system" }) {
  const charge = await one(
    "SELECT * FROM recurring_charge WHERE id = ? AND company_id = ?", chargeId, companyId);
  /* Ending a charge that has not started yet cannot stamp today's date:
     end_date has to fall on or after start_date, or the row is rejected and
     the charge stays live. The run only bills active charges, so marking it
     inactive is what stops it; the end date is the start date, the earliest
     day that is still a legal end. */
  let ended = endDate || today();
  if (ended < charge.start_date) ended = charge.start_date;
  await update("recurring_charge", charge.id, {
    active: 0, end_date: ended,
  });
  log.info("recurring charge ended", { chargeId: charge.id, by });
  return await one("SELECT * FROM recurring_charge WHERE id = ?", charge.id);
}

export async function chargesFor(companyId, leaseId, { includeEnded = false } = {}) {
  return await all(
    `SELECT * FROM recurring_charge
      WHERE company_id = ? AND lease_id = ?
        ${includeEnded ? "" : "AND active = 1"}
      ORDER BY label`, companyId, leaseId);
}

/* What this lease is billed every month on top of rent, as one figure. Read
   by the portal and the pay page, which have to show a tenant what they owe
   rather than what their rent is. */
export async function monthlyExtrasFor(companyId, leaseId, on = today()) {
  const rows = await all(
    `SELECT * FROM recurring_charge
      WHERE company_id = ? AND lease_id = ? AND active = 1
        AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
      ORDER BY label`, companyId, leaseId, on, on);
  return {
    rows,
    cents: rows.reduce((n, r) => n + Number(r.amount_cents), 0),
  };
}

/* --- the run ----------------------------------------------------------------- */

/* Charges that could be billed for a period: active, starting on or before
   the period ends, not ended before it begins, on a lease that was occupied. */
async function billableIn(companyId, period) {
  const { start, end } = monthRange(`${period}-01`);
  return await all(
    /* `c.label` and `u.label` are both called label, and selecting `c.*`
       beside `u.label` let the unit's — "1" — silently overwrite the
       charge's, so every memo read "1 2026-03". Both are named here. */
    `SELECT c.id, c.company_id, c.lease_id, c.label AS charge_label, c.category,
            c.amount_cents, c.payee, c.prorate, c.start_date, c.end_date,
            l.start_date AS lease_start, l.end_date AS lease_end,
            l.moveout_date, l.status AS lease_status, l.rent_due_day,
            l.unit_id,
            u.label AS unit_label, p.line1, p.id AS property_id, p.owner_id
       FROM recurring_charge c
       JOIN lease l ON l.id = c.lease_id
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE c.company_id = ? AND c.active = 1
        AND c.start_date <= ?
        AND (c.end_date IS NULL OR c.end_date >= ?)
        AND l.start_date <= ?
        AND (l.status = 'active' OR COALESCE(l.moveout_date, l.end_date) >= ?)
      ORDER BY p.line1, u.label, c.label`,
    companyId, end, start, end, start);
}

async function alreadyCharged(companyId, chargeId, period) {
  const row = await get(
    `SELECT id FROM journal
      WHERE company_id = ? AND source_type = 'recurring_charge' AND source_id = ?
        AND reverses_id IS NULL AND reversed_by IS NULL`,
    companyId, `${chargeId}:${period}`);
  return Boolean(row);
}

/* What would be charged, without charging it. The screen and the run read the
   same function, so what somebody is shown is what will happen. */
export async function planRecurring(companyId, { period = monthKey(today()) } = {}) {
  const company = await one(
    "SELECT id, name, proration_basis FROM company WHERE id = ?", companyId);
  const basis = basisOf(company.proration_basis);
  const charges = await billableIn(companyId, period);

  const rows = [];
  for (const c of charges) {
    /* The lease's occupancy, not the charge's own dates: a charge cannot be
       billed for days nobody lived there. */
    const window = occupancyIn(
      { start_date: c.lease_start, end_date: c.lease_end,
        moveout_date: c.moveout_date, status: c.lease_status }, period);
    if (!window) continue;

    let cents = Number(c.amount_cents);
    let explain = null, prorated = false;
    if (c.prorate) {
      const p = prorate({
        rentCents: Number(c.amount_cents), basis, period,
        occupiedFrom: window.from, occupiedTo: window.to,
      });
      if (!p.charge || p.cents <= 0) continue;
      cents = p.cents; prorated = p.prorated; explain = p.explain;
    }

    rows.push({
      chargeId: c.id, leaseId: c.lease_id, label: c.charge_label, category: c.category,
      payee: c.payee,
      ownerId: c.owner_id, propertyId: c.property_id, unitId: c.unit_id,
      where: `${c.line1}${c.unit_label ? `, unit ${c.unit_label}` : ""}`,
      unitLabel: c.unit_label,
      dueDate: dueDateFor(period, c.rent_due_day || 1),
      cents, prorated, explain, basis,
      already: await alreadyCharged(companyId, c.id, period),
    });
  }

  return {
    period, basis, company: company.name, rows,
    totalCents: rows.reduce((n, r) => n + (r.already ? 0 : r.cents), 0),
    toCharge: rows.filter((r) => !r.already).length,
    alreadyCharged: rows.filter((r) => r.already).length,
  };
}

export async function chargeRecurring(companyId, {
  period = monthKey(today()), postedBy = "system",
} = {}) {
  const { postJournal, ACCT } = await import("../features/accounting.js");
  const plan = await planRecurring(companyId, { period });
  const { start: periodStart } = monthRange(`${period}-01`);

  let charged = 0, skipped = 0, closed = 0, cents = 0;

  for (const row of plan.rows) {
    if (row.already) { skipped += 1; continue; }

    const dims = {
      ownerId: row.ownerId, propertyId: row.propertyId,
      unitId: row.unitId, leaseId: row.leaseId,
    };
    const memo = row.prorated
      ? `${row.label} ${period} (${row.explain}, ${row.basis})`
      : `${row.label} ${period}`;

    /* Whose income it is decides the posting, which is the whole reason the
       column exists.

         owner     Dr 1300 / Cr 2400, exactly as rent — the money becomes the
                   owner's when it arrives, through the payment path.
         manager   Dr 1200 / Cr 4100, exactly as a late fee — the manager's
                   own income, on the receivable that payments now settle. */
    const splits = row.payee === "manager"
      ? [
        { code: ACCT.RENT_RECEIVABLE, debit: row.cents, ...dims, memo: row.label },
        { code: ACCT.LATE_FEE_INCOME, credit: row.cents, ...dims,
          memo: `${row.label} — your charge` },
      ]
      : [
        { code: ACCT.TENANT_RECEIVABLE, debit: row.cents, ...dims, memo: row.label },
        { code: ACCT.RENT_DUE_OWNERS, credit: row.cents, ...dims,
          memo: "owed to owner when collected" },
      ];

    try {
      await postJournal({
        companyId, date: periodStart, memo,
        source: row.payee === "manager" ? "late_fee" : "rent",
        sourceType: "recurring_charge",
        sourceId: `${row.chargeId}:${period}`, postedBy,
        splits,
      });
      charged += 1;
      cents += row.cents;
    } catch (err) {
      if (err?.periodClosed) { closed += 1; continue; }
      if (/journal_one_recurring_charge_per_period|duplicate key/.test(String(err.message))) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return { period, charged, skipped, closed, cents };
}

/* Every company, for one period. Called by the scheduler, straight after the
   rent charge — a tenant's balance is rent plus these, and anything that reads
   what they owe must see both or neither. */
export async function runRecurringCharges({ period = null, postedBy = "system" } = {}) {
  const companies = await all("SELECT id, timezone FROM company ORDER BY id");
  let charged = 0, skipped = 0, closed = 0, cents = 0;

  for (const company of companies) {
    const { todayIn } = await import("./timezone.js");
    const forPeriod = period || monthKey(todayIn(company.timezone));
    try {
      const res = await chargeRecurring(company.id, { period: forPeriod, postedBy });
      charged += res.charged; skipped += res.skipped;
      closed += res.closed; cents += res.cents;
    } catch (err) {
      log.error("recurring charge run failed for a company", {
        companyId: company.id, reason: String(err.message).slice(0, 200),
      });
    }
  }

  return {
    recurringCharged: charged, recurringSkipped: skipped,
    recurringClosed: closed, recurringChargedCents: cents,
  };
}

export function describePlan(plan) {
  if (!plan.rows.length) return `No recurring charges for ${plan.period}.`;
  const lines = [`${plan.company} — ${plan.period}`, ""];
  for (const r of plan.rows) {
    lines.push(`  ${r.already ? "already charged" : "to charge      "}  `
      + `${usd(r.cents).padStart(12)}  ${r.label}${r.prorated ? " (prorated)" : ""}`);
  }
  lines.push("", `  ${plan.toCharge} to charge, ${usd(plan.totalCents)} in total.`);
  return lines.join("\n");
}
