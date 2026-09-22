/* Turning notifications on, and off.

   Subscribing needs JavaScript — `pushManager.subscribe()` has no HTML
   equivalent — so the enable button is the one control in this application
   that a browser without scripting cannot use. Everything else here is a
   plain form: the list of devices, and removing one. That split is
   deliberate. Turning notifications *on* is a convenience; turning them
   *off*, and seeing what is listening, must never depend on a script loading.

   The routes are duplicated for staff and for portal people rather than
   shared, because the two have different actors and different session checks,
   and a single handler taking "whoever is signed in" is how a tenant ends up
   subscribed against a staff id. */
import { all, get, run } from "../lib/db.js";
import { sendJson, sendText, redirect } from "../lib/http.js";
import { html, attr, raw } from "../lib/render.js";
import { notice } from "../views/layout.js";
import { humanStamp } from "../lib/dates.js";
import {
  subscribe, unsubscribe, publicKey, PUSH_CONFIGURED,
} from "../lib/push/index.js";

export function registerPush(router) {
  /* Public, and public on purpose: the VAPID public key is handed to every
     browser that subscribes. It is an identifier, not a credential. The
     service worker reads it from here rather than being told it, so there is
     one copy. */
  router.get("/push/key", async (ctx) => {
    sendJson(ctx.res, { configured: PUSH_CONFIGURED, key: publicKey() });
  });

  /* --- staff --- */

  router.post("/app/push/subscribe", async (ctx) => {
    const res = await subscribe({
      companyId: ctx.staff.company_id,
      staffId: ctx.staff.id,
      subscription: ctx.fields.subscription,
      userAgent: ctx.req.headers["user-agent"],
    });
    sendJson(ctx.res, res, res.ok ? 200 : 400);
  });

  router.post("/app/push/remove", async (ctx) => {
    await removeOwned(ctx.fields.id, "staff_id", ctx.staff.id);
    redirect(ctx.res, "/app/account?m=That+device+will+no+longer+be+notified.");
  });

  /* --- portal --- */

  router.post("/portal/push/subscribe", async (ctx) => {
    const res = await subscribe({
      companyId: ctx.person.companyId,
      personId: ctx.person.personId,
      subscription: ctx.fields.subscription,
      userAgent: ctx.req.headers["user-agent"],
    });
    sendJson(ctx.res, res, res.ok ? 200 : 400);
  });

  router.post("/portal/push/remove", async (ctx) => {
    await removeOwned(ctx.fields.id, "person_id", ctx.person.personId);
    redirect(ctx.res, "/portal/details?m=That+device+will+no+longer+be+notified.");
  });
}

/* Scoped to the actor in the same statement that deletes, rather than fetched,
   checked and then deleted. The two-step version is a race and it is also one
   forgotten `if` away from letting anybody unsubscribe anybody. */
async function removeOwned(id, column, actorId) {
  await run(
    `DELETE FROM push_subscription WHERE id = ? AND ${column} = ?`,
    String(id || ""), actorId);
}

/* --- the panel, shared by both settings pages ------------------------------
 *
 * Rendered with the furniture every other panel uses. The only additions are
 * data attributes, which the script reads; there is no new styling here. */
/* `configured` is a parameter rather than read straight from the module so
   the off state — the one every deployment starts in — can be rendered and
   checked. It is the state most likely to be wrong and the least likely to
   be looked at. */
/* The enable button starts hidden by an inline style rather than by the
   `hidden` attribute.

   `.pill` sets `display:inline-flex`, which beats the browser's own
   `[hidden] { display: none }` — the stylesheet has no `[hidden]` rule of its
   own to restore it — so the attribute is inert on every pill in this
   application. With it, the page printed "notifications are blocked for this
   site" directly above a button offering to turn them on. Found by looking at
   the rendered page, which is the only way it could have been found. */
const HIDDEN = raw("display:none;margin-top:.75rem");

export async function notificationsPanel({
  csrf, staffId = null, personId = null, base, configured = PUSH_CONFIGURED,
}) {
  const devices = staffId
    ? await all("SELECT * FROM push_subscription WHERE staff_id = ? ORDER BY created_at", staffId)
    : await all("SELECT * FROM push_subscription WHERE person_id = ? ORDER BY created_at", personId);

  /* The delivery-honesty rule, applied to a feature rather than a message: if
     the keys are not set, say that, rather than showing a button that would
     subscribe a device nothing can ever send to. */
  if (!configured) {
    return html`
      <div class="panel" style="max-width:32rem">
        <div class="panel__head"><h2>Notifications</h2></div>
        <div class="panel__body">
          ${notice("warn", "Not switched on yet",
            "This application has not been given the keys it needs to send notifications, so there is nothing to turn on here yet.")}
        </div>
      </div>`;
  }

  return html`
    <div class="panel" style="max-width:32rem">
      <div class="panel__head"><h2>Notifications</h2><p>${devices.length}</p></div>

      ${devices.length ? html`
        <div class="panel__body panel__body--flush">
          ${devices.map((d) => html`
            <div class="minirow">
              <div class="minirow__main">
                <b>${d.label || "A device"}</b>
                <span class="cellsub">added ${humanStamp(d.created_at)}</span>
              </div>
              <form method="post" action="${base}/remove">
                <input type="hidden" name="_csrf" value="${csrf}" />
                <input type="hidden" name="id" value="${d.id}" />
                <button class="pill outline sm" type="submit">Stop</button>
              </form>
            </div>`)}
        </div>` : ""}

      <div class="panel__body"${attr("style", devices.length ? "border-top:1px solid var(--hairline)" : null)}>
        <div data-push${attr("data-key", publicKey())}${attr("data-csrf", csrf)}${attr("data-base", base)}>
          <p class="field__help" data-push-state>
            Turning notifications on needs JavaScript, and this browser has it switched off.
            Everything else on this page works without it.
          </p>
          <button class="pill solid" type="button" data-push-enable style="${HIDDEN}">
            Turn on for this device
          </button>
        </div>
        <p class="field__help" style="margin-top:.75rem">
          A notification says that something happened and never what. No amount,
          no balance, no name and no address — it is read on a lock screen, by
          whoever is holding the phone.
        </p>
      </div>
    </div>`;
}
