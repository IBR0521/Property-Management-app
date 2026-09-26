/* F18  Platform administration.

   The operator's view across companies, and the support backdoor.

   Every other screen in this application is scoped by `company_id`, and the
   isolation test drives every route as one company holding another's ids to
   prove it. This file is the deliberate exception, which makes it the most
   dangerous code here. It is written accordingly.

   Access is one email address from the environment, not a role — a role is a
   column somebody can change, and this capability should not be grantable from
   inside the product.

   Impersonation is read-only, time-limited, logged where the customer can see
   it, and announced by a banner for its whole duration. It exists to answer
   "what does this look like from their side", which is a real and frequent
   support question, and not to act as somebody. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp } from "../lib/dates.js";
import { usd } from "../lib/money.js";
import { sendHtml, redirect, BadRequest, Forbidden } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { PLATFORM_OPERATOR_EMAIL } from "../lib/config.js";
import { clientIp } from "../lib/ratelimit.js";
import { log } from "../lib/logger.js";
import { describeStatus, monthlyCents, PER_DOOR_CENTS } from "../lib/plans.js";

/* A session may borrow a company's view for this long. Support conversations
   are minutes; anything still open after an hour is forgotten rather than
   in use. */
const MAX_MINUTES = 60;

export function isPlatformOperator(staff) {
  if (!PLATFORM_OPERATOR_EMAIL || !staff?.email) return false;
  return String(staff.email).toLowerCase() === PLATFORM_OPERATOR_EMAIL.toLowerCase();
}

/* Everything an impersonated session may not do, checked in the gate.

   Reading is the point. Writing is not — and the three exclusions below are
   the ones that would let support become the customer rather than observe
   them: taking over the account, removing the second factor, or spending
   their money. */
export function impersonationForbids(path, method) {
  if (method !== "GET") return "write";
  if (path.startsWith("/app/account")) return "account";
  if (path.startsWith("/app/billing")) return "billing";
  if (path.startsWith("/app/staff")) return "staff";
  return null;
}

export async function activeImpersonation(staff) {
  if (!staff?.impersonation_id) return null;
  const row = await get(
    "SELECT * FROM impersonation WHERE id = ? AND ended_at IS NULL", staff.impersonation_id);
  if (!row) return null;

  /* Expiry is enforced on read rather than by a sweep, so a forgotten session
     closes itself the next time it is used rather than whenever a cron runs. */
  const age = (Date.now() - new Date(row.started_at).getTime()) / 60000;
  if (age > MAX_MINUTES) {
    await run("UPDATE impersonation SET ended_at = ? WHERE id = ?", stamp(), row.id);
    return null;
  }
  return row;
}

