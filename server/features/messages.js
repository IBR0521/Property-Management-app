/* F12  The outbox, and what went wrong with it.

   Until now the only sign of a message's existence was a count on the
   dashboard. That is enough when nothing is ever sent. It is not enough the
   moment delivery is real, because the interesting rows are the ones that
   failed, and a count cannot tell you which notice never reached which tenant.

   Three states earn a screen.

   Queued is the honest state when delivery is off, and the backlog when it is
   on. It is also where stale messages accumulate: turning delivery on with a
   month of old notices sitting in the queue would send every one of them,
   backdated, at once. Hence discard — reviewing and dropping a backlog is a
   thing somebody has to be able to do before the first live run.

   Dead is where the retries stopped. Each row carries the provider's own error,
   because "failed" is not actionable and "21614: not a mobile number" is.

   Suppressed is not a failure. The recipient said no and the system listened,
   which is a different fact and is shown as one. */
import { all, get, one, run } from "../lib/db.js";
import { stamp, human, humanStamp, today } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { DELIVERY, lastTickAt, tickIsStale } from "../lib/scheduler.js";
import { describe as describeDelivery } from "../lib/delivery/mode.js";
import { sendNow } from "../lib/delivery/now.js";

const TABS = [
  { key: "queued", href: "/app/messages", label: "Queued" },
  { key: "dead", href: "/app/messages/dead", label: "Not delivered" },
  { key: "sent", href: "/app/messages/sent", label: "Sent" },
];

const STATE_TONE = { sent: "ok", dead: "danger", suppressed: null, queued: "warn", failed: "warn" };

