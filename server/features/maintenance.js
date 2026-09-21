/* F1  Maintenance intake, triage and dispatch.

   The whole feature exists to remove phone calls from a repair. Three
   surfaces:
     /report        tenant intake, no account, works without JavaScript
     /t/:token      tenant status page, so "any update?" is self-service
     /app/...       the queue a manager actually works from

   Two rules that are not negotiable and are enforced here rather than left to
   whoever is on the rota:
     1. An emergency is escalated to a phone call at intake and is never
        represented to the tenant as "logged, we will be in touch".
     2. Spend above an owner's threshold cannot be dispatched until that owner
        has said yes, and the asking is automatic. */
import { all, get, insert, update, tx, one } from "../lib/db.js";
import { id, token, ref } from "../lib/ids.js";
import { stamp, humanStamp, human, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr, raw } from "../lib/render.js";
import { appPage, publicPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { storeMany, fileUrl } from "../lib/files.js";
import { CATEGORIES, category, assess } from "../lib/triage.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { sendNow } from "../lib/delivery/now.js";
import { resolvePublicCompany, companyForUnitToken, publicPath } from "../lib/tenancy.js";
import { complianceState } from "./vendors.js";

const STATUS_TONE = {
  new: "warn", triaged: "warn", awaiting_owner: "warn",
  assigned: "brand", scheduled: "brand", complete: "ok", cancelled: null,
};
const SEVERITY_TONE = { emergency: "danger", urgent: "warn", normal: null };

export function registerMaintenance(router) {
  /* ======================================================================
     Public: tenant intake
     ====================================================================== */

  /* The QR sticker points here. Short on purpose: it is printed under the
     code in readable text, and somebody will always type it instead. */
  router.get("/r/:tok", async (ctx) => {
    return redirect(ctx.res, `/report?u=${encodeURIComponent(ctx.params.tok)}`);
  });

  router.get("/report", async (ctx) => renderReport(ctx));
  router.get("/c/:slug/report", async (ctx) => renderReport(ctx));

  async function renderReport(ctx) {
    /* The sticker token names a unit, and a unit names its company. Resolving
       in that order is the whole fix: the old code chose a company first and
       then looked for the token inside it, so every sticker outside the first
       company found nothing. */
    const { company, reason } = await resolvePublicCompany(ctx, {
      tokenLookup: () => companyForUnitToken(ctx.query.u),
    });
    if (!company) return sendHtml(ctx.res, whichCompanyPage(reason), reason === "none" ? 500 : 404);

    const unit = await unitByToken(company.id, ctx.query.u);

    /* No sticker scanned, so the tenant has to tell us where they live. This
       page used to offer a dropdown of every unit under management, which
       handed the whole portfolio to anyone who opened it. Now nothing is
       listed until an address is typed, and what comes back is only ever the
       property that was typed. */
    if (!unit) {
      const typed = String(ctx.query.addr || "").trim();
      if (!typed) {
        return sendHtml(ctx.res, publicPage({
          company, title: `Report a repair · ${company.name}`,
          heading: "Report something that needs fixing",
          lede: "Tell us where you are and what kind of problem it is. It takes about a minute, and you will get a link to follow progress.",
          body: intakeAddress({ company, typed: "", error: ctx.query.e }),
        }));
      }

      const matches = await findUnits(company.id, typed);
      if (matches.length === 1) {
        return redirect(ctx.res, `/report?u=${encodeURIComponent(matches[0].report_token)}`);
      }
      if (matches.length === 0) {
        return sendHtml(ctx.res, publicPage({
          company, title: `Report a repair · ${company.name}`,
          heading: "Report something that needs fixing",
          lede: "Tell us where you are and what kind of problem it is.",
          body: intakeAddress({ company, typed,
            error: "We could not find that address. Check the spelling, or call us and we will log it for you." }),
        }));
      }
      // Several units at one address. Listing them is not an enumeration —
      // the tenant already told us the building they are standing in.
      return sendHtml(ctx.res, publicPage({
        company, title: `Which unit? · ${company.name}`,
        heading: "Which unit are you in?",
        lede: matches[0].line1,
        body: intakePickUnit({ company, matches, typed }),
      }));
    }

    const chosenCat = category(ctx.query.category);

    // Step two only once we know both, so the questions shown are the ones
    // that apply. No JavaScript involved in getting here.
    const body = chosenCat
      ? intakeStepTwo({ company, unit, cat: chosenCat, csrf: ctx.csrf, error: ctx.query.e })
      : intakeCategory({ company, unit, error: ctx.query.e });

    sendHtml(ctx.res, publicPage({
      company,
      title: `Report a repair · ${company.name}`,
      heading: chosenCat ? chosenCat.label : "Report something that needs fixing",
      lede: `${unit.line1}${unit.label ? `, unit ${unit.label}` : ""}`,
      body,
    }));
  }

  router.post("/report", async (ctx) => handleReport(ctx));
  router.post("/c/:slug/report", async (ctx) => handleReport(ctx));

  async function handleReport(ctx) {
    /* Anyone can reach this form, so anyone can script it. Generous enough for
       a real block of flats reporting a burst outage, tight enough that nobody
       fills the queue with thousands of jobs. */
    const gate = await check("report", clientIp(ctx.req));
    if (!gate.allowed) {
      return sendHtml(ctx.res, "Too many requests from this connection. Please call us instead.", 429);
    }
    const { company } = await resolvePublicCompany(ctx, {
      tokenLookup: () => companyForUnitToken(ctx.fields.unit_token),
    });
    if (!company) throw new BadRequest("We could not tell which company this form belongs to.");
    const f = ctx.fields;
    /* The unit arrives as its sticker token, never as a row id. A posted id
       would let anyone file against any unit by guessing a primary key; the
       token is the only thing the tenant was ever given. */
    const unit = await unitByToken(company.id, f.unit_token);
    const cat = category(String(f.category || ""));

    const back = `/report?u=${encodeURIComponent(String(f.unit_token || ""))}&category=${encodeURIComponent(f.category || "")}`;
    if (!unit || !cat) return redirect(ctx.res, `/report?e=${encodeURIComponent("Pick your address and the kind of problem.")}`);

    const summary = String(f.summary || "").trim();
    if (summary.length < 3) {
      return redirect(ctx.res, `${back}&e=${encodeURIComponent("Tell us in a few words what is wrong.")}`);
    }
    const phone = String(f.phone || "").trim();
    if (phone.replace(/\D/g, "").length < 10) {
      return redirect(ctx.res, `${back}&e=${encodeURIComponent("We need a phone number with all ten digits.")}`);
    }

    const choiceKey = String(f.closest || "");
    const { severity, reasons, choice } = assess(cat.key, choiceKey);
    if (!choice) {
      return redirect(ctx.res, `${back}&e=${encodeURIComponent("Pick the line that's closest to the problem.")}`);
    }
    const lease = await get(
      "SELECT * FROM lease WHERE unit_id = ? AND status = 'active' ORDER BY start_date DESC LIMIT 1", unit.id);

    const { stored, problems } = await storeMany(ctx.files, "photos");
    const woId = id();
    const publicToken = token();
    const reference = ref("WO");

    await tx(async () => {
      await insert("work_order", {
        id: woId, company_id: company.id, unit_id: unit.id, lease_id: lease ? lease.id : null,
        reference, category: cat.key, severity, summary,
        detail: null,
        triage_answers: JSON.stringify({ choice: choice.key, said: choice.label, reasons }),
        reported_by_name: String(f.name || "").trim() || null,
        reported_by_phone: phone, reported_channel: "web",
        entry_permission: ["yes", "no", "call_first"].includes(f.entry) ? f.entry : null,
        access_note: String(f.access || "").trim() || null,
        status: "new", public_token: publicToken, created_at: stamp(),
      });

      for (const s of stored) {
        await insert("work_order_photo", {
          id: id(), work_order_id: woId, path: s.path, phase: "report",
          mime: s.mime, bytes: s.bytes, created_at: stamp(),
        });
      }

      await event(woId, "tenant", "reported",
        `${cat.label} · ${severity}${stored.length ? ` · ${stored.length} photo(s)` : ""}`);

      if (severity === "emergency") {
        // Escalate, loudly, to the people who can act — and do not pretend to
        // the tenant that a queue entry is a response.
        await event(woId, "system", "escalated",
          `Emergency at intake: ${reasons.join(" / ")}. Tenant directed to call ${company.emergency_phone || company.phone}.`);
        const to = company.emergency_phone || company.phone;
        if (to) {
          /* Sent inside the request, not queued. The scheduler runs daily;
             an on-call alert delivered tomorrow is not an on-call alert. If
             it fails the tenant still sees the stop card telling them to
             phone, which is the guarantee that actually holds — but the
             failure is recorded on the work order so a manager knows the
             number was never reached. */
          const alert = await sendNow({
            companyId: company.id, channel: "sms", to,
            subject: `EMERGENCY ${reference}`,
            body: `${reference} ${cat.label} EMERGENCY at ${unit.line1}${unit.label ? " unit " + unit.label : ""}. `
              + `${reasons.join("; ")}. Tenant ${f.name || "unknown"} ${phone}.`,
            aboutType: "work_order_emergency", aboutId: woId,
          });

          await event(woId, "system", "note",
            alert.ok
              ? `On-call alerted by SMS to ${to}.`
              : `ON-CALL SMS DID NOT SEND to ${to} — ${alert.reason}. `
                + `The tenant was told to call ${to}; confirm somebody has picked this up.`,
            0);
        }
        for (const s of await all("SELECT email FROM staff WHERE company_id = ? AND active = 1", company.id)) {
          await insert("outbox", {
            id: id(), company_id: company.id, channel: "email", to_contact: s.email,
            subject: `EMERGENCY ${reference} — ${unit.line1}`,
            body: `${reasons.join("\n")}\n\nTenant: ${f.name || "unknown"} ${phone}\nSummary: ${summary}`,
            about_type: "work_order_emergency", about_id: woId, status: "queued", queued_at: stamp(),
          });
        }
      } else {
        await autoRoute({ company, woId, cat, unit, severity });
      }
    });

    if (severity === "emergency") {
      return sendHtml(ctx.res, publicPage({
        company, title: "Call us now",
        body: html`
          <div class="stopcard">
            ${icons.phone}
            <h2>Please call us now — do not wait for a reply</h2>
            <p>From what you told us this needs someone straight away, so it has not been left in a queue.
               We have alerted the on-call number, and calling is still the fastest way to reach a person.</p>
            <a class="pill" href="tel:${company.emergency_phone || company.phone}">Call ${company.emergency_phone || company.phone}</a>
            <small>Reference ${reference} · if you smell gas or there is a fire, call the emergency services first.</small>
          </div>
          <div class="panel">
            <div class="panel__body">
              <p style="font-size:0.875rem;color:var(--ink-soft)">Your report is saved and the on-call team can see it.
                 You can follow it here: <a href="/t/${publicToken}">status page</a>.</p>
            </div>
          </div>`,
      }));
    }

    const q = problems.length ? `?m=${encodeURIComponent(problems.join(" "))}` : "";
    redirect(ctx.res, `/t/${publicToken}${q}`);
  }

  /* Tenant status page. The tokenised URL is the credential, which is why the
     token is 32 bytes and the page shows no other tenant's data. */
  router.get("/t/:tok", async (ctx) => {
    const wo = await get(
      `SELECT w.*, u.label, p.line1, p.city, c.name AS company_name, c.phone AS company_phone,
              c.emergency_phone, v.name AS vendor_name, v.trade AS vendor_trade
         FROM work_order w
         JOIN unit u ON u.id = w.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN company c ON c.id = w.company_id
         LEFT JOIN vendor v ON v.id = w.vendor_id
        WHERE w.public_token = ?`, ctx.params.tok);
    if (!wo) return sendHtml(ctx.res, "Not found", 404);

    const events = await all(
      `SELECT * FROM work_order_event WHERE work_order_id = ? AND tenant_visible = 1 ORDER BY at`, wo.id);
    const photos = await all("SELECT * FROM work_order_photo WHERE work_order_id = ? ORDER BY created_at", wo.id);
    const company = { name: wo.company_name, phone: wo.company_phone };

    sendHtml(ctx.res, publicPage({
      company, title: `${wo.reference} · ${wo.company_name}`,
      heading: wo.summary,
      lede: `${wo.reference} · ${wo.line1}${wo.label ? `, unit ${wo.label}` : ""}`,
      body: html`
        ${ctx.flash ? notice("warn", "Some photos were not saved", ctx.flash) : ""}
        <div class="panel">
          <div class="panel__head">
            <h2>Where it stands</h2>
            <span class="chip"${attr("data-tone", STATUS_TONE[wo.status])}>${wo.status.replace(/_/g, " ")}</span>
          </div>
          <div class="panel__body">
            ${wo.scheduled_start
              ? notice("ok", "Visit booked",
                  html`${wo.vendor_name ? html`<b style="font-weight:500">${wo.vendor_name}</b> — ` : ""}${humanStamp(wo.scheduled_start)}${wo.scheduled_end ? html` to ${humanStamp(wo.scheduled_end)}` : ""}`)
              : wo.status === "complete"
                ? notice("ok", "Finished", `Marked complete ${humanStamp(wo.closed_at)}.`)
                : notice(null, "No visit booked yet", "You will see the appointment here as soon as it is set.")}

            <div class="timeline" style="margin-top:1.25rem">
              ${events.map((e) => html`
                <div class="tl"${attr("data-tone", e.kind === "escalated" ? "danger" : e.kind === "completed" ? "ok" : "brand")}>
                  <div class="tl__dot">${e.kind === "completed" ? icons.check : e.kind === "escalated" ? icons.alert : icons.clock}</div>
                  <div class="tl__body">
                    <b>${labelEvent(e.kind)}</b>
                    <time>${humanStamp(e.at)}</time>
                    ${e.note ? html`<p>${e.note}</p>` : ""}
                  </div>
                </div>`)}
            </div>
          </div>
          <div class="panel__foot">
            Something changed, or this is now urgent? Call
            <a href="tel:${wo.emergency_phone || wo.company_phone}">${wo.emergency_phone || wo.company_phone}</a>
            and quote ${wo.reference}.
          </div>
        </div>

        ${photos.length
          ? html`<div class="panel">
              <div class="panel__head"><h2>Photos on file</h2></div>
              <div class="panel__body"><div class="thumbs">
                ${photos.map((p) => html`<a href="${fileUrl(p.path)}" target="_blank"><img src="${fileUrl(p.path)}" alt="" loading="lazy" /></a>`)}
              </div></div>
            </div>`
          : ""}`,
      foot: html`Keep this link — it is the status of ${wo.reference}.`,
    }));
  });

  /* ======================================================================
     App: queue
     ====================================================================== */

  router.get("/app/maintenance", async (ctx) => {
    const cid = ctx.staff.company_id;
    const filter = ctx.query.severity;
    const show = ctx.query.show || "open";

    const where = ["w.company_id = ?"];
    const args = [cid];
    if (show === "open") where.push("w.status NOT IN ('complete','cancelled')");
    if (show === "complete") where.push("w.status = 'complete'");
    if (filter === "emergency") where.push("w.severity = 'emergency'");

    const rows = await all(
      `SELECT w.*, u.label, p.line1, v.name AS vendor_name,
              (SELECT COUNT(*) FROM work_order_photo ph WHERE ph.work_order_id = w.id) AS photos
         FROM work_order w
         JOIN unit u ON u.id = w.unit_id
         JOIN property p ON p.id = u.property_id
         LEFT JOIN vendor v ON v.id = w.vendor_id
        WHERE ${where.join(" AND ")}
        ORDER BY CASE w.severity WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, w.created_at DESC`,
      ...args);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Maintenance",
      subtitle: `${rows.length} ${show === "open" ? "open" : show} request${rows.length === 1 ? "" : "s"}`,
      actions: html`
        <a class="pill outline" href="/report" target="_blank">Tenant form</a>
        <a class="pill solid" href="/app/maintenance/new">Log a request</a>`,
      body: html`
        ${tabs(PROPERTY_TABS, "repairs")}
        <div class="btnrow">
          <a class="pill ${show === "open" ? "solid" : "outline"} sm" href="/app/maintenance?show=open">Open</a>
          <a class="pill ${show === "complete" ? "solid" : "outline"} sm" href="/app/maintenance?show=complete">Completed</a>
          <a class="pill ${show === "all" ? "solid" : "outline"} sm" href="/app/maintenance?show=all">All</a>
          <a class="pill ${filter === "emergency" ? "danger" : "outline"} sm" href="/app/maintenance?severity=emergency">Emergencies</a>
        </div>
        <div class="panel">
          <div class="panel__body panel__body--flush">
            ${rows.length
              ? html`<div class="tablewrap"><table class="data">
                  <thead><tr>
                    <th>Ref</th><th>Property</th><th>Problem</th><th>Vendor</th>
                    <th class="shrink">Severity</th><th class="shrink">Status</th><th class="num">Cost</th><th class="shrink"></th>
                  </tr></thead>
                  <tbody>${rows.map((w) => html`
                    <tr>
                      <td class="shrink"><a href="/app/maintenance/${w.id}">${w.reference}</a>
                        <span class="cellsub">${human(w.created_at.slice(0, 10))}</span></td>
                      <td>${w.line1}${w.label ? html`<span class="cellsub">Unit ${w.label}</span>` : ""}</td>
                      <td>${w.summary}<span class="cellsub">${w.category}${w.photos ? ` · ${w.photos} photo(s)` : ""}</span></td>
                      <td>${w.vendor_name || html`<span style="color:var(--ink-soft)">—</span>`}</td>
                      <td class="shrink"><span class="chip"${attr("data-tone", SEVERITY_TONE[w.severity])}>${w.severity}</span></td>
                      <td class="shrink"><span class="chip"${attr("data-tone", STATUS_TONE[w.status])}>${w.status.replace(/_/g, " ")}</span></td>
                      <td class="num">${w.actual_cents != null ? usd(w.actual_cents) : w.estimate_cents != null ? html`<span style="color:var(--ink-soft)">est ${usd(w.estimate_cents)}</span>` : "—"}</td>
                      <td class="shrink"><a class="pill outline sm" href="/app/maintenance/${w.id}">Open</a></td>
                    </tr>`)}</tbody>
                </table></div>`
              : empty("Nothing here", "No requests match this filter.")}
          </div>
        </div>`,
    }));
  });

  /* --- staff-entered request (phone-reported) ---------------------------- */

  router.get("/app/maintenance/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const units = await unitOptions(cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Log a request",
      subtitle: "For a repair a tenant phoned in, or something staff spotted",
      body: html`
        ${notice(null, "This is the fallback, not the main route",
          html`When a tenant reports it themselves at
               <a href="/report" target="_blank">the tenant form</a> you get their photo and access
               details first-hand, and they get a status link so they stop ringing to ask.
               Use this screen for the ones who phone anyway.`)}
        <div class="panel" style="max-width:44rem">
          <div class="panel__body">
            <form method="post" action="/app/maintenance/new" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="unit_id">Property and unit</label>
                <select id="unit_id" name="unit_id" required>
                  <option value="">Choose…</option>
                  ${units.map((u) => html`<option value="${u.id}">${u.line1}${u.label ? ` — unit ${u.label}` : ""}</option>`)}
                </select>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="category">Category</label>
                  <select id="category" name="category" required>
                    ${CATEGORIES.map((c) => html`<option value="${c.key}">${c.label}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="severity">Severity</label>
                  <select id="severity" name="severity" required>
                    <option value="normal">Normal</option>
                    <option value="urgent">Urgent</option>
                    <option value="emergency">Emergency</option>
                  </select>
                  <span class="field__help">Set by the intake questions on the tenant form; set by hand here.</span>
                </div>
              </div>
              <div class="field">
                <label for="summary">What is wrong</label>
                <input id="summary" name="summary" type="text" required placeholder="Kitchen tap dripping constantly" />
              </div>
              <div class="field">
                <label for="detail">Detail <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                <textarea id="detail" name="detail" rows="3"></textarea>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="name">Tenant's name</label>
                  <input id="name" name="name" type="text" placeholder="Who reported it" />
                  <span class="field__help">The person living there — not the owner.</span>
                </div>
                <div class="field">
                  <label for="phone">Tenant's phone</label>
                  <input id="phone" name="phone" type="tel" />
                  <span class="field__help">So the vendor can arrange access.</span>
                </div>
              </div>
              <div class="btnrow">
                <button class="pill solid" type="submit">Create request</button>
                <a class="pill outline" href="/app/maintenance">Cancel</a>
              </div>
            </form>
          </div>
        </div>`,
    }));
  });

  router.post("/app/maintenance/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const unit = await one(
      `SELECT u.*, p.line1, p.owner_id FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.id = ? AND u.company_id = ?`, String(f.unit_id || ""), cid);
    const cat = category(String(f.category || "")) || category("other");
    const severity = ["normal", "urgent", "emergency"].includes(f.severity) ? f.severity : "normal";
    const lease = await get("SELECT * FROM lease WHERE unit_id = ? AND status = 'active' LIMIT 1", unit.id);
    const woId = id();
    const reference = ref("WO");
    const company = await one("SELECT * FROM company WHERE id = ?", cid);

    await tx(async () => {
      await insert("work_order", {
        id: woId, company_id: cid, unit_id: unit.id, lease_id: lease ? lease.id : null,
        reference, category: cat.key, severity,
        summary: String(f.summary || "").trim() || "Reported by staff",
        detail: String(f.detail || "").trim() || null,
        reported_by_name: String(f.name || "").trim() || ctx.staff.name,
        reported_by_phone: String(f.phone || "").trim() || null,
        reported_channel: "staff", status: "new",
        public_token: token(), created_at: stamp(),
      });
      await event(woId, ctx.staff.name, "reported", `Logged by staff · ${cat.label} · ${severity}`);
      if (severity !== "emergency") await autoRoute({ company, woId, cat, unit, severity });
    });

    redirect(ctx.res, `/app/maintenance/${woId}`);
  });

  /* --- detail ------------------------------------------------------------ */

  router.get("/app/maintenance/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await get(
      `SELECT w.*, u.label, u.id AS unit_id, p.line1, p.city, p.owner_id,
              o.name AS owner_name, o.approval_threshold_cents,
              v.name AS vendor_name, v.phone AS vendor_phone
         FROM work_order w
         JOIN unit u ON u.id = w.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN owner o ON o.id = p.owner_id
         LEFT JOIN vendor v ON v.id = w.vendor_id
        WHERE w.id = ? AND w.company_id = ?`, ctx.params.id, cid);
    if (!wo) return sendHtml(ctx.res, "Not found", 404);

    const events = await all("SELECT * FROM work_order_event WHERE work_order_id = ? ORDER BY at DESC", wo.id);
    const photos = await all("SELECT * FROM work_order_photo WHERE work_order_id = ? ORDER BY created_at", wo.id);
    const vendors = await all(
      "SELECT * FROM vendor WHERE company_id = ? AND active = 1 ORDER BY trade, name", cid);
    const approval = await get(
      "SELECT * FROM owner_approval WHERE work_order_id = ? ORDER BY requested_at DESC LIMIT 1", wo.id);
    const triage = wo.triage_answers ? JSON.parse(wo.triage_answers) : null;
    const done = wo.status === "complete" || wo.status === "cancelled";

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `${wo.reference} · ${wo.summary}`,
      subtitle: `${wo.line1}${wo.label ? `, unit ${wo.label}` : ""} · owner ${wo.owner_name}`,
      actions: html`
        <a class="pill outline sm" href="/t/${wo.public_token}" target="_blank">Tenant's view</a>
        <a class="pill outline sm" href="/app/maintenance">Back to queue</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${wo.severity === "emergency" && !done
          ? notice("danger", "Emergency",
              html`${triage?.reasons?.length ? triage.reasons.join(" / ") : "Flagged at intake."}
                   ${wo.reported_by_phone ? html` — tenant <a href="tel:${wo.reported_by_phone}">${wo.reported_by_phone}</a>.` : ""}`)
          : ""}
        ${approval && approval.status === "pending"
          ? notice("warn", "Waiting on the owner",
              html`${usd(approval.amount_cents)} is above ${wo.owner_name}'s ${usd(wo.approval_threshold_cents)} threshold.
                   Asked ${humanStamp(approval.requested_at)}. <a href="/o/a/${approval.token}" target="_blank">Owner's link</a>`)
          : ""}
        ${approval && approval.status === "declined"
          ? notice("danger", "Owner declined", approval.decided_note || "No reason given.")
          : ""}

        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head">
              <h2>Request</h2>
              <span class="chip"${attr("data-tone", SEVERITY_TONE[wo.severity])}>${wo.severity}</span>
              <span class="chip"${attr("data-tone", STATUS_TONE[wo.status])}>${wo.status.replace(/_/g, " ")}</span>
            </div>
            <div class="panel__body">
              <dl class="dl">
                <div><dt>Category</dt><dd>${wo.category}</dd></div>
                <div><dt>Reported</dt><dd>${humanStamp(wo.created_at)} · ${wo.reported_channel}</dd></div>
                <div><dt>By</dt><dd>${wo.reported_by_name || "—"}${wo.reported_by_phone ? html` · <a href="tel:${wo.reported_by_phone}">${wo.reported_by_phone}</a>` : ""}</dd></div>
                <div><dt>Entry</dt><dd>${entryLabel(wo.entry_permission)}</dd></div>
                ${wo.access_note ? html`<div><dt>Access</dt><dd>${wo.access_note}</dd></div>` : ""}
                ${wo.detail ? html`<div><dt>Detail</dt><dd>${wo.detail}</dd></div>` : ""}
                ${wo.vendor_name ? html`<div><dt>Vendor</dt><dd>${wo.vendor_name}${wo.vendor_phone ? html` · <a href="tel:${wo.vendor_phone}">${wo.vendor_phone}</a>` : ""}</dd></div>` : ""}
                ${wo.scheduled_start ? html`<div><dt>Booked</dt><dd>${humanStamp(wo.scheduled_start)}</dd></div>` : ""}
                ${wo.estimate_cents != null ? html`<div><dt>Estimate</dt><dd>${usd(wo.estimate_cents)}</dd></div>` : ""}
                ${wo.actual_cents != null ? html`<div><dt>Actual</dt><dd>${usd(wo.actual_cents)}</dd></div>` : ""}
              </dl>

              ${triage?.said
                ? html`<div style="margin-top:1.25rem">
                    <span class="tile__label">What the tenant picked</span>
                    <p style="font-size:0.875rem;margin-top:0.375rem">${triage.said}</p>
                  </div>`
                : ""}

              ${photos.length
                ? html`<div style="margin-top:1.25rem">
                    <span class="tile__label">Photos</span>
                    <div class="thumbs" style="margin-top:0.5rem">
                      ${photos.map((p) => html`<a href="${fileUrl(p.path)}" target="_blank"><img src="${fileUrl(p.path)}" alt="${p.phase}" loading="lazy" /></a>`)}
                    </div>
                  </div>`
                : ""}
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:1.25rem">
            ${done ? "" : actionPanels({ wo, vendors, csrf: ctx.csrf })}
            <div class="panel">
              <div class="panel__head"><h2>History</h2><p>${events.length} entries</p></div>
              <div class="panel__body">
                <div class="timeline">
                  ${events.map((e) => html`
                    <div class="tl"${attr("data-tone", e.kind === "escalated" ? "danger" : e.kind === "completed" ? "ok" : "brand")}>
                      <div class="tl__dot">${e.kind === "completed" ? icons.check : e.kind === "escalated" ? icons.alert : icons.clock}</div>
                      <div class="tl__body">
                        <b>${labelEvent(e.kind)}</b>
                        <time>${humanStamp(e.at)} · ${e.actor}</time>
                        ${e.note ? html`<p>${e.note}</p>` : ""}
                      </div>
                    </div>`)}
                </div>
              </div>
            </div>
          </div>
        </div>`,
    }));
  });

  /* --- actions ----------------------------------------------------------- */

  router.post("/app/maintenance/:id/assign", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await loadForWrite(ctx.params.id, cid);
    const vendorId = String(ctx.fields.vendor_id || "");
    const vendor = await one("SELECT * FROM vendor WHERE id = ? AND company_id = ?", vendorId, cid);

    /* The compliance barrier, in the dispatch path rather than on a dashboard.
       Sending an uninsured contractor to somebody's home is the manager's
       liability the moment they arrive, so this refuses instead of warning. */
    const compliance = complianceState(vendor);
    if (!compliance.canDispatch) {
      return redirect(ctx.res, `/app/maintenance/${wo.id}?m=${encodeURIComponent(
        `${vendor.name} cannot be dispatched: ${compliance.dispatchReasons.join(" ")} ` +
        `Update their record under Contractors first.`)}`);
    }

    const estimate = parseMoney(ctx.fields.estimate);

    const owner = await one(
      `SELECT o.* FROM owner o JOIN property p ON p.owner_id = o.id
         JOIN unit u ON u.property_id = p.id WHERE u.id = ?`, wo.unit_id);

    await tx(async () => {
      await update("work_order", wo.id, { vendor_id: vendor.id, estimate_cents: estimate });

      /* The threshold gate. Above it, the owner is asked and the vendor is
         not dispatched — that is the whole point of recording a threshold. */
      if (estimate != null && estimate > owner.approval_threshold_cents) {
        const apprId = id();
        const tok = token();
        await insert("owner_approval", {
          id: apprId, company_id: cid, owner_id: owner.id, work_order_id: wo.id,
          amount_cents: estimate, status: "pending", token: tok, requested_at: stamp(),
        });
        await update("work_order", wo.id, { status: "awaiting_owner" });
        await event(wo.id, ctx.staff.name, "owner_asked",
          `${usd(estimate)} is over the ${usd(owner.approval_threshold_cents)} threshold — ${owner.name} asked to approve.`);
        if (owner.email) {
          await insert("outbox", {
            id: id(), company_id: cid, channel: "email", to_contact: owner.email,
            subject: `Approval needed: ${usd(estimate)} at ${wo.line1}`,
            body: `${wo.summary}\n\nEstimate ${usd(estimate)} from ${vendor.name}.\n\n`
              + `Approve or decline: ${baseUrl(ctx)}/o/a/${tok}`,
            about_type: "owner_approval", about_id: apprId, status: "queued", queued_at: stamp(),
          });
        }
      } else {
        await update("work_order", wo.id, { status: "assigned" });
        await event(wo.id, ctx.staff.name, "assigned",
          `${vendor.name} (${vendor.trade})${estimate != null ? ` · estimate ${usd(estimate)}` : ""}`);
        if (vendor.email || vendor.phone) {
          await insert("outbox", {
            id: id(), company_id: cid, channel: vendor.email ? "email" : "sms",
            to_contact: vendor.email || vendor.phone,
            subject: `${wo.reference} — ${wo.summary}`,
            body: `${wo.line1}${wo.label ? ` unit ${wo.label}` : ""}\n${wo.summary}\n\n`
              + `Entry: ${entryLabel(wo.entry_permission)}`
            + `${wo.access_note ? `\nAccess: ${wo.access_note}` : ""}`
            + `\nTenant: ${wo.reported_by_name || "—"} ${wo.reported_by_phone || ""}`,
            about_type: "vendor_dispatch", about_id: wo.id, status: "queued", queued_at: stamp(),
          });
        }
      }
    });
    redirect(ctx.res, `/app/maintenance/${wo.id}?m=${encodeURIComponent("Vendor recorded.")}`);
  });

  router.post("/app/maintenance/:id/schedule", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await loadForWrite(ctx.params.id, cid);
    const start = String(ctx.fields.start || "").trim();
    if (!start) throw new BadRequest("Pick a date and time for the visit.");
    await tx(async () => {
      await update("work_order", wo.id, {
        scheduled_start: start,
        scheduled_end: String(ctx.fields.end || "").trim() || null,
        status: "scheduled",
      });
      await event(wo.id, ctx.staff.name, "scheduled", `Visit set for ${humanStamp(start)}`);
    });
    redirect(ctx.res, `/app/maintenance/${wo.id}?m=${encodeURIComponent("Visit booked — the tenant's status page now shows it.")}`);
  });

  router.post("/app/maintenance/:id/complete", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await loadForWrite(ctx.params.id, cid);
    const actual = parseMoney(ctx.fields.actual);
    const { stored, problems } = await storeMany(ctx.files, "photos");
    const owner = await one(
      `SELECT o.*, p.id AS property_id FROM owner o JOIN property p ON p.owner_id = o.id
         JOIN unit u ON u.property_id = p.id WHERE u.id = ?`, wo.unit_id);

    await tx(async () => {
      await update("work_order", wo.id, { status: "complete", actual_cents: actual, closed_at: stamp() });
      for (const s of stored) {
        await insert("work_order_photo", {
          id: id(), work_order_id: wo.id, path: s.path, phase: "completion",
          mime: s.mime, bytes: s.bytes, created_at: stamp(),
        });
      }
      await event(wo.id, ctx.staff.name, "completed",
        `${actual != null ? usd(actual) : "no cost recorded"}${stored.length ? ` · ${stored.length} photo(s)` : ""}`
        + `${ctx.fields.note ? ` · ${String(ctx.fields.note).trim()}` : ""}`);

      /* The cost becomes a line on the owner's statement, with the work order
         attached. This is the link that makes the monthly statement cheap to
         produce and hard to argue with. */
      if (actual != null && actual > 0) {
        await insert("ledger_entry", {
          id: id(), company_id: cid, owner_id: owner.id, property_id: owner.property_id,
          unit_id: wo.unit_id, lease_id: wo.lease_id, date: today(),
          kind: "expense", amount_cents: -Math.abs(actual),
          memo: `${wo.reference} ${wo.summary}`,
          source: "work_order", work_order_id: wo.id, created_at: stamp(),
        });
      }
    });
    const msg = problems.length ? problems.join(" ") : "Marked complete and posted to the owner's ledger.";
    redirect(ctx.res, `/app/maintenance/${wo.id}?m=${encodeURIComponent(msg)}`);
  });

  router.post("/app/maintenance/:id/note", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await loadForWrite(ctx.params.id, cid);
    const note = String(ctx.fields.note || "").trim();
    if (note) {
      await event(wo.id, ctx.staff.name, "note", note, ctx.fields.tenant_visible === "yes" ? 1 : 0);
    }
    redirect(ctx.res, `/app/maintenance/${wo.id}`);
  });

  router.post("/app/maintenance/:id/cancel", async (ctx) => {
    const cid = ctx.staff.company_id;
    const wo = await loadForWrite(ctx.params.id, cid);
    await tx(async () => {
      await update("work_order", wo.id, { status: "cancelled", closed_at: stamp() });
      await event(wo.id, ctx.staff.name, "cancelled", String(ctx.fields.note || "").trim() || null);
    });
    redirect(ctx.res, `/app/maintenance/${wo.id}`);
  });
}

/* ==========================================================================
   Helpers
   ========================================================================== */

async function loadForWrite(woId, cid) {
  return await one(
    `SELECT w.*, u.label, p.line1 FROM work_order w
       JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
      WHERE w.id = ? AND w.company_id = ?`, woId, cid);
}

export async function event(woId, actor, kind, note, tenantVisible = 1) {
  await insert("work_order_event", {
    id: id(), work_order_id: woId, at: stamp(), actor, kind,
    note: note || null, tenant_visible: tenantVisible,
  });
}

/* Routes by the company's rules, lowest rank first. Recording that no rule
   matched is more useful than silently leaving the field null. */
async function autoRoute({ company, woId, cat, unit, severity }) {
  const rule = await get(
    `SELECT r.*, v.name, v.trade, v.after_hours FROM routing_rule r
       JOIN vendor v ON v.id = r.vendor_id
      WHERE r.company_id = ? AND r.category = ? AND v.active = 1
      ORDER BY r.rank LIMIT 1`, company.id, cat.key);

  if (!rule) {
    await event(woId, "system", "triaged", `No routing rule for ${cat.label} — needs a vendor picked by hand.`, 0);
    await update("work_order", woId, { status: "triaged" });
    return;
  }
  await update("work_order", woId, { status: "triaged", vendor_id: rule.vendor_id });
  await event(woId, "system", "triaged", `Routed to ${rule.name} (${rule.trade}) by category rule.`, 0);
}

/* Shown when a public page cannot tell which company it belongs to. It names
   no company: listing every company on the platform so a visitor can pick is
   the portfolio-enumeration mistake one level up. The person following a link
   has one, and the link is what should have carried the answer. */
function whichCompanyPage(reason) {
  const message = reason === "none"
    ? "This installation has no company set up yet."
    : reason === "unknown-slug"
    ? "That web address does not match a company we know."
    : "This link is missing the company it belongs to. Use the link your property manager gave you, or scan the code inside your home.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title>`
    + `<link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css">`
    + `</head><body><div class="pub" style="max-width:32rem"><h1>We need a little more</h1>`
    + `<p class="lede">${message}</p></div></body></html>`;
}

