/* Screening: the applicant's consent page, the panel beside the criteria, and
   the adverse action notice.

   ## The panel is rendered here and shown by applications.js

   Screening is a section of the application screen rather than a screen of
   its own — a person deciding an application should see the report, the
   criteria and the decision together, not in three places. But the code for
   it belongs with the rest of screening, so the panel is a function this file
   exports and the application screen calls.

   ## The applicant already has a link

   They got a token URL when they applied, for adding documents. Consent goes
   there: no new login, no new email, and the same link they already have. */
import { all, get, one, update, insert, run, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, publicPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { storeMany, DOC_TYPES, fileUrl } from "../lib/files.js";
import { clientIp } from "../lib/ratelimit.js";
import { screeningSettings } from "../lib/screening/settings.js";
import { provider, agencyFor, PROVIDERS } from "../lib/screening/providers.js";
import {
  consentWording, recordConsent, activeConsent, consentHistory, withdrawConsent,
  intact, ConsentRefused,
} from "../lib/screening/consent.js";
import {
  orderScreening, recordReport, cancelScreening, screeningFor, ScreeningRefused,
} from "../lib/screening/requests.js";
import {
  recordAdverseAction, adverseActionsFor, renderNotice, noticeOutstanding,
  AdverseActionRefused, TEMPLATE_KEY,
} from "../lib/screening/adverse.js";
import { deleteReport } from "../lib/screening/retain.js";

export function registerScreening(router) {
  /* --- the applicant's own page ------------------------------------------- */

  router.get("/a/:tok/consent", async (ctx) => {
    const app = await get("SELECT * FROM application WHERE token = ?", ctx.params.tok);
    if (!app) return sendHtml(ctx.res, "Not found", 404);
    const company = await one("SELECT * FROM company WHERE id = ?", app.company_id);
    const settings = await screeningSettings(company.id);
    const agency = agencyFor({ providerKey: settings.provider, settings });
    const existing = await activeConsent(app.id);

    let wording = null;
    let problem = null;
    try {
      wording = agency ? consentWording({ companyName: company.name, agency }) : null;
    } catch (err) {
      problem = err.message;
    }

    sendHtml(ctx.res, publicPage({
      company, title: "Tenant screening",
      heading: existing ? "You have already agreed" : "Tenant screening",
      lede: existing
        ? `Recorded ${humanStamp(existing.consented_at)}. Nothing further is needed from you.`
        : "Please read this and, if you agree, type your name at the bottom.",
      body: html`
        ${ctx.flash ? notice("warn", null, ctx.flash) : ""}

        ${!agency || problem ? notice("warn", "Not ready yet",
          "This company has not finished setting up screening. Nothing is being asked of "
          + "you — please come back to this link later, or get in touch with them.")
        : existing ? html`
          <div class="panel">
            <div class="panel__head"><h2>What you agreed to</h2></div>
            <div class="panel__body">
              <pre style="white-space:pre-wrap;font-family:inherit;margin:0">${existing.wording}</pre>
              <p class="lede" style="margin-top:1rem">Signed <b>${existing.typed_name}</b>,
                ${humanStamp(existing.consented_at)}.</p>
              <form method="post" action="/a/${app.token}/consent/withdraw" style="margin-top:1rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill outline" type="submit">I want to withdraw this</button>
              </form>
              <span class="field__help">If a report has already been obtained, withdrawing
                does not undo that — but nothing further will be requested.</span>
            </div>
          </div>`
        : html`
          <div class="panel">
            <div class="panel__head"><h2>Please read this</h2></div>
            <div class="panel__body">
              <pre style="white-space:pre-wrap;font-family:inherit;margin:0">${wording}</pre>

              <form method="post" action="/a/${app.token}/consent" class="formgrid" style="margin-top:1.25rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="field">
                  <label for="typed_name">Type your full name to agree</label>
                  <input id="typed_name" name="typed_name" type="text" required
                         autocomplete="name" placeholder="${app.applicant_name}" />
                  <span class="field__help">This is your signature. The wording above is kept
                    exactly as you see it now.</span>
                </div>
                <button class="pill solid" type="submit">I agree</button>
              </form>
            </div>
          </div>`}`,
    }));
  });

  router.post("/a/:tok/consent", async (ctx) => {
    const app = await one("SELECT * FROM application WHERE token = ?", ctx.params.tok);
    const company = await one("SELECT * FROM company WHERE id = ?", app.company_id);
    const settings = await screeningSettings(company.id);
    const agency = agencyFor({ providerKey: settings.provider, settings });

    const back = (m) => redirect(ctx.res, `/a/${app.token}/consent?m=${encodeURIComponent(m)}`);

    if (await activeConsent(app.id)) return back("You have already agreed.");

    try {
      await recordConsent({
        companyId: company.id, applicationId: app.id,
        providerKey: settings.provider, agency, companyName: company.name,
        typedName: ctx.fields.typed_name,
        ip: clientIp(ctx.req),
        userAgent: String(ctx.req.headers["user-agent"] || "").slice(0, 300),
      });
    } catch (err) {
      if (err instanceof ConsentRefused) return back(err.message);
      throw err;
    }

    redirect(ctx.res, `/a/${app.token}/consent`);
  });

  router.post("/a/:tok/consent/withdraw", async (ctx) => {
    const app = await one("SELECT * FROM application WHERE token = ?", ctx.params.tok);
    await withdrawConsent({ applicationId: app.id });
    redirect(ctx.res, `/a/${app.token}?m=${encodeURIComponent(
      "Your consent has been withdrawn. Nothing further will be requested.")}`);
  });

  /* --- staff: ordering and recording -------------------------------------- */

  router.post("/app/applications/:id/screening/order", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await one(
      "SELECT * FROM application WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const settings = await screeningSettings(cid);
    const back = (m) => redirect(ctx.res,
      `/app/applications/${app.id}?m=${encodeURIComponent(m)}`);

    try {
      await orderScreening({
        companyId: cid, application: app, providerKey: settings.provider,
        by: ctx.staff.name, reference: ctx.fields.reference,
      });
    } catch (err) {
      if (err instanceof ScreeningRefused) return back(err.message);
      throw err;
    }
    back("Recorded. Add the report when it comes back.");
  });

  router.post("/app/applications/:id/screening/:requestId/report", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await one(
      "SELECT * FROM application WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const back = (m) => redirect(ctx.res,
      `/app/applications/${app.id}?m=${encodeURIComponent(m)}`);

    const { stored, problems } = await storeMany(ctx.files, "report", { allow: DOC_TYPES });

    try {
      await recordReport({
        requestId: ctx.params.requestId, companyId: cid,
        summary: ctx.fields.summary, reference: ctx.fields.reference,
        file: stored[0] || null, by: ctx.staff.name,
      });
    } catch (err) {
      if (err instanceof ScreeningRefused) return back(err.message);
      throw err;
    }
    back(problems.length ? problems.join(" ") : "Report recorded.");
  });

  router.post("/app/applications/:id/screening/:requestId/cancel", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res,
      `/app/applications/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    try {
      await cancelScreening({ requestId: ctx.params.requestId, companyId: cid });
    } catch (err) {
      if (err instanceof ScreeningRefused) return back(err.message);
      throw err;
    }
    back("Cancelled.");
  });

  router.post("/app/applications/:id/screening/:requestId/delete", async (ctx) => {
    const cid = ctx.staff.company_id;
    await deleteReport({
      requestId: ctx.params.requestId, companyId: cid,
      why: String(ctx.fields.why || "").trim() || "Deleted on request",
      by: ctx.staff.name,
    });
    redirect(ctx.res, `/app/applications/${ctx.params.id}?m=${encodeURIComponent(
      "The report file has been deleted. The record that screening happened stays.")}`);
  });

  /* --- staff: the adverse action notice ----------------------------------- */

  router.post("/app/applications/:id/adverse", async (ctx) => {
    const cid = ctx.staff.company_id;
    const app = await one(
      `SELECT a.*, u.label, p.line1 FROM application a
         LEFT JOIN unit u ON u.id = a.unit_id
         LEFT JOIN property p ON p.id = u.property_id
        WHERE a.id = ? AND a.company_id = ?`, ctx.params.id, cid);
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const settings = await screeningSettings(cid);
    const agency = agencyFor({ providerKey: settings.provider, settings });
    const back = (m) => redirect(ctx.res,
      `/app/applications/${app.id}?m=${encodeURIComponent(m)}`);

    const usedScore = String(ctx.fields.used_score || "") === "yes";
    const score = usedScore ? {
      score: String(ctx.fields.score || "").trim(),
      source: String(ctx.fields.score_source || "").trim(),
      date: String(ctx.fields.score_date || "").trim(),
      range: String(ctx.fields.score_range || "").trim(),
      factors: String(ctx.fields.score_factors || "").trim(),
    } : null;

    if (usedScore && !score.score) {
      return back("If a credit score was part of the decision, the notice has to carry it.");
    }

    try {
      const written = await recordAdverseAction({
        companyId: cid, application: app, company, agency, score,
        property: app.line1 ? `${app.line1}${app.label ? `, unit ${app.label}` : ""}` : null,
        contributed: true, by: ctx.staff.name,
      });
      await insert("audit_log", {
        id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
        entity: "application", entity_id: app.id, action: "adverse_action",
        detail: `Notice written${written.outbox_id ? " and queued" : ", not sent — no email on file"}`,
      });
    } catch (err) {
      if (err instanceof AdverseActionRefused) return back(err.message);
      throw err;
    }

    back("Adverse action notice written. It is in the outbox — check Messages for delivery.");
  });
}

/* --- the panel, shown on the application screen ------------------------------ */

/* Everything about screening for one application, as a panel. Returns "" when
   the company has not set screening up, rather than an empty box asking them
   to — an application screen is not the place to be sold a feature. */
export async function screeningPanel(ctx, app) {
  const cid = ctx.staff.company_id;
  const settings = await screeningSettings(cid);
  const agency = agencyFor({ providerKey: settings.provider, settings });
  const spec = provider(settings.provider);

  const consent = await activeConsent(app.id);
  const consents = await consentHistory(app.id);
  const requests = await screeningFor(app.id);
  const notices = await adverseActionsFor(app.id);
  const outstanding = await noticeOutstanding(app);
  const template = await get(
    "SELECT * FROM notice_template WHERE company_id = ? AND key = ?", cid, TEMPLATE_KEY);

  const open = requests.find((r) => r.status === "ordered");
  const received = requests.filter((r) => r.status === "received");
  const decided = ["approved", "declined", "withdrawn"].includes(app.status);

  return html`
    <div class="panel">
      <div class="panel__head"><h2>Screening</h2>
        <p>${spec.label} · reports deleted ${settings.retentionDays} days after the decision</p>
      </div>
      <div class="panel__body">
        ${!agency ? notice("warn", "Not set up",
          html`Screening needs the name, address and telephone number of the agency you use —
            an adverse action notice is required to carry them. Set them in
            <a href="/app/setup/screening">Setup</a>.`)
        : html`
          ${outstanding ? notice("danger", "This decline needs an adverse action notice",
            "A consumer report was obtained and the application was declined. A written "
            + "notice is required even if the report was only a minor factor.") : ""}

          <!-- consent -->
          ${consent && intact(consent) ? html`
            <div class="tablewrap"><table class="data">
              <tbody>
                <tr>
                  <td class="shrink">Consent</td>
                  <td><span class="chip" data-tone="ok">given</span>
                    <span class="cellsub">${consent.typed_name} · ${humanStamp(consent.consented_at)}
                      · naming ${consent.provider_name}</span></td>
                </tr>
              </tbody>
            </table></div>`
          : consent && !intact(consent) ? notice("danger", "The consent record has been altered",
              "Its stored hash no longer matches its wording. Do not screen against it — ask "
              + "for consent again.")
          : html`${notice("warn", "No consent yet",
              html`Nothing may be ordered until the applicant agrees. Their link is
                <a href="/a/${app.token}/consent">/a/${app.token}/consent</a> — it is the same
                link they already have for documents.`)}
            ${consents.length ? html`<span class="cellsub">Previously given and withdrawn
              ${humanStamp(consents[0].consented_at)}.</span>` : ""}`}

          <!-- ordering -->
          ${consent && intact(consent) && !open && !received.length ? html`
            <form method="post" action="/app/applications/${app.id}/screening/order"
                  class="formgrid" style="margin-top:1.25rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="reference">Their reference <span
                  style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                <input id="reference" name="reference" type="text" maxlength="80"
                       placeholder="The number ${consent.provider_name} gave you" />
                <span class="field__help">You order the report wherever you order it today.
                  This records that you did, against the consent above.</span>
              </div>
              <button class="pill solid sm" type="submit">Record that it was ordered</button>
            </form>` : ""}

          <!-- the report -->
          ${open ? html`
            <div style="margin-top:1.25rem">
              ${notice("info", "Ordered, waiting for the report",
                html`${humanStamp(open.ordered_at)} by ${open.ordered_by}${open.reference
                  ? html` · reference ${open.reference}` : ""}`)}
              <form method="post" action="/app/applications/${app.id}/screening/${open.id}/report"
                    enctype="multipart/form-data" class="formgrid" style="margin-top:1rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="field">
                  <label for="summary">What does it say</label>
                  <textarea id="summary" name="summary" rows="3" required
                    placeholder="Two late payments in 2024, no judgements, addresses match the application."></textarea>
                  <span class="field__help">In your own words. This is what somebody reading
                    this decision in a year will have — the report itself is deleted after
                    ${settings.retentionDays} days.</span>
                </div>
                <div class="field">
                  <label for="report">The report <span
                    style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                  <input id="report" name="report" type="file" accept=".pdf,image/*" />
                </div>
                <div class="btnrow">
                  <button class="pill solid sm" type="submit">Record the report</button>
                </div>
              </form>
              <form method="post" action="/app/applications/${app.id}/screening/${open.id}/cancel"
                    style="margin-top:0.75rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill outline sm" type="submit">It was not gone through with</button>
              </form>
            </div>` : ""}

          ${received.length ? html`
            <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
              <thead><tr><th>Received</th><th>What it said</th><th class="shrink">Report</th></tr></thead>
              <tbody>${received.map((r) => html`
                <tr>
                  <td class="shrink">${humanStamp(r.received_at)}
                    <span class="cellsub">${r.reference || ""}</span></td>
                  <td>${r.summary}</td>
                  <td class="shrink">${r.report_path
                    ? html`<a class="pill outline sm" href="${fileUrl(r.report_path)}" target="_blank">Open</a>
                        <form method="post" action="/app/applications/${app.id}/screening/${r.id}/delete"
                              style="margin-top:0.35rem">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <button class="pill outline sm" type="submit">Delete now</button>
                        </form>`
                    : html`<span class="cellsub">${r.deleted_at
                        ? `deleted ${humanStamp(r.deleted_at)}` : "none kept"}</span>`}</td>
                </tr>`)}</tbody>
            </table></div>` : ""}

          <!-- adverse action -->
          ${notices.length ? html`
            <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
              <thead><tr><th>Adverse action notice</th><th class="shrink">Sent</th></tr></thead>
              <tbody>${notices.map((n) => html`
                <tr>
                  <td>${humanStamp(n.created_at)} by ${n.created_by}
                    <span class="cellsub">naming ${n.agency_name}${n.score
                      ? ` · score ${n.score} recorded on the notice` : ""}</span></td>
                  <td class="shrink">${n.outbox_id
                    ? html`<a class="pill outline sm" href="/app/messages/sent">In the outbox</a>`
                    : html`<span class="cellsub">no email on file</span>`}</td>
                </tr>`)}</tbody>
            </table></div>` : ""}

          ${received.length && decided && app.status === "declined" && !notices.length ? html`
            <div style="margin-top:1.25rem">
              ${template?.approved_at ? "" : notice("warn", "The template is not approved yet",
                html`An unapproved notice template is never sent. Have it looked at and approve
                  it in <a href="/app/setup">Setup</a>.`)}
              <form method="post" action="/app/applications/${app.id}/adverse" class="formgrid">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                ${notice("info", "This is required even if the report was a minor factor",
                  html`The notice will name <b>${agency.name}</b>, say that they did not make
                    the decision, and tell the applicant how to dispute the report and get a
                    free copy within 60 days. Those parts are written for you.`)}

                <div class="field" style="margin-top:1rem">
                  <label>Did a credit score come into it?</label>
                  <label style="display:flex;gap:0.5rem;align-items:center;font-weight:400">
                    <input type="radio" name="used_score" value="no" checked /> No
                  </label>
                  <label style="display:flex;gap:0.5rem;align-items:center;font-weight:400">
                    <input type="radio" name="used_score" value="yes" /> Yes — and then the law
                    requires it on the notice
                  </label>
                </div>

                <div class="formgrid formgrid--2">
                  <div class="field">
                    <label for="score">The score</label>
                    <input id="score" name="score" type="text" maxlength="20" placeholder="712" />
                  </div>
                  <div class="field">
                    <label for="score_source">Who supplied it</label>
                    <input id="score_source" name="score_source" type="text" maxlength="120"
                           value="${agency.name}" />
                  </div>
                  <div class="field">
                    <label for="score_date">Date on the report</label>
                    <input id="score_date" name="score_date" type="text" maxlength="40"
                           placeholder="${human(stamp().slice(0, 10))}" />
                  </div>
                  <div class="field">
                    <label for="score_range">Possible range</label>
                    <input id="score_range" name="score_range" type="text" maxlength="40"
                           placeholder="350 to 850" />
                  </div>
                </div>
                <div class="field">
                  <label for="score_factors">The key factors, most important first</label>
                  <textarea id="score_factors" name="score_factors" rows="3"
                    placeholder="Serious delinquency&#10;Length of time accounts have been established"></textarea>
                  <span class="field__help">One per line, copied from the report. They go on
                    the notice in the order you put them.</span>
                </div>
                <button class="pill solid sm" type="submit">Write the notice</button>
              </form>
            </div>` : ""}`}
      </div>
    </div>`;
}
