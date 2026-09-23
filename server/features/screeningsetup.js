/* What a company decides about screening, once.

   Three things, and each is here because something downstream cannot work
   without it:

     the agency        an adverse action notice is *required* to name the
                       agency that supplied the report, with its address and
                       telephone number. Without them there is no lawful
                       notice, so consent cannot be taken either — the consent
                       wording names the agency too.

     retention         how long a report is kept after the decision. The
                       shortest useful number is the right one; the report
                       that is not there cannot leak.

     the template      the covering wording for the notice. The required
                       paragraphs are written for them and cannot be edited
                       away; this is what goes around them, and it needs a
                       solicitor before the first one is sent. */
import { get, one, run } from "../lib/db.js";
import { stamp } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { screeningSettings, saveScreeningSettings, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS }
  from "../lib/screening/settings.js";
import { PROVIDERS, PROVIDER_KEYS, provider } from "../lib/screening/providers.js";
import { STARTING_TEMPLATE, TEMPLATE_KEY, requiredNotice } from "../lib/screening/adverse.js";

export function registerScreeningSetup(router) {
  router.get("/app/setup/screening", async (ctx) => {
    sendHtml(ctx.res, await page(ctx));
  });

  router.post("/app/setup/screening", async (ctx) => {
    const cid = ctx.staff.company_id;
    await saveScreeningSettings(cid, {
      provider: String(ctx.fields.provider || ""),
      retentionDays: ctx.fields.retention_days,
      agency: {
        name: String(ctx.fields.agency_name || ""),
        address: String(ctx.fields.agency_address || ""),
        phone: String(ctx.fields.agency_phone || ""),
      },
    });
    redirect(ctx.res, `/app/setup/screening?m=${encodeURIComponent("Saved.")}`);
  });

  /* Puts the starting wording in place, unapproved. Separate from saving the
     settings because creating a legal document is not something to do as a
     side effect of changing a retention period. */
  router.post("/app/setup/screening/template", async (ctx) => {
    const cid = ctx.staff.company_id;
    const existing = await get(
      "SELECT * FROM notice_template WHERE company_id = ? AND key = ?", cid, TEMPLATE_KEY);
    if (existing) {
      return redirect(ctx.res, `/app/setup?m=${encodeURIComponent(
        "There is already an adverse action template. Edit it in Setup.")}`);
    }
    await run(
      `INSERT INTO notice_template (company_id, key, name, body) VALUES (?, ?, ?, ?)`,
      cid, TEMPLATE_KEY, "Adverse action notice", STARTING_TEMPLATE);
    redirect(ctx.res, `/app/setup?m=${encodeURIComponent(
      "Added, unapproved. It needs your solicitor before the first one can be sent.")}`);
  });
}