export function registerMessages(router) {
  router.get("/app/messages", async (ctx) => renderList(ctx, "queued"));
  router.get("/app/messages/dead", async (ctx) => renderList(ctx, "dead"));
  router.get("/app/messages/sent", async (ctx) => renderList(ctx, "sent"));

  /* Put a dead message back in the queue. Attempts reset, because the operator
     has presumably fixed whatever was wrong and a row that starts at five
     attempts would die again immediately. */
  router.post("/app/messages/:id/retry", async (ctx) => {
    const cid = ctx.staff.company_id;
    const m = await one(
      "SELECT * FROM outbox WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (m.status !== "dead" && m.status !== "suppressed") {
      throw new BadRequest("Only messages that stopped can be retried.");
    }
    await run(
      `UPDATE outbox SET status = 'queued', attempts = 0, last_error = NULL,
              next_attempt_at = NULL, failed_at = NULL WHERE id = ?`, m.id);
    redirect(ctx.res, `/app/messages/dead?m=${encodeURIComponent("Back in the queue.")}`);
  });

  /* Drop a message without sending it. The reason this exists: a backlog that
     accumulated while delivery was off contains notices whose dates have
     passed, and the first thing a new delivery system should not do is send a
     month of backdated rent warnings. */
  router.post("/app/messages/:id/discard", async (ctx) => {
    const cid = ctx.staff.company_id;
    const m = await one(
      "SELECT * FROM outbox WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (m.status === "sent") throw new BadRequest("That message has already gone.");
    await run(
      `UPDATE outbox SET status = 'dead', last_error = ?, failed_at = ? WHERE id = ?`,
      `discarded by ${ctx.staff.name}`, stamp(), m.id);
    redirect(ctx.res, `/app/messages?m=${encodeURIComponent("Discarded. It will not be sent.")}`);
  });

  /* Discard everything queued older than a cutoff. One at a time is not a
     realistic way to clear a backlog of thirty-nine. */
  router.post("/app/messages/discard-stale", async (ctx) => {
    const cid = ctx.staff.company_id;
    const days = Math.max(1, Math.min(365, Number(ctx.fields.days) || 7));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const affected = await all(
      "SELECT id FROM outbox WHERE company_id = ? AND status = 'queued' AND queued_at < ?", cid, cutoff);
    for (const row of affected) {
      await run(
        `UPDATE outbox SET status = 'dead', last_error = ?, failed_at = ? WHERE id = ?`,
        `discarded as stale (older than ${days} days) by ${ctx.staff.name}`, stamp(), row.id);
    }
    redirect(ctx.res, `/app/messages?m=${encodeURIComponent(
      `${affected.length} stale message${affected.length === 1 ? "" : "s"} discarded.`)}`);
  });

  /* Send to yourself. The one test that cannot spam somebody else, and the
     only way to see a provider's real error before a tenant does. */
  router.post("/app/messages/test", async (ctx) => {
    const cid = ctx.staff.company_id;
    const channel = ctx.fields.channel === "sms" ? "sms" : "email";
    const to = String(ctx.fields.to || "").trim() || (channel === "email" ? ctx.staff.email : "");

    if (!to) {
      return redirect(ctx.res, `/app/setup?m=${encodeURIComponent("Give a number to test SMS against.")}`);
    }

    const result = await sendNow({
      companyId: cid, channel, to,
      subject: "Test message from your property software",
      body: `This is a test sent by ${ctx.staff.name} at ${humanStamp(stamp())}. `
        + `If you are reading it, delivery is working.`,
      aboutType: "delivery_test", aboutId: ctx.staff.id,
    });

    const message = result.ok
      ? `Test ${channel} accepted by the provider for ${to}.`
      : `Test ${channel} to ${to} did not send — ${result.reason}`;
    redirect(ctx.res, `/app/setup?m=${encodeURIComponent(message)}`);
  });
}

async function renderList(ctx, view) {
  const cid = ctx.staff.company_id;

  const where = view === "queued" ? "status = 'queued'"
    : view === "dead" ? "status IN ('dead', 'suppressed')"
    : "status = 'sent'";

  const rows = await all(
    `SELECT * FROM outbox WHERE company_id = ? AND ${where}
      ORDER BY COALESCE(failed_at, sent_at, queued_at) DESC LIMIT 200`, cid);

  const counts = await one(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE status IN ('dead','suppressed'))::int AS dead,
       COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
       COUNT(*) FILTER (WHERE status = 'queued' AND queued_at < ?)::int AS stale
     FROM outbox WHERE company_id = ?`,
    new Date(Date.now() - 7 * 86400000).toISOString(), cid);

  const delivery = describeDelivery(DELIVERY.mode, counts.queued);

  sendHtml(ctx.res, appPage({
    staff: ctx.staff, csrf: ctx.csrf, active: "messages", counts: await navCounts(cid),
    title: "Messages",
    subtitle: `${counts.queued} queued · ${counts.dead} not delivered · ${counts.sent} sent`,
    body: html`
      ${tabs(TABS, view)}
      ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
      ${DELIVERY.reaching ? "" : notice(delivery.tone, delivery.title, delivery.detail)}

      ${view === "queued" && counts.stale > 0 ? html`
        <div class="panel">
          <div class="panel__head"><h2>${counts.stale} stale message${counts.stale === 1 ? "" : "s"}</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0 0 0.875rem">
              Queued more than a week ago. If delivery is switched on these go out as they
              are — including rent notices whose dates have passed. Review them below, or
              discard the lot: the first thing a new delivery system should not do is send
              a month of backdated warnings.
            </p>
            <form method="post" action="/app/messages/discard-stale" class="filterbar" style="padding:0;border:0">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="days">Older than (days)</label>
                <input id="days" name="days" type="number" min="1" max="365" value="7" />
              </div>
              <button class="pill outline sm" type="submit">Discard them</button>
            </form>
          </div>
        </div>` : ""}

      <div class="panel"><div class="panel__body panel__body--flush">
        ${rows.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
          <thead><tr><th>To</th><th>Message</th><th class="shrink">State</th><th class="shrink"></th></tr></thead>
          <tbody>${rows.map((m) => html`
            <tr>
              <td>${m.to_contact}<span class="cellsub">${m.channel}</span></td>
              <td>${m.subject || html`<span style="color:var(--ink-soft)">no subject</span>`}
                <span class="cellsub">${humanStamp(m.queued_at)}${m.attempts ? ` · ${m.attempts} attempt(s)` : ""}</span>
                ${m.last_error ? html`<span class="cellsub" style="color:var(--danger)">${m.last_error}</span>` : ""}
              </td>
              <td class="shrink">
                <span class="chip"${attr("data-tone", STATE_TONE[m.status])}>${m.status}</span>
              </td>
              <td class="shrink">
                ${m.status === "sent" ? "" : html`
                  <div class="btnrow">
                    ${m.status === "dead" || m.status === "suppressed" ? html`
                      <form method="post" action="/app/messages/${m.id}/retry">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <button class="pill outline sm" type="submit">Retry</button>
                      </form>` : ""}
                    ${m.status === "queued" ? html`
                      <form method="post" action="/app/messages/${m.id}/discard">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <button class="pill outline sm" type="submit">Discard</button>
                      </form>` : ""}
                  </div>`}
              </td>
            </tr>`)}</tbody>
        </table></div>` : empty(
          view === "queued" ? "Nothing waiting to go out"
            : view === "dead" ? "Nothing failed" : "Nothing sent yet",
          /* Each of these says what would put something here. An empty state
             that only reports an absence leaves somebody wondering whether
             the feature is broken or they have not found the button. */
          view === "dead"
            ? "Nothing has given up. Anything that fails appears here with the reason, "
              + "so you can fix the address and send it again."
            : view === "queued"
              ? "Rent notices, repair updates and anything you send by hand wait here "
                + "until the next send. They usually leave within a few minutes."
              : "Messages appear here once they go out, with exactly what was sent — "
                + "which is the record that matters if anybody asks later.")}
      </div></div>`,
  }));
}
