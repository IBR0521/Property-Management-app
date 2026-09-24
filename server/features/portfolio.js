/* Portfolio: the properties, units and leases everything else hangs off. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id, stickerToken } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween, monthKey, rentDayLabel } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr, raw } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { linkTenant } from "../lib/identity.js";
import { tick } from "../lib/scheduler.js";
import { qrSvg } from "../lib/qr.js";

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
      actions: html`
        <a class="pill outline sm" href="/app/portfolio/labels">Repair QR codes</a>
        <a class="pill solid sm" href="/app/portfolio/new">Add a building</a>`,
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

  /* The sticker sheet.

     A tenant who has to find the right website, then find their own address in
     a list, will phone instead — which is the cost this whole feature exists
     to remove. A code on the back of the kitchen door removes both steps: it
     opens the form with the address already known.

     Printed, not screen-shown, so the page carries its own print rules and the
     QR is inline SVG — one request, and sharp at any paper size. */
  /* --- building and apartment records --------------------------------------
     Everything else in this app operates a portfolio. This is the part that
     builds one, and it runs in dependency order: an owner exists, then their
     building, then its apartments, then somebody living in one.

     Registered before any /app/portfolio/:param route, because routes match in
     registration order and a :param would swallow these literal words. ----- */

  router.get("/app/portfolio/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owners = await all("SELECT id, name FROM owner WHERE company_id = ? ORDER BY name", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Add a building",
      subtitle: "A street address. Its apartments come next.",
      body: owners.length
        ? propertyForm({ csrf: ctx.csrf, property: null, owners, error: ctx.query.e })
        : empty("No owners yet", "A building has to belong to somebody. Add the owner first, then come back."),
    }));
  });

  router.post("/app/portfolio/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const bad = (msg) => redirect(ctx.res, `/app/portfolio/new?e=${encodeURIComponent(msg)}`);

    const owner = await get("SELECT id FROM owner WHERE id = ? AND company_id = ?", String(f.owner_id || ""), cid);
    if (!owner) return bad("Pick which owner this building belongs to.");
    const line1 = String(f.line1 || "").trim();
    if (line1.length < 3) return bad("A building needs a street address.");
    const city = String(f.city || "").trim();
    if (!city) return bad("Which city?");

    const propId = id();
    const kind = ["single", "multi", "condo"].includes(f.kind) ? f.kind : "single";
    await tx(async () => {
      await insert("property", {
        id: propId, company_id: cid, owner_id: owner.id, line1, city,
        state: String(f.state || "").trim().toUpperCase().slice(0, 2) || "OH",
        zip: String(f.zip || "").trim(), kind,
        year_built: yearOf(f.year_built),
        notes: String(f.notes || "").trim() || null,
        created_at: stamp(),
      });
      /* A house is one apartment. Making the manager add "the unit" to a
         single-family home after typing its address is a question with only
         one answer, so it is not asked. */
      if (kind === "single") await createUnit({ cid, propertyId: propId, label: "", f });
    });

    redirect(ctx.res, kind === "single"
      ? `/app/portfolio?m=${encodeURIComponent("Building added. Open it to set rent and move someone in.")}`
      : `/app/portfolio/p/${propId}/unit/new?m=${encodeURIComponent("Building added. Now add its apartments.")}`);
  });

  router.get("/app/portfolio/p/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const property = await one("SELECT * FROM property WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const owners = await all("SELECT id, name FROM owner WHERE company_id = ? ORDER BY name", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `Edit ${property.line1}`, subtitle: "Building details",
      body: propertyForm({ csrf: ctx.csrf, property, owners, error: ctx.query.e }),
    }));
  });

  router.post("/app/portfolio/p/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const property = await one("SELECT * FROM property WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const owner = await get("SELECT id FROM owner WHERE id = ? AND company_id = ?", String(f.owner_id || ""), cid);
    const line1 = String(f.line1 || "").trim();
    if (!owner || line1.length < 3) {
      return redirect(ctx.res, `/app/portfolio/p/${property.id}/edit?e=${encodeURIComponent("An owner and a street address are both required.")}`);
    }
    await update("property", property.id, {
      owner_id: owner.id, line1,
      city: String(f.city || "").trim(),
      state: String(f.state || "").trim().toUpperCase().slice(0, 2),
      zip: String(f.zip || "").trim(),
      kind: ["single", "multi", "condo"].includes(f.kind) ? f.kind : property.kind,
      year_built: yearOf(f.year_built),
      notes: String(f.notes || "").trim() || null,
    });
    redirect(ctx.res, `/app/portfolio?m=${encodeURIComponent("Building updated.")}`);
  });

  router.get("/app/portfolio/p/:id/unit/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const property = await one("SELECT * FROM property WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const existing = await all(
      "SELECT label FROM unit WHERE property_id = ? ORDER BY label", property.id);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Add an apartment",
      subtitle: `${property.line1}${existing.length ? ` · ${existing.length} already added` : ""}`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${unitForm({ csrf: ctx.csrf, unit: null, property, error: ctx.query.e })}
        ${existing.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Already in this building</h2></div>
            <div class="panel__body">
              <div class="btnrow">
                ${existing.map((u) => html`<span class="chip chip--plain">Unit ${u.label || "—"}</span>`)}
              </div>
            </div>
          </div>` : ""}`,
    }));
  });

  router.post("/app/portfolio/p/:id/unit/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const property = await one("SELECT * FROM property WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const label = String(f.label || "").trim();

    const clash = await get(
      "SELECT id FROM unit WHERE property_id = ? AND label = ?", property.id, label);
    if (clash) {
      return redirect(ctx.res, `/app/portfolio/p/${property.id}/unit/new?e=${encodeURIComponent(`This building already has a unit ${label || "with no number"}.`)}`);
    }

    await createUnit({ cid, propertyId: property.id, label, f });

    /* Straight back to a blank form. Adding a twelve-unit building means
       twelve of these, and returning to a list each time would be twelve
       extra clicks. */
    redirect(ctx.res, `/app/portfolio/p/${property.id}/unit/new?m=${encodeURIComponent(`Unit ${label || "added"} saved. Add another, or go back to Properties.`)}`);
  });

  router.get("/app/portfolio/u/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = await one(
      `SELECT u.*, p.line1, p.city FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.id = ? AND u.company_id = ?`, ctx.params.id, cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `Edit ${unit.line1}${unit.label ? ` · unit ${unit.label}` : ""}`,
      subtitle: "Apartment details",
      body: unitForm({ csrf: ctx.csrf, unit, property: { id: unit.property_id, line1: unit.line1 }, error: ctx.query.e }),
    }));
  });

  router.post("/app/portfolio/u/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = await one("SELECT * FROM unit WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const label = String(f.label || "").trim();
    const clash = await get(
      "SELECT id FROM unit WHERE property_id = ? AND label = ? AND id <> ?", unit.property_id, label, unit.id);
    if (clash) {
      return redirect(ctx.res, `/app/portfolio/u/${unit.id}/edit?e=${encodeURIComponent(`Another unit in this building is already ${label || "unnumbered"}.`)}`);
    }
    await update("unit", unit.id, {
      label,
      beds: numOf(f.beds), baths: numOf(f.baths),
      sqft: intOf(f.sqft),
      market_rent_cents: parseMoney(f.market_rent) ?? null,
      status: ["occupied", "vacant", "turn", "offline"].includes(f.status) ? f.status : unit.status,
    });
    redirect(ctx.res, `/app/portfolio/u/${unit.id}?m=${encodeURIComponent("Apartment updated.")}`);
  });

  /* Move-in: the mirror of the move-out that already exists. Creates the
     tenant, the lease and the link between them in one transaction, because a
     lease with no tenant on it is a row nobody can act on. */
  router.get("/app/portfolio/u/:id/movein", async (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = await one(
      `SELECT u.*, p.line1, p.city FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.id = ? AND u.company_id = ?`, ctx.params.id, cid);
    const active = await get(
      "SELECT id FROM lease WHERE unit_id = ? AND status = 'active' LIMIT 1", unit.id);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Move someone in",
      subtitle: `${unit.line1}${unit.label ? ` · unit ${unit.label}` : ""}`,
      body: active
        ? notice("warn", "Someone already lives here",
            html`Record the move-out first — two active leases on one apartment would make the rent ledger wrong.
                 <a href="/app/portfolio/u/${unit.id}">Back to the apartment</a>.`)
        : moveInForm({ csrf: ctx.csrf, unit, error: ctx.query.e }),
    }));
  });

  router.post("/app/portfolio/u/:id/movein", async (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = await one("SELECT * FROM unit WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const bad = (msg) => redirect(ctx.res, `/app/portfolio/u/${unit.id}/movein?e=${encodeURIComponent(msg)}`);

    const name = String(f.tenant_name || "").trim();
    if (name.length < 2) return bad("Who is moving in?");
    const rent = parseMoney(f.rent);
    if (rent == null || rent <= 0) return bad("What is the rent?");
    const start = String(f.start_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return bad("When does the lease start?");
    const end = String(f.end_date || "").trim();
    if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return bad("That end date is not a date.");
    if (end && end <= start) return bad("The lease cannot end before it starts.");

    const existing = await get("SELECT id FROM lease WHERE unit_id = ? AND status = 'active' LIMIT 1", unit.id);
    if (existing) return bad("Someone already has an active lease on this apartment.");

    await tx(async () => {
      const tenantId = id();
      const leaseId = id();
      await insert("tenant", {
        id: tenantId, company_id: cid, name,
        email: String(f.tenant_email || "").trim() || null,
        phone: String(f.tenant_phone || "").trim() || null,
        created_at: stamp(),
      });
      await insert("lease", {
        id: leaseId, company_id: cid, unit_id: unit.id,
        start_date: start, end_date: end || null,
        rent_cents: rent,
        deposit_cents: parseMoney(f.deposit) ?? 0,
        rent_due_day: dueDayOf(f.rent_due_day),
        grace_days: graceOf(f.grace_days),
        status: "active", created_at: stamp(),
      });
      await insert("lease_tenant", { lease_id: leaseId, tenant_id: tenantId });
      await update("unit", unit.id, { status: "occupied" });

      /* The portal side of the same fact. This insert makes a fresh `tenant`
         row every time, so somebody moving from unit 1 to unit 3 becomes two
         rows — linking them to one person here is what lets them sign in once
         and see both. A tenancy with no email gets no link and keeps working
         exactly as it does now, reachable by token. */
      await linkTenant({ tenantId, source: "movein" });
      await insert("audit_log", {
        id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
        entity: "lease", entity_id: leaseId, action: "movein", detail: `${name} from ${start}`,
      });
    });

    redirect(ctx.res, `/app/portfolio/u/${unit.id}?m=${encodeURIComponent(`${name} moved in. Rent is now on the ledger.`)}`);
  });

  router.get("/app/portfolio/labels", async (ctx) => {
    const cid = ctx.staff.company_id;
    const only = String(ctx.query.property || "");
    const units = await all(
      `SELECT u.id, u.label, u.report_token, p.id AS property_id, p.line1, p.city, p.zip
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ?${only ? " AND p.id = ?" : ""}
        ORDER BY p.line1, u.label`,
      ...(only ? [cid, only] : [cid]));

    const properties = await all(
      `SELECT p.id, p.line1, count(u.id)::int AS units
         FROM property p JOIN unit u ON u.property_id = p.id
        WHERE p.company_id = ? GROUP BY p.id, p.line1 ORDER BY p.line1`, cid);

    const origin = `${ctx.url.protocol}//${ctx.url.host}`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, active: "portfolio", csrf: ctx.csrf,
      counts: await navCounts(cid),
      title: "Repair QR codes",
      subtitle: `${units.length} label${units.length === 1 ? "" : "s"} · print, then put one inside each unit`,
      // No print button: this app ships no client JavaScript, and window.print()
      // would be the only reason to start. The browser's own print command does
      // the same job and works when script is blocked.
      actions: html`<a class="pill outline sm" href="/app/portfolio">All units</a>`,
      body: html`
        ${tabs(PROPERTY_TABS, "units")}
        <div class="panel noprint">
          <div class="panel__body">
            <div class="btnrow">
              <a class="pill${only ? " outline" : " solid"} sm" href="/app/portfolio/labels">All properties</a>
              ${properties.map((pr) => html`
                <a class="pill${only === pr.id ? " solid" : " outline"} sm"
                   href="/app/portfolio/labels?property=${pr.id}">${pr.line1} (${pr.units})</a>`)}
            </div>
            <p class="lede" style="margin:0.75rem 0 0">
              Print this page (<b>Ctrl</b>+<b>P</b>, or <b>&#8984;</b>+<b>P</b>) on plain paper or
              sticker sheets — everything except the labels drops off the page. Each code
              opens the repair form with that unit already filled in, so the tenant never
              picks an address. If a code is misused, regenerate it on the unit's page and
              the old sticker stops working straight away.
            </p>
          </div>
        </div>

        ${units.length === 0 ? empty("No units yet.") : html`
          <div class="labelsheet">
            ${units.map((u) => {
              const url = `${origin}/r/${u.report_token}`;
              return html`
                <div class="labelcard">
                  ${raw(qrSvg(url, { size: 150, label: `Report a repair at ${u.line1}${u.label ? ` unit ${u.label}` : ""}` }))}
                  <div class="labelcard__t">
                    <b>Something broken?</b>
                    <span>Scan this code to tell ${ctx.staff.company_name}. No app, no account.</span>
                    <small>${u.line1}${u.label ? ` · Unit ${u.label}` : ""}, ${u.city}</small>
                    <code>${origin.replace(/^https?:\/\//, "")}/r/${u.report_token}</code>
                  </div>
                </div>`;
            })}
          </div>`}`,
    }));
  });

  /* Burn a sticker. The only reason to need this is a code that got shared or
     photographed somewhere public and is now attracting junk — so it takes
     effect immediately and the reprint is the staff member's problem. */
  router.post("/app/portfolio/u/:id/newtoken", async (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = await get("SELECT id FROM unit WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (!unit) throw new BadRequest("No such unit.");
    await update("unit", unit.id, { report_token: stickerToken() });
    redirect(ctx.res, `/app/portfolio/u/${unit.id}?m=${encodeURIComponent("New QR code generated. Reprint the sticker for this unit — the old one no longer works.")}`);
  });

  router.post("/app/portfolio/moveout", async (ctx) => {
    const cid = ctx.staff.company_id;
    const lease = await one("SELECT * FROM lease WHERE id = ? AND company_id = ?", String(ctx.fields.lease_id || ""), cid);
    const date = String(ctx.fields.moveout_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("Give the date the keys came back.");

    let ret = null;
    await tx(async () => {
      await update("lease", lease.id, { moveout_date: date, status: "ended" });
      await update("unit", lease.unit_id, { status: "vacant" });
      await insert("audit_log", {
        id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
        entity: "lease", entity_id: lease.id, action: "moveout", detail: date,
      });

      /* The return opens here, in the same transaction as the move-out, so a
         tenancy cannot end without one. The compliance engine has counted
         forward to this deadline since Phase 1 with nothing for it to be a
         deadline for; this is the thing it was always counting towards. */
      const { openReturn } = await import("../lib/deposits.js");
      ret = await openReturn({
        companyId: cid, leaseId: lease.id, moveoutDate: date, by: ctx.staff.name,
      });
    });
    // The deposit obligation is generated by the scheduler from this date, so
    // it appears whether or not anyone visits the compliance screen.
    await tick("moveout");
    redirect(ctx.res, `/app/deposits/${ret.id}?m=${encodeURIComponent(
      "Move-out recorded. This is the deposit return — the clock is running.")}`);
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
        <a class="pill outline sm" href="/app/portfolio/u/${u.id}/edit">Edit</a>
        ${lease ? "" : html`<a class="pill outline sm" href="/app/portfolio/u/${u.id}/movein">Move someone in</a>`}
        <a class="pill outline sm" href="/app/portfolio/labels?property=${u.property_id}">QR label</a>
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
                      <div><dt>Rent</dt><dd>${usd(lease.rent_cents)} on ${rentDayLabel(lease.rent_due_day)}, ${lease.grace_days} days grace</dd></div>
                      <div><dt>Lease</dt><dd>${human(lease.start_date)} to ${lease.end_date ? human(lease.end_date) : "open"}
                        ${lease.end_date ? html`<span class="cellsub">${daysBetween(today(), lease.end_date)} days left</span>` : ""}</dd></div>
                      <div><dt>Deposit held</dt><dd>${usd(lease.deposit_cents)}</dd></div>
                      <div><dt>Pay rent link</dt><dd>
                        ${Number(lease.payments_blocked)
                          ? html`<span class="chip" data-tone="warn">cash only</span>
                                 <span class="cellsub">${lease.payments_blocked_reason || ""}</span>`
                          : html`<a href="/pay/${lease.pay_token}" style="word-break:break-all">${ctx.url.protocol}//${ctx.url.host}/pay/${lease.pay_token}</a>
                                 <span class="cellsub">Send this once; it does not expire and shows only this home.</span>`}
                      </dd></div>
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
              <div class="panel__head">
                <h2>Building</h2>
                <a class="pill outline sm" href="/app/portfolio/p/${u.property_id}/edit">Edit</a>
              </div>
              <div class="panel__body">
                <dl class="dl">
                  <div><dt>Address</dt><dd>${u.line1}, ${u.city} ${u.zip}</dd></div>
                  <div><dt>Apartments</dt><dd><a href="/app/portfolio/p/${u.property_id}/unit/new">Add another to this building</a></dd></div>
                </dl>
              </div>
            </div>

            <div class="panel">
              <div class="panel__head"><h2>Repair QR code</h2></div>
              <div class="panel__body">
                <p class="lede" style="margin:0 0 0.75rem">
                  The sticker inside this unit opens the repair form with the
                  address already filled in.
                </p>
                <div class="btnrow">
                  <a class="pill outline sm" href="/app/portfolio/labels?property=${u.property_id}">Print label</a>
                  <form method="post" action="/app/portfolio/u/${u.id}/newtoken">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <button class="pill outline sm" type="submit">New code</button>
                  </form>
                </div>
                <span class="field__help" style="display:block;margin-top:0.5rem">
                  A new code kills the old sticker immediately. Only do this if
                  the current one is being misused — it means reprinting.
                </span>
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

/* --- record helpers -------------------------------------------------------- */

/* Every apartment gets its repair token in the same statement that creates it,
   so a unit added through the app is never a unit whose QR sticker cannot be
   printed. The column is NOT NULL, so this cannot be a follow-up UPDATE. */
async function createUnit({ cid, propertyId, label, f }) {
  const unitId = id();
  await insert("unit", {
    id: unitId, company_id: cid, property_id: propertyId, label,
    beds: numOf(f.beds), baths: numOf(f.baths), sqft: intOf(f.sqft),
    market_rent_cents: parseMoney(f.market_rent) ?? null,
    status: ["occupied", "vacant", "turn", "offline"].includes(f.status) ? f.status : "vacant",
    report_token: stickerToken(),
    created_at: stamp(),
  });
  return unitId;
}

function numOf(v) {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function intOf(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function yearOf(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1700 && n <= new Date().getFullYear() + 1 ? n : null;
}

function dueDayOf(v) {
  const n = parseInt(String(v || ""), 10);
  /* 1 to 31. It used to stop at 28 "for the same reason statements use it:
     February" — but `dueDateFor` has always clamped the day to the length of
     the month it lands in, so February was never the problem the ceiling
     solved. What the ceiling did instead was forbid the second most common
     arrangement there is: rent due on the last day of the month. It also did
     it quietly, because anything outside the range fell back to 1, so a lease
     imported as due on the 30th silently became due on the 1st.

     31 means the last day, in every month. */
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : 1;
}

function graceOf(v) {
  const n = parseInt(String(v || ""), 10);
  return Number.isFinite(n) && n >= 0 && n <= 31 ? n : 5;
}

/* --- record forms ---------------------------------------------------------- */

function propertyForm({ csrf, property, owners, error }) {
  const action = property ? `/app/portfolio/p/${property.id}/edit` : "/app/portfolio/new";
  const kind = property ? property.kind : "single";
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>${property ? "Building details" : "New building"}</h2></div>
      <div class="panel__body">
        <form method="post" action="${action}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="owner_id">Owner</label>
            <select id="owner_id" name="owner_id" required>
              <option value="">Who owns it?</option>
              ${owners.map((o) => html`
                <option value="${o.id}"${attr("selected", property && property.owner_id === o.id)}>${o.name}</option>`)}
            </select>
          </div>

          <div class="field">
            <label for="line1">Street address</label>
            <input id="line1" name="line1" type="text" required maxlength="160"
                   value="${property ? property.line1 : ""}" placeholder="1507 Brice Rd" />
            <span class="field__help">Just the street and number — apartment numbers are added per unit.</span>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="city">City</label>
              <input id="city" name="city" type="text" required maxlength="80"
                     value="${property ? property.city : ""}" />
            </div>
            <div class="field">
              <label for="state">State</label>
              <input id="state" name="state" type="text" maxlength="2" required
                     value="${property ? property.state : ""}" placeholder="OH" />
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="zip">ZIP</label>
              <input id="zip" name="zip" type="text" maxlength="12"
                     value="${property ? property.zip : ""}" />
            </div>
            <div class="field">
              <label for="year_built">Year built <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
              <input id="year_built" name="year_built" type="number" min="1700" max="2100"
                     value="${property && property.year_built ? property.year_built : ""}" />
            </div>
          </div>

          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">What kind of building?</span>
            <div class="radioset">
              <label class="radiotile">
                <input type="radio" name="kind" value="single"${attr("checked", kind === "single")} />
                <span>A house<small>One home, one address. We will create its single unit for you.</small></span>
              </label>
              <label class="radiotile">
                <input type="radio" name="kind" value="multi"${attr("checked", kind === "multi")} />
                <span>Apartments<small>Several units at this address. You add them next.</small></span>
              </label>
              <label class="radiotile">
                <input type="radio" name="kind" value="condo"${attr("checked", kind === "condo")} />
                <span>Condo<small>A single unit inside a building somebody else runs.</small></span>
              </label>
            </div>
          </div>

          ${property ? "" : html`
            <div class="formgrid formgrid--2">
              <div class="field">
                <label for="beds">Bedrooms <span style="color:var(--ink-soft);font-weight:400">(a house only)</span></label>
                <input id="beds" name="beds" type="number" min="0" step="0.5" />
              </div>
              <div class="field">
                <label for="market_rent">Asking rent <span style="color:var(--ink-soft);font-weight:400">(a house only)</span></label>
                <input id="market_rent" name="market_rent" type="text" inputmode="decimal" placeholder="1200.00" />
              </div>
            </div>`}

          <div class="field">
            <label for="notes">Notes <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
            <input id="notes" name="notes" type="text" maxlength="400"
                   value="${property && property.notes ? property.notes : ""}"
                   placeholder="Boiler serviced annually · parking at the rear" />
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">${property ? "Save changes" : "Add building"}</button>
            <a class="pill outline" href="/app/portfolio">Cancel</a>
          </div>
        </form>
      </div>
    </div>`;
}

function unitForm({ csrf, unit, property, error }) {
  const action = unit ? `/app/portfolio/u/${unit.id}/edit` : `/app/portfolio/p/${property.id}/unit/new`;
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>${unit ? "Apartment details" : "New apartment"}</h2><p>${property.line1}</p></div>
      <div class="panel__body">
        <form method="post" action="${action}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="label">Unit number</label>
            <input id="label" name="label" type="text" maxlength="24"
                   value="${unit ? unit.label : ""}" placeholder="1, 2, A, Rear" />
            <span class="field__help">However it is written on the door. Leave blank for a whole house.</span>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="beds">Bedrooms</label>
              <input id="beds" name="beds" type="number" min="0" step="0.5"
                     value="${unit && unit.beds != null ? unit.beds : ""}" />
            </div>
            <div class="field">
              <label for="baths">Bathrooms</label>
              <input id="baths" name="baths" type="number" min="0" step="0.5"
                     value="${unit && unit.baths != null ? unit.baths : ""}" />
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="sqft">Square feet <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
              <input id="sqft" name="sqft" type="number" min="1"
                     value="${unit && unit.sqft ? unit.sqft : ""}" />
            </div>
            <div class="field">
              <label for="market_rent">Asking rent</label>
              <input id="market_rent" name="market_rent" type="text" inputmode="decimal"
                     value="${unit && unit.market_rent_cents ? (unit.market_rent_cents / 100).toFixed(2) : ""}"
                     placeholder="950.00" />
              <span class="field__help">What you would list it at. The actual rent comes from the lease.</span>
            </div>
          </div>

          ${unit ? html`
            <div class="field">
              <label for="status">State</label>
              <select id="status" name="status">
                ${["occupied", "vacant", "turn", "offline"].map((k) => html`
                  <option value="${k}"${attr("selected", unit.status === k)}>${
                    k === "turn" ? "Being turned" : k === "offline" ? "Off the market" : k[0].toUpperCase() + k.slice(1)
                  }</option>`)}
              </select>
            </div>` : ""}

          <div class="btnrow">
            <button class="pill solid" type="submit">${unit ? "Save changes" : "Add apartment"}</button>
            <a class="pill outline" href="${unit ? `/app/portfolio/u/${unit.id}` : "/app/portfolio"}">${unit ? "Cancel" : "Done adding"}</a>
          </div>
        </form>
      </div>
      ${unit ? "" : html`<div class="panel__foot">
        Each apartment gets its own repair QR code the moment you add it.
      </div>`}
    </div>`;
}

function moveInForm({ csrf, unit, error }) {
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>New tenancy</h2></div>
      <div class="panel__body">
        <form method="post" action="/app/portfolio/u/${unit.id}/movein" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="tenant_name">Tenant name</label>
            <input id="tenant_name" name="tenant_name" type="text" required maxlength="120" />
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="tenant_email">Email</label>
              <input id="tenant_email" name="tenant_email" type="email" maxlength="160" />
            </div>
            <div class="field">
              <label for="tenant_phone">Phone</label>
              <input id="tenant_phone" name="tenant_phone" type="tel" inputmode="tel" maxlength="40" />
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="start_date">Lease starts</label>
              <input id="start_date" name="start_date" type="date" required value="${today()}" />
            </div>
            <div class="field">
              <label for="end_date">Lease ends <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
              <input id="end_date" name="end_date" type="date" />
              <span class="field__help">Leave blank for month to month.</span>
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="rent">Monthly rent</label>
              <input id="rent" name="rent" type="text" inputmode="decimal" required
                     value="${unit.market_rent_cents ? (unit.market_rent_cents / 100).toFixed(2) : ""}" />
            </div>
            <div class="field">
              <label for="deposit">Deposit held</label>
              <input id="deposit" name="deposit" type="text" inputmode="decimal" placeholder="0.00" />
              <span class="field__help">The clock on returning this starts at move-out.</span>
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="rent_due_day">Rent due on the</label>
              <input id="rent_due_day" name="rent_due_day" type="number" min="1" max="31" value="1" />
              <span class="field__help">Day of the month. 31 means the last day, whatever its length.</span>
            </div>
            <div class="field">
              <label for="grace_days">Grace days</label>
              <input id="grace_days" name="grace_days" type="number" min="0" max="31" value="5" />
              <span class="field__help">Days after the due date before it counts as late.</span>
            </div>
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">Move them in</button>
            <a class="pill outline" href="/app/portfolio/u/${unit.id}">Cancel</a>
          </div>
        </form>
      </div>
    </div>`;
}