/* --- resolving a unit without listing the portfolio ------------------------ */

async function unitByToken(companyId, tok) {
  const t = String(tok || "");
  if (t.length < 8 || t.length > 64) return null;
  return await get(
    `SELECT u.*, p.line1, p.city, p.owner_id FROM unit u JOIN property p ON p.id = u.property_id
      WHERE u.report_token = ? AND u.company_id = ?`, t, companyId);
}

/* Addresses get typed the way people say them, not the way they are stored:
   "123 Maple St", "123 maple street", "123  Maple Str.". Fold both sides to
   the same shape before comparing, and expand the handful of suffixes that
   account for nearly all of the variation. */
const SUFFIX = {
  st: "street", str: "street", rd: "road", ave: "avenue", av: "avenue",
  blvd: "boulevard", dr: "drive", ln: "lane", ct: "court", pl: "place",
  ter: "terrace", trl: "trail", pkwy: "parkway", hwy: "highway",
  sq: "square", cres: "crescent", cl: "close", gdns: "gardens",
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  apt: "", unit: "", "#": "", no: "",
};

function normaliseAddress(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w in SUFFIX ? SUFFIX[w] : w))
    .filter(Boolean)
    .join(" ");
}

/* Returns every unit whose property matches what was typed. One match sends
   the tenant straight on; several means a building, and they pick the unit.

   This is deliberately a lookup and not a search: it answers "is this address
   one of yours", which any intake form must answer, and never "what addresses
   do you have". The rate limit on POST /report covers the rest. */
