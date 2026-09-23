/* The working lists, as reports.

   The roadmap asks that every table in the application can be exported as
   CSV. Most of the tables that carry data worth exporting already are
   reports — the rent roll, aged receivables, the trial balance, the general
   ledger, deposits, 1099, repair spend. What was left were the four working
   lists: owners, properties and units, work orders, and contractors.

   They are registry entries rather than export buttons bolted onto four
   screens, which means one export path, one escaping function and one set of
   tests. Each of them also gains a PDF and a schedule for nothing. The
   alternative was four bespoke handlers that would drift apart.

   These read the operational tables and do not tie to the trial balance.
   Where a figure here is money, it is what the record says rather than what
   the books say, and the difference matters: a work order's `actual_cents`
   is what somebody typed, not what was posted. */
import { all } from "../db.js";
import { today } from "../dates.js";

export async function ownerList(companyId) {
  const rows = await all(
    `SELECT o.id, o.name, o.email, o.phone, o.approval_threshold_cents, o.statement_day,
            COUNT(DISTINCT p.id)::int AS properties,
            COUNT(DISTINCT u.id)::int AS units,
            COALESCE(SUM(e.amount_cents), 0)::bigint AS balance_cents
       FROM owner o
       LEFT JOIN property p ON p.owner_id = o.id
       LEFT JOIN unit u ON u.property_id = p.id
       LEFT JOIN ledger_entry e ON e.owner_id = o.id
      WHERE o.company_id = ?
      GROUP BY o.id, o.name, o.email, o.phone, o.approval_threshold_cents, o.statement_day
      ORDER BY o.name`, companyId);

  return {
    kind: "owner_list",
    rows: rows.map((r) => ({
      ownerId: r.id, name: r.name,
      email: r.email || null, phone: r.phone || null,
      properties: Number(r.properties), units: Number(r.units),
      /* Positive is money towards the owner, the same sign the ledger uses
         and the same sign their statement shows. */
      balanceCents: Number(r.balance_cents),
      thresholdCents: Number(r.approval_threshold_cents),
      statementDay: r.statement_day,
    })),
    owners: rows.length,
    balanceCents: rows.reduce((n, r) => n + Number(r.balance_cents), 0),
  };
}

export async function unitList(companyId, { propertyId = null } = {}) {
  const rows = await all(
    `SELECT u.id, u.label, u.beds, u.baths, u.sqft, u.status, u.market_rent_cents,
            p.id AS property_id, p.line1, p.city, p.state, p.zip, p.kind, p.year_built,
            o.name AS owner_name,
            l.rent_cents, l.start_date, l.end_date,
            (SELECT string_agg(t.name, ', ' ORDER BY t.name)
               FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
              WHERE lt.lease_id = l.id) AS tenants
       FROM unit u
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
       LEFT JOIN LATERAL (
         SELECT * FROM lease l2
          WHERE l2.unit_id = u.id AND l2.status = 'active'
          ORDER BY l2.start_date DESC LIMIT 1
       ) l ON TRUE
      WHERE u.company_id = ?
        AND (?::text IS NULL OR p.id = ?)
      ORDER BY p.line1, u.label`, companyId, propertyId, propertyId);

  return {
    kind: "unit_list", propertyId,
    rows: rows.map((r) => ({
      unitId: r.id, label: r.label,
      where: `${r.line1}${r.label ? `, unit ${r.label}` : ""}`,
      city: r.city, state: r.state, zip: r.zip,
      kind: r.kind, yearBuilt: r.year_built,
      owner: r.owner_name,
      beds: r.beds, baths: r.baths, sqft: r.sqft,
      status: r.status,
      tenants: r.tenants || null,
      rentCents: r.rent_cents == null ? null : Number(r.rent_cents),
      marketRentCents: Number(r.market_rent_cents || 0),
      startDate: r.start_date || null, endDate: r.end_date || null,
    })),
    units: rows.length,
    rentCents: rows.reduce((n, r) => n + Number(r.rent_cents || 0), 0),
    marketRentCents: rows.reduce((n, r) => n + Number(r.market_rent_cents || 0), 0),
  };
}

/* Work orders over a period, by when they were raised.

   `actual_cents` is what somebody recorded on the job, which since the
   one-cost-per-repair fix is not always what was posted: a job closed out
   before the contractor's bill arrived keeps its figure and the invoice is
   what reaches the books. The two are reported side by side rather than
   one being quietly preferred. */
