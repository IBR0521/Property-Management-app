/* F16  Company settings.

   Most of these columns have existed for a while and nothing has ever written
   to them. `timezone` has been on the table since 001 and every date in the
   app is still computed in the server's zone. `from_email` and its siblings
   arrived with the delivery work and were read by nothing until the outbox was
   rewritten. `legal_name` and `slug` arrived with multi-tenancy.

   They are gathered here rather than scattered through Setup because they are
   one idea — who this company is, to the outside world. A lease says the legal
   name, a statement carries the logo, an email comes from the sending address,
   and a tenant's rent is due on a date in their building's timezone rather
   than in the server's. */
import { all, get, one, update } from "../lib/db.js";
import { stamp, human } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { slugProblem, uniqueSlug } from "../lib/slug.js";
import { storeUpload, fileUrl, IMAGE_TYPES } from "../lib/files.js";
import { senderFor } from "../lib/outbox.js";
import { hasSecondFactor } from "../lib/auth.js";
import { COMMON_ZONES, isValidZone, nowInZone } from "../lib/timezone.js";

const CURRENCIES = ["USD", "CAD", "GBP", "EUR", "AUD", "NZD"];

export function registerCompany(router) {
  router.get("/app/company", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const sender = await senderFor(cid, "email");
    const origin = `${ctx.url.protocol}//${ctx.url.host}`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "company", counts: await navCounts(cid),
      title: "Company", subtitle: company.legal_name || company.name,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${company.verified_at ? "" : notice("warn", "Email not confirmed yet",
          html`Until it is, nothing is sent to your owners or tenants.
               <form method="post" action="/app/verify/resend" style="display:inline">
                 <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                 <button class="pill outline sm" type="submit" style="margin-left:0.5rem">Send it again</button>
               </form>`)}

        <form method="post" action="/app/company" enctype="multipart/form-data">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />

          <div class="panel">
            <div class="panel__head"><h2>Who you are</h2></div>
            <div class="panel__body">
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="name">Trading name</label>
                  <input id="name" name="name" type="text" required maxlength="120" value="${company.name}" />
                  <span class="field__help">What tenants and owners call you.</span>
                </div>
                <div class="field">
                  <label for="legal_name">Legal name</label>
                  <input id="legal_name" name="legal_name" type="text" maxlength="160"
                         value="${company.legal_name || ""}" />
                  <span class="field__help">Goes on leases and 1099s. Often different, and the one that matters legally.</span>
                </div>
              </div>

              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="phone">Phone</label>
                  <input id="phone" name="phone" type="tel" value="${company.phone || ""}" />
                  <span class="field__help">Your ordinary number, on statements and the
                    foot of every page a tenant or owner sees.</span>
                </div>
                <div class="field">
                  <label for="emergency_phone">Emergency number</label>
                  <input id="emergency_phone" name="emergency_phone" type="tel"
                         value="${company.emergency_phone || ""}" />
                  <span class="field__help">Shown to a tenant on the stop card when something is flooding.</span>
                </div>
              </div>

              <div class="field">
                <label for="address">Address</label>
                <input id="address" name="address" type="text" maxlength="240" value="${company.address || ""}" />
                <span class="field__help">Where post reaches you. It goes on leases and on
                  notices, so it wants to be the address you would accept mail at.</span>
              </div>
              <div class="field">
                <label for="website">Website</label>
                <input id="website" name="website" type="url" maxlength="240" value="${company.website || ""}" />
                <span class="field__help">Optional. Linked from your public listings page.</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Your web address</h2></div>
            <div class="panel__body">
              <div class="field">
                <label for="slug">Handle</label>
                <input id="slug" name="slug" type="text" maxlength="48" value="${company.slug}" />
                <span class="field__help">
                  Tenants and applicants reach you at
                  <code>${origin}/c/${company.slug}/report</code>.
                  Changing it breaks any link already printed or bookmarked, including QR
                  stickers that use the long form — so change it early or not at all.
                </span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Branding</h2></div>
            <div class="panel__body">
              ${company.logo_path ? html`
                <div style="margin-bottom:1rem">
                  <img src="${fileUrl({ path: company.logo_path })}" alt="${company.name}"
                       style="max-height:4rem;max-width:14rem" />
                </div>` : ""}
              <div class="field">
                <label for="logo">Logo</label>
                <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" />
                <span class="field__help">Appears on statements, notices and the pages tenants see.</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Where your mail comes from</h2></div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 1rem">
                Mail goes out as you, not as the platform. Set an address on a domain you
                control and authenticate it with SPF and DKIM, or notices land in spam.
              </p>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="from_name">Sender name</label>
                  <input id="from_name" name="from_name" type="text" maxlength="120"
                         value="${company.from_name || ""}" placeholder="${company.name}" />
                </div>
                <div class="field">
                  <label for="from_email">Sender address</label>
                  <input id="from_email" name="from_email" type="email" maxlength="160"
                         value="${company.from_email || ""}" placeholder="notices@yourdomain.com" />
                </div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="reply_to">Replies go to</label>
                  <input id="reply_to" name="reply_to" type="email" maxlength="160"
                         value="${company.reply_to || ""}" />
                  <span class="field__help">Otherwise a tenant's reply reaches nobody.</span>
                </div>
                <div class="field">
                  <label for="sms_from">Text messages from</label>
                  <input id="sms_from" name="sms_from" type="tel" maxlength="24"
                         value="${company.sms_from || ""}" placeholder="+1…" />
                  <span class="field__help">Needs carrier registration before it will deliver in the US.</span>
                </div>
              </div>
              <span class="field__help" style="display:block">
                Currently sending as <b>${sender.from || "not configured"}</b>.
              </span>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Dates and money</h2></div>
            <div class="panel__body">
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="timezone">Timezone</label>
                  <select id="timezone" name="timezone">
                    ${COMMON_ZONES.map((z) => html`
                      <option value="${z}"${attr("selected", company.timezone === z)}>${z.replace(/_/g, " ")}</option>`)}
                  </select>
                  <span class="field__help">
                    Rent is due on a calendar date where the building is, not where the
                    server is. It is ${nowInZone(company.timezone)} for you now.
                  </span>
                </div>
                <div class="field">
                  <label for="currency">Currency</label>
                  <select id="currency" name="currency">
                    ${CURRENCIES.map((c) => html`
                      <option value="${c}"${attr("selected", company.currency === c)}>${c}</option>`)}
                  </select>
                </div>
              </div>

              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="open">Office opens</label>
                  <input id="open" name="business_open" type="time"
                         value="${minutesToTime(company.business_open_minute)}" />
                </div>
                <div class="field">
                  <label for="close">Office closes</label>
                  <input id="close" name="business_close" type="time"
                         value="${minutesToTime(company.business_close_minute)}" />
                </div>
              </div>
              <span class="field__help" style="display:block">
                Used to decide whether "call the office" is advice or a dead end.
              </span>
            </div>
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">Save</button>
          </div>
        </form>

        <div class="panel">
          <div class="panel__head"><h2>Security</h2></div>
          <div class="panel__body">
            <form method="post" action="/app/company/require-2fa" class="filterbar" style="padding:0;border:0">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">
                  Two-factor authentication
                </span>
                <div class="radioset">
                  <label class="radiotile">
                    <input type="radio" name="require" value="no"${attr("checked", !company.require_2fa)} />
                    <span>Optional<small>Each person chooses.</small></span>
                  </label>
                  <label class="radiotile">
                    <input type="radio" name="require" value="yes"${attr("checked", company.require_2fa)} />
                    <span>Required for everyone<small>Staff set it up next time they sign in.</small></span>
                  </label>
                </div>
              </div>
              <button class="pill outline sm" type="submit">Save</button>
            </form>
            ${company.require_2fa || hasSecondFactor(ctx.staff) ? "" : html`
              <span class="field__help" style="display:block;margin-top:0.75rem">
                You have not set it up yourself yet, so requiring it would lock you out on the
                next request. <a href="/app/account/2fa">Set it up first</a>.
              </span>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <h2>Let someone look</h2>
            <p>A support session is read-only, and you can end it.</p>
          </div>
          <div class="panel__foot">
            <a class="pill outline sm" href="/app/company/access">Support access</a>
          </div>
        </div>`,
    }));
  });

  router.post("/app/company", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const f = ctx.fields;
    const back = (m) => redirect(ctx.res, `/app/company?m=${encodeURIComponent(m)}`);

    const name = String(f.name || "").trim();
    if (name.length < 2) return back("A company needs a name.");

    /* The handle is in printed QR stickers and bookmarked links, so a change
       is accepted but never silently: the caller is told what it costs. */
    let slug = company.slug;
    const wanted = String(f.slug || "").trim().toLowerCase();
    let slugNote = "";
    if (wanted && wanted !== company.slug) {
      const problem = slugProblem(wanted);
      if (problem) return back(problem);
      const taken = await get("SELECT id FROM company WHERE slug = ? AND id <> ?", wanted, cid);
      if (taken) return back(`"${wanted}" is already taken by another company.`);
      slug = wanted;
      slugNote = " Your web address changed — links printed with the old one no longer work.";
    }

    const timezone = isValidZone(f.timezone) ? String(f.timezone) : company.timezone;

    let logoPath = company.logo_path;
    const upload = (ctx.files || []).find((file) => file.field === "logo" && file.size > 0);
    if (upload) {
      const stored = await storeUpload(upload, { allow: IMAGE_TYPES });
      if (!stored.ok) return back(stored.problem || "That file is not an image we can use.");
      logoPath = stored.path;
    }

    await update("company", cid, {
      name,
      legal_name: String(f.legal_name || "").trim() || null,
      phone: String(f.phone || "").trim() || null,
      emergency_phone: String(f.emergency_phone || "").trim() || null,
      address: String(f.address || "").trim() || null,
      website: String(f.website || "").trim() || null,
      slug,
      logo_path: logoPath,
      from_name: String(f.from_name || "").trim() || null,
      from_email: String(f.from_email || "").trim().toLowerCase() || null,
      reply_to: String(f.reply_to || "").trim().toLowerCase() || null,
      sms_from: String(f.sms_from || "").trim() || null,
      timezone,
      currency: CURRENCIES.includes(f.currency) ? f.currency : company.currency,
      business_open_minute: timeToMinutes(f.business_open, company.business_open_minute),
      business_close_minute: timeToMinutes(f.business_close, company.business_close_minute),
    });

    back("Saved." + slugNote);
  });
}

/* --- shared --------------------------------------------------------------- */

function minutesToTime(minutes) {
  const m = Number(minutes || 0);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function timeToMinutes(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1439 ? minutes : fallback;
}
