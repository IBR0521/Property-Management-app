/* Issuing and revoking API keys.

   ## A key acts as the person who made it, and only as them

   There is no "who should hold this key" field, and its absence is the
   security property. If a manager could issue a key held by an administrator,
   the manager would be holding an administrator's credential — a privilege
   escalation with a form in front of it. Tying the holder to the issuer
   removes the question rather than answering it carefully.

   It also means a key dies with the person. Somebody leaves, their account is
   deactivated, and every key they made stops working in the same moment —
   which is what should happen and is otherwise the thing everybody forgets.

   ## Shown once, and this page does not redirect afterwards

   The usual post-then-redirect would have to carry the key somewhere: a query
   string puts a live credential in the browser's history and in our own
   access log, and a session flash is a copy of it we did not need to keep.
   So the POST renders the key itself, once, and says plainly that this is the
   only time. */
import { all, get, one } from "../lib/db.js";
import { stamp, human, humanStamp } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { roleLabel, can } from "../lib/auth.js";
import { SCOPES, SCOPE_NAMES } from "../lib/api/scopes.js";
import { issueKey, revokeKey, keysFor, effectiveScopes, RATE } from "../lib/api/keys.js";
import { API_PREFIX } from "./api.js";

export function registerApiKeys(router) {
  router.get("/app/setup/api", async (ctx) => {
    sendHtml(ctx.res, await page(ctx, {}));
  });

  router.post("/app/setup/api", async (ctx) => {
    const cid = ctx.staff.company_id;
    const name = String(ctx.fields.name || "").trim();
    const scopes = [].concat(ctx.fields.scopes || []).filter((s) => SCOPES[s]);

    if (!name) {
      return sendHtml(ctx.res, await page(ctx, {
        error: "A key needs a name, so you can tell it from the next one." }));
    }
    if (!scopes.length) {
      return sendHtml(ctx.res, await page(ctx, {
        error: "Choose at least one thing the key may do. A key with no scopes can do nothing." }));
    }

    /* The holder is the person issuing it, always. See the header. */
    const { key, record } = await issueKey({
      companyId: cid, staffId: ctx.staff.id, name, scopes,
      createdBy: ctx.staff.id,
    });

    ctx.log.info("api key issued", { keyId: record.id, scopes });
    sendHtml(ctx.res, await page(ctx, { issued: { key, record } }));
  });

  router.post("/app/setup/api/:id/revoke", async (ctx) => {
    const cid = ctx.staff.company_id;
    await revokeKey({ companyId: cid, keyId: ctx.params.id, by: ctx.staff.id });
    ctx.log.info("api key revoked", { keyId: ctx.params.id });
    redirect(ctx.res, `/app/setup/api?m=${encodeURIComponent(
      "Revoked. Any request using it now gets a 401.")}`);
  });
}

