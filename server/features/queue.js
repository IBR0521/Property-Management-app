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
import { publicPath } from "../lib/tenancy.js";
import { humanStamp } from "../lib/dates.js";
import { human, today } from "../lib/dates.js";

const ICON = {
  emergency: "alert", approval: "users", deadline: "shield", unassigned: "wrench", unscheduled: "clock",
  blocked: "alert", rent: "cash", turn: "loop", application: "inbox",
};

/* How many of a section to draw.

   The queue rendered everything it had. At 2,200 open items that was 2,200
   rows, 1.85MB of HTML and a page 192,000 pixels tall — and more to the
   point, "2,200 things need you" is not an instruction, it is a wall. There
   is no first thing to do on a page that long.

   The list is already in the order the work should be done in, so the top of
   it is the answer and the rest is a number. */
const SHOWN = 25;

const shownOf = (list) => list.length > SHOWN
  ? `the ${SHOWN} most urgent of ${list.length}`
  : String(list.length);

const moreFoot = (list, which) => list.length <= SHOWN ? "" : html`
  <div class="panel__foot">
    ${list.length - SHOWN} more, in the same order. The oldest and the most
    serious are above — work down and this list shortens from the top.
    ${which === "now"
      ? html` Everything here is an emergency, past a deadline, or somebody waiting on an answer.`
      : ""}
  </div>`;

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
    const mailWaiting = !DELIVERY.reaching && queued > 0;
    const subtitle = items.length
      ? `${items.length} thing${items.length === 1 ? "" : "s"} to deal with · ${human(today())}`
      : !onboarding.complete
        ? `Finish setup · ${human(today())}`
        : mailWaiting
          ? `Mail is waiting to go out · ${human(today())}`
          : `Nothing to deal with · ${human(today())}`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "queue", counts: await navCounts(cid),
      title: "Today",
      subtitle,
      actions: html`
        <a class="pill outline" href="${publicPath({ slug: ctx.staff.company_slug }, "/report")}" target="_blank">Tenant form</a>
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
                    : html`<a class="pill outline sm" href="${step.href}">${step.action}</a>`}
                </div>`)}
            </div>
            <div class="panel__foot">
              You can use the rest of the app while this list is open. It goes away when every step is done.
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

        ${!items.length && onboarding.complete && !mailWaiting && !schedulerStale
          ? html`<div class="panel"><div class="panel__body">
              ${empty("All clear", "No emergencies, no overdue deadlines, no rent past grace and nobody waiting on an answer.")}
            </div></div>`
          : ""}

        ${now.length ? html`
          <div class="panel">
            <div class="panel__head">
              <h2>Needs you now</h2>
              <p>${shownOf(now)}</p>
            </div>
            <ul class="qlist">${now.slice(0, SHOWN).map(row)}</ul>
            ${moreFoot(now, "now")}
          </div>` : ""}

        ${later.length ? html`
          <div class="panel">
            <div class="panel__head">
              <h2>Then</h2>
              <p>${shownOf(later)}</p>
            </div>
            <ul class="qlist">${later.slice(0, SHOWN).map(row)}</ul>
            ${moreFoot(later, "then")}
          </div>` : ""}`,
    }));
  });
}
