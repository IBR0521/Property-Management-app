/* The home screen: one list of what needs a person.

   Replaces the old dashboard, which showed four separate panels and left the
   manager to work out what to do first. */
import { sendHtml } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { buildQueue } from "../lib/queue.js";
import { outboxPending, DELIVERY, lastTickAt, tickIsStale, STALE_AFTER_HOURS } from "../lib/scheduler.js";
import { describe as describeDelivery } from "../lib/delivery/mode.js";
import { onboardingState } from "./signup.js";
import { humanStamp } from "../lib/dates.js";
import { human, today } from "../lib/dates.js";

const ICON = {
  emergency: "alert", approval: "users", deadline: "shield", unassigned: "wrench", unscheduled: "clock",
  blocked: "alert", rent: "cash", turn: "loop", application: "inbox",
};

export function registerQueue(router) {
  router.get("/app", async (ctx) => {
    const cid = ctx.staff.company_id;
    const items = await buildQueue(cid);
    const now = items.filter((i) => i.rank <= 1);
    const later = items.filter((i) => i.rank > 1);
    const queued = await outboxPending(cid);

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

    const onboarding = await onboardingState(cid);
    const lastRun = await lastTickAt();
    const schedulerStale = tickIsStale(lastRun);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "queue", counts: await navCounts(cid),
      title: items.length ? `${items.length} thing${items.length === 1 ? "" : "s"} need you` : "Nothing needs you",
      subtitle: human(today()),
      actions: html`
        <a class="pill outline" href="/report" target="_blank">Tenant form</a>
        <a class="pill solid" href="/app/maintenance/new">Log a repair</a>`,
      body: html`
        ${onboarding.complete ? "" : html`
          <div class="panel">
            <div class="panel__head">
              <h2>Getting set up</h2>
              <p>${onboarding.done} of ${onboarding.total}</p>
            </div>
            <div class="panel__body panel__body--flush">
              ${onboarding.steps.map((step) => html`
                <div class="minirow">
                  <div class="minirow__main">
                    <b>${step.done ? "✓ " : ""}${step.label}</b>
                    <span class="cellsub">${step.hint}</span>
                  </div>
                  ${step.done
                    ? html`<span class="chip" data-tone="ok">done</span>`
                    : html`<a class="pill outline sm" href="${step.href}">Do it</a>`}
                </div>`)}
            </div>
            <div class="panel__foot">
              This disappears once everything is ticked. Nothing here blocks you from working.
            </div>
          </div>`}

        ${(() => {
          /* Nothing else in the app can tell a manager the clocks have
             stopped. Obligations stop ageing, the delinquency ladder stops
             advancing, and every screen looks exactly as it did yesterday —
             which is the failure mode of a scheduler nobody is watching. */
          if (!schedulerStale) return "";
          return notice("danger", "The scheduler has not run",
            html`Deadlines, the delinquency ladder and payment promises stop advancing without it.
                 ${lastRun ? html`Last completed ${humanStamp(lastRun.finished_at)}.`
                           : html`It has never completed a run.`}
                 <a href="/app/compliance">Run it now</a>.`);
        })()}

        ${!DELIVERY.reaching && queued > 0
          ? (() => {
              const d = describeDelivery(DELIVERY.mode, queued);
              return notice(d.tone, d.title,
                html`${d.detail} <a href="/app/setup">Delivery settings</a>.`);
            })()
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
