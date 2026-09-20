/* Setup: vendors, category routing, criteria, notice templates and delivery.

   Everything on this screen is a thing the company owns and we do not: who
   their tradespeople are, which trade takes which category, what they screen
   on, and what their attorney approved. The app's job is to apply it
   consistently, not to supply it. */
import { all, get, insert, update, one, run as sqlRun } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { CATEGORIES } from "../lib/triage.js";
import { DELIVERY, outboxPending } from "../lib/scheduler.js";

export function registerSetup(router) {
  router.get("/app/setup", (ctx) => {
    const cid = ctx.staff.company_id;
    const company = one("SELECT * FROM company WHERE id = ?", cid);
    const vendors = all("SELECT * FROM vendor WHERE company_id = ? ORDER BY trade, name", cid);
    const rules = all(
      `SELECT r.*, v.name AS vendor_name FROM routing_rule r JOIN vendor v ON v.id = r.vendor_id
        WHERE r.company_id = ? ORDER BY r.category, r.rank`, cid);
    const templates = all("SELECT * FROM notice_template WHERE company_id = ? ORDER BY key", cid);
    const criteria = all("SELECT * FROM criteria_set WHERE company_id = ? ORDER BY created_at DESC", cid);
    const owners = all("SELECT * FROM owner WHERE company_id = ? ORDER BY name", cid);
    const queued = outboxPending(cid);
    const recent = all(
      `SELECT * FROM outbox WHERE company_id = ? ORDER BY queued_at DESC LIMIT 12`, cid);
    const unrouted = CATEGORIES.filter((c) => !rules.some((r) => r.category === c.key));

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: navCounts(cid),
      title: "Setup",
      subtitle: company.name,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <!-- Delivery -->
        <div class="panel">
          <div class="panel__head"><h2>Delivery</h2>
            <span class="chip"${attr("data-tone", DELIVERY.mode === "none" ? "warn" : "ok")}>${DELIVERY.mode}</span>
          </div>
          <div class="panel__body">
            ${DELIVERY.mode === "none"
              ? notice("warn", "Nothing is being sent",
                  html`${queued} message${queued === 1 ? "" : "s"} queued. Reminders, owner requests and rent
                       notices are <b>recorded but not delivered</b>. Start the server with
                       <code>DELIVERY_MODE=log</code> to drain the queue to the console, or wire a real
                       provider in <code>server/lib/scheduler.js</code> (<code>drainOutbox</code>).
                       This is deliberately off by default — a queue that silently claims to have sent a
                       late-rent notice is worse than one that admits it has not.`)
              : notice("ok", `Delivery mode: ${DELIVERY.mode}`, `${queued} still queued.`)}

            ${recent.length ? html`
              <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                <thead><tr><th>To</th><th>Subject</th><th class="shrink">Channel</th><th class="shrink">State</th><th>Queued</th></tr></thead>
                <tbody>${recent.map((m) => html`
                  <tr><td>${m.to_contact}</td><td>${m.subject || "—"}<span class="cellsub">${String(m.body).slice(0, 80)}…</span></td>
                      <td class="shrink">${m.channel}</td>
                      <td class="shrink"><span class="chip"${attr("data-tone", m.status === "sent" ? "ok" : m.status === "failed" ? "danger" : "warn")}>${m.status}</span></td>
                      <td>${human(m.queued_at.slice(0, 10))}</td></tr>`)}</tbody>
              </table></div>` : ""}
          </div>
        </div>

        <!-- Vendors -->
        <div class="panel">
          <div class="panel__head"><h2>Vendors</h2><p>${vendors.length}</p></div>
          <div class="panel__body panel__body--flush">
            ${vendors.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Name</th><th>Trade</th><th>Contact</th><th class="shrink">After hours</th><th class="shrink">Active</th></tr></thead>
              <tbody>${vendors.map((v) => html`
                <tr><td>${v.name}</td><td>${v.trade}</td>
                    <td>${v.phone || ""}<span class="cellsub">${v.email || ""}</span></td>
                    <td class="shrink">${v.after_hours ? html`<span class="chip" data-tone="ok">yes</span>` : html`<span class="chip">no</span>`}</td>
                    <td class="shrink">${v.active ? html`<span class="chip" data-tone="ok">on</span>` : html`<span class="chip">off</span>`}</td></tr>`)}</tbody>
            </table></div>` : empty("No vendors", "Add one below, then map categories to them.")}
          </div>
          <div class="panel__body" style="border-top:1px solid var(--hairline)">
            <form method="post" action="/app/setup/vendor" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field"><label for="v_name">Name</label>
                  <input id="v_name" name="name" type="text" required placeholder="Brice Plumbing" /></div>
                <div class="field"><label for="v_trade">Trade</label>
                  <input id="v_trade" name="trade" type="text" required placeholder="plumber" /></div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field"><label for="v_phone">Phone</label><input id="v_phone" name="phone" type="tel" /></div>
                <div class="field"><label for="v_email">Email</label><input id="v_email" name="email" type="email" /></div>
              </div>
              <label class="radiotile" style="grid-template-columns:1.0625rem 1fr">
                <input type="checkbox" name="after_hours" value="yes" />
                <span>Takes after-hours emergency calls</span>
              </label>
              <button class="pill solid sm" type="submit">Add vendor</button>
            </form>
          </div>
        </div>

        <!-- Routing -->
        <div class="panel">
          <div class="panel__head"><h2>Category routing</h2>
            <p>Which trade gets which kind of request</p></div>
          <div class="panel__body">
            ${unrouted.length
              ? notice("warn", `${unrouted.length} categor${unrouted.length === 1 ? "y has" : "ies have"} no rule`,
                  html`${unrouted.map((c) => c.label).join(", ")} — requests in these land as “triaged”
                       with no vendor and wait for someone to pick one by hand.`)
              : notice("ok", "Every category is routed", "New requests get a vendor without anyone touching them.")}

            ${rules.length ? html`
              <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                <thead><tr><th>Category</th><th>Vendor</th><th class="num">Rank</th></tr></thead>
                <tbody>${rules.map((r) => html`
                  <tr><td>${CATEGORIES.find((c) => c.key === r.category)?.label || r.category}</td>
                      <td>${r.vendor_name}</td><td class="num">${r.rank}</td></tr>`)}</tbody>
              </table></div>` : ""}

            <form method="post" action="/app/setup/routing" class="formgrid" style="margin-top:1.25rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="r_category">Category</label>
                  <select id="r_category" name="category" required>
                    ${CATEGORIES.map((c) => html`<option value="${c.key}">${c.label}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="r_vendor">Vendor</label>
                  <select id="r_vendor" name="vendor_id" required>
                    <option value="">Choose…</option>
                    ${vendors.filter((v) => v.active).map((v) => html`<option value="${v.id}">${v.name} — ${v.trade}</option>`)}
                  </select>
                </div>
              </div>
              <div class="field" style="max-width:8rem">
                <label for="r_rank">Rank</label>
                <input id="r_rank" name="rank" type="number" min="1" max="9" value="1" required />
                <span class="field__help">1 is tried first.</span>
              </div>
              <button class="pill solid sm" type="submit">Add rule</button>
            </form>
          </div>
        </div>

        <!-- Owner thresholds -->
        <div class="panel">
          <div class="panel__head"><h2>Owner approval thresholds</h2>
            <p>Spend above this is put to the owner before a vendor is dispatched</p></div>
          <div class="panel__body panel__body--flush">
            ${owners.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Owner</th><th class="num">Threshold</th><th class="shrink"></th></tr></thead>
              <tbody>${owners.map((o) => html`
                <tr>
                  <td>${o.name}<span class="cellsub">${o.email || "no email — cannot be asked"}</span></td>
                  <td class="num">${usd(o.approval_threshold_cents)}</td>
                  <td class="shrink">
                    <form method="post" action="/app/setup/owner/${o.id}" class="btnrow">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <input name="threshold" type="text" inputmode="decimal" placeholder="400"
                             style="width:6rem;padding:0.375rem 0.5rem;border:1px solid var(--hairline);border-radius:var(--radius-xl);font-size:0.8125rem" />
                      <input name="email" type="email" placeholder="email" value="${o.email || ""}"
                             style="width:12rem;padding:0.375rem 0.5rem;border:1px solid var(--hairline);border-radius:var(--radius-xl);font-size:0.8125rem" />
                      <button class="pill outline sm" type="submit">Save</button>
                    </form>
                  </td>
                </tr>`)}</tbody>
            </table></div>` : empty("No owners", "")}
          </div>
        </div>

        <!-- Notice templates -->
        <div class="panel">
          <div class="panel__head"><h2>Notice templates</h2>
            <p>Supplied and approved by your attorney</p></div>
          <div class="panel__body">
            ${notice("warn", "We do not write these",
              html`Notice wording is jurisdiction-specific. Paste your attorney's text, then record the
                   sign-off. <b>An unapproved template cannot be sent</b> — the ladder stops and flags it.
                   Placeholders available: <code>{{amount}} {{period}} {{days_late}} {{address}} {{company}} {{company_phone}}</code>`)}
            <div style="display:grid;gap:1rem;margin-top:1.25rem">
              ${templates.map((t) => html`
                <div class="panel">
                  <div class="panel__head">
                    <h2>${t.name}</h2>
                    <span class="chip"${attr("data-tone", t.approved_at ? "ok" : "warn")}>
                      ${t.approved_at ? `approved by ${t.approved_by}` : "not approved"}</span>
                  </div>
                  <div class="panel__body">
                    <form method="post" action="/app/setup/template" class="formgrid">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <input type="hidden" name="key" value="${t.key}" />
                      <div class="field">
                        <label for="b_${t.key}">Body</label>
                        <textarea id="b_${t.key}" name="body" rows="5">${t.body}</textarea>
                      </div>
                      <div class="formgrid formgrid--2">
                        <div class="field">
                          <label for="a_${t.key}">Approved by</label>
                          <input id="a_${t.key}" name="approved_by" type="text" value="${t.approved_by || ""}"
                                 placeholder="Name of the attorney who signed it off" />
                        </div>
                        <div class="field">
                          <label for="d_${t.key}">Sign-off date</label>
                          <input id="d_${t.key}" name="approved_on" type="date" value="${t.approved_at ? t.approved_at.slice(0, 10) : ""}" />
                        </div>
                      </div>
                      <button class="pill outline sm" type="submit">Save template</button>
                      <span class="field__help">Leaving the sign-off blank keeps it unsendable.</span>
                    </form>
                  </div>
                </div>`)}
            </div>
          </div>
        </div>

        <!-- Screening criteria -->
        <div class="panel">
          <div class="panel__head"><h2>Screening criteria</h2>
            <p>Applied by a person, uniformly, and recorded per applicant</p></div>
          <div class="panel__body">
            ${notice("warn", "Have these reviewed before using them",
              html`Some jurisdictions restrict criminal-history screening, cap income-ratio requirements or
                   require first-come-first-served consideration. This app deliberately does <b>not</b> score
                   or rank applicants — it records that the same written list was applied to each one.`)}
            ${criteria.length ? html`
              <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                <thead><tr><th>Set</th><th class="num">Items</th><th>Reviewed</th><th class="shrink">Active</th></tr></thead>
                <tbody>${criteria.map((c) => html`
                  <tr><td>${c.name}</td><td class="num">${safeLen(c.items)}</td>
                      <td>${c.reviewed_by ? `${c.reviewed_by}, ${human(c.reviewed_at?.slice(0, 10))}` : html`<span class="chip chip--plain" data-tone="warn">not recorded</span>`}</td>
                      <td class="shrink">${c.active ? html`<span class="chip" data-tone="ok">active</span>` : html`<span class="chip">off</span>`}</td></tr>`)}</tbody>
              </table></div>` : empty("No criteria set", "Applications cannot be assessed consistently until there is one.")}
          </div>
        </div>`,
    }));
  });

  /* --- writes ------------------------------------------------------------- */

  router.post("/app/setup/vendor", (ctx) => {
    const cid = ctx.staff.company_id;
    const name = String(ctx.fields.name || "").trim();
    const trade = String(ctx.fields.trade || "").trim().toLowerCase();
    if (!name || !trade) throw new BadRequest("A vendor needs a name and a trade.");
    insert("vendor", {
      id: id(), company_id: cid, name, trade,
      phone: String(ctx.fields.phone || "").trim() || null,
      email: String(ctx.fields.email || "").trim() || null,
      after_hours: ctx.fields.after_hours === "yes" ? 1 : 0,
      active: 1, created_at: stamp(),
    });
    redirect(ctx.res, `/app/setup?m=${encodeURIComponent("Vendor added.")}`);
  });

  router.post("/app/setup/routing", (ctx) => {
    const cid = ctx.staff.company_id;
    const category = String(ctx.fields.category || "");
    if (!CATEGORIES.some((c) => c.key === category)) throw new BadRequest("Unknown category.");
    const vendor = one("SELECT * FROM vendor WHERE id = ? AND company_id = ?", String(ctx.fields.vendor_id || ""), cid);
    const rank = Number(ctx.fields.rank) || 1;

    // The UNIQUE on (company, category, rank) means re-adding the same rank is
    // an update, not a duplicate — which is what the operator meant.
    const existing = get(
      "SELECT * FROM routing_rule WHERE company_id = ? AND category = ? AND rank = ?", cid, category, rank);
    if (existing) update("routing_rule", existing.id, { vendor_id: vendor.id });
    else insert("routing_rule", { id: id(), company_id: cid, category, vendor_id: vendor.id, rank });

    redirect(ctx.res, `/app/setup?m=${encodeURIComponent("Routing saved.")}`);
  });

  router.post("/app/setup/owner/:id", (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = one("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const patch = {};
    const t = parseMoney(ctx.fields.threshold);
    if (t != null && t >= 0) patch.approval_threshold_cents = t;
    const email = String(ctx.fields.email || "").trim();
    if (email) patch.email = email;
    update("owner", owner.id, patch);
    redirect(ctx.res, `/app/setup?m=${encodeURIComponent("Owner updated.")}`);
  });

  router.post("/app/setup/template", (ctx) => {
    const cid = ctx.staff.company_id;
    const key = String(ctx.fields.key || "");
    const tpl = one("SELECT * FROM notice_template WHERE company_id = ? AND key = ?", cid, key);
    const body = String(ctx.fields.body || "").trim();
    if (!body) throw new BadRequest("A template needs a body.");

    const approvedBy = String(ctx.fields.approved_by || "").trim();
    const approvedOn = String(ctx.fields.approved_on || "").trim();
    // Approval needs BOTH a name and a date. Half a sign-off is not one, and
    // this is the gate that decides whether a notice can reach a tenant.
    const signed = Boolean(approvedBy) && /^\d{4}-\d{2}-\d{2}$/.test(approvedOn);

    /* Editing the wording invalidates an existing sign-off, because nobody
       approved the new text. Since the form prefills the previous approval,
       carrying it forward silently is exactly the failure to avoid. Recording
       a NEW date alongside the edit is how an operator says counsel has seen
       this version. */
    const changed = body !== tpl.body;
    const storedOn = tpl.approved_at ? tpl.approved_at.slice(0, 10) : null;
    const freshSignOff = signed && approvedOn !== storedOn;
    const keep = signed && (!changed || freshSignOff);

    // notice_template is keyed on (company_id, key), so the id-based update()
    // helper does not apply here.
    sqlRun(
      `UPDATE notice_template SET body = ?, approved_by = ?, approved_at = ?
        WHERE company_id = ? AND key = ?`,
      body,
      keep ? approvedBy : null,
      keep ? `${approvedOn}T00:00:00.000Z` : null,
      cid, key
    );

    const msg = keep
      ? "Template saved and marked approved."
      : changed && signed
        ? "Text saved. The previous sign-off was cleared because the wording changed — record a new sign-off date to make it sendable."
        : "Template saved. It cannot be sent until a sign-off name and date are recorded.";
    redirect(ctx.res, `/app/setup?m=${encodeURIComponent(msg)}`);
  });
}

function safeLen(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}
