/* The reports that are about property rather than about money.

   These read the operational tables rather than the journal, and that is worth
   stating plainly because it changes what they can promise. A rent roll is not
   a financial statement and does not tie to the trial balance — it says what
   the portfolio is contracted to earn, which is a different question from what
   it has earned. Where a figure here can be checked against the books, it is;
   where it cannot, the report says so rather than implying an authority it
   does not have.

   Every one of them takes an `asOf`, because "how many units are vacant" has
   no answer without a date. */
import { all, get } from "../db.js";
import { today, daysBetween, addDays, human } from "../dates.js";

/* --- the rent roll ----------------------------------------------------------- */

/* Every unit, whether or not it is let. A rent roll that listed only occupied
   units would answer "what am I earning" and hide "what am I not", and the
   second is the number that pays for the report. */
export async function rentRoll(companyId, { asOf = today(), propertyId = null } = {}) {
  const units = await all(
    `SELECT u.id, u.label, u.beds, u.baths, u.sqft, u.status, u.market_rent_cents,
            p.id AS property_id, p.line1, p.city, p.owner_id, o.name AS owner_name,
            l.id AS lease_id, l.start_date, l.end_date, l.rent_cents, l.deposit_cents,
            l.rent_due_day, l.status AS lease_status,
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
              WHERE lt.lease_id = l.id) AS tenants
       FROM unit u
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
       LEFT JOIN LATERAL (
         /* The lease in force on the date asked about, not merely the one
            flagged active today. A rent roll for last quarter has to show who
            was in the unit last quarter. */
         SELECT * FROM lease l2
          WHERE l2.unit_id = u.id
            AND l2.start_date <= ?
            AND (COALESCE(l2.moveout_date, l2.end_date) IS NULL
                 OR COALESCE(l2.moveout_date, l2.end_date) >= ?)
            AND l2.status <> 'pending'
          ORDER BY l2.start_date DESC LIMIT 1
       ) l ON TRUE
      WHERE u.company_id = ?
        AND (?::text IS NULL OR p.id = ?)
      ORDER BY p.line1, u.label`,
    asOf, asOf, companyId, propertyId, propertyId);

  const rows = units.map((u) => {
    const let_ = Boolean(u.lease_id);
    const rent = let_ ? Number(u.rent_cents) : 0;
    const market = Number(u.market_rent_cents || 0);
    return {
      unitId: u.id, label: u.label, beds: u.beds, baths: u.baths, sqft: u.sqft,
      propertyId: u.property_id, where: `${u.line1}${u.label ? `, unit ${u.label}` : ""}`,
      city: u.city, ownerId: u.owner_id, owner: u.owner_name,
      occupied: let_, unitStatus: u.status,
      tenants: u.tenants || null,
      leaseId: u.lease_id, startDate: u.start_date, endDate: u.end_date,
      rentCents: rent, marketRentCents: market,
      depositCents: let_ ? Number(u.deposit_cents || 0) : 0,
      /* What the vacancy is costing, at the asking rent. Zero for a let unit
         even when it is let below market — that is a different report and
         conflating them makes both unreadable. */
      vacancyLossCents: let_ ? 0 : market,
    };
  });

  const occupied = rows.filter((r) => r.occupied);
  return {
    kind: "rent_roll", asOf, propertyId,
    rows,
    units: rows.length,
    occupiedUnits: occupied.length,
    vacantUnits: rows.length - occupied.length,
    /* On units, not on rent. An occupancy rate weighted by rent flatters a
       portfolio whose cheap units are the empty ones. */
    occupancyRate: rows.length ? occupied.length / rows.length : 0,
    rentCents: occupied.reduce((n, r) => n + r.rentCents, 0),
    marketRentCents: rows.reduce((n, r) => n + r.marketRentCents, 0),
    vacancyLossCents: rows.reduce((n, r) => n + r.vacancyLossCents, 0),
    depositCents: occupied.reduce((n, r) => n + r.depositCents, 0),
  };
}

/* --- vacancy ----------------------------------------------------------------- */

/* How long each empty unit has been empty.

   Derived, and it says so. There is no history of unit status in this
   database, so the best available answer is when the last tenancy ended —
   keys back if they came back, the lease's end date otherwise. A unit that
   has never been let has no such date, and is reported as never let rather
   than as vacant for zero days, because those are very different facts and
   one of them is a number somebody would put in a board pack. */