async function page(ctx, { issued = null, error = null }) {
  const cid = ctx.staff.company_id;
  const keys = await keysFor(cid);
  const recent = await all(
    `SELECT r.*, k.name AS key_name FROM api_request r
       LEFT JOIN api_key k ON k.id = r.key_id
      WHERE r.company_id = ? ORDER BY r.at DESC LIMIT 20`, cid);

  /* What each key can do *today*, which is not always what it was given.
     A key issued by somebody who has since been moved to a leasing account
     carries scopes its holder can no longer back, and saying so here is far
     better than it failing at three in the morning. */
  const holders = new Map();
  for (const k of keys) {
    if (!holders.has(k.staff_id)) {
      holders.set(k.staff_id, await get("SELECT * FROM staff WHERE id = ?", k.staff_id));
    }
  }

  return appPage({
    staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
    title: "API keys",
    subtitle: `For integrations. ${RATE.perHour.toLocaleString()} calls an hour per key.`,
    body: html`
      ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
      ${error ? notice("danger", "Nothing was created", error) : ""}

      ${issued ? html`
        <div class="panel">
          <div class="panel__head"><h2>Your new key</h2>
            <p>This is the only time it is shown</p>
          </div>
          <div class="panel__body">
            ${notice("warn", "Copy it now",
              html`We store a hash of this key and not the key. There is no way to show it
                again — if it is lost, revoke it and make another. If it leaks, revoke it;
                that takes effect on the next request.`)}
            <div class="tablewrap" style="margin-top:1rem"><table class="data">
              <tbody><tr><td style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${issued.key}</td></tr></tbody>
            </table></div>
            <p class="lede" style="margin-top:0.75rem">Send it as a header:</p>
            <div class="tablewrap"><table class="data"><tbody><tr><td
              style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">Authorization: Bearer ${issued.key.slice(0, 12)}…</td>
            </tr></tbody></table></div>
          </div>
        </div>` : ""}

      <div class="panel">
        <div class="panel__head"><h2>Make a key</h2>
          <p>It acts as you, and never as more than you</p>
        </div>
        <div class="panel__body">
          ${notice("info", "What a key can do",
            html`A key can do what <b>you</b> can do, and less — the scopes you tick, narrowed
              by your own role every time it is used. Changing your role changes your keys in
              the same moment, and deactivating your account stops them.
              <br /><br />
              That is also why there is no "who holds this" field: a key held by somebody with
              more access than the person making it would be a way to borrow their account.`)}

          <form method="post" action="/app/setup/api" class="formgrid" style="margin-top:1.25rem">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />
            <div class="field">
              <label for="name">What is it for</label>
              <input id="name" name="name" type="text" required maxlength="80"
                     placeholder="Zapier — new work orders" />
              <span class="field__help">You will be reading this in a year, deciding whether
                it is still needed.</span>
            </div>

            <div class="field">
              <label>What it may do</label>
              ${SCOPE_NAMES.map((scope) => {
                const held = can(ctx.staff, SCOPES[scope].capability);
                return html`
                  <label style="display:flex;gap:0.5rem;align-items:flex-start;margin:0.35rem 0;font-weight:400">
                    <input type="checkbox" name="scopes" value="${scope}"${attr("disabled", !held)} />
                    <span>
                      <code>${scope}</code> — ${SCOPES[scope].describes}
                      ${held ? "" : html`<span class="cellsub" style="color:var(--danger)">Your
                        ${roleLabel(ctx.staff.role).toLowerCase()} account does not have this,
                        so a key of yours cannot either.</span>`}
                    </span>
                  </label>`;
              })}
            </div>

            <button class="pill solid sm" type="submit">Create key</button>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Keys</h2>
          <p><a href="${API_PREFIX}/openapi.json">The specification</a> — it needs a key too</p>
        </div>
        <div class="panel__body panel__body--flush">
          ${keys.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>Name</th><th>Holder</th><th>May do</th><th>Used</th><th class="num">Calls</th><th class="shrink"></th></tr></thead>
            <tbody>${keys.map((k) => {
              const holder = holders.get(k.staff_id);
              const live = holder ? effectiveScopes(k, holder) : [];
              const lost = k.scopes.filter((s) => !live.includes(s));
              return html`
                <tr${attr("style", k.revoked_at ? "opacity:0.55" : null)}>
                  <td>${k.name}
                    <span class="cellsub">…${k.hint} · made ${human(String(k.created_at).slice(0, 10))}</span></td>
                  <td>${k.staff_name}
                    <span class="cellsub">${roleLabel(k.staff_role)}${k.staff_active ? "" : " · deactivated"}</span></td>
                  <td>${k.revoked_at
                    ? html`<span class="chip" data-tone="danger">revoked</span>`
                    : html`${live.map((s) => html`<span class="chip chip--plain">${s}</span> `)}
                        ${lost.length ? html`<span class="cellsub" style="color:var(--warn,#8a6d00)">
                          ${lost.join(", ")} — asked for, but ${k.staff_name}'s role no longer
                          carries it, so the key cannot use it.</span>` : ""}`}</td>
                  <td>${k.last_used_at ? humanStamp(k.last_used_at) : html`<span class="cellsub">never</span>`}</td>
                  <td class="num">${Number(k.calls).toLocaleString()}</td>
                  <td class="shrink">${k.revoked_at ? "" : html`
                    <form method="post" action="/app/setup/api/${k.id}/revoke">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <button class="pill outline sm" type="submit">Revoke</button>
                    </form>`}</td>
                </tr>`;
            })}</tbody>
          </table></div>` : empty("No keys yet",
            "Make one above. Nothing can reach the API without one.")}
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Recent calls</h2>
          <p>The route and the outcome — never the body</p>
        </div>
        <div class="panel__body panel__body--flush">
          ${recent.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>When</th><th>Key</th><th>Request</th><th class="shrink">Answer</th><th class="num">ms</th></tr></thead>
            <tbody>${recent.map((r) => html`
              <tr>
                <td class="shrink">${humanStamp(r.at)}</td>
                <td class="shrink">${r.key_name || html`<span class="cellsub">deleted</span>`}</td>
                <td><code>${r.method} ${r.route}</code></td>
                <td class="shrink"><span class="chip"${attr("data-tone",
                  r.status < 300 ? "ok" : r.status < 500 ? "warn" : "danger")}>${r.status}</span></td>
                <td class="num">${r.ms ?? ""}</td>
              </tr>`)}</tbody>
          </table></div>` : empty("Nothing has called yet",
            "Every request shows up here — what was asked for and what it answered, "
            + "so “did it work” is a question you can settle yourself.")}
        </div>
      </div>`,
  });
}