async function findUnits(companyId, typed) {
  const want = normaliseAddress(typed);
  if (want.length < 4) return [];

  const rows = await all(
    `SELECT u.id, u.label, u.report_token, p.line1, p.city FROM unit u
       JOIN property p ON p.id = u.property_id
      WHERE u.company_id = ? ORDER BY p.line1, u.label`, companyId);

  const scored = rows.map((r) => ({ r, key: normaliseAddress(r.line1) }));

  // Exact first, then "typed the street but also the unit number", then a
  // house-number-plus-street-name match for everything else.
  let hit = scored.filter((x) => x.key === want);
  if (!hit.length) hit = scored.filter((x) => want.startsWith(x.key + " ") || want === x.key);
  if (!hit.length) {
    const num = want.match(/^\d+/);
    if (num) {
      hit = scored.filter((x) => {
        if (!x.key.startsWith(num[0] + " ")) return false;
        const street = x.key.slice(num[0].length + 1).split(" ")[0];
        return street && want.includes(street);
      });
    }
  }
  return hit.map((x) => x.r);
}

async function unitOptions(companyId) {
  return await all(
    `SELECT u.id, u.label, p.line1, p.city FROM unit u
       JOIN property p ON p.id = u.property_id
      WHERE u.company_id = ? ORDER BY p.line1, u.label`, companyId);
}