export async function vacancy(companyId, { asOf = today() } = {}) {
  const roll = await rentRoll(companyId, { asOf });
  const empty = roll.rows.filter((r) => !r.occupied);

  const rows = [];
  for (const unit of empty) {
    const last = await get(
      `SELECT COALESCE(moveout_date, end_date) AS ended
         FROM lease
        WHERE unit_id = ? AND COALESCE(moveout_date, end_date) IS NOT NULL
          AND COALESCE(moveout_date, end_date) <= ?
        ORDER BY COALESCE(moveout_date, end_date) DESC LIMIT 1`,
      unit.unitId, asOf);

    rows.push({
      ...unit,
      vacantSince: last?.ended || null,
      daysVacant: last?.ended ? daysBetween(last.ended, asOf) : null,
      neverLet: !last?.ended,
    });
  }

  rows.sort((a, b) => (b.daysVacant ?? -1) - (a.daysVacant ?? -1));

  const measured = rows.filter((r) => r.daysVacant != null);
  return {
    kind: "vacancy", asOf,
    rows,
    vacantUnits: rows.length,
    neverLetUnits: rows.filter((r) => r.neverLet).length,
    /* Only over the units where a date exists. An average that counted
       never-let units as zero days would report a portfolio of empty new
       builds as turning over briskly. */
    averageDaysVacant: measured.length
      ? Math.round(measured.reduce((n, r) => n + r.daysVacant, 0) / measured.length)
      : null,
    lostMonthlyCents: rows.reduce((n, r) => n + r.marketRentCents, 0),
    derivedFrom: "the end of the last tenancy — this database keeps no history of unit status",
  };
}

/* --- lease expirations -------------------------------------------------------- */

/* What is ending, and when. The report that exists so a renewal conversation
   happens before a notice period runs out rather than after. */
export async function leaseExpirations(companyId, { asOf = today(), withinDays = 120 } = {}) {
  const horizon = addDays(asOf, withinDays);

  const rows = await all(
    `SELECT l.id, l.start_date, l.end_date, l.rent_cents, l.status,
            u.label, u.market_rent_cents, p.line1, p.city, p.id AS property_id,
            o.name AS owner_name,
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
              WHERE lt.lease_id = l.id) AS tenants
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
      WHERE l.company_id = ? AND l.status = 'active'
        AND (l.end_date IS NULL OR l.end_date <= ?)
      ORDER BY l.end_date NULLS LAST, p.line1, u.label`,
    companyId, horizon);

  const expiring = [], rolling = [];
  for (const r of rows) {
    const row = {
      leaseId: r.id, where: `${r.line1}${r.label ? `, unit ${r.label}` : ""}`,
      city: r.city, propertyId: r.property_id, owner: r.owner_name,
      tenants: r.tenants || "—",
      startDate: r.start_date, endDate: r.end_date,
      rentCents: Number(r.rent_cents),
      marketRentCents: Number(r.market_rent_cents || 0),
      daysRemaining: r.end_date ? daysBetween(asOf, r.end_date) : null,
      /* Already past its end date and still marked active. Not an error —
         a tenancy that runs on is ordinary — but it is worth naming rather
         than showing as "minus nine days". */
      overrun: Boolean(r.end_date && r.end_date < asOf),
    };
    if (r.end_date) expiring.push(row); else rolling.push(row);
  }

  return {
    kind: "lease_expirations", asOf, withinDays, horizon,
    expiring,
    /* Month to month, so they do not expire at all. Kept separate rather than
       dropped: a portfolio that is half rolling is a fact about risk. */
    rolling,
    expiringCount: expiring.length,
    rollingCount: rolling.length,
    overrunCount: expiring.filter((r) => r.overrun).length,
    rentAtRiskCents: expiring.reduce((n, r) => n + r.rentCents, 0),
  };
}

/* --- deposits ------------------------------------------------------------------ */

/* Money held that is somebody else's, and whether the books know about it.

   Two figures per lease on purpose. What the lease says was taken, and what
   has actually been posted to the deposits-held account. They should be the
   same, and on this application they are currently not: deposits were recorded
   on leases and posted nowhere at all. A report that showed only one of them
   would hide that. */
