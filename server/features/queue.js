/* The home screen: one list of what needs a person.

   Replaces the old dashboard, which showed four separate panels and left the
   manager to work out what to do first. */
import { sendHtml } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { buildQueue } from "../lib/queue.js";
import { outboxPending, DELIVERY } from "../lib/scheduler.js";
import { human, today } from "../lib/dates.js";

const ICON = {
  emergency: "alert", approval: "users", deadline: "shield", unassigned: "wrench", unscheduled: "clock",
  blocked: "alert", rent: "cash", turn: "loop", application: "inbox",
};

export function registerQueue(router) {
  router.get("/app", (ctx) => {
    const cid = ctx.staff.company_id;
    const items = buildQueue(cid);
    const now = items.filter((i) => i.rank <= 1);
    const later = items.filter((i) => i.rank > 1);
    const queued = outboxPending(cid);

    const row = (i) => html`
      <li class="q"${attr("data-tone", i.tone)}>
        <span class="q__icon">${icons[ICON[i.kind]] || icons.clock}</span>
        <div class="q__body">
          <a class="q__title" href="${i.href}">${i.title}</a>
          <span class="q__why">${i.why}</span>
          <span class="q__where">${i.where}${i.ref ? html` · ${i.ref}` : ""}</span>
        </div>
        <span class="q__age">${i.age === 0 ? "today" : `${i.age}d`}</span>
        <span class="q__act">
          ${i.tel ? html`<a class="pill danger sm" href="tel:${i.tel}">${i.cta}</a>`
                  : html`<a class="pill outline sm" href="${i.href}">${i.cta}</a>`}
        </span>
      </li>`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "queue", counts: navCounts(cid),
      title: items.length ? `${items.length} thing${items.length === 1 ? "" : "s"} need you` : "Nothing needs you",
      subtitle: human(today()),
      actions: html`
        <a class="pill outline" href="/report" target="_blank">Tenant form</a>
        <a class="pill solid" href="/app/maintenance/new">Log a repair</a>`,
      body: html`
        ${DELIVERY.mode === "none" && queued > 0
          ? notice("warn", "Nothing is being sent",
              html`${queued} message${queued === 1 ? " is" : "s are"} queued and not delivered.
                   <a href="/app/setup">Turn on a provider</a>.`)
          : ""}

        ${!items.length
          ? html`<div class="panel"><div class="panel__body">
              ${empty("All clear", "No emergencies, no overdue deadlines, no rent past grace and nobody waiting on an answer.")}
            </div></div>`
          : ""}

        ${now.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Needs you now</h2><p>${now.length}</p></div>
            <ul class="qlist">${now.map(row)}</ul>
          </div>` : ""}

        ${later.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Then</h2><p>${later.length}</p></div>
            <ul class="qlist">${later.map(row)}</ul>
          </div>` : ""}`,
    }));
  });
}
