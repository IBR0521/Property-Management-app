/* F10  Contractor compliance, invoicing and 1099 extraction.

   The barrier is the point of this file. An uninsured contractor who falls off
   a roof, or floods a unit, becomes the manager's liability — and the moment to
   find out that a certificate lapsed is before dispatch, not when the claim
   arrives. So one function decides whether a vendor may be used or paid, and
   every path that dispatches work or releases money calls it. Not a warning on
   a dashboard somebody reads on Tuesdays.

   Workers compensation blocks payouts, per the brief. General liability and the
   licence block dispatch but not the settling of work already done: refusing to
   pay for completed work because a certificate expired afterwards creates a
   dispute, not compliance. */
import { all, get, one, insert, update, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, sendJson, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { seal, tryOpen, sealingAvailable } from "../lib/crypto.js";
import { postJournal, ACCT } from "./accounting.js";
import { supersedeCloseOutCost } from "../lib/repaircost.js";

const VENDOR_TABS = [
  { key: "vendors", href: "/app/vendors", label: "Contractors" },
  { key: "invoices", href: "/app/vendors/invoices", label: "Invoices" },
  { key: "tax", href: "/app/vendors/1099", label: "1099" },
];

/* The IRS reporting threshold for non-employee compensation. Payments below it
   are not reportable on a 1099-NEC. */
const THRESHOLD_1099_CENTS = 60000;

/* --- the barrier ---------------------------------------------------------- */

/* One answer to "may we use this vendor", with the reasons spelled out so the
   blocked screen can say something a person can act on. `asOf` is a parameter
   so a payout dated last month is judged against the cover in force then. */
export function complianceState(vendor, asOf = today()) {
  const problems = [];
  const warnings = [];

  const expired = (dateStr) => dateStr && dateStr < asOf;
  const expiringSoon = (dateStr) => dateStr && !expired(dateStr) && daysBetween(asOf, dateStr) <= 30;

  if (!vendor.wc_exempt) {
    if (!vendor.wc_expires) {
      problems.push({ kind: "payout", text: "No workers compensation certificate on file." });
    } else if (expired(vendor.wc_expires)) {
      problems.push({ kind: "payout", text: `Workers compensation expired ${human(vendor.wc_expires)}.` });
    } else if (expiringSoon(vendor.wc_expires)) {
      warnings.push(`Workers compensation expires ${human(vendor.wc_expires)}.`);
    }
  }

  if (vendor.gl_expires && expired(vendor.gl_expires)) {
    problems.push({ kind: "dispatch", text: `General liability expired ${human(vendor.gl_expires)}.` });
  } else if (expiringSoon(vendor.gl_expires)) {
    warnings.push(`General liability expires ${human(vendor.gl_expires)}.`);
  }

  if (vendor.license_expires && expired(vendor.license_expires)) {
    problems.push({ kind: "dispatch", text: `Licence expired ${human(vendor.license_expires)}.` });
  } else if (expiringSoon(vendor.license_expires)) {
    warnings.push(`Licence expires ${human(vendor.license_expires)}.`);
  }

  if (vendor.payout_hold) {
    problems.push({
      kind: "payout",
      text: `Payments are on hold: ${vendor.payout_hold_reason || "no reason recorded"}.`,
    });
  }
  if (vendor.onboarding_state === "suspended") {
    problems.push({ kind: "dispatch", text: "This contractor is suspended." });
  }

  const blocksPayout = problems.filter((p) => p.kind === "payout");
  const blocksDispatch = problems;

  return {
    problems, warnings,
    canDispatch: blocksDispatch.length === 0,
    canBePaid: blocksPayout.length === 0,
    dispatchReasons: blocksDispatch.map((p) => p.text),
    payoutReasons: blocksPayout.map((p) => p.text),
  };
}

/* Called from the work order dispatch path. Throws rather than returning a
   flag, because a caller that has to remember to check is a caller that
   eventually does not. */
export async function assertDispatchable(vendorId, companyId) {
  const vendor = await one(
    "SELECT * FROM vendor WHERE id = ? AND company_id = ?", vendorId, companyId);
  const state = complianceState(vendor);
  if (!state.canDispatch) {
    throw new BadRequest(
      `${vendor.name} cannot be dispatched: ${state.dispatchReasons.join(" ")} ` +
      `Update their compliance record first.`);
  }
  return vendor;
}

export async function assertPayable(vendorId, companyId, asOf) {
  const vendor = await one(
    "SELECT * FROM vendor WHERE id = ? AND company_id = ?", vendorId, companyId);
  const state = complianceState(vendor, asOf);
  if (!state.canBePaid) {
    throw new BadRequest(
      `Payment to ${vendor.name} is blocked: ${state.payoutReasons.join(" ")}`);
  }
  return vendor;
}

/* --- invoices and payouts ------------------------------------------------- */

export async function recordInvoice({
  companyId, vendorId, workOrderId, invoiceNo, invoiceDate, dueDate,
  amountCents, taxCents = 0, memo, createdBy,
}) {
  const vendor = await one(
    "SELECT * FROM vendor WHERE id = ? AND company_id = ?", vendorId, companyId);
  const state = complianceState(vendor, invoiceDate || today());

  const wo = workOrderId
    ? await get("SELECT unit_id FROM work_order WHERE id = ? AND company_id = ?", workOrderId, companyId)
    : null;
  const unit = wo && wo.unit_id
    ? await get("SELECT property_id FROM unit WHERE id = ?", wo.unit_id) : null;
  /* Who bears it. A repair on somebody's property is their cost, and the
     journal needs the owner on it for any report by owner to mean anything. */
  const owner = unit
    ? await get("SELECT o.id FROM owner o JOIN property p ON p.owner_id = o.id WHERE p.id = ?",
        unit.property_id)
    : null;

  const invId = id();
  return await tx(async () => {
    await insert("vendor_invoice", {
      id: invId, company_id: companyId, vendor_id: vendorId,
      work_order_id: workOrderId || null,
      property_id: unit ? unit.property_id : null,
      unit_id: wo ? wo.unit_id : null,
      invoice_no: invoiceNo || null,
      invoice_date: invoiceDate || today(), due_date: dueDate || null,
      amount_cents: amountCents, tax_cents: taxCents,
      /* Recorded as blocked rather than refused. The bill is real and the
         liability exists whether or not the paperwork is in order; what is
         withheld is the payment. */
      status: state.canBePaid ? "received" : "blocked",
      block_reason: state.canBePaid ? null : state.payoutReasons.join(" "),
      memo: memo || null, created_at: stamp(),
    });

    /* One repair, one cost. A job closed out before the bill arrived has
       already posted a figure somebody typed; this is the figure money is
       actually paid against, so it supersedes it. The close-out posting is
       reversed rather than edited — the journal is append-only, and the
       difference between what was recorded and what was billed is worth
       being able to see. */
    const superseded = workOrderId
      ? await supersedeCloseOutCost({
          companyId, workOrderId, by: createdBy, date: invoiceDate || today(),
          reason: `Superseded by ${vendor.name}'s invoice${invoiceNo ? ` (${invoiceNo})` : ""}.`,
          replacedWithCents: amountCents + taxCents,
        })
      : { superseded: false, cents: 0 };

    /* Whose cost this is decides which account it lands in.

       An invoice against a property is the owner's cost, paid out of the
       owner's money: it reduces what is owed to them. It is not the manager's
       expense, and booking it as one inflated the manager's P&L by every
       repair they had ever arranged on somebody else's behalf. An invoice with
       no property — the office printer — is genuinely theirs. */
    const ownerBorne = Boolean(unit && unit.property_id);
    const total = amountCents + taxCents;

    /* Booking the liability the moment the bill arrives, not when it is paid.
       That is the difference between accrual and a cheque stub. */
    const jid = await postJournal({
      companyId, date: invoiceDate || today(),
      memo: `Invoice from ${vendor.name}${invoiceNo ? ` (${invoiceNo})` : ""}`,
      source: "vendor", sourceType: "vendor_invoice", sourceId: invId, postedBy: createdBy,
      splits: [
        { code: ownerBorne ? ACCT.OWNER_FUNDS : ACCT.REPAIRS, debit: total, vendorId,
          ownerId: owner ? owner.id : null,
          unitId: wo ? wo.unit_id : null, propertyId: unit ? unit.property_id : null,
          memo: memo || (ownerBorne ? "the owner's repair" : "vendor invoice") },
        { code: ACCT.PAYABLE, credit: total, vendorId, memo: "owed to vendor" },
      ],
    });
    await update("vendor_invoice", invId, { journal_id: jid });

    /* The owner sees it on their statement, the same as a repair closed out
       in-house does. Without this the cost would be in the books and absent
       from the ledger the owner is actually shown. */
    if (ownerBorne && owner) {
      const { postMoney } = await import("../lib/ledger.js");
      await postMoney({
        companyId, ownerId: owner.id, propertyId: unit.property_id,
        unitId: wo ? wo.unit_id : null,
        date: invoiceDate || today(), kind: "expense", amountCents: -total,
        memo: `${vendor.name}${invoiceNo ? ` (${invoiceNo})` : ""}`,
        source: workOrderId ? "work_order" : "manual",
        workOrderId: workOrderId || null,
        sourceType: "vendor_invoice", sourceId: invId, postedBy: createdBy,
        journalId: jid,
      });
    }

    return { invoiceId: invId, journalId: jid, ownerBorne,
             superseded: superseded.superseded, supersededCents: superseded.cents,
             blocked: !state.canBePaid, reasons: state.payoutReasons };
  });
}

/* Releases money. The barrier is checked here even though the invoice was
   checked when it arrived, because a certificate can lapse in between. */
export async function payInvoice({ companyId, invoiceId, paidDate, method, reference, by }) {
  const inv = await one(
    "SELECT * FROM vendor_invoice WHERE id = ? AND company_id = ?", invoiceId, companyId);
  if (inv.status === "paid") throw new BadRequest("That invoice is already paid.");
  if (inv.status === "void") throw new BadRequest("That invoice was voided.");

  const when = paidDate || today();
  const vendor = await assertPayable(inv.vendor_id, companyId, when);
  const total = Number(inv.amount_cents) + Number(inv.tax_cents);

  return await tx(async () => {
    const jid = await postJournal({
      companyId, date: when,
      memo: `Paid ${vendor.name}${inv.invoice_no ? ` (${inv.invoice_no})` : ""}`,
      source: "vendor", sourceType: "vendor_invoice", sourceId: inv.id, postedBy: by,
      splits: [
        { code: ACCT.PAYABLE, debit: total, vendorId: vendor.id, memo: "settling invoice" },
        { code: ACCT.CASH, credit: total, memo: `${method || "payment"} ${reference || ""}`.trim() },
      ],
    });
    await insert("vendor_payout", {
      id: id(), company_id: companyId, vendor_id: vendor.id, invoice_id: inv.id,
      paid_date: when, amount_cents: total,
      method: ["check", "ach", "card", "cash", "other"].includes(method) ? method : "check",
      reference: reference || null, journal_id: jid,
      /* Frozen at payout. A vendor's classification can change next year and
         last year's 1099 must not change with it. */
      is_1099_reportable: vendor.is_1099 ? 1 : 0,
      tax_year: Number(when.slice(0, 4)),
      created_by: by, created_at: stamp(),
    });
    await update("vendor_invoice", inv.id, { status: "paid" });
    return jid;
  });
}

/* --- 1099 extraction ------------------------------------------------------ */

/* Aggregates a tax year into the shape a 1099-NEC filing wants. Returns data,
   not a file: the filing formats differ by transmitter, and a structure that
   can be serialised to any of them is more use than a CSV nobody's software
   accepts.

   Vendors below the threshold are returned too, marked, because the person
   filing needs to see what was excluded and why. */
export async function extract1099(companyId, taxYear) {
  const company = await one("SELECT * FROM company WHERE id = ?", companyId);
  const rows = await all(
    `SELECT v.id, v.name, v.legal_name, v.address, v.tax_id_enc, v.tax_id_last4,
            v.tax_classification, v.w9_received_at, v.is_1099,
            COALESCE(SUM(p.amount_cents), 0)::bigint AS paid,
            COUNT(p.id)::int AS payments
       FROM vendor v
       LEFT JOIN vendor_payout p
         ON p.vendor_id = v.id AND p.tax_year = ? AND p.is_1099_reportable = 1
      WHERE v.company_id = ?
      GROUP BY v.id, v.name, v.legal_name, v.address, v.tax_id_enc, v.tax_id_last4,
               v.tax_classification, v.w9_received_at, v.is_1099
      HAVING COALESCE(SUM(p.amount_cents), 0) > 0
      ORDER BY SUM(p.amount_cents) DESC`, taxYear, companyId);

  const recipients = rows.map((r) => {
    const paid = Number(r.paid);
    const reportable = paid >= THRESHOLD_1099_CENTS && Boolean(r.is_1099);
    const missing = [];
    if (!r.w9_received_at) missing.push("W-9 not on file");
    if (!r.tax_id_enc) missing.push("no taxpayer ID");
    if (!r.tax_classification) missing.push("no tax classification");
    if (!r.legal_name) missing.push("no legal name");
    if (!r.address) missing.push("no address");

    return {
      vendorId: r.id,
      recipientName: r.legal_name || r.name,
      doingBusinessAs: r.legal_name && r.legal_name !== r.name ? r.name : null,
      address: r.address || null,
      taxClassification: r.tax_classification || null,
      /* Only the last four leave this function. The full number is fetched
         deliberately, once, by the export that actually needs it — a report
         anybody can open should not carry a TIN. */
      tinLast4: r.tax_id_last4 || null,
      tinOnFile: Boolean(r.tax_id_enc),
      box1NonEmployeeCompensationCents: paid,
      payments: r.payments,
      reportable,
      excludedBecause: reportable ? null
        : !r.is_1099 ? "marked not 1099-reportable"
        : `under the $${(THRESHOLD_1099_CENTS / 100).toFixed(0)} threshold`,
      missing,
    };
  });

  return {
    taxYear,
    payer: { name: company.name, phone: company.phone || null },
    generatedAt: stamp(),
    thresholdCents: THRESHOLD_1099_CENTS,
    recipients,
    summary: {
      recipients: recipients.length,
      reportable: recipients.filter((r) => r.reportable).length,
      incomplete: recipients.filter((r) => r.reportable && r.missing.length).length,
      totalReportableCents: recipients.filter((r) => r.reportable)
        .reduce((n, r) => n + r.box1NonEmployeeCompensationCents, 0),
    },
  };
}

/* --- routes --------------------------------------------------------------- */

export function registerVendors(router) {
  router.get("/app/vendors", async (ctx) => {
    const cid = ctx.staff.company_id;
    const vendors = await all(
      `SELECT v.*,
              (SELECT COALESCE(SUM(amount_cents),0) FROM vendor_payout p
                WHERE p.vendor_id = v.id AND p.tax_year = ?)::bigint AS paid_ytd,
              (SELECT COUNT(*) FROM vendor_invoice i
                WHERE i.vendor_id = v.id AND i.status IN ('received','approved','blocked'))::int AS open_invoices
         FROM vendor v WHERE v.company_id = ? ORDER BY v.active DESC, v.name`,
      Number(today().slice(0, 4)), cid);
    const year = Number(today().slice(0, 4));

    const states = vendors.map((v) => ({ v, s: complianceState(v) }));
    const blocked = states.filter((x) => !x.s.canDispatch || !x.s.canBePaid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: "Contractors", subtitle: `${vendors.length} on file · ${blocked.length} blocked`,
      actions: html`<a class="pill solid sm" href="/app/vendors/new">Add contractor</a>`,
      body: html`
        ${tabs(VENDOR_TABS, "vendors")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${blocked.length ? notice("warn", `${blocked.length} contractor(s) cannot be used`,
          "Expired cover or a hold. They stay on the list, but dispatch and payment are refused until it is fixed.") : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${vendors.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Contractor</th><th>Cover</th>
              <th class="num">Paid in ${year}</th><th>State</th><th class="shrink"></th></tr></thead>
            <tbody>${states.map(({ v, s }) => html`
              <tr>
                <td><a href="/app/vendors/${v.id}">${v.name}</a>
                  <span class="cellsub">${v.trade}${v.open_invoices ? ` · ${v.open_invoices} open invoice(s)` : ""}</span></td>
                <td>${coverCell(v.wc_expires, v.wc_exempt)} <span class="cellsub">workers comp</span>
                  <div style="margin-top:0.25rem">${coverCell(v.gl_expires, 0)} <span class="cellsub">liability</span></div></td>
                <td class="num">${usd(Number(v.paid_ytd))}</td>
                <td>${s.canDispatch && s.canBePaid
                  ? html`<span class="chip" data-tone="ok">clear</span>`
                  : html`<span class="chip" data-tone="danger">${s.canDispatch ? "no payouts" : "blocked"}</span>`}</td>
                <td class="shrink"><a class="pill outline sm" href="/app/vendors/${v.id}"
                  ${attr("aria-label", `Open ${v.name}`)}>Open</a></td>
              </tr>`)}</tbody></table></div>`
            : empty("No contractors yet", "Add the trades you actually call.")}
        </div></div>`,
    }));
  });

  router.get("/app/vendors/new", async (ctx) => {
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(ctx.staff.company_id),
      title: "Add a contractor", subtitle: "Trade, cover, and how they are paid",
      body: vendorForm({ csrf: ctx.csrf, vendor: null, error: ctx.query.e }),
    }));
  });

  router.post("/app/vendors/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const name = String(f.name || "").trim();
    if (name.length < 2) {
      return redirect(ctx.res, `/app/vendors/new?e=${encodeURIComponent("A contractor needs a name.")}`);
    }
    const vid = id();
    await insert("vendor", { id: vid, company_id: cid, name,
      trade: String(f.trade || "general").trim(),
      phone: String(f.phone || "").trim() || null,
      email: String(f.email || "").trim() || null,
      after_hours: f.after_hours === "yes" ? 1 : 0, active: 1,
      created_at: stamp(), ...complianceFields(f) });
    redirect(ctx.res, `/app/vendors/${vid}?m=${encodeURIComponent("Contractor added.")}`);
  });

  /* Registered before /app/vendors/:id so the literal paths are not swallowed. */
  router.get("/app/vendors/invoices", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await all(
      `SELECT i.*, v.name AS vendor_name FROM vendor_invoice i
         JOIN vendor v ON v.id = i.vendor_id
        WHERE i.company_id = ? ORDER BY
          CASE i.status WHEN 'blocked' THEN 0 WHEN 'received' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
          i.invoice_date DESC LIMIT 200`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: "Invoices", subtitle: `${rows.filter((r) => r.status !== "paid").length} outstanding`,
      actions: html`<a class="pill solid sm" href="/app/vendors/invoices/new">Record an invoice</a>`,
      body: html`
        ${tabs(VENDOR_TABS, "invoices")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${rows.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Contractor</th><th>Invoice</th><th>Date</th><th class="num">Amount</th>
              <th>Status</th><th class="shrink"></th></tr></thead>
            <tbody>${rows.map((r) => html`
              <tr>
                <td><a href="/app/vendors/${r.vendor_id}">${r.vendor_name}</a></td>
                <td>${r.invoice_no || html`<span style="color:var(--ink-soft)">no number</span>`}
                  ${r.block_reason ? html`<span class="cellsub">${r.block_reason}</span>` : ""}</td>
                <td>${human(r.invoice_date)}</td>
                <td class="num">${usd(Number(r.amount_cents) + Number(r.tax_cents))}</td>
                <td><span class="chip"${attr("data-tone",
                  r.status === "paid" ? "ok" : r.status === "blocked" ? "danger" : "warn")}>${r.status}</span></td>
                <td class="shrink">${r.status === "paid" || r.status === "void" ? "" : html`
                  <form method="post" action="/app/vendors/invoices/${r.id}/pay">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <button class="pill outline sm" type="submit">Pay</button>
                  </form>`}</td>
              </tr>`)}</tbody></table></div>`
            : empty("No invoices yet.")}
        </div></div>`,
    }));
  });

  router.get("/app/vendors/invoices/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const vendors = await all(
      "SELECT id, name, trade FROM vendor WHERE company_id = ? AND active = 1 ORDER BY name", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: "Record an invoice", subtitle: "Books the cost now, whether or not it can be paid yet",
      body: invoiceForm({ csrf: ctx.csrf, vendors, error: ctx.query.e }),
    }));
  });

  router.post("/app/vendors/invoices/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const bad = (m) => redirect(ctx.res, `/app/vendors/invoices/new?e=${encodeURIComponent(m)}`);
    const amount = parseMoney(f.amount);
    if (!f.vendor_id) return bad("Which contractor sent it?");
    if (amount == null || amount <= 0) return bad("What is the amount?");

    const res = await recordInvoice({
      companyId: cid, vendorId: String(f.vendor_id), workOrderId: String(f.work_order_id || "") || null,
      invoiceNo: String(f.invoice_no || "").trim() || null,
      invoiceDate: String(f.invoice_date || today()),
      dueDate: String(f.due_date || "") || null,
      amountCents: amount, taxCents: parseMoney(f.tax) || 0,
      memo: String(f.memo || "").trim() || null, createdBy: ctx.staff.id,
    });
    redirect(ctx.res, `/app/vendors/invoices?m=${encodeURIComponent(
      res.blocked ? `Invoice recorded but payment is blocked: ${res.reasons.join(" ")}` : "Invoice recorded and booked.")}`);
  });

  router.post("/app/vendors/invoices/:id/pay", async (ctx) => {
    const cid = ctx.staff.company_id;
    try {
      await payInvoice({
        companyId: cid, invoiceId: ctx.params.id,
        paidDate: String(ctx.fields.paid_date || today()),
        method: String(ctx.fields.method || "check"),
        reference: String(ctx.fields.reference || "").trim() || null,
        by: ctx.staff.id,
      });
      redirect(ctx.res, `/app/vendors/invoices?m=${encodeURIComponent("Paid, and the journal posted.")}`);
    } catch (err) {
      redirect(ctx.res, `/app/vendors/invoices?m=${encodeURIComponent(err.message)}`);
    }
  });

  router.get("/app/vendors/1099", async (ctx) => {
    const cid = ctx.staff.company_id;
    const year = Number(ctx.query.year) || Number(today().slice(0, 4)) - 1;
    const data = await extract1099(cid, year);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: `1099 extract · ${year}`,
      subtitle: `${data.summary.reportable} reportable · ${usd(data.summary.totalReportableCents)}`,
      actions: html`<a class="pill outline sm" href="/app/vendors/1099.json?year=${year}">Download JSON</a>`,
      body: html`
        ${tabs(VENDOR_TABS, "tax")}
        ${data.summary.incomplete ? notice("warn",
          `${data.summary.incomplete} reportable contractor(s) have missing details`,
          "A 1099 cannot be filed without a legal name, address and taxpayer ID. Collect a W-9 before filing season.") : ""}
        <div class="panel">
          <div class="panel__head"><h2>Tax year</h2></div>
          <div class="panel__body">
            <form method="get" action="/app/vendors/1099" class="formgrid formgrid--2">
              <div class="field"><label for="year">Year</label>
                <input id="year" name="year" type="number" min="2000" max="2100" value="${year}" /></div>
              <button class="pill outline" type="submit">Show</button>
            </form>
          </div>
        </div>
        <div class="panel"><div class="panel__body panel__body--flush">
          ${data.recipients.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Recipient</th><th>TIN</th><th>Class</th>
              <th class="num">Box 1</th><th>Reportable</th><th>Missing</th></tr></thead>
            <tbody>${data.recipients.map((r) => html`
              <tr>
                <td>${r.recipientName}${r.doingBusinessAs ? html`<span class="cellsub">t/a ${r.doingBusinessAs}</span>` : ""}</td>
                <td>${r.tinLast4 ? `•••••${r.tinLast4}` : html`<span style="color:var(--danger)">none</span>`}</td>
                <td>${r.taxClassification || "—"}</td>
                <td class="num">${usd(r.box1NonEmployeeCompensationCents)}</td>
                <td>${r.reportable
                  ? html`<span class="chip" data-tone="ok">yes</span>`
                  : html`<span class="chip">${r.excludedBecause}</span>`}</td>
                <td>${r.missing.length ? html`<span class="cellsub">${r.missing.join("; ")}</span>` : "—"}</td>
              </tr>`)}</tbody></table></div>`
            : empty(`No payouts in ${year}.`)}
        </div></div>`,
    }));
  });

  router.get("/app/vendors/1099.json", async (ctx) => {
    const year = Number(ctx.query.year) || Number(today().slice(0, 4)) - 1;
    sendJson(ctx.res, await extract1099(ctx.staff.company_id, year));
  });

  router.get("/app/vendors/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const v = await one("SELECT * FROM vendor WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const s = complianceState(v);
    const invoices = await all(
      "SELECT * FROM vendor_invoice WHERE vendor_id = ? ORDER BY invoice_date DESC LIMIT 20", v.id);
    const payouts = await all(
      "SELECT * FROM vendor_payout WHERE vendor_id = ? ORDER BY paid_date DESC LIMIT 20", v.id);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: v.name, subtitle: `${v.trade}${v.after_hours ? " · takes after-hours calls" : ""}`,
      actions: html`
        <a class="pill outline sm" href="/app/vendors">All contractors</a>
        <a class="pill outline sm" href="/app/vendors/${v.id}/edit">Edit</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${s.canDispatch && s.canBePaid
          ? notice("ok", "Clear to work and be paid", "Cover is current and nothing is on hold.")
          : notice("danger", "Blocked", html`<ul style="margin:0.25rem 0 0 1rem">
              ${s.problems.map((p) => html`<li>${p.text} <span class="cellsub">blocks ${p.kind}</span></li>`)}
            </ul>`)}
        ${s.warnings.length ? notice("warn", "Expiring soon", html`<ul style="margin:0.25rem 0 0 1rem">
          ${s.warnings.map((w) => html`<li>${w}</li>`)}</ul>`) : ""}

        <div class="hub">
          <div class="hub__col">
            <div class="panel">
              <div class="panel__head"><h2>Invoices</h2><p>${invoices.length}</p></div>
              <div class="panel__body panel__body--flush">
                ${invoices.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
                  <thead><tr><th>Date</th><th>Number</th><th class="num">Amount</th><th>Status</th></tr></thead>
                  <tbody>${invoices.map((i) => html`
                    <tr><td>${human(i.invoice_date)}</td><td>${i.invoice_no || "—"}</td>
                      <td class="num">${usd(Number(i.amount_cents) + Number(i.tax_cents))}</td>
                      <td><span class="chip"${attr("data-tone", i.status === "paid" ? "ok" : i.status === "blocked" ? "danger" : "warn")}>${i.status}</span></td>
                    </tr>`)}</tbody></table></div>` : html`<div class="panel__body">No invoices.</div>`}
              </div>
            </div>
            <div class="panel">
              <div class="panel__head"><h2>Payments</h2><p>${payouts.length}</p></div>
              <div class="panel__body panel__body--flush">
                ${payouts.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
                  <thead><tr><th>Date</th><th>Method</th><th class="num">Amount</th><th>1099</th></tr></thead>
                  <tbody>${payouts.map((p) => html`
                    <tr><td>${human(p.paid_date)}</td><td>${p.method}</td>
                      <td class="num">${usd(Number(p.amount_cents))}</td>
                      <td>${p.is_1099_reportable ? "yes" : "no"}</td></tr>`)}</tbody></table></div>`
                  : html`<div class="panel__body">Nothing paid yet.</div>`}
              </div>
            </div>
          </div>

          <div class="hub__col">
            <div class="panel">
              <div class="panel__head"><h2>Cover</h2></div>
              <div class="panel__body">
                <dl class="dl">
                  <div><dt>Workers comp</dt><dd>${v.wc_exempt ? "Exempt (recorded)"
                    : v.wc_expires ? `${v.wc_carrier || "carrier not recorded"} — expires ${human(v.wc_expires)}`
                    : "Not on file"}</dd></div>
                  <div><dt>General liability</dt><dd>${v.gl_expires
                    ? `${v.gl_carrier || "carrier not recorded"} — expires ${human(v.gl_expires)}` : "Not on file"}</dd></div>
                  <div><dt>Licence</dt><dd>${v.license_no || "—"}${v.license_expires ? ` · expires ${human(v.license_expires)}` : ""}</dd></div>
                </dl>
              </div>
            </div>
            <div class="panel">
              <div class="panel__head"><h2>Tax</h2></div>
              <div class="panel__body">
                <dl class="dl">
                  <div><dt>Legal name</dt><dd>${v.legal_name || "—"}</dd></div>
                  <div><dt>W-9</dt><dd>${v.w9_received_at ? human(v.w9_received_at) : "not received"}</dd></div>
                  <div><dt>Taxpayer ID</dt><dd>${v.tax_id_last4 ? `•••••${v.tax_id_last4}` : "not on file"}
                    <span class="cellsub">stored encrypted</span></dd></div>
                  <div><dt>Classification</dt><dd>${v.tax_classification || "—"}</dd></div>
                </dl>
              </div>
            </div>
          </div>
        </div>`,
    }));
  });

  router.get("/app/vendors/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const v = await one("SELECT * FROM vendor WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "vendors", counts: await navCounts(cid),
      title: `Edit ${v.name}`, subtitle: "Compliance and tax details",
      body: vendorForm({ csrf: ctx.csrf, vendor: v, error: ctx.query.e }),
    }));
  });

  router.post("/app/vendors/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const v = await one("SELECT * FROM vendor WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    await update("vendor", v.id, {
      name: String(f.name || v.name).trim(),
      trade: String(f.trade || v.trade).trim(),
      phone: String(f.phone || "").trim() || null,
      email: String(f.email || "").trim() || null,
      after_hours: f.after_hours === "yes" ? 1 : 0,
      active: f.active === "no" ? 0 : 1,
      ...complianceFields(f, v),
    });
    redirect(ctx.res, `/app/vendors/${v.id}?m=${encodeURIComponent("Contractor updated.")}`);
  });
}

/* --- shared field handling ------------------------------------------------ */

/* The TIN is sealed on the way in and only its last four are kept in the clear.
   Left untouched when the field is submitted blank, so opening the edit form and
   saving does not wipe a number nobody retyped. */
function complianceFields(f, existing = null) {
  const out = {
    legal_name: String(f.legal_name || "").trim() || null,
    address: String(f.address || "").trim() || null,
    license_no: String(f.license_no || "").trim() || null,
    license_expires: dateOrNull(f.license_expires),
    gl_carrier: String(f.gl_carrier || "").trim() || null,
    gl_policy_no: String(f.gl_policy_no || "").trim() || null,
    gl_expires: dateOrNull(f.gl_expires),
    wc_carrier: String(f.wc_carrier || "").trim() || null,
    wc_policy_no: String(f.wc_policy_no || "").trim() || null,
    wc_expires: dateOrNull(f.wc_expires),
    wc_exempt: f.wc_exempt === "yes" ? 1 : 0,
    w9_received_at: dateOrNull(f.w9_received_at),
    tax_classification: ["individual", "sole_prop", "partnership", "c_corp", "s_corp", "llc", "trust", "other"]
      .includes(f.tax_classification) ? f.tax_classification : null,
    is_1099: f.is_1099 === "no" ? 0 : 1,
    payout_hold: f.payout_hold === "yes" ? 1 : 0,
    payout_hold_reason: String(f.payout_hold_reason || "").trim() || null,
    onboarding_state: ["invited", "documents_pending", "approved", "suspended"]
      .includes(f.onboarding_state) ? f.onboarding_state : "invited",
  };

  const tin = String(f.tax_id || "").replace(/[^0-9]/g, "");
  if (tin.length >= 9) {
    if (!sealingAvailable()) {
      throw new BadRequest("APP_ENCRYPTION_KEY is not set, so a taxpayer ID cannot be stored safely.");
    }
    out.tax_id_enc = seal(tin);
    out.tax_id_last4 = tin.slice(-4);
  } else if (!existing) {
    out.tax_id_enc = null;
    out.tax_id_last4 = null;
  }
  return out;
}

function dateOrNull(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function coverCell(expires, exempt) {
  if (exempt) return html`<span class="chip">exempt</span>`;
  if (!expires) return html`<span class="chip" data-tone="danger">none</span>`;
  const gone = expires < today();
  return html`<span class="chip"${attr("data-tone", gone ? "danger" : "ok")}>${human(expires)}</span>`;
}

/* --- views ---------------------------------------------------------------- */

function vendorForm({ csrf, vendor, error }) {
  const action = vendor ? `/app/vendors/${vendor.id}/edit` : "/app/vendors/new";
  const val = (k) => (vendor && vendor[k] != null ? vendor[k] : "");
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <form method="post" action="${action}">
      <input type="hidden" name="_csrf" value="${csrf}" />

      <div class="panel">
        <div class="panel__head"><h2>Who they are</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field"><label for="name">Trading name</label>
              <input id="name" name="name" type="text" required maxlength="120" value="${val("name")}" /></div>
            <div class="field"><label for="trade">Trade</label>
              <input id="trade" name="trade" type="text" required maxlength="60"
                     value="${val("trade")}" placeholder="plumbing" /></div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="phone">Phone</label>
              <input id="phone" name="phone" type="tel" value="${val("phone")}" /></div>
            <div class="field"><label for="email">Email</label>
              <input id="email" name="email" type="email" value="${val("email")}" /></div>
          </div>
          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">After-hours calls</span>
            <div class="radioset">
              <label class="radiotile"><input type="radio" name="after_hours" value="yes"${attr("checked", vendor && vendor.after_hours)} /><span>Yes</span></label>
              <label class="radiotile"><input type="radio" name="after_hours" value="no"${attr("checked", !vendor || !vendor.after_hours)} /><span>No</span></label>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Insurance and licence</h2></div>
        <div class="panel__body">
          <p class="lede" style="margin:0 0 0.75rem">
            Expired workers compensation blocks <b>payment</b>. Expired liability or licence blocks
            <b>dispatch</b>. Both are refused by the system, not flagged for somebody to notice.
          </p>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="wc_carrier">Workers comp carrier</label>
              <input id="wc_carrier" name="wc_carrier" type="text" value="${val("wc_carrier")}" /></div>
            <div class="field"><label for="wc_expires">Workers comp expires</label>
              <input id="wc_expires" name="wc_expires" type="date" value="${val("wc_expires")}" /></div>
          </div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="wc_exempt" value="yes"${attr("checked", vendor && vendor.wc_exempt)} />
              <span>Exempt from workers compensation (sole trader with no employees)</span>
            </label>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="gl_carrier">Liability carrier</label>
              <input id="gl_carrier" name="gl_carrier" type="text" value="${val("gl_carrier")}" /></div>
            <div class="field"><label for="gl_expires">Liability expires</label>
              <input id="gl_expires" name="gl_expires" type="date" value="${val("gl_expires")}" /></div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="license_no">Licence number</label>
              <input id="license_no" name="license_no" type="text" value="${val("license_no")}" /></div>
            <div class="field"><label for="license_expires">Licence expires</label>
              <input id="license_expires" name="license_expires" type="date" value="${val("license_expires")}" /></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Tax</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field"><label for="legal_name">Legal name</label>
              <input id="legal_name" name="legal_name" type="text" value="${val("legal_name")}"
                     placeholder="As written on the W-9" /></div>
            <div class="field"><label for="w9_received_at">W-9 received</label>
              <input id="w9_received_at" name="w9_received_at" type="date" value="${val("w9_received_at")}" /></div>
          </div>
          <div class="field"><label for="address">Address</label>
            <input id="address" name="address" type="text" maxlength="240" value="${val("address")}" /></div>
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="tax_id">Taxpayer ID (EIN or SSN)</label>
              <input id="tax_id" name="tax_id" type="text" inputmode="numeric" autocomplete="off"
                     placeholder="${vendor && vendor.tax_id_last4 ? `on file, ending ${vendor.tax_id_last4}` : "9 digits"}" />
              <span class="field__help">Encrypted before it is stored. Leave blank to keep what is on file.</span>
            </div>
            <div class="field">
              <label for="tax_classification">Classification</label>
              <select id="tax_classification" name="tax_classification">
                <option value="">—</option>
                ${["individual", "sole_prop", "partnership", "c_corp", "s_corp", "llc", "trust", "other"].map((k) => html`
                  <option value="${k}"${attr("selected", vendor && vendor.tax_classification === k)}>${k.replace(/_/g, " ")}</option>`)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Standing</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="onboarding_state">Onboarding</label>
              <select id="onboarding_state" name="onboarding_state">
                ${["invited", "documents_pending", "approved", "suspended"].map((k) => html`
                  <option value="${k}"${attr("selected", vendor && vendor.onboarding_state === k)}>${k.replace(/_/g, " ")}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="payout_hold_reason">Hold reason</label>
              <input id="payout_hold_reason" name="payout_hold_reason" type="text"
                     value="${val("payout_hold_reason")}" placeholder="Why payments are withheld" />
            </div>
          </div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="payout_hold" value="yes"${attr("checked", vendor && vendor.payout_hold)} />
              <span>Hold all payments to this contractor</span>
            </label>
          </div>
          ${vendor ? html`
            <div class="field">
              <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Active</span>
              <div class="radioset">
                <label class="radiotile"><input type="radio" name="active" value="yes"${attr("checked", vendor.active)} /><span>In use</span></label>
                <label class="radiotile"><input type="radio" name="active" value="no"${attr("checked", !vendor.active)} /><span>Retired</span></label>
              </div>
            </div>` : ""}
        </div>
      </div>

      <div class="btnrow">
        <button class="pill solid" type="submit">${vendor ? "Save changes" : "Add contractor"}</button>
        <a class="pill outline" href="/app/vendors">Cancel</a>
      </div>
    </form>`;
}

function invoiceForm({ csrf, vendors, error }) {
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>Invoice</h2></div>
      <div class="panel__body">
        <form method="post" action="/app/vendors/invoices/new" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="vendor_id">Contractor</label>
            <select id="vendor_id" name="vendor_id" required>
              <option value="">Who sent it?</option>
              ${vendors.map((v) => html`<option value="${v.id}">${v.name} — ${v.trade}</option>`)}
            </select>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="invoice_no">Invoice number</label>
              <input id="invoice_no" name="invoice_no" type="text" maxlength="60" /></div>
            <div class="field"><label for="invoice_date">Invoice date</label>
              <input id="invoice_date" name="invoice_date" type="date" required value="${today()}" /></div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="amount">Amount</label>
              <input id="amount" name="amount" type="text" inputmode="decimal" required placeholder="0.00" /></div>
            <div class="field"><label for="tax">Tax</label>
              <input id="tax" name="tax" type="text" inputmode="decimal" placeholder="0.00" /></div>
          </div>
          <div class="field"><label for="memo">What it is for</label>
            <input id="memo" name="memo" type="text" maxlength="240" /></div>
          <div class="btnrow">
            <button class="pill solid" type="submit">Record invoice</button>
            <a class="pill outline" href="/app/vendors/invoices">Cancel</a>
          </div>
        </form>
      </div>
      <div class="panel__foot">
        The cost is booked when the invoice arrives, not when it is paid. If the contractor's
        cover has lapsed the bill is still recorded — what is withheld is the payment.
      </div>
    </div>`;
}
