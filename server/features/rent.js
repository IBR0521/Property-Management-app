/* F4  Rent status and the delinquency ladder.

   The value here is consistency, not automation. Every tenant gets the same
   sequence on the same offsets, and notice_log proves it afterwards — which
   is the part that matters if a case is ever examined.

   Two hard boundaries, enforced in code rather than in a policy document:
     1. No money moves through this app. Payments are RECORDED here after they
        happen somewhere else.
     2. No notice is sent from a template that has not been marked approved.
        An unapproved template blocks and raises a flag instead. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween, monthKey, dueDateFor, addDays } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest, Forbidden } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { queueNotice, renderTemplate, tick } from "../lib/scheduler.js";
import { postMoney } from "../lib/ledger.js";

export function registerRent(router) {
  /* --- rent roll ---------------------------------------------------------- */
  router.get("/app/rent", async (ctx) => {
    const cid = ctx.staff.company_id;
    const period = /^\d{4}-\d{2}$/.test(ctx.query.period || "") ? ctx.query.period : monthKey(today());

    const leases = await all(
      `SELECT l.*, u.label, p.line1,
              (SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entry e
                WHERE e.lease_id = l.id AND e.kind = 'rent_payment'
                  AND e.date >= ? AND e.date <= ?) AS paid,
              (SELECT id FROM delinquency d WHERE d.lease_id = l.id AND d.period = ?) AS delinquency_id,
              (SELECT status FROM delinquency d WHERE d.lease_id = l.id AND d.period = ?) AS delinquency_status,
              (SELECT stage FROM delinquency d WHERE d.lease_id = l.id AND d.period = ?) AS stage
         FROM lease l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.company_id = ? AND l.status = 'active'
        ORDER BY p.line1, u.label`,
      `${period}-01`, addDays(`${period}-01`, 45), period, period, period, cid);

    const expected = leases.reduce((n, l) => n + l.rent_cents, 0);
    const collected = leases.reduce((n, l) => n + Math.min(l.paid, l.rent_cents), 0);
    const outstanding = expected - collected;
    const lateCount = leases.filter((l) => l.paid < l.rent_cents && today() > addDays(dueDateFor(period, l.rent_due_day), l.grace_days)).length;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Rent",
      subtitle: `${period} · ${leases.length} active lease${leases.length === 1 ? "" : "s"}`,
      actions: html`
        <a class="pill outline sm" href="/app/rent/ladder">Ladder</a>
        <form method="post" action="/app/rent/run" style="display:inline">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
          <button class="pill outline sm" type="submit">Re-check now</button>
        </form>`,
      body: html`
        ${tabs(PROPERTY_TABS, "rent")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="grid grid--4">
          <div class="tile"><span class="tile__label">Expected</span><span class="tile__value">${usd(expected)}</span></div>
          <div class="tile" data-tone="ok"><span class="tile__label">Collected</span><span class="tile__value">${usd(collected)}</span></div>
          <div class="tile"${attr("data-tone", outstanding > 0 ? "warn" : null)}><span class="tile__label">Outstanding</span><span class="tile__value">${usd(outstanding)}</span></div>
          <div class="tile"${attr("data-tone", lateCount ? "warn" : null)}><span class="tile__label">Past grace</span><span class="tile__value">${lateCount}</span></div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Rent roll</h2><p>${period}</p></div>
          <div class="panel__body panel__body--flush">
            ${leases.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Property</th><th class="num">Rent</th><th class="num">Paid</th><th class="num">Owed</th><th>Due</th><th class="shrink">State</th><th class="shrink"></th></tr></thead>
              <tbody>${leases.map((l) => {
                const owed = l.rent_cents - l.paid;
                const due = dueDateFor(period, l.rent_due_day);
                const lateFrom = addDays(due, l.grace_days);
                const isLate = owed > 0 && today() > lateFrom;
                return html`
                  <tr>
                    <td>${l.line1}${l.label ? html`<span class="cellsub">Unit ${l.label}</span>` : ""}</td>
                    <td class="num">${usd(l.rent_cents)}</td>
                    <td class="num">${usd(l.paid)}</td>
                    <td class="num" style="${owed > 0 ? "color:var(--danger)" : ""}">${owed > 0 ? usd(owed) : "—"}</td>
                    <td>${human(due)}<span class="cellsub">grace to ${human(lateFrom)}</span></td>
                    <td class="shrink">${owed <= 0
                      ? html`<span class="chip" data-tone="ok">paid</span>`
                      : isLate
                        ? html`<span class="chip"${attr("data-tone", l.delinquency_status === "attorney" ? "danger" : "warn")}>${l.delinquency_status === "attorney" ? "attorney" : `stage ${l.stage ?? 0}`}</span>`
                        : html`<span class="chip">in grace</span>`}</td>
                    <td class="shrink">
                      ${l.delinquency_id
                        ? html`<a class="pill outline sm" href="/app/rent/${l.delinquency_id}">Open</a>`
                        : html`<a class="pill outline sm" href="/app/rent/record?lease=${l.id}&period=${period}">Record payment</a>`}
                    </td>
                  </tr>`;
              })}</tbody>
            </table></div>` : empty("No active leases", "Add leases in Setup and the rent roll fills itself.")}
          </div>
        </div>`,
    }));
  });

  /* --- record a payment --------------------------------------------------- */
  router.get("/app/rent/record", async (ctx) => {
    const cid = ctx.staff.company_id;
    const lease = await one(
      `SELECT l.*, u.label, p.line1, p.owner_id FROM lease l
         JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.id = ? AND l.company_id = ?`, String(ctx.query.lease || ""), cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Record a payment",
      subtitle: `${lease.line1}${lease.label ? `, unit ${lease.label}` : ""} · rent ${usd(lease.rent_cents)}`,
      body: html`
        ${notice(null, "This records a payment, it does not take one",
          "Money is collected wherever you already collect it. This is the reporting entry that shows up on the owner's statement.")}
        <div class="panel" style="max-width:32rem">
          <div class="panel__body">
            <form method="post" action="/app/rent/record" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <input type="hidden" name="lease_id" value="${lease.id}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="amount">Amount received</label>
                  <input id="amount" name="amount" type="text" inputmode="decimal" required
                         value="${(lease.rent_cents / 100).toFixed(2)}" />
                </div>
                <div class="field">
                  <label for="date">Date received</label>
                  <input id="date" name="date" type="date" value="${today()}" required />
                </div>
              </div>
              <div class="field">
                <label for="memo">Memo</label>
                <input id="memo" name="memo" type="text" value="Rent ${ctx.query.period || monthKey(today())}" required />
              </div>
              <div class="btnrow">
                <button class="pill solid" type="submit">Record it</button>
                <a class="pill outline" href="/app/rent">Cancel</a>
              </div>
            </form>
          </div>
        </div>`,
    }));
  });

  router.post("/app/rent/record", async (ctx) => {
    const cid = ctx.staff.company_id;
    const lease = await one(
      `SELECT l.*, p.owner_id, p.id AS property_id FROM lease l
         JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.id = ? AND l.company_id = ?`, String(ctx.fields.lease_id || ""), cid);
    const amount = parseMoney(ctx.fields.amount);
    if (amount == null || amount <= 0) throw new BadRequest("Enter the amount received.");
    const date = String(ctx.fields.date || today());

    await tx(async () => {
      /* Both books, in one call. This wrote ledger_entry alone, which meant
         recording rent told the owner's statement and told the company's
         accounts nothing — twelve payments and thirteen thousand dollars had
         accumulated on one side only. */
      await postMoney({
        companyId: cid, ownerId: lease.owner_id, propertyId: lease.property_id,
        unitId: lease.unit_id, leaseId: lease.id, date, kind: "rent_payment",
        amountCents: Math.abs(amount), memo: String(ctx.fields.memo || "Rent").trim(),
        source: "manual", sourceType: "lease", sourceId: lease.id,
        postedBy: ctx.staff.id,
      });

      /* Close any delinquency the payment clears. Recomputed from the ledger
         rather than decremented, so a correction cannot leave a stale balance. */
      const period = monthKey(date);
      const d = await get("SELECT * FROM delinquency WHERE lease_id = ? AND period = ?", lease.id, period);
      if (d && d.status !== "resolved") {
        const paid = (await get(
          `SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger_entry
            WHERE lease_id = ? AND kind = 'rent_payment' AND date >= ? AND date <= ?`,
          lease.id, `${period}-01`, addDays(`${period}-01`, 45))).c;
        const owed = lease.rent_cents - paid;
        if (owed <= 0) {
          await update("delinquency", d.id, { status: "resolved", resolved_at: stamp(), amount_cents: 0 });
        } else {
          await update("delinquency", d.id, { amount_cents: owed });
        }
      }
    });
    redirect(ctx.res, `/app/rent?m=${encodeURIComponent("Payment recorded.")}`);
  });

  /* --- the ladder config -------------------------------------------------- */
  router.get("/app/rent/ladder", async (ctx) => {
    const cid = ctx.staff.company_id;
    const steps = await all("SELECT * FROM delinquency_step WHERE company_id = ? ORDER BY stage", cid);
    const templates = await all("SELECT * FROM notice_template WHERE company_id = ? ORDER BY key", cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Delinquency ladder",
      subtitle: "The same sequence for every tenant, on the same offsets",
      actions: html`<a class="pill outline sm" href="/app/rent">Back</a>`,
      body: html`
        ${notice("warn", "Templates need your attorney, not us",
          html`This app runs the clock and keeps the record. The wording of every notice is
               jurisdiction-specific, so it is supplied and signed off by your attorney.
               <b>An unapproved template will not send</b> — the ladder stops and flags it instead.`)}
        <div class="panel">
          <div class="panel__head"><h2>Rungs</h2></div>
          <div class="panel__body panel__body--flush">
            ${steps.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th class="shrink">Stage</th><th class="shrink">Day</th><th>Template</th><th class="shrink">Channel</th><th class="shrink">Approved</th></tr></thead>
              <tbody>${steps.map((s) => {
                const t = templates.find((x) => x.key === s.template_key);
                return html`<tr>
                  <td class="shrink">${s.stage}</td>
                  <td class="shrink">day ${s.day_offset}</td>
                  <td>${t ? t.name : html`<span style="color:var(--danger)">missing: ${s.template_key}</span>`}
                    ${s.requires_attorney ? html`<span class="cellsub">stops for attorney hand-off</span>` : ""}</td>
                  <td class="shrink">${s.channel}</td>
                  <td class="shrink">${s.requires_attorney
                    ? html`<span class="chip chip--plain">n/a</span>`
                    : t && t.approved_at
                      ? html`<span class="chip" data-tone="ok">yes</span>`
                      : html`<span class="chip" data-tone="danger">no</span>`}</td>
                </tr>`;
              })}</tbody>
            </table></div>` : empty("No ladder configured", "Add rungs in Setup.")}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Templates</h2><p>Preview uses this month's figures</p></div>
          <div class="panel__body" style="display:grid;gap:1rem">
            ${templates.map((t) => html`
              <div class="notice"${attr("data-tone", t.approved_at ? "ok" : "warn")}>
                <span></span>
                <div>
                  <b>${t.name} ${t.approved_at
                    ? html`<span class="chip" data-tone="ok">approved ${human(t.approved_at.slice(0, 10))} by ${t.approved_by || "—"}</span>`
                    : html`<span class="chip" data-tone="warn">awaiting sign-off</span>`}</b>
                  <pre style="white-space:pre-wrap;font-family:var(--mono,monospace);font-size:0.75rem;margin-top:0.5rem">${renderTemplate(t.body, {
                    amount: "$1,450.00", period: monthKey(today()), days_late: "12",
                    address: "412 Maple Grove Dr", company: ctx.staff.company_name, company_phone: ctx.staff.company_phone || "",
                  })}</pre>
                </div>
              </div>`)}
          </div>
        </div>`,
    }));
  });
  router.post("/app/rent/run", async (ctx) => {
    const r = await tick("manual");
    const bits = Object.entries(r).filter(([, v]) => typeof v === "number" && v > 0).map(([k, v]) => `${k} ${v}`);
    redirect(ctx.res, `/app/rent?m=${encodeURIComponent(bits.length ? bits.join(", ") : "Nothing changed.")}`);
  });

  /* --- one delinquency ---------------------------------------------------- */
  router.get("/app/rent/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const d = await get(
      `SELECT d.*, l.rent_cents, l.rent_due_day, l.grace_days, u.label, p.line1, p.city
         FROM delinquency d JOIN lease l ON l.id = d.lease_id
         JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE d.id = ? AND d.company_id = ?`, ctx.params.id, cid);
    if (!d) return sendHtml(ctx.res, "Not found", 404);

    const tenants = await all(
      `SELECT t.* FROM tenant t JOIN lease_tenant lt ON lt.tenant_id = t.id WHERE lt.lease_id = ?`, d.lease_id);
    const notices = await all(
      "SELECT * FROM notice_log WHERE delinquency_id = ? ORDER BY sent_at DESC", d.id);
    const promises = await all(
      "SELECT * FROM payment_promise WHERE delinquency_id = ? ORDER BY promised_date DESC", d.id);
    const steps = await all("SELECT * FROM delinquency_step WHERE company_id = ? ORDER BY stage", cid);
    const templates = await all("SELECT * FROM notice_template WHERE company_id = ?", cid);
    const lateDays = daysBetween(d.late_since, today());
    const nextStep = steps.find((s) => s.stage === d.stage + 1);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `${usd(d.amount_cents)} outstanding`,
      subtitle: `${d.line1}${d.label ? `, unit ${d.label}` : ""} · ${d.period} · ${lateDays} day(s) late`,
      actions: html`<a class="pill outline sm" href="/app/rent">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${d.status === "attorney"
          ? notice("danger", "Marked for attorney hand-off",
              "The ladder reached the stage your firm flagged as hand-off. No further notice is sent automatically.")
          : ""}
        ${d.status === "resolved" ? notice("ok", "Resolved", `Cleared ${humanStamp(d.resolved_at)}.`) : ""}

        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head"><h2>Where it stands</h2>
              <span class="chip"${attr("data-tone", d.status === "attorney" ? "danger" : d.status === "resolved" ? "ok" : "warn")}>${d.status}</span>
            </div>
            <div class="panel__body">
              <dl class="dl">
                <div><dt>Owed</dt><dd><b style="font-weight:500">${usd(d.amount_cents)}</b> of ${usd(d.rent_cents)}</dd></div>
                <div><dt>Late since</dt><dd>${human(d.late_since)} (${lateDays} days)</dd></div>
                <div><dt>Stage</dt><dd>${d.stage} of ${steps.length}</dd></div>
                <div><dt>Next rung</dt><dd>${nextStep
                  ? `stage ${nextStep.stage} at day ${nextStep.day_offset}${nextStep.requires_attorney ? " — attorney hand-off" : ""}`
                  : "end of the ladder"}</dd></div>
                <div><dt>Tenants</dt><dd>${tenants.map((t) => html`${t.name}${t.phone ? html` · <a href="tel:${t.phone}">${t.phone}</a>` : ""}<br />`)}</dd></div>
              </dl>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:1.25rem">
            <div class="panel">
              <div class="panel__head"><h2>Log a promise to pay</h2></div>
              <div class="panel__body">
                <form method="post" action="/app/rent/${d.id}/promise" class="formgrid">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="formgrid formgrid--2">
                    <div class="field">
                      <label for="promised_date">By when</label>
                      <input id="promised_date" name="promised_date" type="date" required min="${today()}" />
                    </div>
                    <div class="field">
                      <label for="promised">How much</label>
                      <input id="promised" name="promised" type="text" inputmode="decimal" required
                             value="${(d.amount_cents / 100).toFixed(2)}" />
                    </div>
                  </div>
                  <div class="field">
                    <label for="pnote">Note</label>
                    <input id="pnote" name="note" type="text" placeholder="Said payday is Friday the 26th" />
                  </div>
                  <button class="pill outline sm" type="submit">Log it</button>
                  <span class="field__help">The ladder pauses while a promise is open, and resumes by itself if the date passes unpaid.</span>
                </form>
              </div>
            </div>

            <div class="panel">
              <div class="panel__head"><h2>Send the next notice</h2></div>
              <div class="panel__body">
                <form method="post" action="/app/rent/${d.id}/notice" class="formgrid">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="field">
                    <label for="template_key">Template</label>
                    <select id="template_key" name="template_key" required>
                      ${templates.map((t) => html`
                        <option value="${t.key}"${attr("disabled", !t.approved_at)}>
                          ${t.name}${t.approved_at ? "" : " — not approved, cannot send"}
                        </option>`)}
                    </select>
                    <span class="field__help">Only templates your attorney has signed off can be sent.</span>
                  </div>
                  <button class="pill solid sm" type="submit">Queue the notice</button>
                </form>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>What has been sent</h2><p>${notices.length} on record</p></div>
          <div class="panel__body panel__body--flush">
            ${notices.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th class="shrink">Stage</th><th>Template</th><th>To</th><th>When</th><th class="shrink">By</th></tr></thead>
              <tbody>${notices.map((n) => html`
                <tr><td class="shrink">${n.stage}</td>
                    <td>${n.template_key}<span class="cellsub">${n.channel}</span></td>
                    <td>${n.to_name}<span class="cellsub">${n.to_contact}</span></td>
                    <td>${humanStamp(n.sent_at)}</td>
                    <td class="shrink">${n.sent_by}</td></tr>`)}</tbody>
            </table></div>` : empty("Nothing sent yet", "Notices appear here with their full rendered text, which is the record that matters later.")}
          </div>
        </div>

        ${promises.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Promises</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>By</th><th class="num">Amount</th><th>Note</th><th class="shrink">Kept</th></tr></thead>
                <tbody>${promises.map((p) => html`
                  <tr><td>${human(p.promised_date)}</td><td class="num">${usd(p.promised_cents)}</td>
                      <td>${p.note || "—"}</td>
                      <td class="shrink">${p.kept == null
                        ? html`<span class="chip">open</span>`
                        : p.kept
                          ? html`<span class="chip" data-tone="ok">kept</span>`
                          : html`<span class="chip" data-tone="danger">broken</span>`}</td></tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}`,
    }));
  });

  router.post("/app/rent/:id/promise", async (ctx) => {
    const cid = ctx.staff.company_id;
    const d = await one("SELECT * FROM delinquency WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const amount = parseMoney(ctx.fields.promised);
    const date = String(ctx.fields.promised_date || "");
    if (amount == null || amount <= 0) throw new BadRequest("How much did they promise?");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("Give the date they promised to pay by.");

    await tx(async () => {
      await insert("payment_promise", {
        id: id(), company_id: cid, delinquency_id: d.id,
        promised_date: date, promised_cents: amount,
        note: String(ctx.fields.note || "").trim() || null,
        created_at: stamp(), created_by: ctx.staff.name,
      });
      // Pausing the ladder is the point: chasing someone who has committed to
      // a date, on the same schedule as someone who has not, is what makes a
      // sequence feel mechanical rather than fair.
      if (d.status === "open") await update("delinquency", d.id, { status: "promised" });
    });
    redirect(ctx.res, `/app/rent/${d.id}?m=${encodeURIComponent("Promise logged — the ladder is paused until that date.")}`);
  });

  router.post("/app/rent/:id/notice", async (ctx) => {
    const cid = ctx.staff.company_id;
    const d = await one(
      `SELECT d.*, u.label, p.line1 FROM delinquency d JOIN lease l ON l.id = d.lease_id
         JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE d.id = ? AND d.company_id = ?`, ctx.params.id, cid);
    const key = String(ctx.fields.template_key || "");
    const template = await get("SELECT * FROM notice_template WHERE company_id = ? AND key = ?", cid, key);
    if (!template) throw new BadRequest("That template does not exist.");

    /* The block that matters. A form can be tampered with, so approval is
       checked here and not only in the markup that disabled the option. */
    if (!template.approved_at) {
      throw new Forbidden(
        `"${template.name}" has not been marked approved, so it cannot be sent. `
        + `Have your attorney review it and record the sign-off in Setup.`);
    }

    const step = await get("SELECT * FROM delinquency_step WHERE company_id = ? AND template_key = ?", cid, key)
      || { stage: d.stage, channel: "email", template_key: key };
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const n = await queueNotice({
      company, delinquency: d, step, template,
      lateDays: daysBetween(d.late_since, today()), sentBy: ctx.staff.name,
    });
    redirect(ctx.res, `/app/rent/${d.id}?m=${encodeURIComponent(n ? `Queued for ${n} recipient(s) and recorded.` : "No tenant has a contact for that channel.")}`);
  });

}