function entryLabel(v) {
  return v === "yes" ? "May enter when nobody is home"
    : v === "no" ? "Tenant must be present"
    : v === "call_first" ? "Call before entering"
    : "Not stated";
}

function labelEvent(kind) {
  return {
    reported: "Request received", triaged: "Triaged", escalated: "Escalated as an emergency",
    owner_asked: "Sent to the owner for approval", owner_approved: "Owner approved",
    owner_declined: "Owner declined", assigned: "Vendor assigned", scheduled: "Visit booked",
    completed: "Work completed", cancelled: "Cancelled", note: "Note",
  }[kind] || kind;
}

function baseUrl(ctx) {
  return `${ctx.url.protocol}//${ctx.url.host}`;
}

/* --- public intake views --------------------------------------------------- */

function emergencyBanner(company) {
  // Above everything, on both steps. A tenant should never have to complete a
  // form to discover they should be phoning instead.
  return html`
    <div class="notice" data-tone="danger" style="margin-bottom:1.5rem">
      ${icons.phone}
      <div>
        <b>Gas, fire, flooding or anyone in danger?</b>
        Do not use this form — call
        <a href="tel:${company.emergency_phone || company.phone}"><b>${company.emergency_phone || company.phone}</b></a>
        now. For a fire or a gas leak, call the emergency services first.
      </div>
    </div>`;
}

