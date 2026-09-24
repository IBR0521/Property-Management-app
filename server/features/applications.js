/* F6  Application intake.

   This is intake plus a consistency record, and nothing else. There is no
   score, no ranking and no automated decision anywhere in this file, and that
   is a design decision rather than an unfinished feature:

     - Screening rules vary by jurisdiction. Some places restrict the use of
       criminal history, cap income-ratio requirements, or require applications
       to be considered in the order received.
     - A scoring model would both systematise whatever bias sits in the
       criteria AND produce a tidy audit trail of having applied it uniformly,
       which is worse than deciding case by case.

   So: the company writes its own criteria, a human marks each one pass/fail/na
   per application with a note, and the record shows that every applicant was
   measured against the same list. The decision stays with the human, and the
   reason is required. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id, token } from "../lib/ids.js";
import { stamp, human, humanStamp, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, publicPage, notice, empty, tabs, PEOPLE_TABS } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { storeMany, DOC_TYPES, fileUrl } from "../lib/files.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { resolvePublicCompany, companyForToken } from "../lib/tenancy.js";

const STATUS_TONE = {
  received: "warn", incomplete: "warn", screening: "brand",
  approved: "ok", declined: "danger", withdrawn: null,
};

export function registerApplications(router) {
  /* --- public: apply ----------------------------------------------------- */
  router.get("/apply", async (ctx) => renderApply(ctx));
  router.get("/c/:slug/apply", async (ctx) => renderApply(ctx));

  async function renderApply(ctx) {
    /* No token on this page — an applicant arrives from a listing or an
       advert, not from a record. The slug in the path is what says whose
       vacancies these are; without it, /apply served the first company's
       units to everyone. */
    const { company, reason } = await resolvePublicCompany(ctx);
    if (!company) return sendHtml(ctx.res, applyNoCompanyPage(reason), reason === "none" ? 500 : 404);
    const units = await all(
      `SELECT u.id, u.label, u.beds, u.baths, u.market_rent_cents, p.line1, p.city
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ? AND u.status IN ('vacant','turn')
        ORDER BY p.line1, u.label`, company.id);
    const criteria = await get(
      "SELECT * FROM criteria_set WHERE company_id = ? AND active = 1 LIMIT 1", company.id);

    sendHtml(ctx.res, publicPage({
      company, title: `Apply · ${company.name}`,
      heading: "Apply for a home",
      lede: units.length
        ? "Tell us which place and a little about you. You will get a link to add documents afterwards."
        : "There is nothing available right now.",
      body: html`
        ${ctx.flash ? notice("warn", null, ctx.flash) : ""}
        ${criteria ? html`
          <div class="panel">
            <div class="panel__head"><h2>What we look at</h2><p>The same list for every applicant</p></div>
            <div class="panel__body">
              <ul style="display:grid;gap:0.625rem;font-size:0.875rem">
                ${safeItems(criteria.items).map((i) => html`
                  <li><b style="font-weight:500">${i.label}</b>${i.how_checked ? html`<span class="cellsub">${i.how_checked}</span>` : ""}</li>`)}
              </ul>
            </div>
          </div>` : ""}

        ${units.length ? html`
        <div class="panel">
          <div class="panel__head"><h2>Your application</h2></div>
          <div class="panel__body">
            <form method="post" action="/apply" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="unit_id">Which home</label>
                <select id="unit_id" name="unit_id" required>
                  <option value="">Choose…</option>
                  ${units.map((u) => html`
                    <option value="${u.id}"${attr("selected", ctx.query.unit === u.id)}>
                      ${u.line1}${u.label ? ` — unit ${u.label}` : ""}${u.beds ? `, ${u.beds} bed` : ""}${u.market_rent_cents ? ` — ${usd(u.market_rent_cents)}/mo` : ""}
                    </option>`)}
                </select>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field"><label for="name">Your name</label>
                  <input id="name" name="name" type="text" required autocomplete="name" /></div>
                <div class="field"><label for="phone">Phone</label>
                  <input id="phone" name="phone" type="tel" required autocomplete="tel" /></div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field"><label for="email">Email</label>
                  <input id="email" name="email" type="email" required autocomplete="email" /></div>
                <div class="field"><label for="move_in">Desired move-in</label>
                  <input id="move_in" name="move_in" type="date" min="${today()}" /></div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field"><label for="occupants">How many people</label>
                  <input id="occupants" name="occupants" type="number" min="1" max="20" /></div>
                <div class="field"><label for="income">Monthly household income</label>
                  <input id="income" name="income" type="text" inputmode="decimal" placeholder="4200" /></div>
              </div>
              <div class="field"><label for="employer">Employer <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                <input id="employer" name="employer" type="text" /></div>
              <div class="field">
                <label for="notes">Anything you would like us to know <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                <textarea id="notes" name="notes" rows="3"></textarea>
              </div>
              <button class="pill solid" type="submit">Send application</button>
            </form>
          </div>
          <div class="panel__foot">
            We consider every application against the same written list above. Nothing on this form is scored automatically.
          </div>
        </div>` : ""}`,
    }));
  }

  router.post("/apply", async (ctx) => handleApply(ctx));
  router.post("/c/:slug/apply", async (ctx) => handleApply(ctx));

  async function handleApply(ctx) {
    const gate = await check("apply", clientIp(ctx.req));
    if (!gate.allowed) {
      return sendHtml(ctx.res, "Too many applications from this connection. Please call us instead.", 429);
    }
    /* The chosen unit names its company; the slug covers the case where no
       unit was picked and the form comes back with an error. */
    const { company } = await resolvePublicCompany(ctx, {
      tokenLookup: async () => {
        const unitId = String(ctx.fields.unit_id || "");
        if (!unitId) return null;
        return await get(
          `SELECT c.* FROM unit u JOIN company c ON c.id = u.company_id WHERE u.id = ?`, unitId);
      },
    });
    if (!company) throw new BadRequest("We could not tell which company this application is for.");
    const f = ctx.fields;
    const unit = await get(
      "SELECT * FROM unit WHERE id = ? AND company_id = ?", String(f.unit_id || ""), company.id);
    if (!unit) return redirect(ctx.res, `/apply?m=${encodeURIComponent("Pick which home you are applying for.")}`);

    const name = String(f.name || "").trim();
    const phone = String(f.phone || "").trim();
    if (!name || phone.replace(/\D/g, "").length < 10) {
      return redirect(ctx.res, `/apply?m=${encodeURIComponent("We need your name and a full phone number.")}`);
    }

    const criteria = await get(
      "SELECT * FROM criteria_set WHERE company_id = ? AND active = 1 LIMIT 1", company.id);
    const appId = id();
    const tok = token();

    await tx(async () => {
      await insert("application", {
        id: appId, company_id: company.id, unit_id: unit.id,
        criteria_set_id: criteria ? criteria.id : null,
        applicant_name: name, email: String(f.email || "").trim() || null, phone,
        desired_move_in: String(f.move_in || "") || null,
        occupants: Number(f.occupants) || null,
        monthly_income_cents: parseMoney(f.income),
        employer: String(f.employer || "").trim() || null,
        notes: String(f.notes || "").trim() || null,
        status: "received", received_at: stamp(), token: tok,
      });

      // Seed one pending check per criterion so nothing gets skipped by
      // accident, and so the list is identical for every applicant.
      if (criteria) {
        for (const item of safeItems(criteria.items)) {
          await insert("application_check", {
            id: id(), application_id: appId, criteria_item_key: item.key,
            result: "pending", checked_by: "—", checked_at: stamp(),
          });
        }
      }

      for (const s of await all("SELECT email FROM staff WHERE company_id = ? AND active = 1", company.id)) {
        await insert("outbox", {
          id: id(), company_id: company.id, channel: "email", to_contact: s.email,
          subject: `Application: ${name}`,
          body: `${name} applied for ${unit.label || "the unit"}.\nPhone ${phone}.`,
          about_type: "application", about_id: appId, status: "queued", queued_at: stamp(),
        });
      }
    });
    redirect(ctx.res, `/a/${tok}`);
  }

  /* --- public: applicant's own page, for documents ------------------------- */
  router.get("/a/:tok", async (ctx) => {
    const app = await get("SELECT * FROM application WHERE token = ?", ctx.params.tok);
    if (!app) return sendHtml(ctx.res, "Not found", 404);
    const company = await one("SELECT * FROM company WHERE id = ?", app.company_id);
    const docs = await all("SELECT * FROM application_doc WHERE application_id = ? ORDER BY created_at", app.id);

    sendHtml(ctx.res, publicPage({
      company, title: "Your application",
      heading: "Your application is in",
      lede: `Received ${humanStamp(app.received_at)}. Keep this link — it is how you add documents and check progress.`,
      body: html`
        ${ctx.flash ? notice("warn", null, ctx.flash) : ""}
        <div class="panel">
          <div class="panel__head"><h2>Status</h2>
            <span class="chip"${attr("data-tone", STATUS_TONE[app.status])}>${app.status}</span>
          </div>
          <div class="panel__body">
            ${app.status === "approved"
              ? notice("ok", "Approved", "Someone will be in touch about the lease and the deposit.")
              : app.status === "declined"
                ? notice(null, "Not going ahead", app.decision_reason || "We are not able to proceed with this application.")
                : notice(null, "Being reviewed", "We check every application against the same written list. Adding your documents is the fastest way to move it along.")}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Documents</h2><p>${docs.length} on file</p></div>
          <div class="panel__body">
            <form method="post" action="/a/${app.token}" enctype="multipart/form-data" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="kind">What is it</label>
                <select id="kind" name="kind" required>
                  <option value="id">Photo ID</option>
                  <option value="income">Proof of income</option>
                  <option value="reference">Reference</option>
                  <option value="other">Something else</option>
                </select>
              </div>
              <div class="field">
                <label for="docs">File</label>
                <input id="docs" name="docs" type="file" accept="image/*,application/pdf" multiple required />
                <span class="field__help">Images or PDFs, up to 10MB each.</span>
              </div>
              <button class="pill solid" type="submit">Upload</button>
            </form>
            ${docs.length ? html`
              <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                <thead><tr><th>Kind</th><th>Added</th></tr></thead>
                <tbody>${docs.map((d) => html`<tr><td>${d.kind}</td><td>${humanStamp(d.created_at)}</td></tr>`)}</tbody>
              </table></div>` : ""}
          </div>
        </div>`,
    }));
  });

  router.post("/a/:tok", async (ctx) => {
    const app = await get("SELECT * FROM application WHERE token = ?", ctx.params.tok);
    if (!app) return sendHtml(ctx.res, "Not found", 404);
    const { stored, problems } = await storeMany(ctx.files, "docs", { allow: DOC_TYPES });
    const kind = String(ctx.fields.kind || "other");
    for (const s of stored) {
      await insert("application_doc", {
        id: id(), application_id: app.id, kind, path: s.path,
        mime: s.mime, bytes: s.bytes, created_at: stamp(),
      });
    }
    const q = problems.length ? `?m=${encodeURIComponent(problems.join(" "))}` : "";
    redirect(ctx.res, `/a/${app.token}${q}`);
  });

  /* --- app: list ---------------------------------------------------------- */
  router.get("/app/applications", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await all(
      `SELECT a.*, u.label, p.line1,
              (SELECT COUNT(*) FROM application_doc d WHERE d.application_id = a.id) AS docs,
              (SELECT COUNT(*) FROM application_check c WHERE c.application_id = a.id AND c.result = 'pending') AS pending,
              /* A decline that a consumer report contributed to needs a
                 written notice, and a compliance obligation that is only
                 visible if somebody happens to open the record is not much of
                 a reminder. Asked here so it is on the list. */
              (a.status = 'declined'
               AND EXISTS (SELECT 1 FROM screening_request r
                            WHERE r.application_id = a.id AND r.status = 'received')
               AND NOT EXISTS (SELECT 1 FROM adverse_action n
                                WHERE n.application_id = a.id)) AS notice_due
         FROM application a
         LEFT JOIN unit u ON u.id = a.unit_id
         LEFT JOIN property p ON p.id = u.property_id
        WHERE a.company_id = ? ORDER BY a.received_at`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(cid),
      title: "Applications",
      subtitle: "In the order received",
      actions: html`<a class="pill outline" href="/apply" target="_blank">Public form</a>`,
      body: html`
        ${tabs(PEOPLE_TABS, "applicants")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${notice(null, "Order received is shown deliberately",
          "Some jurisdictions require applications to be considered in order. Nothing here is scored or ranked.")}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${rows.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th class="shrink">#</th><th>Applicant</th><th>Unit</th><th>Received</th><th class="shrink">Docs</th><th class="shrink">Checks left</th><th class="shrink">Status</th><th class="shrink"></th></tr></thead>
            <tbody>${rows.map((a, i) => html`
              <tr>
                <td class="shrink">${i + 1}</td>
                <td><a href="/app/applications/${a.id}">${a.applicant_name}</a>
                  <span class="cellsub">${a.phone || ""}</span></td>
                <td>${a.line1 || "—"}${a.label ? html`<span class="cellsub">Unit ${a.label}</span>` : ""}</td>
                <td>${human(a.received_at.slice(0, 10))}</td>
                <td class="shrink">${a.docs}</td>
                <td class="shrink">${a.pending ? html`<span class="chip" data-tone="warn">${a.pending}</span>` : html`<span class="chip" data-tone="ok">0</span>`}</td>
                <td class="shrink"><span class="chip"${attr("data-tone", STATUS_TONE[a.status])}>${a.status}</span>
                  ${a.notice_due ? html`<span class="cellsub" style="color:var(--danger)">adverse
                    action notice due</span>` : ""}</td>
                <td class="shrink"><a class="pill outline sm" href="/app/applications/${a.id}">Open</a></td>
              </tr>`)}</tbody>
          </table></div>` : empty("No applications", "The public form is at /apply.")}
        </div></div>`,
    }));
  });

  /* --- app: one application ----------------------------------------------- */
  router.get("/app/applications/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await get(
      `SELECT a.*, u.label, u.market_rent_cents, p.line1 FROM application a
         LEFT JOIN unit u ON u.id = a.unit_id LEFT JOIN property p ON p.id = u.property_id
        WHERE a.id = ? AND a.company_id = ?`, ctx.params.id, cid);
    if (!app) return sendHtml(ctx.res, "Not found", 404);

    const criteria = app.criteria_set_id
      ? await get("SELECT * FROM criteria_set WHERE id = ?", app.criteria_set_id) : null;
    const checks = await all("SELECT * FROM application_check WHERE application_id = ?", app.id);
    const docs = await all("SELECT * FROM application_doc WHERE application_id = ? ORDER BY created_at", app.id);
    const items = criteria ? safeItems(criteria.items) : [];
    const decided = ["approved", "declined", "withdrawn"].includes(app.status);

    /* Screening sits on this screen rather than one of its own: a person
       deciding an application should see the report, the criteria and the
       decision together. The code for it lives with the rest of screening. */
    const { screeningPanel } = await import("./screening.js");
    const screening = await screeningPanel(ctx, app);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(cid),
      title: app.applicant_name,
      subtitle: `${app.line1 || "no unit"}${app.label ? `, unit ${app.label}` : ""} · received ${humanStamp(app.received_at)}`,
      actions: html`<a class="pill outline sm" href="/app/applications">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head"><h2>Applicant</h2>
              <span class="chip"${attr("data-tone", STATUS_TONE[app.status])}>${app.status}</span></div>
            <div class="panel__body">
              <dl class="dl">
                <div><dt>Phone</dt><dd><a href="tel:${app.phone}">${app.phone}</a></dd></div>
                <div><dt>Email</dt><dd>${app.email || "—"}</dd></div>
                <div><dt>Move-in wanted</dt><dd>${app.desired_move_in ? human(app.desired_move_in) : "—"}</dd></div>
                <div><dt>Occupants</dt><dd>${app.occupants ?? "—"}</dd></div>
                <div><dt>Stated income</dt><dd>${app.monthly_income_cents ? `${usd(app.monthly_income_cents)}/mo` : "—"}</dd></div>
                <div><dt>Employer</dt><dd>${app.employer || "—"}</dd></div>
                ${app.notes ? html`<div><dt>Notes</dt><dd>${app.notes}</dd></div>` : ""}
                <div><dt>Their link</dt><dd><a href="/a/${app.token}" target="_blank">applicant page</a></dd></div>
              </dl>
              ${docs.length ? html`
                <div style="margin-top:1.25rem"><span class="tile__label">Documents</span>
                  <div class="btnrow" style="margin-top:0.5rem">
                    ${docs.map((d) => html`<a class="pill outline sm" href="${fileUrl(d.path)}" target="_blank">${d.kind}</a>`)}
                  </div>
                </div>` : notice("warn", "No documents yet", html`Send them to <a href="/a/${app.token}">their page</a> to upload ID and proof of income.`)}
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Criteria</h2><p>${criteria ? criteria.name : "no set active"}</p></div>
            <div class="panel__body">
              ${!criteria
                ? notice("warn", "No criteria set is active",
                    html`Applications cannot be assessed consistently without one. <a href="/app/setup">Create one in Setup.</a>`)
                : html`
                  <form method="post" action="/app/applications/${app.id}/checks" class="formgrid">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    ${items.map((item) => {
                      const c = checks.find((x) => x.criteria_item_key === item.key) || { result: "pending", note: "" };
                      return html`
                        <div class="field">
                          <label for="r_${item.key}">${item.label}</label>
                          ${item.how_checked ? html`<span class="field__help" style="margin-top:0;margin-bottom:0.375rem">${item.how_checked}</span>` : ""}
                          <div class="btnrow">
                            <select id="r_${item.key}" name="result_${item.key}" style="width:9rem">
                              <option value="pending"${attr("selected", c.result === "pending")}>Not checked</option>
                              <option value="pass"${attr("selected", c.result === "pass")}>Meets it</option>
                              <option value="fail"${attr("selected", c.result === "fail")}>Does not</option>
                              <option value="na"${attr("selected", c.result === "na")}>Not applicable</option>
                            </select>
                            <input name="note_${item.key}" type="text" value="${c.note || ""}" placeholder="note"
                                   style="flex:1;min-width:10rem;padding:0.625rem 0.875rem;border:1px solid var(--control-edge);border-radius:var(--radius-xl);font-size:0.875rem" />
                          </div>
                        </div>`;
                    })}
                    <button class="pill outline sm" type="submit">Save checks</button>
                  </form>`}
            </div>
          </div>
        </div>

        ${screening}

        ${decided
          ? notice(app.status === "approved" ? "ok" : null, `Decided: ${app.status}`,
              html`${humanStamp(app.decided_at)} by ${app.decided_by || "—"}${app.decision_reason ? html` — ${app.decision_reason}` : ""}`)
          : html`
            <div class="panel" style="max-width:36rem">
              <div class="panel__head"><h2>Decide</h2><p>A reason is required, whichever way it goes</p></div>
              <div class="panel__body">
                <form method="post" action="/app/applications/${app.id}/decide" class="formgrid">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="field">
                    <label for="reason">Reason</label>
                    <input id="reason" name="reason" type="text" required
                           placeholder="Met every criterion / income below the stated threshold" />
                    <span class="field__help">Recorded against the application. This is the record that shows decisions were made on the written criteria.</span>
                  </div>
                  <div class="btnrow">
                    <button class="pill solid" type="submit" name="status" value="approved">Approve</button>
                    <button class="pill outline" type="submit" name="status" value="declined">Decline</button>
                    <button class="pill outline" type="submit" name="status" value="withdrawn">Withdrawn</button>
                  </div>
                </form>
              </div>
            </div>`}`,
    }));
  });

  router.post("/app/applications/:id/checks", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await one("SELECT * FROM application WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const criteria = app.criteria_set_id ? await get("SELECT * FROM criteria_set WHERE id = ?", app.criteria_set_id) : null;
    if (!criteria) throw new BadRequest("No criteria set is attached to this application.");

    await tx(async () => {
      for (const item of safeItems(criteria.items)) {
        const result = String(ctx.fields[`result_${item.key}`] || "pending");
        if (!["pass", "fail", "na", "pending"].includes(result)) continue;
        const note = String(ctx.fields[`note_${item.key}`] || "").trim() || null;
        const existing = await get(
          "SELECT * FROM application_check WHERE application_id = ? AND criteria_item_key = ?", app.id, item.key);
        if (existing) {
          await update("application_check", existing.id, {
            result, note, checked_by: ctx.staff.name, checked_at: stamp(),
          });
        } else {
          await insert("application_check", {
            id: id(), application_id: app.id, criteria_item_key: item.key,
            result, note, checked_by: ctx.staff.name, checked_at: stamp(),
          });
        }
      }
      if (app.status === "received") await update("application", app.id, { status: "screening" });
    });
    redirect(ctx.res, `/app/applications/${app.id}?m=${encodeURIComponent("Checks saved.")}`);
  });

  router.post("/app/applications/:id/decide", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await one("SELECT * FROM application WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const status = String(ctx.fields.status || "");
    if (!["approved", "declined", "withdrawn"].includes(status)) throw new BadRequest("Pick a decision.");
    const reason = String(ctx.fields.reason || "").trim();
    // Required both ways round: a bare "approved" with no reason leaves no
    // record that the written criteria were what decided it.
    if (!reason) throw new BadRequest("Give the reason for the decision.");

    await tx(async () => {
      await update("application", app.id, {
        status, decided_at: stamp(), decided_by: ctx.staff.name, decision_reason: reason,
      });
      await insert("audit_log", {
        id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
        entity: "application", entity_id: app.id, action: status, detail: reason,
      });
      if (app.email) {
        await insert("outbox", {
          id: id(), company_id: cid, channel: "email", to_contact: app.email,
          subject: `Your application`,
          body: status === "approved"
            ? `Good news — your application was approved. We will be in touch about the lease.`
            : `Thank you for applying. On this occasion we are not going ahead.\n\n${reason}`,
          about_type: "application_decision", about_id: app.id, status: "queued", queued_at: stamp(),
        });
      }
    });
    redirect(ctx.res, `/app/applications/${app.id}?m=${encodeURIComponent("Decision recorded.")}`);
  });
}

function safeItems(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((i) => i && i.key && i.label) : [];
  } catch {
    return [];
  }
}

/* Named no company on purpose. Listing every company on the platform so a
   visitor can choose is the portfolio-enumeration mistake one level up — the
   applicant arrived from somewhere, and that somewhere should have carried
   the answer. */
function applyNoCompanyPage(reason) {
  const message = reason === "none"
    ? "This installation has no company set up yet."
    : reason === "unknown-slug"
    ? "That web address does not match a company we know."
    : "This link is missing the company it belongs to. Use the link from the advert or the agent you spoke to.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title>`
    + `<link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css">`
    + `</head><body><div class="pub" style="max-width:32rem"><h1>We need a little more</h1>`
    + `<p class="lede">${message}</p></div></body></html>`;
}