async function page(ctx) {
  const cid = ctx.staff.company_id;
  const company = await one("SELECT * FROM company WHERE id = ?", cid);
  const settings = await screeningSettings(cid);
  const template = await get(
    "SELECT * FROM notice_template WHERE company_id = ? AND key = ?", cid, TEMPLATE_KEY);

  /* Shown rather than described. Somebody deciding whether their wording is
     good enough should be able to see what is added to it. */
  const example = settings.agency.name
    ? requiredNotice({
        agency: settings.agency,
        score: { score: "712", source: settings.agency.name, date: "3 Mar 2026",
          range: "350 to 850", factors: "Serious delinquency\nToo many accounts with balances" },
      })
    : null;

  return appPage({
    staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
    title: "Screening",
    subtitle: "Consent, reports, the adverse action notice, and how long any of it is kept",
    body: html`
      ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

      <div class="panel">
        <div class="panel__head"><h2>How you screen</h2></div>
        <div class="panel__body">
          ${notice("info", "You bring your own screening account",
            html`This platform does not pull credit files and is not a reporting agency.
              Pulling one means credentialing with the bureau, an on-site inspection of your
              premises, and — for anybody in the middle — a reporting agency's own obligations
              toward every applicant.
              <br /><br />
              So you screen wherever you screen today, and everything the law asks of
              <b>you</b> lives here: the applicant's consent, what the report said, the
              decision, and the adverse action notice.`)}

          <form method="post" action="/app/setup/screening" class="formgrid" style="margin-top:1.25rem">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />

            <div class="field">
              <label for="provider">How reports are obtained</label>
              <select id="provider" name="provider" required>
                ${PROVIDER_KEYS.map((key) => html`
                  <option value="${key}"${attr("selected", settings.provider === key)}>${PROVIDERS[key].label}</option>`)}
              </select>
              <span class="field__help">${provider(settings.provider).summary}</span>
            </div>

            <div class="field">
              <label>The agency you use</label>
              <span class="field__help">An adverse action notice is required to name the agency
                that supplied the report, with its address and telephone number. Until these are
                here, consent cannot be taken and no notice can be written.</span>
            </div>
            <div class="formgrid formgrid--2">
              <div class="field">
                <label for="agency_name">Name</label>
                <input id="agency_name" name="agency_name" type="text" maxlength="120"
                       value="${settings.agency.name}" placeholder="TransUnion Rental Screening Solutions, Inc." />
              </div>
              <div class="field">
                <label for="agency_phone">Telephone</label>
                <input id="agency_phone" name="agency_phone" type="text" maxlength="40"
                       value="${settings.agency.phone}" placeholder="(833) 458-6338" />
              </div>
            </div>
            <div class="field">
              <label for="agency_address">Address</label>
              <input id="agency_address" name="agency_address" type="text" maxlength="200"
                     value="${settings.agency.address}"
                     placeholder="P.O. Box 800, Woodlyn, PA 19094" />
              <span class="field__help">Copy it from the report or the agency's own site. It is
                printed on the notice and the applicant may need to write to it.</span>
            </div>

            <div class="field">
              <label for="retention_days">Delete reports this many days after the decision</label>
              <input id="retention_days" name="retention_days" type="number" min="1"
                     max="${MAX_RETENTION_DAYS}" value="${settings.retentionDays}" required />
              <span class="field__help">A screening report holds somebody's credit file and
                possibly their criminal history. The shortest useful number is the right one;
                ${DEFAULT_RETENTION_DAYS} days covers the period a decision might be questioned.
                What is deleted is the report file. What it said, who consented, the decision and
                the notice all stay — those are what you would need if somebody asked.</span>
            </div>

            <button class="pill solid sm" type="submit">Save</button>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>The adverse action notice</h2>
          <p>Required when a report contributes to a decline — even as a minor factor</p>
        </div>
        <div class="panel__body">
          ${template
            ? template.approved_at
              ? notice("ok", "Approved",
                  html`By ${template.approved_by}, ${template.approved_at.slice(0, 10)}.
                    Edit it in <a href="/app/setup">Setup</a>.`)
              : notice("warn", "Not approved, so nothing can be sent",
                  html`An unapproved template is never sent, for the same reason an unapproved
                    eviction notice is not. Have it looked at, then approve it in
                    <a href="/app/setup">Setup</a>.`)
            : html`
              ${notice("warn", "There is no template yet",
                "Add the starting wording and have your solicitor look at it. It arrives "
                + "unapproved, and nothing can be sent until somebody approves it.")}
              <form method="post" action="/app/setup/screening/template" style="margin-top:1rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill solid sm" type="submit">Add the starting wording</button>
              </form>`}

          <p class="lede" style="margin-top:1.25rem">Whatever your wording says, these
            paragraphs are added to it and cannot be edited away — they are what the law
            requires, and they are built from the record rather than typed:</p>
          <div class="tablewrap"><table class="data"><tbody><tr><td>
            <pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:0.9em">${example
              || "Fill in the agency above and this will show you exactly what is added."}</pre>
          </td></tr></tbody></table></div>
          <span class="cellsub">The credit score paragraph appears only when you say a score
            came into the decision. That is the one place in this system a score is written
            down — there is no score field on an application, and there will not be one.</span>
        </div>
      </div>`,
  });
}