function intakeAddress({ company, typed, error }) {
  return html`
    ${emergencyBanner(company)}
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>Where are you?</h2></div>
      <div class="panel__body">
        <form method="get" action="/report" class="formgrid">
          <div class="field">
            <label for="addr">Your street address</label>
            <input id="addr" name="addr" type="text" required autocomplete="street-address"
                   value="${typed || ""}" placeholder="123 Maple Street" />
            <span class="field__help">Street and number is enough — we will ask which unit if we need to.</span>
          </div>
          <button class="pill solid" type="submit">Continue</button>
        </form>
      </div>
      <div class="panel__foot">
        There is a QR code inside your unit that skips this step. Scanning it
        is the fastest way in, and it fills your address in for you.
      </div>
    </div>`;
}

function intakePickUnit({ company, matches, typed }) {
  return html`
    ${emergencyBanner(company)}
    <div class="panel">
      <div class="panel__head">
        <h2>Which unit?</h2>
        <a class="pill outline sm" href="/report">Change address</a>
      </div>
      <div class="panel__body">
        <form method="get" action="/report" class="formgrid">
          <div class="field">
            <div class="radioset">
              ${matches.map((u) => html`
                <label class="radiotile">
                  <input type="radio" name="u" value="${u.report_token}" required />
                  <span>Unit ${u.label || "—"}<small>${u.line1}, ${u.city}</small></span>
                </label>`)}
            </div>
          </div>
          <button class="pill solid" type="submit">Continue</button>
        </form>
      </div>
    </div>`;
}