export function registerPlatform(router) {
  /* Every route here checks the operator email itself. The capability gate is
     company-scoped by design and has no notion of somebody standing outside a
     company, so this one exception is explicit rather than folded into a model
     that would then have to express it for everything else. */
  const requireOperator = (ctx) => {
    if (!isPlatformOperator(ctx.staff)) {
      log.warn("platform area refused", { staffId: ctx.staff?.id, email: ctx.staff?.email });
      throw new Forbidden("That area is not part of your account.");
    }
  };

  router.get("/app/platform", async (ctx) => {
    requireOperator(ctx);

    const companies = await all(
      `SELECT c.*,
              (SELECT COUNT(*) FROM unit u WHERE u.company_id = c.id)::int AS units,
              (SELECT COUNT(*) FROM staff s WHERE s.company_id = c.id AND s.active = 1)::int AS staff,
              (SELECT COUNT(*) FROM work_order w WHERE w.company_id = c.id)::int AS work_orders,
              s.status AS sub_status, s.plan_key, s.trial_ends_at, s.current_period_end
         FROM company c
         LEFT JOIN subscription s ON s.company_id = c.id
        ORDER BY c.created_at DESC`);

    const open = await all(
      `SELECT i.*, c.name AS company_name FROM impersonation i
         JOIN company c ON c.id = i.company_id
        WHERE i.ended_at IS NULL ORDER BY i.started_at DESC`);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "platform", counts: await navCounts(ctx.staff.company_id),
      title: "Platform", subtitle: `${companies.length} compan${companies.length === 1 ? "y" : "ies"}`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${open.length ? notice("warn", `${open.length} impersonation session open`,
          html`${open.map((o) => html`${o.company_name} since ${humanStamp(o.started_at)}. `)}
               <a href="/app/platform/stop">End them</a>.`) : ""}

        <div class="panel"><div class="panel__body panel__body--flush">
          <div class="tablewrap"><table class="data">
            <thead><tr><th>Company</th><th class="num">Units</th><th class="num">Staff</th>
              <th>Subscription</th><th class="shrink"></th></tr></thead>
            <tbody>${companies.map((c) => {
              const status = describeStatus({
                status: c.sub_status || "none", trial_ends_at: c.trial_ends_at,
              });
              const bill = monthlyCents(c.units);
              return html`
              <tr>
                <td><b>${c.name}</b>
                  <span class="cellsub">/c/${c.slug} · joined ${human(c.created_at.slice(0, 10))}</span>
                  ${c.verified_at ? "" : html`<span class="cellsub" style="color:var(--warn)">email unverified</span>`}</td>
                <td class="num">${c.units}</td>
                <td class="num">${c.staff}</td>
                <td><span class="chip"${attr("data-tone", status.tone)}>${c.sub_status || "none"}</span>
                  ${c.units ? html`<span class="cellsub">${usd(PER_DOOR_CENTS)} × ${c.units} · ${usd(bill)} a month</span>` : ""}</td>
                <td class="shrink">
                  <a class="pill outline sm" href="/app/platform/c/${c.id}"
                  ${attr("aria-label", `Open ${c.name}`)}>Open</a>
                </td>
              </tr>`;
            })}</tbody>
          </table></div>
        </div></div>`,
    }));
  });

  router.get("/app/platform/c/:id", async (ctx) => {
    requireOperator(ctx);
    const company = await one("SELECT * FROM company WHERE id = ?", ctx.params.id);
    const people = await all(
      "SELECT id, name, email, role, active FROM staff WHERE company_id = ? ORDER BY active DESC, name",
      company.id);
    const history = await all(
      `SELECT * FROM impersonation WHERE company_id = ? ORDER BY started_at DESC LIMIT 20`, company.id);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "platform", counts: await navCounts(ctx.staff.company_id),
      title: company.name, subtitle: `/c/${company.slug}`,
      actions: html`<a class="pill outline sm" href="/app/platform">All companies</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <div class="panel">
          <div class="panel__head"><h2>Look at their account</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0 0 1rem">
              Borrows one person's view, read-only, for up to ${MAX_MINUTES} minutes. A banner
              is shown for the whole time, and it is written to an audit trail this company
              can read. You cannot change anything, touch billing, or alter an account —
              the point is to see what they see.
            </p>
            <form method="post" action="/app/platform/c/${company.id}/impersonate" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="staff_id">As</label>
                  <select id="staff_id" name="staff_id" required>
                    ${people.filter((p) => p.active).map((p) => html`
                      <option value="${p.id}">${p.name} (${p.role})</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="reason">Why</label>
                  <input id="reason" name="reason" type="text" required maxlength="160"
                         placeholder="Ticket 412 — statement totals look wrong" />
                  <span class="field__help">They will see this.</span>
                </div>
              </div>
              <button class="pill solid" type="submit">Start</button>
            </form>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Support access history</h2><p>${history.length}</p></div>
          <div class="panel__body panel__body--flush">
            ${history.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
              <thead><tr><th>When</th><th>Operator</th><th>Reason</th><th class="num">Pages</th></tr></thead>
              <tbody>${history.map((h) => html`
                <tr>
                  <td>${humanStamp(h.started_at)}<span class="cellsub">${h.ended_at ? `ended ${humanStamp(h.ended_at)}` : "open"}</span></td>
                  <td>${h.operator}</td>
                  <td>${h.reason}</td>
                  <td class="num">${h.pages_viewed}</td>
                </tr>`)}</tbody>
            </table></div>` : empty("Nobody has looked at this account.")}
          </div>
        </div>`,
    }));
  });

  router.post("/app/platform/c/:id/impersonate", async (ctx) => {
    requireOperator(ctx);
    const company = await one("SELECT * FROM company WHERE id = ?", ctx.params.id);
    const person = await one(
      "SELECT * FROM staff WHERE id = ? AND company_id = ? AND active = 1",
      String(ctx.fields.staff_id || ""), company.id);

    const reason = String(ctx.fields.reason || "").trim();
    if (reason.length < 4) throw new BadRequest("Record why. The customer can read it.");

    const impersonationId = id();
    await tx(async () => {
      await insert("impersonation", {
        id: impersonationId, company_id: company.id, staff_id: person.id,
        operator: ctx.staff.email, reason,
        started_at: stamp(), ip: clientIp(ctx.req) || null,
        user_agent: String(ctx.req.headers["user-agent"] || "").slice(0, 300),
        created_at: stamp(),
      });

      /* A separate session rather than mutating the operator's own: ending
         impersonation must not end their real sign-in, and the two must be
         distinguishable in the session table. */
      const { startSession } = await import("../lib/auth.js");
      const sid = await startSession(ctx.res, person.id, { secure: ctx.url.protocol === "https:" });
      await run("UPDATE session SET impersonation_id = ?, totp_at = ? WHERE id = ?",
        impersonationId, stamp(), sid);
    });

    log.warn("impersonation started", {
      operator: ctx.staff.email, companyId: company.id, staffId: person.id, reason,
    });
    redirect(ctx.res, "/app");
  });

  router.get("/app/platform/stop", async (ctx) => {
    /* A GET, because it is reached from the banner on every page and a form
       there would be a form on every page. It ends a session rather than
       changing data, which is the one class of state change a link may make. */
    const session = await activeImpersonation(ctx.staff);
    if (session) {
      await tx(async () => {
        await run("UPDATE impersonation SET ended_at = ? WHERE id = ?", stamp(), session.id);
        await run("DELETE FROM session WHERE impersonation_id = ?", session.id);
      });
      log.warn("impersonation ended", { impersonationId: session.id });
    }
    const { clearCookie } = await import("../lib/http.js");
    const { SESSION_COOKIE } = await import("../lib/auth.js");
    clearCookie(ctx.res, SESSION_COOKIE);
    redirect(ctx.res, "/app/sign-in?e=" + encodeURIComponent(
      "Support session ended. Sign in again to return to your own account."));
  });

  /* The company's own view of who has looked at their data. Deliberately not
     buried in the platform area: it is their record, not ours. */
  router.get("/app/company/access", async (ctx) => {
    const cid = ctx.staff.company_id;
    const history = await all(
      "SELECT * FROM impersonation WHERE company_id = ? ORDER BY started_at DESC LIMIT 50", cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "company", counts: await navCounts(cid),
      title: "Support access", subtitle: `${history.length} occasion${history.length === 1 ? "" : "s"}`,
      body: html`
        ${notice(null, "Every time we look at your account, it is recorded here",
          "Support can read your screens to answer a question. They cannot change anything, "
          + "see your password, or touch billing — and you can see exactly when, who and why.")}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${history.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>When</th><th>Who</th><th>Why</th><th class="num">Pages seen</th></tr></thead>
            <tbody>${history.map((h) => html`
              <tr>
                <td>${humanStamp(h.started_at)}
                  <span class="cellsub">${h.ended_at ? `for ${minutes(h)} min` : "still open"}</span></td>
                <td>${h.operator}</td>
                <td>${h.reason}</td>
                <td class="num">${h.pages_viewed}</td>
              </tr>`)}</tbody>
          </table></div>` : empty("Nobody has ever accessed your account.",
            "If support ever needs to, it will appear here.")}
        </div></div>`,
    }));
  });
}

function minutes(row) {
  if (!row.ended_at) return "—";
  return Math.max(1, Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 60000));
}
