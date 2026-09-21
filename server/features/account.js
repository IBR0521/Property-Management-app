/* The signed-in user's own account.

   This existed as a gap rather than a feature: there was no way to change a
   password without running a script against the database, which is how a
   seeded credential survives long after it should have been replaced. */
import { one, run, all } from "../lib/db.js";
import { hashPassword, verifyPassword, SESSION_COOKIE } from "../lib/auth.js";
import { sendHtml, redirect, cookies } from "../lib/http.js";
import { html } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { check, clear, clientIp } from "../lib/ratelimit.js";

const MIN_LENGTH = 12;

export function registerAccount(router) {
  router.get("/app/account", async (ctx) => {
    const sessions = await all(
      "SELECT id, created_at, expires_at FROM session WHERE staff_id = ? ORDER BY created_at DESC",
      ctx.staff.id);
    const current = cookies(ctx.req)[SESSION_COOKIE];

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(ctx.staff.company_id),
      title: "Your account",
      subtitle: ctx.staff.email,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, decodeURIComponent(ctx.query.e)) : ""}

        <div class="panel" style="max-width:32rem">
          <div class="panel__head"><h2>Change your password</h2></div>
          <div class="panel__body">
            <form method="post" action="/app/account/password" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="current">Current password</label>
                <input id="current" name="current" type="password" required autocomplete="current-password" />
              </div>
              <div class="field">
                <label for="next">New password</label>
                <input id="next" name="next" type="password" required minlength="${MIN_LENGTH}" autocomplete="new-password" />
                <span class="field__help">At least ${MIN_LENGTH} characters. Longer beats complicated.</span>
              </div>
              <div class="field">
                <label for="confirm">New password again</label>
                <input id="confirm" name="confirm" type="password" required minlength="${MIN_LENGTH}" autocomplete="new-password" />
              </div>
              <button class="pill solid" type="submit">Change it</button>
              <span class="field__help">Every other device signed in as you will be signed out.</span>
            </form>
          </div>
        </div>

        <div class="panel" style="max-width:32rem">
          <div class="panel__head"><h2>Where you are signed in</h2><p>${sessions.length}</p></div>
          <div class="panel__body panel__body--flush">
            ${sessions.map((s) => html`
              <div class="minirow">
                <div class="minirow__main">
                  <b>${s.id === current ? "This device" : "Another device"}</b>
                  <span class="cellsub">signed in ${s.created_at.slice(0, 16).replace("T", " ")}</span>
                </div>
              </div>`)}
          </div>
          <div class="panel__body" style="border-top:1px solid var(--hairline)">
            <form method="post" action="/app/account/sign-out-others">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <button class="pill outline sm" type="submit">Sign out everywhere else</button>
            </form>
          </div>
        </div>`,
    }));
  });

  router.post("/app/account/password", async (ctx) => {
    const staff = await one("SELECT * FROM staff WHERE id = ?", ctx.staff.id);
    const fail = (m) => redirect(ctx.res, `/app/account?e=${encodeURIComponent(m)}`);

    /* Knowing the current password is the check that stops someone who found
       an unlocked laptop from taking the account permanently. Rate limited on
       the same basis as sign-in, since it is the same guess. */
    const gate = await check("signin", `${clientIp(ctx.req)}|${staff.email}`);
    if (!gate.allowed) return fail(`Too many attempts. Wait ${gate.retryAfterMinutes} minutes.`);

    if (!verifyPassword(String(ctx.fields.current || ""), staff.password_hash)) {
      return fail("That current password is not right.");
    }
    const next = String(ctx.fields.next || "");
    if (next.length < MIN_LENGTH) return fail(`Use at least ${MIN_LENGTH} characters.`);
    if (next !== String(ctx.fields.confirm || "")) return fail("The two new passwords do not match.");
    if (next === String(ctx.fields.current || "")) return fail("That is the password you already have.");

    await run("UPDATE staff SET password_hash = ? WHERE id = ?", hashPassword(next), staff.id);
    await clear("signin", `${clientIp(ctx.req)}|${staff.email}`);

    /* Any other session was established under the old password, so it should
       not survive the change. The current one is kept so the user is not
       bounced out of the page they are standing on. */
    const keep = cookies(ctx.req)[SESSION_COOKIE];
    await run("DELETE FROM session WHERE staff_id = ? AND id <> ?", staff.id, keep || "");

    redirect(ctx.res, `/app/account?m=${encodeURIComponent("Password changed. Other devices were signed out.")}`);
  });

  router.post("/app/account/sign-out-others", async (ctx) => {
    const keep = cookies(ctx.req)[SESSION_COOKIE];
    const r = await run("DELETE FROM session WHERE staff_id = ? AND id <> ?", ctx.staff.id, keep || "");
    redirect(ctx.res, `/app/account?m=${encodeURIComponent(`Signed out of ${r.changes} other session(s).`)}`);
  });
}