function intakeCategory({ company, unit, error }) {
  return html`
    ${emergencyBanner(company)}
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head">
        <h2>What kind of problem is it?</h2>
        <a class="pill outline sm" href="/report">Not your address?</a>
      </div>
      <div class="panel__body">
        <form method="get" action="/report" class="formgrid">
          <input type="hidden" name="u" value="${unit.report_token}" />
          <div class="field">
            <div class="radioset">
              ${CATEGORIES.map((c) => html`
                <label class="radiotile">
                  <input type="radio" name="category" value="${c.key}" required />
                  <span>${c.label}<small>${c.blurb}</small></span>
                </label>`)}
            </div>
          </div>
          <button class="pill solid" type="submit">Continue</button>
        </form>
      </div>
    </div>`;
}

function intakeStepTwo({ company, unit, cat, csrf, error }) {
  return html`
    ${emergencyBanner(company)}
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head">
        <h2>${cat.label}</h2>
        <a class="pill outline sm" href="/report?u=${unit.report_token}">Change</a>
      </div>
      <div class="panel__body">
        <form method="post" action="/report" enctype="multipart/form-data" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <input type="hidden" name="unit_token" value="${unit.report_token}" />
          <input type="hidden" name="category" value="${cat.key}" />

          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Which of these is closest?</span>
            <div class="radioset">
              ${cat.options.map((o) => html`
                <label class="radiotile">
                  <input type="radio" name="closest" value="${o.key}" required />
                  <span>${o.label}</span>
                </label>`)}
            </div>
          </div>

          <div class="field">
            <label for="summary">Tell us a bit more</label>
            <textarea id="summary" name="summary" rows="3" required maxlength="400"
                      placeholder="Where it is, when it started, anything you've already tried"></textarea>
          </div>

          <div class="field">
            <label for="photos">Add a photo <span style="color:var(--ink-soft);font-weight:400">— the most useful thing you can do</span></label>
            <input id="photos" name="photos" type="file" accept="image/*" multiple />
            <span class="field__help">It means we send the right trade the first time.</span>
          </div>

          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Can we come in if you're out?</span>
            <div class="radioset">
              <label class="radiotile"><input type="radio" name="entry" value="yes" /><span>Yes, let yourselves in</span></label>
              <label class="radiotile"><input type="radio" name="entry" value="call_first" /><span>Call me first</span></label>
              <label class="radiotile"><input type="radio" name="entry" value="no" /><span>No, I need to be there</span></label>
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="name">Your name</label>
              <input id="name" name="name" type="text" autocomplete="name" />
            </div>
            <div class="field">
              <label for="phone">Your phone</label>
              <input id="phone" name="phone" type="tel" inputmode="tel" required autocomplete="tel" />
            </div>
          </div>

          <div class="field">
            <label for="access">Anything about getting in? <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
            <input id="access" name="access" type="text" placeholder="Dog in the back room · weekday mornings are best" />
          </div>

          <button class="pill solid" type="submit">Send this in</button>
        </form>
      </div>
      <div class="panel__foot">
        You'll get a link to follow progress — no account, no password.
      </div>
    </div>`;
}

