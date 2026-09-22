/* What a landlord sees about their own property.

   The same rule as the tenant side: this is a signed-in way to views that
   already exist, not a second copy of them. Statements are still read at
   `/o/s/:tok`, approvals are still decided at `/o/a/:tok`, and the tokenised
   links in the emails keep working — an owner who only ever opens the link in
   their monthly statement email never has to see this at all.

   What the portal adds is the question a token cannot answer: *how is the
   portfolio doing right now*. A statement is last month. An owner ringing the
   office to ask whether unit 3 is let yet, or whether the boiler was fixed,
   is asking something no statement contains.

   Reports and year-end tax documents are Phase 6. They are named as missing
   rather than half-built, because an owner who finds an empty "Reports" tab
   concludes the product is broken. */
import { all, get, one } from "../lib/db.js";
import { usd } from "../lib/money.js";
import { human, humanStamp, monthKey, today, prevMonthRange } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr } from "../lib/render.js";
import { portalPage, notice, empty } from "../views/layout.js";
import { propertiesFor, propertyIfHeld, rolesIn } from "../lib/identity.js";
import { portalTabs } from "./portal.js";

export function registerPortalOwner(router) {
  /* --- what you own -------------------------------------------------------- */

  router.get("/portal/home/owning", async (ctx) => {
    const { personId, companyId, company } = ctx.person;
    const roles = await rolesIn(personId, companyId);
    if (!roles.isOwner) return redirect(ctx.res, "/portal/home");

    const properties = await propertiesFor(personId, companyId);
    const ownerIds = roles.ownerIds;

    const [statements, distributions, approvals, totals] = await Promise.all([
      all(`SELECT * FROM owner_statement WHERE owner_id = ANY(?::text[])
            ORDER BY period_end DESC LIMIT 12`, ownerIds),
      all(`SELECT i.*, b.effective_date, b.method, b.status AS batch_status
             FROM payout_item i JOIN payout_batch b ON b.id = i.batch_id
            WHERE i.owner_id = ANY(?::text[]) AND b.status IN ('approved', 'issued')
            ORDER BY b.effective_date DESC LIMIT 12`, ownerIds),
      all(`SELECT a.*, w.summary, w.category, u.label, p.line1
             FROM owner_approval a
             JOIN work_order w ON w.id = a.work_order_id
             LEFT JOIN unit u ON u.id = w.unit_id
             LEFT JOIN property p ON p.id = u.property_id
            WHERE a.owner_id = ANY(?::text[]) AND a.status = 'pending'
            ORDER BY a.requested_at DESC`, ownerIds),
      get(`SELECT COALESCE(SUM(amount_cents), 0)::bigint AS balance
             FROM ledger_entry WHERE owner_id = ANY(?::text[])`, ownerIds),
    ]);

    const units = properties.reduce((n, p) => n + Number(p.units), 0);
    const occupied = properties.reduce((n, p) => n + Number(p.occupied), 0);

    sendHtml(ctx.res, portalPage({
      title: "What you own",
      heading: "Your property",
      lede: `Managed by ${company.name}`,
      person: ctx.person, company,
      tabs: portalTabs(roles), active: "owning",
      body: html`
        ${approvals.length ? approvalsPanel(approvals) : ""}

        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Units</span><span class="tile__value">${units}</span></div>
          <div class="tile"${attr("data-tone", units && occupied === units ? "ok" : null)}>
            <span class="tile__label">Occupied</span>
            <span class="tile__value">${occupied}${units ? ` / ${units}` : ""}</span>
          </div>
          <div class="tile"${attr("data-tone", Number(totals.balance) > 0 ? "ok" : null)}>
            <span class="tile__label">Held for you</span>
            <span class="tile__value">${usd(totals.balance)}</span>
          </div>
        </div>

        ${propertiesPanel(properties)}
        ${statementsPanel(statements)}
        ${distributionsPanel(distributions)}

        <div class="panel">
          <div class="panel__head"><h2>Reports</h2></div>
          <div class="panel__body">
            ${empty("Not here yet",
              html`Profit and loss, rent roll and year-end tax documents are being built.
                   Until then, ask ${company.name}
                   ${company.phone ? html`on <a href="tel:${company.phone}">${company.phone}</a>` : ""}
                   and they can produce them for you.`)}
          </div>
        </div>`,
    }));
  });

  /* --- one property -------------------------------------------------------- */

  router.get("/portal/owning/:propertyId", async (ctx) => {
    const { personId, companyId, company } = ctx.person;

    const property = await propertyIfHeld({ personId, companyId, propertyId: ctx.params.propertyId });
    if (!property) throw new NotFound("That property is not one of yours.");

    const period = monthKey(today());
    const [units, jobs, collected] = await Promise.all([
      all(`SELECT u.*, l.id AS lease_id, l.rent_cents, l.status AS lease_status,
                  l.start_date, l.end_date,
                  (SELECT string_agg(t.name, ', ') FROM lease_tenant lt
                     JOIN tenant t ON t.id = lt.tenant_id WHERE lt.lease_id = l.id) AS tenants
             FROM unit u
             LEFT JOIN lease l ON l.unit_id = u.id AND l.status = 'active'
            WHERE u.property_id = ? ORDER BY u.label`, property.id),
      all(`SELECT w.*, u.label FROM work_order w
             JOIN unit u ON u.id = w.unit_id
            WHERE u.property_id = ? AND w.status NOT IN ('complete', 'cancelled')
            ORDER BY w.created_at DESC LIMIT 20`, property.id),
      get(`SELECT
             COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'rent_payment'), 0)::bigint AS rent,
             COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'expense'), 0)::bigint AS costs
           FROM ledger_entry WHERE property_id = ? AND date >= ?`,
        property.id, `${period}-01`),
    ]);

    const due = units.reduce((n, u) => n + (u.lease_status === "active" ? Number(u.rent_cents) : 0), 0);
    const roles = await rolesIn(personId, companyId);

    sendHtml(ctx.res, portalPage({
      title: property.line1,
      heading: property.line1,
      lede: `${property.city}, ${property.state} ${property.zip}`,
      person: ctx.person, company,
      tabs: portalTabs(roles), active: "owning",
      body: html`
        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Rent due this month</span><span class="tile__value">${usd(due)}</span></div>
          <div class="tile" data-tone="ok"><span class="tile__label">Collected</span><span class="tile__value">${usd(collected.rent)}</span></div>
          <div class="tile"><span class="tile__label">Costs</span><span class="tile__value">${usd(Math.abs(Number(collected.costs)))}</span></div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Units</h2><p>Who is in, and what they pay</p></div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Unit</th><th>Who</th><th class="num">Rent</th><th>Lease ends</th></tr></thead>
                <tbody>
                  ${units.map((u) => html`
                    <tr>
                      <td>${u.label || "—"}<div class="cellsub">${u.beds} bed · ${u.baths} bath</div></td>
                      <td>${u.tenants || html`<span class="chip" data-tone="warn">vacant</span>`}</td>
                      <td class="num">${u.lease_status === "active" ? usd(u.rent_cents) : "—"}</td>
                      <td>${u.end_date ? human(u.end_date) : u.lease_status === "active" ? "open" : "—"}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Open repairs</h2></div>
          <div class="panel__body panel__body--flush">
            ${jobs.length === 0
              ? html`<div class="panel__body">${empty("Nothing open", "No repair is outstanding here.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Reported</th><th>Unit</th><th>What</th><th>State</th></tr></thead>
                    <tbody>
                      ${jobs.map((j) => html`
                        <tr>
                          <td>${humanStamp(j.created_at)}</td>
                          <td>${j.label || "—"}</td>
                          <td>${j.summary}<div class="cellsub">${j.category}</div></td>
                          <td><span class="chip" data-tone="warn">${j.status.replace(/_/g, " ")}</span></td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
          <div class="panel__foot">
            You are shown what was reported and where it got to. Anything over your
            approval limit is sent to you to decide before work starts.
          </div>
        </div>`,
    }));
  });
}

/* --- views ------------------------------------------------------------------- */

function approvalsPanel(approvals) {
  /* Above everything else, because it is the only thing on this page that is
     waiting on the person reading it. */
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Waiting for you</h2>
        <p>Work cannot start until you decide</p>
      </div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <thead><tr><th>Asked</th><th>Where</th><th>What</th><th class="num">Estimate</th><th></th></tr></thead>
            <tbody>
              ${approvals.map((a) => html`
                <tr>
                  <td>${humanStamp(a.requested_at)}</td>
                  <td>${a.line1 || "—"}${a.label ? html`<div class="cellsub">Unit ${a.label}</div>` : ""}</td>
                  <td>${a.summary}<div class="cellsub">${a.category}</div></td>
                  <td class="num">${usd(a.amount_cents)}</td>
                  <td class="shrink"><a class="pill solid sm" href="/o/a/${a.token}">Decide</a></td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function propertiesPanel(properties) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Your buildings</h2></div>
      <div class="panel__body panel__body--flush">
        ${properties.length === 0
          ? html`<div class="panel__body">${empty("Nothing listed",
              "No property is linked to this address. If that looks wrong, contact the office.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Address</th><th>Units</th><th>Occupied</th><th></th></tr></thead>
                <tbody>
                  ${properties.map((p) => html`
                    <tr>
                      <td>${p.line1}<div class="cellsub">${p.city}, ${p.state} ${p.zip}</div></td>
                      <td>${p.units}</td>
                      <td>${p.occupied}${Number(p.units) && Number(p.occupied) === Number(p.units)
                        ? html` <span class="chip" data-tone="ok">full</span>` : ""}</td>
                      <td class="shrink"><a class="pill outline sm" href="/portal/owning/${p.id}">Open</a></td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function statementsPanel(statements) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Statements</h2></div>
      <div class="panel__body panel__body--flush">
        ${statements.length === 0
          ? html`<div class="panel__body">${empty("None yet",
              "Your first statement appears after a full month under management.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Period</th><th>Sent</th><th></th></tr></thead>
                <tbody>
                  ${statements.map((s) => html`
                    <tr>
                      <td>${human(s.period_start)} to ${human(s.period_end)}</td>
                      <td>${s.sent_at ? humanStamp(s.sent_at) : html`<span class="cellsub">not sent</span>`}</td>
                      <td class="shrink"><a class="pill outline sm" href="/o/s/${s.token}">Read</a></td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function distributionsPanel(rows) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>What has been paid to you</h2>
        <p>Money sent to your own bank or posted as a cheque</p>
      </div>
      <div class="panel__body panel__body--flush">
        ${rows.length === 0
          ? html`<div class="panel__body">${empty("Nothing yet", "Distributions appear here once one has been sent.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Date</th><th>How</th><th class="num">Amount</th><th>State</th></tr></thead>
                <tbody>
                  ${rows.map((r) => html`
                    <tr${attr("style", r.voided_at ? "opacity:0.55" : null)}>
                      <td>${human(r.effective_date)}</td>
                      <td>${r.method === "ach" ? "Bank transfer" : `Cheque ${r.check_number || ""}`.trim()}</td>
                      <td class="num">${usd(r.amount_cents)}</td>
                      <td>${r.voided_at
                        ? html`<span class="chip" data-tone="danger">void</span>`
                        : html`<span class="chip"${attr("data-tone", r.batch_status === "issued" ? "ok" : "warn")}>
                            ${r.batch_status === "issued" ? "sent" : "being sent"}</span>`}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}