export async function depositsHeld(companyId, { asOf = today() } = {}) {
  const leases = await all(
    `SELECT l.id, l.deposit_cents, l.status, l.start_date, l.end_date, l.moveout_date,
            u.label, p.line1, p.city, p.id AS property_id, o.name AS owner_name,
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
              WHERE lt.lease_id = l.id) AS tenants
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
      WHERE l.company_id = ? AND l.deposit_cents > 0
        AND l.start_date <= ?
        AND (l.status = 'active' OR COALESCE(l.moveout_date, l.end_date) >= ?)
      ORDER BY p.line1, u.label`,
    companyId, asOf, addDays(asOf, -90));

  const posted = new Map(
    (await all(
      `SELECT s.lease_id, COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
         FROM journal_split s
         JOIN account a ON a.id = s.account_id
         JOIN journal j ON j.id = s.journal_id
        WHERE a.company_id = ? AND a.code = '2100' AND s.lease_id IS NOT NULL
          AND j.date <= ?
        GROUP BY s.lease_id`, companyId, asOf))
      .map((r) => [r.lease_id, Number(r.cents)]));

  const rows = leases.map((l) => {
    const onLease = Number(l.deposit_cents);
    const inBooks = posted.get(l.id) || 0;
    return {
      leaseId: l.id, where: `${l.line1}${l.label ? `, unit ${l.label}` : ""}`,
      city: l.city, propertyId: l.property_id, owner: l.owner_name,
      tenants: l.tenants || "—", status: l.status,
      movedOut: l.moveout_date || null,
      onLeaseCents: onLease, inBooksCents: inBooks,
      differenceCents: onLease - inBooks,
    };
  });

  const onLeaseCents = rows.reduce((n, r) => n + r.onLeaseCents, 0);
  const inBooksCents = rows.reduce((n, r) => n + r.inBooksCents, 0);

  return {
    kind: "deposits_held", asOf,
    rows,
    onLeaseCents, inBooksCents,
    differenceCents: onLeaseCents - inBooksCents,
    unpostedCount: rows.filter((r) => r.differenceCents !== 0).length,
  };
}

/* --- what was spent on repairs --------------------------------------------------- */

/* Read from the owner-visible ledger rather than the journal, because that is
   the record that carries the work order — and so the category, the vendor and
   the property come with it. It is also the figure an owner has been shown,
   which is the one worth being able to explain.

   Since a repair can only be costed once — the contractor's invoice when there
   is one, the close-out when there is not — this counts each repair once. */
export async function repairSpend(companyId, { from = null, to = today(), propertyId = null } = {}) {
  const rows = await all(
    `SELECT e.id, e.date, e.amount_cents, e.memo, e.work_order_id,
            e.property_id, e.owner_id,
            w.reference, w.category, w.severity, w.summary,
            v.id AS vendor_id, v.name AS vendor_name, v.trade,
            p.line1, u.label
       FROM ledger_entry e
       JOIN journal j ON j.id = e.journal_id
       LEFT JOIN work_order w ON w.id = e.work_order_id
       LEFT JOIN vendor_invoice vi ON vi.work_order_id = e.work_order_id
        AND vi.status <> 'void'
       LEFT JOIN vendor v ON v.id = vi.vendor_id
       LEFT JOIN property p ON p.id = e.property_id
       LEFT JOIN unit u ON u.id = e.unit_id
      WHERE e.company_id = ? AND e.kind = 'expense'
        /* One live line per repair. A cost that was superseded — a close-out
           figure replaced by the contractor's invoice — leaves the original
           and its mirror behind, and both belong in the ledger detail rather
           than here. Summing them absolute would report the superseded
           figure twice and the real one once, which is exactly the inflated
           number this whole report is supposed to be trustworthy about. */
        AND j.reverses_id IS NULL AND j.reversed_by IS NULL
        AND (?::text IS NULL OR e.date >= ?) AND (?::text IS NULL OR e.date <= ?)
        AND (?::text IS NULL OR e.property_id = ?)
      ORDER BY e.date, e.created_at`,
    companyId, from, from, to, to, propertyId, propertyId);

  const lines = rows.map((r) => ({
    date: r.date,
    /* Negated rather than absolute. An expense is stored negative on the
       owner's ledger because it is money away from them, and spend reads
       better positive — but anything that arrives positive is a credit and
       must stay negative here rather than being flipped into spend. */
    cents: -Number(r.amount_cents),
    workOrderId: r.work_order_id, reference: r.reference,
    category: r.category || "uncategorised",
    severity: r.severity || null,
    summary: r.summary || r.memo,
    vendorId: r.vendor_id, vendor: r.vendor_name || "In house",
    trade: r.trade || null,
    propertyId: r.property_id,
    where: r.line1 ? `${r.line1}${r.label ? `, unit ${r.label}` : ""}` : "—",
  }));

  return {
    kind: "repair_spend", from, to, propertyId,
    lines,
    totalCents: lines.reduce((n, l) => n + l.cents, 0),
    byVendor: group(lines, (l) => l.vendor),
    byCategory: group(lines, (l) => l.category),
    byProperty: group(lines, (l) => l.where),
  };
}

function group(lines, keyOf) {
  const map = new Map();
  for (const line of lines) {
    const key = keyOf(line);
    const row = map.get(key) || { key, cents: 0, jobs: 0 };
    row.cents += line.cents;
    row.jobs += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents);
}