function actionPanels({ wo, vendors, csrf }) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Move it along</h2></div>
      <div class="panel__body" style="display:flex;flex-direction:column;gap:1.5rem">
        <form method="post" action="/app/maintenance/${wo.id}/assign" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="vendor_id">Vendor</label>
              <select id="vendor_id" name="vendor_id" required>
                <option value="">Choose…</option>
                ${vendors.map((v) => html`<option value="${v.id}"${attr("selected", wo.vendor_id === v.id)}>${v.name} — ${v.trade}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="estimate">Estimate</label>
              <input id="estimate" name="estimate" type="text" inputmode="decimal"
                     placeholder="380" value="${wo.estimate_cents != null ? (wo.estimate_cents / 100).toFixed(2) : ""}" />
              <span class="field__help">Over the owner's threshold, they are asked before dispatch.</span>
            </div>
          </div>
          <button class="pill solid sm" type="submit">Assign</button>
        </form>

        <form method="post" action="/app/maintenance/${wo.id}/schedule" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="start">Visit starts</label>
              <input id="start" name="start" type="datetime-local" required />
            </div>
            <div class="field">
              <label for="end">Window ends <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
              <input id="end" name="end" type="datetime-local" />
            </div>
          </div>
          <button class="pill outline sm" type="submit">Book the visit</button>
        </form>

        <form method="post" action="/app/maintenance/${wo.id}/complete" enctype="multipart/form-data" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="actual">Final cost</label>
              <input id="actual" name="actual" type="text" inputmode="decimal" placeholder="412.50" />
              <span class="field__help">Posts to the owner's ledger with this job attached.</span>
            </div>
            <div class="field">
              <label for="cphotos">Completion photos</label>
              <input id="cphotos" name="photos" type="file" accept="image/*" multiple />
            </div>
          </div>
          <div class="field">
            <label for="cnote">What was done</label>
            <input id="cnote" name="note" type="text" placeholder="Replaced supply line and trap" />
          </div>
          <button class="pill solid sm" type="submit">Mark complete</button>
        </form>

        <form method="post" action="/app/maintenance/${wo.id}/note" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="note">Add a note</label>
            <input id="note" name="note" type="text" />
          </div>
          <label class="radiotile" style="grid-template-columns:1.0625rem 1fr">
            <input type="checkbox" name="tenant_visible" value="yes" />
            <span>Show this to the tenant on their status page</span>
          </label>
          <div class="btnrow">
            <button class="pill outline sm" type="submit">Save note</button>
          </div>
        </form>
      </div>
    </div>

    <form method="post" action="/app/maintenance/${wo.id}/cancel">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <button class="pill outline sm" type="submit">Cancel this request</button>
    </form>`;
}