export async function workOrderList(companyId, { from = null, to = today(), propertyId = null } = {}) {
  const rows = await all(
    `SELECT w.id, w.reference, w.category, w.severity, w.status, w.summary,
            w.created_at, w.closed_at, w.scheduled_start,
            w.estimate_cents, w.actual_cents,
            w.checked_in_at, w.checked_out_at,
            u.label, p.id AS property_id, p.line1, p.city,
            o.name AS owner_name,
            v.name AS vendor_name,
            s.name AS assigned_to,
            (SELECT COALESCE(SUM(vi.amount_cents + COALESCE(vi.tax_cents, 0)), 0)
               FROM vendor_invoice vi
              WHERE vi.work_order_id = w.id AND vi.status <> 'void')::bigint AS invoiced_cents
       FROM work_order w
       JOIN unit u ON u.id = w.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
       LEFT JOIN vendor v ON v.id = w.vendor_id
       LEFT JOIN staff s ON s.id = w.assigned_staff_id
      WHERE w.company_id = ?
        AND (?::text IS NULL OR w.created_at >= ?)
        AND (?::text IS NULL OR w.created_at <= ?)
        AND (?::text IS NULL OR p.id = ?)
      ORDER BY w.created_at DESC`,
    companyId, from, from, to, to ? `${to}T23:59:59.999Z` : null,
    propertyId, propertyId);

  const mapped = rows.map((r) => ({
    workOrderId: r.id, reference: r.reference,
    raised: String(r.created_at).slice(0, 10),
    closed: r.closed_at ? String(r.closed_at).slice(0, 10) : null,
    where: `${r.line1}${r.label ? `, unit ${r.label}` : ""}`,
    city: r.city, propertyId: r.property_id, owner: r.owner_name,
    category: r.category, severity: r.severity, status: r.status,
    summary: r.summary,
    vendor: r.vendor_name || null,
    assignedTo: r.assigned_to || null,
    scheduled: r.scheduled_start || null,
    arrived: r.checked_in_at ? String(r.checked_in_at).slice(0, 10) : null,
    estimateCents: r.estimate_cents == null ? null : Number(r.estimate_cents),
    recordedCents: r.actual_cents == null ? null : Number(r.actual_cents),
    invoicedCents: Number(r.invoiced_cents) || null,
  }));

  return {
    kind: "work_order_list", from, to, propertyId,
    rows: mapped,
    jobs: mapped.length,
    open: mapped.filter((r) => r.status !== "complete" && r.status !== "cancelled").length,
    emergencies: mapped.filter((r) => r.severity === "emergency").length,
    /* What was billed where a bill exists, and what was recorded where one
       does not. The same rule the books follow, so the two agree. */
    costCents: mapped.reduce((n, r) => n + (r.invoicedCents ?? r.recordedCents ?? 0), 0),
  };
}

/* Contractors, with the compliance verdict attached rather than applied.
   The barrier lives in `complianceState`; this reports what it says. */
export async function vendorList(companyId, { asOf = today() } = {}) {
  const { complianceState } = await import("../../features/vendors.js");

  const rows = await all(
    `SELECT v.*, 
            (SELECT COUNT(*) FROM work_order w WHERE w.vendor_id = v.id)::int AS jobs
       FROM vendor v
      WHERE v.company_id = ?
      ORDER BY v.active DESC, v.name`, companyId);

  const mapped = rows.map((v) => {
    const state = complianceState(v, asOf);
    return {
      vendorId: v.id, name: v.name, trade: v.trade,
      email: v.email || null, phone: v.phone || null,
      active: Boolean(v.active),
      afterHours: Boolean(v.after_hours),
      jobs: Number(v.jobs),
      licenceExpires: v.license_expires || null,
      liabilityExpires: v.gl_expires || null,
      workersCompExpires: v.wc_exempt ? "exempt" : (v.wc_expires || null),
      w9: v.w9_received_at ? "on file" : null,
      is1099: Boolean(v.is_1099),
      canDispatch: state.canDispatch,
      canBePaid: state.canBePaid,
      /* The reasons, joined, because a CSV cell cannot hold a list and a
         reader wants the whole answer in one place. */
      blocked: [...new Set([...state.dispatchReasons, ...state.payoutReasons])].join("; ") || null,
      /* `warnings` are plain strings and `problems` are objects with a
         `.text`. Two shapes in one return value, so this is worth reading
         rather than assuming. */
      warnings: state.warnings.join("; ") || null,
    };
  });

  return {
    kind: "vendor_list", asOf,
    rows: mapped,
    vendors: mapped.length,
    blockedFromDispatch: mapped.filter((v) => v.active && !v.canDispatch).length,
    blockedFromPayment: mapped.filter((v) => v.active && !v.canBePaid).length,
  };
}
