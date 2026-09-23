/* Staff sign-in. */
import { get } from "../lib/db.js";
import { verifyPassword, startSession, endSession, staffByEmail, hasSecondFactor, landingFor } from "../lib/auth.js";
import { sendHtml, redirect } from "../lib/http.js";
import { check, clear, clientIp } from "../lib/ratelimit.js";
import { signInPage, publicPage, notice } from "../views/layout.js";
import { html, attr } from "../lib/render.js";

export function registerAuthRoutes(router) {
  router.get("/app/sign-in", async (ctx) => {
    if (ctx.staff) return redirect(ctx.res, landingFor(ctx.staff));
    /* Branding only. With several companies there is no way to know whose
       sign-in page this is until credentials arrive, so it shows the product
       rather than guessing a customer's name at them. */
    const { soleCompany } = await import("../lib/tenancy.js");
    const company = await soleCompany();
    sendHtml(ctx.res, signInPage({
      company,
      csrf: ctx.csrf,
      next: typeof ctx.query.next === "string" && ctx.query.next.startsWith("/app") ? ctx.query.next : null,
      error: ctx.query.e ? decodeURIComponent(ctx.query.e) : null,
    }));
  });

  router.post("/app/sign-in", async (ctx) => {
    const email = String(ctx.fields.email || "").trim().toLowerCase();
    const password = String(ctx.fields.password || "");

    /* Without this a password is simply brute-forceable. Keyed on address AND
       email so one noisy client cannot lock a colleague out, and so trying a
       thousand passwords against one account is what actually gets stopped. */
    const gate = await check("signin", `${clientIp(ctx.req)}|${email}`);
    if (!gate.allowed) {
      return redirect(ctx.res, `/app/sign-in?e=${encodeURIComponent(
        `Too many attempts. Wait ${gate.retryAfterMinutes} minutes and try again.`)}`);
    }
    /* Every company this address works for, not whichever row came back
       first. staff is unique on (company_id, email), so the same person may
       legitimately be staff at two management firms — and picking one
       arbitrarily is the same bug the public pages had. */
    const candidates = await staffByEmail(email);

    /* The password is checked against every candidate before any decision is
       made, so the time taken does not reveal how many companies an address
       belongs to. */
    const matched = [];
    for (const row of candidates) {
      if (verifyPassword(password, row.password_hash)) matched.push(row);
    }

    // One message for both cases: a different error for "no such user" tells
    // an attacker which addresses exist.
    if (matched.length === 0) {
      return redirect(ctx.res, `/app/sign-in?e=${encodeURIComponent("That email and password do not match.")}`);
    }

    // A legitimate user who fumbled the password should not stay throttled.
    await clear("signin", `${clientIp(ctx.req)}|${email}`);

    let staff = matched[0];

    if (matched.length > 1) {
      /* The same credentials at two companies. Asking is the only honest
         answer — signing them into one and hoping is how somebody files a
         work order against the wrong portfolio. */
      const chosen = String(ctx.fields.company_id || "");
      const pick = matched.find((m) => m.company_id === chosen);
      if (!pick) {
        return sendHtml(ctx.res, chooseCompanyPage({
          csrf: ctx.csrf, email, password, next: ctx.fields.next,
          companies: matched.map((m) => ({ id: m.company_id, name: m.company_name })),
        }));
      }
      staff = pick;
    }

    await startSession(ctx.res, staff.id, { secure: ctx.url.protocol === "https:" });

    const next = typeof ctx.fields.next === "string" && ctx.fields.next.startsWith("/app")
      ? ctx.fields.next
      : landingFor(staff);
    /* The session exists but is only half authenticated. The gate in app.js
       sends them to the challenge; passing `next` through means they land
       where they were going once it is answered. */
    if (hasSecondFactor(staff)) {
      return redirect(ctx.res, `/app/2fa?next=${encodeURIComponent(next)}`);
    }
    redirect(ctx.res, next);
  });

  router.post("/app/sign-out", async (ctx) => {
    await endSession(ctx.req, ctx.res);
    redirect(ctx.res, "/app/sign-in");
  });
}

/* Shown when one address and password open more than one company. Names only
   the companies this person actually belongs to — it is not a directory. */
function chooseCompanyPage({ csrf, email, password, next, companies }) {
  return publicPage({
    company: null,
    title: "Which company?",
    heading: "Which company?",
    lede: "Your details work for more than one. Pick the one you are signing in to.",
    body: html`
      <div class="panel">
        <div class="panel__body">
          <form method="post" action="/app/sign-in" class="formgrid">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <input type="hidden" name="email" value="${email}" />
            <input type="hidden" name="password" value="${password}" />
            ${next ? html`<input type="hidden" name="next" value="${next}" />` : ""}
            <div class="field">
              <div class="radioset">
                ${companies.map((c, i) => html`
                  <label class="radiotile">
                    <input type="radio" name="company_id" value="${c.id}"${attr("checked", i === 0)} required />
                    <span>${c.name}</span>
                  </label>`)}
              </div>
            </div>
            <button class="pill solid" type="submit">Continue</button>
          </form>
        </div>
      </div>`,
  });
}
