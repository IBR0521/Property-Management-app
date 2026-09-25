/* F3  Compliance deadlines.

   This feature is a timer and a record, and deliberately nothing more. The
   windows come from the company or their attorney and are stored with the
   basis they gave us; the app never asserts what a statute requires. That
   boundary is the reason it is safe to ship.

   The deposit-return clock is the one that matters most: it starts the day
   keys come back, and in many states missing it carries penalties well beyond
   the deposit. */
import { all, get, insert, update, one } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, today, daysBetween } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { tick } from "../lib/scheduler.js";

const KINDS = [
  { key: "deposit_return", label: "Security deposit return", hint: "Counts forward from the move-out date" },
  { key: "lease_renewal_notice", label: "Lease renewal notice", hint: "Counts backward from the lease end date" },
  { key: "registration_renewal", label: "Rental registration renewal", hint: "Counts forward from the property record" },
  { key: "inspection", label: "Periodic inspection", hint: "Counts forward from the lease start" },
  { key: "insurance_expiry", label: "Insurance expiry", hint: "Counts forward from the property record" },
  { key: "detector_check", label: "Smoke / CO detector check", hint: "Counts forward from the lease start" },
  { key: "custom", label: "Something else", hint: "Any other dated obligation" },
];

export function registerCompliance(router) {
  router.get("/app/compliance", async (ctx) => {
    const cid = ctx.staff.company_id;
    /* Three independent reads, issued together. Sequentially this page cost
       three full round trips before it rendered anything. */
    const [rows, label, doneRecently] = await Promise.all([
      all(`SELECT o.*, r.label, r.kind, r.authority_note
             FROM obligation o JOIN compliance_rule r ON r.id = o.rule_id
            WHERE o.company_id = ? AND o.status IN ('open','overdue')
            ORDER BY o.due_date`, cid),
      subjectLabeller(cid),
      all(`SELECT o.*, r.label FROM obligation o JOIN compliance_rule r ON r.id = o.rule_id
            WHERE o.company_id = ? AND o.status IN ('done','waived')
            ORDER BY o.completed_at DESC LIMIT 10`, cid),
    ]);
    const overdue = rows.filter((r) => r.status === "overdue");
    const dueSoon = rows.filter((r) => r.status === "open" && daysBetween(today(), r.due_date) <= 14);
    const later = rows.filter((r) => r.status === "open" && daysBetween(today(), r.due_date) > 14);

    const group = (title, list, tone) => list.length ? html`
      <div class="panel">
        <div class="panel__head"><h2>${title}</h2><p>${list.length}</p></div>
        <div class="panel__body panel__body--flush">
          <div class="tablewrap"><table class="data">
            <thead><tr><th>Obligation</th><th>Subject</th><th>Due</th><th class="shrink">Basis on file</th><th class="shrink"></th></tr></thead>
            <tbody>${list.map((o) => html`
              <tr>
                <td>${o.label}<span class="cellsub">triggered ${human(o.trigger_date)}</span></td>
                <td>${label(o.subject_type, o.subject_id)}</td>
                <td>${human(o.due_date)}
                  <span class="cellsub">${o.status === "overdue"
                    ? `${Math.abs(daysBetween(today(), o.due_date))} day(s) late`
                    : `${daysBetween(today(), o.due_date)} day(s)`}</span></td>
                <td class="shrink">${o.authority_note
                  ? html`<span class="chip chip--plain">${o.authority_note}</span>`
                  : html`<span class="chip chip--plain" data-tone="warn">not recorded</span>`}</td>
                <td class="shrink">
                  <form method="post" action="/app/compliance/${o.id}/close" class="btnrow">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <input type="hidden" name="how" value="done" />
                    <button class="pill solid sm" type="submit">Done</button>
                  </form>
                </td>
              </tr>`)}</tbody>
          </table></div>
        </div>
      </div>` : "";

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Deadlines",
      subtitle: `${overdue.length} overdue · ${dueSoon.length} inside two weeks`,
      actions: html`
        <a class="pill outline sm" href="/app/compliance/rules">Rules</a>
        <form method="post" action="/app/compliance/run" style="display:inline">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
          <button class="pill outline sm" type="submit">Re-check now</button>
        </form>`,
      body: html`
        ${tabs(PROPERTY_TABS, "deadlines")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${overdue.length ? notice("danger", `${overdue.length} deadline${overdue.length === 1 ? "" : "s"} already passed`,
            "A missed deposit-return window is the one on this list that usually carries a statutory penalty.") : ""}
        ${!rows.length ? html`<div class="panel"><div class="panel__body">${empty("Nothing outstanding",
            "Every obligation generated from your rules is closed. Add rules to track more.")}</div></div>` : ""}
        ${group("Overdue", overdue, "danger")}
        ${group("Next fourteen days", dueSoon, "warn")}
        ${group("Later", later, null)}
        ${doneRecently.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Recently closed</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Obligation</th><th>Due</th><th>Closed</th><th class="shrink">How</th></tr></thead>
                <tbody>${doneRecently.map((o) => html`
                  <tr><td>${o.label}</td><td>${human(o.due_date)}</td>
                      <td>${o.completed_at ? human(o.completed_at.slice(0, 10)) : "—"}
                        <span class="cellsub">${o.completed_by || ""}</span></td>
                      <td class="shrink"><span class="chip"${attr("data-tone", o.status === "done" ? "ok" : null)}>${o.status}</span></td></tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}`,
    }));
  });

  router.post("/app/compliance/:id/close", async (ctx) => {
    const cid = ctx.staff.company_id;
    const o = await one("SELECT * FROM obligation WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const how = ctx.fields.how === "waived" ? "waived" : "done";
    await update("obligation", o.id, {
      status: how, completed_at: stamp(), completed_by: ctx.staff.name,
      note: String(ctx.fields.note || "").trim() || null,
    });
    await insert("audit_log", {
      id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
      entity: "obligation", entity_id: o.id, action: how, detail: null,
    });
    redirect(ctx.res, `/app/compliance?m=${encodeURIComponent("Closed.")}`);
  });

  /* --- rules -------------------------------------------------------------- */
  router.get("/app/compliance/rules", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rules = await all("SELECT * FROM compliance_rule WHERE company_id = ? ORDER BY kind", cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Compliance rules",
      subtitle: "The windows are yours to set — this app times them, it does not interpret the law",
      actions: html`<a class="pill outline sm" href="/app/compliance">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${notice("warn", "Have these checked",
          html`Every window below should be confirmed against your jurisdiction by your attorney, and the
               <b>basis</b> field is where to record that confirmation. A rule with no basis recorded is
               flagged on the obligation list.`)}

        <div class="panel">
          <div class="panel__head"><h2>Active rules</h2></div>
          <div class="panel__body panel__body--flush">
            ${rules.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Rule</th><th>Kind</th><th class="num">Window</th><th>Nags at</th><th>Basis on file</th><th class="shrink"></th></tr></thead>
              <tbody>${rules.map((r) => html`
                <tr>
                  <td>${r.label}</td>
                  <td><span class="chip chip--plain">${r.kind.replace(/_/g, " ")}</span></td>
                  <td class="num">${r.window_days}d</td>
                  <td>${safeLeads(r.lead_days).join(", ")} days out</td>
                  <td>${r.authority_note || html`<span class="chip chip--plain" data-tone="warn">not recorded</span>`}</td>
                  <td class="shrink"><span class="chip"${attr("data-tone", r.active ? "ok" : null)}>${r.active ? "on" : "off"}</span></td>
                </tr>`)}</tbody>
            </table></div>` : empty("No rules yet", "Add one below and the app will start generating dated obligations from your portfolio.")}
          </div>
        </div>

        <div class="panel" style="max-width:44rem">
          <div class="panel__head"><h2>Add a rule</h2></div>
          <div class="panel__body">
            <form method="post" action="/app/compliance/rules" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="kind">Kind</label>
                <select id="kind" name="kind" required>
                  ${KINDS.map((k) => html`<option value="${k.key}">${k.label} — ${k.hint}</option>`)}
                </select>
              </div>
              <div class="field">
                <label for="label">What to call it</label>
                <input id="label" name="label" type="text" required placeholder="Deposit return — Ohio" />
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="window_days">Window, in days</label>
                  <input id="window_days" name="window_days" type="number" min="1" max="3650" required placeholder="30" />
                  <span class="field__help">Days from the trigger to the deadline.</span>
                </div>
                <div class="field">
                  <label for="lead_days">Nag at</label>
                  <input id="lead_days" name="lead_days" type="text" value="30,7,0" required />
                  <span class="field__help">Days before the deadline, comma separated.</span>
                </div>
              </div>
              <div class="field">
                <label for="authority_note">Basis</label>
                <input id="authority_note" name="authority_note" type="text"
                       placeholder="e.g. confirmed with counsel, March 2026" />
                <span class="field__help">Where this window came from. Recorded, not interpreted.</span>
              </div>
              <button class="pill solid" type="submit">Add rule</button>
            </form>
          </div>
        </div>`,
    }));
  });

  router.post("/app/compliance/rules", async (ctx) => {
    const cid = ctx.staff.company_id;
    const kind = String(ctx.fields.kind || "");
    if (!KINDS.some((k) => k.key === kind)) throw new BadRequest("Pick a kind of rule.");
    const windowDays = Number(ctx.fields.window_days);
    if (!Number.isInteger(windowDays) || windowDays < 1) throw new BadRequest("The window must be a whole number of days.");

    const leads = String(ctx.fields.lead_days || "")
      .split(",").map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);

    await insert("compliance_rule", {
      id: id(), company_id: cid, kind,
      label: String(ctx.fields.label || "").trim() || kind,
      window_days: windowDays,
      lead_days: JSON.stringify(leads.length ? leads : [7, 0]),
      authority_note: String(ctx.fields.authority_note || "").trim() || null,
      active: 1, created_at: stamp(),
    });
    await tick("rule-added");
    redirect(ctx.res, `/app/compliance/rules?m=${encodeURIComponent("Rule added and obligations generated.")}`);
  });

  router.post("/app/compliance/run", async (ctx) => {
    const r = await tick("manual");
    const bits = Object.entries(r).filter(([, v]) => typeof v === "number" && v > 0).map(([k, v]) => `${k} ${v}`);
    redirect(ctx.res, `/app/compliance?m=${encodeURIComponent(bits.length ? bits.join(", ") : "Nothing new was due.")}`);
  });
}

