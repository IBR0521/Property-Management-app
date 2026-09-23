/* Webhook endpoints: adding them, watching them, and seeing what was sent.

   ## The delivery log is the feature

   "Did you send it" is the first question every integration asks, and the
   only answer worth having is a record. So this screen leads with what was
   attempted, what came back, and why anything stopped — rather than with a
   form. A customer should be able to settle an argument with their own
   integrator without opening a ticket.

   ## The secret is shown once

   Same reason as an API key: "we can show it to you again" means "we have
   it". The POST renders the secret rather than redirecting, so it is never
   in a URL, a browser history or our access log. */
import { all, get, one, insert, run } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, humanStamp, human } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { EVENTS, EVENT_NAMES, parseEvents } from "../lib/webhooks/events.js";
import { newSecret, checkUrl } from "../lib/webhooks/sign.js";
import { BACKOFF, DISABLE_AFTER, attempt } from "../lib/webhooks/send.js";

export function registerWebhooks(router) {
  router.get("/app/setup/webhooks", async (ctx) => {
    sendHtml(ctx.res, await page(ctx, {}));
  });

  router.post("/app/setup/webhooks", async (ctx) => {
    const cid = ctx.staff.company_id;
    const url = String(ctx.fields.url || "").trim();
    const events = [].concat(ctx.fields.events || []).filter((e) => EVENTS[e]);
    const description = String(ctx.fields.description || "").trim() || null;

    const shape = checkUrl(url);
    if (!shape.ok) return sendHtml(ctx.res, await page(ctx, { error: shape.reason }));

    const secret = newSecret();
    const endpointId = id();
    await insert("webhook_endpoint", {
      id: endpointId, company_id: cid,
      url: shape.url.toString(), secret, description,
      events: JSON.stringify(events),
      active: 1, created_by: ctx.staff.id, created_at: stamp(),
    });

    ctx.log.info("webhook endpoint added", { endpointId, events: events.length });
    sendHtml(ctx.res, await page(ctx, { issued: { secret, url: shape.url.toString() } }));
  });

  router.post("/app/setup/webhooks/:id/delete", async (ctx) => {
    const cid = ctx.staff.company_id;
    const endpoint = await one(
      "SELECT * FROM webhook_endpoint WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    await run("DELETE FROM webhook_endpoint WHERE id = ?", endpoint.id);
    redirect(ctx.res, `/app/setup/webhooks?m=${encodeURIComponent(
      "Removed. Anything still queued for it has gone with it.")}`);
  });

  router.post("/app/setup/webhooks/:id/enable", async (ctx) => {
    const cid = ctx.staff.company_id;
    const endpoint = await one(
      "SELECT * FROM webhook_endpoint WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    await run(
      `UPDATE webhook_endpoint
          SET active = 1, disabled_at = NULL, disabled_why = NULL, consecutive_failures = 0
        WHERE id = ?`, endpoint.id);
    redirect(ctx.res, `/app/setup/webhooks?m=${encodeURIComponent("Back on.")}`);
  });

  /* Sending one again, by hand.

     Not a new delivery: the same row, the same id, the same body. A retry
     that made a fresh delivery would arrive at a receiver that de-duplicates
     on id as something new, which is the opposite of what the person
     clicking this wants. */
  router.post("/app/setup/webhooks/delivery/:id/retry", async (ctx) => {
    const cid = ctx.staff.company_id;
    const delivery = await one(
      "SELECT * FROM webhook_delivery WHERE id = ? AND company_id = ?", ctx.params.id, cid);

    const result = await attempt({ ...delivery, attempts: 0 });
    const message = result.status === "delivered"
      ? "Delivered."
      : `Still not delivered — ${result.error || `answered ${result.response_status}`}.`;
    redirect(ctx.res, `/app/setup/webhooks?m=${encodeURIComponent(message)}`);
  });
}

async function page(ctx, { issued = null, error = null }) {
  const cid = ctx.staff.company_id;
  const endpoints = await all(
    "SELECT * FROM webhook_endpoint WHERE company_id = ? ORDER BY created_at DESC", cid);
  const deliveries = await all(
    `SELECT d.*, e.url FROM webhook_delivery d
       LEFT JOIN webhook_endpoint e ON e.id = d.endpoint_id
      WHERE d.company_id = ? ORDER BY d.created_at DESC LIMIT 30`, cid);

  return appPage({
    staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
    title: "Webhooks",
    subtitle: "We tell your systems when something happens here",
    body: html`
      ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
      ${error ? notice("danger", "Nothing was added", error) : ""}

      ${issued ? html`
        <div class="panel">
          <div class="panel__head"><h2>The signing secret</h2>
            <p>This is the only time it is shown</p>
          </div>
          <div class="panel__body">
            ${notice("warn", "Copy it into your receiver now",
              html`Every delivery is signed with it. We store it so we can sign, and we will
                not show it again — if it is lost, remove the endpoint and add it back.`)}
            <div class="tablewrap" style="margin-top:1rem"><table class="data">
              <tbody>
                <tr><td class="shrink">URL</td><td style="word-break:break-all">${issued.url}</td></tr>
                <tr><td class="shrink">Secret</td><td
                  style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${issued.secret}</td></tr>
              </tbody>
            </table></div>
          </div>
        </div>` : ""}

      <div class="panel">
        <div class="panel__head"><h2>How to check a delivery</h2></div>
        <div class="panel__body">
          <p class="lede">Each request carries three headers, which is the
            <a href="https://www.standardwebhooks.com" target="_blank" rel="noreferrer noopener">Standard
            Webhooks</a> shape — most languages have a library that verifies it for you.</p>
          <div class="tablewrap"><table class="data">
            <tbody>
              <tr><td class="shrink"><code>webhook-id</code></td><td>The delivery's id. The same
                across retries, so you can ignore one you have already handled.</td></tr>
              <tr><td class="shrink"><code>webhook-timestamp</code></td><td>Unix seconds. Refuse
                anything more than a few minutes old.</td></tr>
              <tr><td class="shrink"><code>webhook-signature</code></td><td><code>v1,</code> then
                base64 HMAC-SHA256 of <code>id.timestamp.body</code> with your secret.</td></tr>
            </tbody>
          </table></div>
          <p class="lede" style="margin-top:0.875rem">Answer <b>2xx</b> and we stop. Answer a 4xx
            and we stop too and record it — that is a refusal rather than a wobble. Anything else
            is retried after ${BACKOFF.join(", ")} minutes and then given up on. An endpoint that
            fails ${DISABLE_AFTER} times in a row turns itself off.</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Add an endpoint</h2>
          <p>https only</p>
        </div>
        <div class="panel__body">
          <form method="post" action="/app/setup/webhooks" class="formgrid">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />
            <div class="field">
              <label for="url">URL</label>
              <input id="url" name="url" type="url" required placeholder="https://example.com/hooks/propops" />
              <span class="field__help">Resolved and checked before every send, not just now —
                a name can be pointed somewhere else later, and private addresses are refused.</span>
            </div>
            <div class="field">
              <label for="description">What it is</label>
              <input id="description" name="description" type="text" maxlength="120"
                     placeholder="Our maintenance dashboard" />
            </div>
            <div class="field">
              <label>Which events</label>
              <span class="field__help">Tick none for all of them, including any added later.</span>
              ${EVENT_NAMES.map((name) => html`
                <label style="display:flex;gap:0.5rem;align-items:flex-start;margin:0.35rem 0;font-weight:400">
                  <input type="checkbox" name="events" value="${name}" />
                  <span><code>${name}</code> — ${EVENTS[name].describes}
                    <span class="cellsub">${EVENTS[name].payload}</span></span>
                </label>`)}
            </div>
            <button class="pill solid sm" type="submit">Add endpoint</button>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Endpoints</h2></div>
        <div class="panel__body panel__body--flush">
          ${endpoints.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>URL</th><th>Events</th><th>State</th><th class="shrink"></th></tr></thead>
            <tbody>${endpoints.map((e) => {
              const events = parseEvents(e.events);
              return html`
                <tr>
                  <td style="word-break:break-all">${e.url}
                    ${e.description ? html`<span class="cellsub">${e.description}</span>` : ""}</td>
                  <td>${events.length
                    ? events.map((n) => html`<span class="chip chip--plain">${n}</span> `)
                    : html`<span class="cellsub">all of them</span>`}</td>
                  <td>${e.disabled_at
                    ? html`<span class="chip" data-tone="danger">off</span>
                        <span class="cellsub">${e.disabled_why}</span>`
                    : html`<span class="chip" data-tone="ok">on</span>
                        <span class="cellsub">${e.last_success_at
                          ? `last delivered ${humanStamp(e.last_success_at)}`
                          : "nothing delivered yet"}${Number(e.consecutive_failures)
                          ? ` · ${e.consecutive_failures} failures in a row` : ""}</span>`}</td>
                  <td class="shrink">
                    <div class="btnrow">
                      ${e.disabled_at ? html`
                        <form method="post" action="/app/setup/webhooks/${e.id}/enable">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <button class="pill outline sm" type="submit">Turn on</button>
                        </form>` : ""}
                      <form method="post" action="/app/setup/webhooks/${e.id}/delete">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <button class="pill outline sm" type="submit">Remove</button>
                      </form>
                    </div>
                  </td>
                </tr>`;
            })}</tbody>
          </table></div>` : empty("No endpoints",
            "Nothing is being sent anywhere. Add one above.")}
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Recent deliveries</h2>
          <p>What was attempted and what came back</p>
        </div>
        <div class="panel__body panel__body--flush">
          ${deliveries.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>When</th><th>Event</th><th>To</th><th class="shrink">State</th>
              <th class="num">Tries</th><th class="shrink"></th></tr></thead>
            <tbody>${deliveries.map((d) => html`
              <tr>
                <td class="shrink">${humanStamp(d.created_at)}</td>
                <td><code>${d.event}</code></td>
                <td style="word-break:break-all"><span class="cellsub">${d.url || "removed"}</span></td>
                <td class="shrink">
                  <span class="chip"${attr("data-tone", tone(d.status))}>${d.status}</span>
                  ${d.response_status ? html`<span class="cellsub">answered ${d.response_status}</span>` : ""}
                  ${d.error ? html`<span class="cellsub">${d.error}</span>` : ""}
                  ${d.status === "pending" && d.next_attempt_at
                    ? html`<span class="cellsub">next try ${humanStamp(d.next_attempt_at)}</span>` : ""}
                </td>
                <td class="num">${d.attempts}</td>
                <td class="shrink">${d.status === "delivered" ? "" : html`
                  <form method="post" action="/app/setup/webhooks/delivery/${d.id}/retry">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <button class="pill outline sm" type="submit">Send again</button>
                  </form>`}</td>
              </tr>`)}</tbody>
          </table></div>` : empty("Nothing sent yet",
            "Deliveries show up here as soon as something happens that an endpoint wants.")}
        </div>
      </div>`,
  });
}

const tone = (status) =>
  status === "delivered" ? "ok"
  : status === "pending" ? "warn"
  : "danger";
