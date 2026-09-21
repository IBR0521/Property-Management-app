/* Portfolio: the properties, units and leases everything else hangs off. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween, monthKey } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { tick } from "../lib/scheduler.js";

const UNIT_TONE = { occupied: "ok", vacant: "warn", turn: "brand", offline: null };

export function registerPortfolio(router) {
  router.get("/app/portfolio", async (ctx) => {
    const cid = ctx.staff.company_id;
    const units = await all(
      `SELECT u.*, p.line1, p.city, p.zip, o.name AS owner_name, o.id AS owner_id,
              l.id AS lease_id, l.rent_cents, l.end_date, l.start_date,
              (SELECT string_agg(t.name, ', ') FROM lease_tenant lt
                 JOIN tenant t ON t.id = lt.tenant_id WHERE lt.lease_id = l.id) AS tenants
         FROM unit u
         JOIN property p ON p.id = u.property_id
         JOIN owner o ON o.id = p.owner_id
         LEFT JOIN lease l ON l.unit_id = u.id AND l.status = 'active'
        WHERE u.company_id = ? ORDER BY p.line1, u.label`, cid);

    const occupied = units.filter((u) => u.status === "occupied").length;
    const rentRoll = units.reduce((n, u) => n + (u.rent_cents || 0), 0);
    const endingSoon = units.filter((u) => u.end_date && daysBetween(today(), u.end_date) <= 90 && daysBetween(today(), u.end_date) >= 0);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Properties",
      subtitle: `${units.length} unit${units.length === 1 ? "" : "s"} · ${occupied} occupied`,
      body: html`
        ${tabs(PROPERTY_TABS, "units")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="grid grid--4">
          <div class="tile"><span class="tile__label">Units</span><span class="tile__value">${units.length}</span></div>
          <div class="tile" data-tone="ok"><span class="tile__label">Occupied</span><span class="tile__value">${occupied}</span>
            <span class="tile__note">${units.length ? Math.round((occupied / units.length) * 100) : 0}% of the portfolio</span></div>
          <div class="tile"><span class="tile__label">Monthly rent roll</span><span class="tile__value">${usd(rentRoll)}</span></div>
          <div class="tile"${attr("data-tone", endingSoon.length ? "warn" : null)}>
            <span class="tile__label">Leases ending</span><span class="tile__value">${endingSoon.length}</span>
            <span class="tile__note">Within 90 days</span></div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Units</h2></div>
          <div class="panel__body panel__body--flush">
            ${units.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Address</th><th>Owner</th><th>Tenants</th><th class="num">Rent</th><th>Lease ends</th><th class="shrink">State</th></tr></thead>
              <tbody>${units.map((u) => html`
                <tr>
                  <td><a href="/app/portfolio/u/${u.id}">${u.line1}${u.label ? html` — ${u.label}` : ""}</a>
                    <span class="cellsub">${u.city} ${u.zip}${u.beds ? ` · ${u.beds} bed` : ""}${u.baths ? `, ${u.baths} bath` : ""}</span></td>
                  <td><a href="/app/owners/${u.owner_id}">${u.owner_name}</a></td>
                  <td>${u.tenants || html`<span style="color:var(--ink-soft)">—</span>`}</td>
                  <td class="num">${u.rent_cents ? usd(u.rent_cents) : u.market_rent_cents ? html`<span style="color:var(--ink-soft)">mkt ${usd(u.market_rent_cents)}</span>` : "—"}</td>
                  <td>${u.end_date ? html`${human(u.end_date)}
                        ${daysBetween(today(), u.end_date) <= 90 && daysBetween(today(), u.end_date) >= 0
                          ? html`<span class="cellsub">${daysBetween(today(), u.end_date)} days</span>` : ""}`
                      : html`<span style="color:var(--ink-soft)">—</span>`}</td>
                  <td class="shrink"><span class="chip"${attr("data-tone", UNIT_TONE[u.status])}>${u.status}</span></td>
                </tr>`)}</tbody>
            </table></div>` : empty("Nothing in the portfolio", "Add an owner, a property and a unit in Setup.")}
          </div>
        </div>

        <div class="panel" style="max-width:44rem">
          <div class="panel__head"><h2>Record a move-out</h2><p>This is what starts the deposit-return clock</p></div>
          <div class="panel__body">
            ${notice("warn", "One date, two consequences",
              "Setting a move-out date ends the lease, and creates the deposit-return obligation with the deadline your rule specifies.")}
            <form method="post" action="/app/portfolio/moveout" class="formgrid" style="margin-top:1rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="lease_id">Lease</label>
                <select id="lease_id" name="lease_id" required>
                  <option value="">Choose…</option>
                  ${units.filter((u) => u.lease_id).map((u) => html`
                    <option value="${u.lease_id}">${u.line1}${u.label ? ` — ${u.label}` : ""} (${u.tenants || "no tenant on file"})</option>`)}
                </select>
              </div>
              <div class="field">
                <label for="moveout_date">Keys returned</label>
                <input id="moveout_date" name="moveout_date" type="date" value="${today()}" required />
              </div>
              <button class="pill solid" type="submit">Record move-out</button>
            </form>
          </div>
        </div>`,
    }));
  });

  router.post("/app/portfolio/moveout", async (ctx) => {
    const cid = ctx.staff.company_id;
    const lease = await one("SELECT * FROM lease WHERE id = ? AND company_id = ?", String(ctx.fields.lease_id || ""), cid);
    const date = String(ctx.fields.moveout_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("Give the date the keys came back.");

    await tx(async () => {
      await update("lease", lease.id, { moveout_date: date, status: "ended" });
      await update("unit", lease.unit_id, { status: "vacant" });
      await insert("audit_log", {
        id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
        entity: "lease", entity_id: lease.id, action: "moveout", detail: date,
      });
    });
    // The deposit obligation is generated by the scheduler from this date, so
    // it appears whether or not anyone visits the compliance screen.
    await tick("moveout");
    redirect(ctx.res, `/app/portfolio?m=${encodeURIComponent("Move-out recorded — the deposit clock is running.")}`);
  });

  /* ======================================================================
     One unit, everything about it.
     ----------------------------------------------------------------------
     The page that exists because the tenant, the rent, the open repair, the
     lease end and the deposit clock for a single address used to live on five
     different screens. A manager thinks in addresses, so this is the hub and
     the feature lists are the reports.
     ====================================================================== */
  router.get("/app/portfolio/u/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const u = await get(
      `SELECT u.*, p.line1, p.city, p.state, p.zip, p.id AS property_id,
              o.name AS owner_name, o.id AS owner_id, o.approval_threshold_cents
         FROM unit u JOIN property p ON p.id = u.property_id JOIN owner o ON o.id = p.owner_id
        WHERE u.id = ? AND u.company_id = ?`, ctx.params.id, cid);
    if (!u) return sendHtml(ctx.res, "Not found", 404);

    const lease = await get(
      `SELECT * FROM lease WHERE unit_id = ? AND status = 'active' ORDER BY start_date DESC LIMIT 1`, u.id);
    const tenants = lease ? await all(
      `SELECT t.* FROM tenant t JOIN lease_tenant lt ON lt.tenant_id = t.id WHERE lt.lease_id = ?`, lease.id) : [];
    const jobs = await all(
      `SELECT w.*, v.name AS vendor_name FROM work_order w LEFT JOIN vendor v ON v.id = w.vendor_id
        WHERE w.unit_id = ? ORDER BY
          CASE WHEN w.status IN ('complete','cancelled') THEN 1 ELSE 0 END,
          w.created_at DESC LIMIT 12`, u.id);
    const period = monthKey(today());
    const delinq = lease ? await get(
      "SELECT * FROM delinquency WHERE lease_id = ? AND period = ?", lease.id, period) : null;
    const paid = lease ? (await get(
      `SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger_entry
        WHERE lease_id = ? AND kind = 'rent_payment' AND date >= ?`, lease.id, `${period}-01`)).c : 0;

    // Deadlines attached to this unit, its lease, or its building.
    const subjects = [u.id, u.property_id, lease ? lease.id : ""].filter(Boolean);
    const obligations = await all(
      `SELECT o.*, r.label FROM obligation o JOIN compliance_rule r ON r.id = o.rule_id
        WHERE o.company_id = ? AND o.status IN ('open','overdue')
          AND o.subject_id IN (${subjects.map(() => "?").join(",")})
        ORDER BY o.due_date LIMIT 8`, cid, ...subjects);

    const turn = await get("SELECT * FROM turn WHERE unit_id = ? AND status = 'open' LIMIT 1", u.id);
    const recent = await all(
      `SELECT e.*, w.reference FROM work_order_event e
         JOIN work_order w ON w.id = e.work_order_id
        WHERE w.unit_id = ? ORDER BY e.at DESC LIMIT 8`, u.id);

    const open = jobs.filter((j) => !["complete", "cancelled"].includes(j.status));

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `${u.line1}${u.label ? ` · unit ${u.label}` : ""}`,
      subtitle: `${u.city}, ${u.state} ${u.zip} · owned by ${u.owner_name}`,
      actions: html`
        <a class="pill outline sm" href="/app/portfolio">All units</a>
        <a class="pill solid sm" href="/app/maintenance/new">Log a repair</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="hub">
          <div class="hub__col">

            <div class="panel">
              <div class="panel__head">
                <h2>Who lives here</h2>
                <span class="chip"${attr("data-tone", UNIT_TONE[u.status])}>${u.status}</span>
              </div>
              <div class="panel__body">
                ${lease
                  ? html`<dl class="dl">
                      <div><dt>Tenants</dt><dd>${tenants.length
                        ? tenants.map((t) => html`${t.name}${t.phone ? html` · <a href="tel:${t.phone}">${t.phone}</a>` : ""}<br />`)
                        : "none recorded"}</dd></div>
                      <div><dt>Rent</dt><dd>${usd(lease.rent_cents)} on day ${lease.rent_due_day}, ${lease.grace_days} days grace</dd></div>
                      <div><dt>Lease</dt><dd>${human(lease.start_date)} to ${lease.end_date ? human(lease.end_date) : "open"}
                        ${lease.end_date ? html`<span class="cellsub">${daysBetween(today(), lease.end_date)} days left</span>` : ""}</dd></div>
                      <div><dt>Deposit held</dt><dd>${usd(lease.deposit_cents)}</dd></div>
                    </dl>`
                  : empty("Vacant", "No active lease on this unit.")}
              </div>
            </div>

            ${lease ? html`
              <div class="panel">
                <div class="panel__head"><h2>Rent this month</h2><p>${period}</p></div>
                <div class="panel__body">
                  <div class="grid grid--3">
                    <div class="tile"><span class="tile__label">Due</span><span class="tile__value">${usd(lease.rent_cents)}</span></div>
                    <div class="tile" data-tone="ok"><span class="tile__label">Paid</span><span class="tile__value">${usd(paid)}</span></div>
                    <div class="tile"${attr("data-tone", lease.rent_cents - paid > 0 ? "warn" : null)}>
                      <span class="tile__label">Outstanding</span>
                      <span class="tile__value">${usd(Math.max(0, lease.rent_cents - paid))}</span></div>
                  </div>
                  <div class="btnrow" style="margin-top:1rem">
                    <a class="pill outline sm" href="/app/rent/record?lease=${lease.id}&period=${period}">Record a payment</a>
                    ${delinq ? html`<a class="pill solid sm" href="/app/rent/${delinq.id}">Chase ${usd(delinq.amount_cents)}</a>` : ""}
                  </div>
                </div>
              </div>` : ""}

            <div class="panel">
              <div class="panel__head"><h2>Repairs</h2><p>${open.length} open</p></div>
              <div class="panel__body panel__body--flush">
                ${jobs.length
                  ? jobs.map((j) => html`
                      <div class="minirow">
                        <span class="chip"${attr("data-tone", j.severity === "emergency" ? "danger" : j.severity === "urgent" ? "warn" : null)}>${j.severity}</span>
                        <div class="minirow__main">
                          <b><a href="/app/maintenance/${j.id}">${j.summary}</a></b>
                          <span class="cellsub">${j.reference} · ${j.vendor_name || "no vendor"} · ${human(j.created_at.slice(0, 10))}</span>
                        </div>
                        <span class="chip"${attr("data-tone", j.status === "complete" ? "ok" : "brand")}>${j.status.replace(/_/g, " ")}</span>
                      </div>`)
                  : html`<div class="empty">Nothing has been reported here.</div>`}
              </div>
            </div>
          </div>

          <div class="hub__col">
            ${turn ? html`
              <div class="panel">
                <div class="panel__head"><h2>Turn in progress</h2></div>
                <div class="panel__body">
                  <dl class="dl">
                    <div><dt>Stage</dt><dd>${turn.stage.replace(/_/g, " ")}</dd></div>
                    <div><dt>Moved out</dt><dd>${human(turn.moveout_date)}</dd></div>
                    <div><dt>Vacant</dt><dd>${turn.moveout_date ? `${daysBetween(turn.moveout_date, today())} days` : "—"}</dd></div>
                  </dl>
                  <a class="pill outline sm" style="margin-top:1rem" href="/app/turns/${turn.id}">Open the turn</a>
                </div>
              </div>` : ""}

            <div class="panel">
              <div class="panel__head"><h2>Deadlines</h2><p>${obligations.length}</p></div>
              <div class="panel__body panel__body--flush">
                ${obligations.length
                  ? obligations.map((o) => html`
                      <div class="minirow">
                        <div class="minirow__main">
                          <b>${o.label}</b>
                          <span class="cellsub">due ${human(o.due_date)}</span>
                        </div>
                        <span class="chip"${attr("data-tone", o.status === "overdue" ? "danger" : "warn")}>${o.status}</span>
                      </div>`)
                  : html`<div class="empty">No clock running on this unit.</div>`}
              </div>
            </div>

            <div class="panel">
              <div class="panel__head"><h2>Owner</h2></div>
              <div class="panel__body">
                <dl class="dl">
                  <div><dt>Name</dt><dd><a href="/app/owners/${u.owner_id}">${u.owner_name}</a></dd></div>
                  <div><dt>Approves over</dt><dd>${usd(u.approval_threshold_cents)}</dd></div>
                </dl>
              </div>
            </div>

            <div class="panel">
              <div class="panel__head"><h2>Recent activity</h2></div>
              <div class="panel__body">
                <div class="timeline">
                  ${recent.length ? recent.map((e) => html`
                    <div class="tl" data-tone="brand">
                      <div class="tl__dot">${icons.clock}</div>
                      <div class="tl__body">
                        <b>${e.reference}</b>
                        <time>${humanStamp(e.at)} · ${e.actor}</time>
                        ${e.note ? html`<p>${e.note}</p>` : ""}
                      </div>
                    </div>`) : html`<div class="empty">Nothing yet.</div>`}
                </div>
              </div>
            </div>
          </div>
        </div>`,
    }));
  });
}