function safeLeads(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [7, 0];
  } catch {
    return [7, 0];
  }
}

/* Resolves an obligation's subject to something a human recognises.
   Three lookups for the whole page, fetched together, rather than one query
   per obligation. */
async function subjectLabeller(companyId) {
  const [leaseRows, unitRows, propRows] = await Promise.all([
    all(`SELECT l.id, p.line1, u.label FROM lease l JOIN unit u ON u.id = l.unit_id
           JOIN property p ON p.id = u.property_id WHERE l.company_id = ?`, companyId),
    all(`SELECT u.id, p.line1, u.label FROM unit u JOIN property p ON p.id = u.property_id
          WHERE u.company_id = ?`, companyId),
    all("SELECT id, line1 FROM property WHERE company_id = ?", companyId),
  ]);

  const place = (line1, label) => `${line1}${label ? ` unit ${label}` : ""}`;
  const maps = {
    lease: new Map(leaseRows.map((r) => [r.id, place(r.line1, r.label)])),
    unit: new Map(unitRows.map((r) => [r.id, place(r.line1, r.label)])),
    property: new Map(propRows.map((r) => [r.id, r.line1])),
  };

  return (type, sid) =>
    (maps[type] && maps[type].get(sid)) || `${type} ${String(sid).slice(0, 8)}`;
}
