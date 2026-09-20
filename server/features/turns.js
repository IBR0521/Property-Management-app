/* F5  Turn tracker.

   A vacant day is money nobody gets back, and most small operators cannot say
   where their turn days actually go. So every stage transition is timestamped
   in turn_stage_event, and the board shows days-in-stage rather than a tidy
   percentage — the number that tells you which step is the bottleneck.

   The photo record has a second job: it is the evidence in a deposit dispute. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween, addDays } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { storeMany } from "../lib/files.js";

const STAGES = [
  { key: "notice", label: "Notice given" },
  { key: "moveout", label: "Moved out" },
  { key: "inspected", label: "Inspected" },
  { key: "scoped", label: "Scoped" },
  { key: "in_progress", label: "Work underway" },
  { key: "ready", label: "Ready" },
  { key: "listed", label: "Listed" },
  { key: "applied", label: "Applications in" },
  { key: "leased", label: "Leased" },
];

export function registerTurns(router) {
  router.get("/app/turns", (ctx) => {
    const cid = ctx.staff.company_id;
    const turns = all(
      `SELECT t.*, u.label, u.market_rent_cents, p.line1,
              (SELECT COUNT(*) FROM turn_task k WHERE k.turn_id = t.id AND k.done_at IS NULL) AS open_tasks,
              (SELECT MAX(entered_at) FROM turn_stage_event e WHERE e.turn_id = t.id) AS stage_since
         FROM turn t JOIN unit u ON u.id = t.unit_id JOIN property p ON p.id = u.property_id
        WHERE t.company_id = ? AND t.status = 'open'
        ORDER BY t.moveout_date`, cid);

    const closed = all(
      `SELECT t.*, u.label, p.line1 FROM turn t
         JOIN unit u ON u.id = t.unit_id JOIN property p ON p.id = u.property_id
        WHERE t.company_id = ? AND t.status = 'closed'
        ORDER BY t.leased_date DESC LIMIT 10`, cid);

    // Average vacant days, measured rather than asserted. Only closed turns
    // with both ends recorded can contribute.
    const measurable = closed.filter((t) => t.moveout_date && t.leased_date);
    const avg = measurable.length
      ? Math.round(measurable.reduce((n, t) => n + daysBetween(t.moveout_date, t.leased_date), 0) / measurable.length)
      : null;
    const lostPerDay = turns.reduce((n, t) => n + Math.round((t.market_rent_cents || 0) / 30), 0);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: navCounts(cid),
      title: "Turns",
      subtitle: `${turns.length} in progress`,
      actions: html`<a class="pill solid" href="/app/turns/new">Start a turn</a>`,
      body: html`
        ${tabs(PROPERTY_TABS, "turns")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Open turns</span><span class="tile__value">${turns.length}</span></div>
          <div class="tile"${attr("data-tone", lostPerDay ? "warn" : null)}>
            <span class="tile__label">Vacancy cost per day</span>
            <span class="tile__value">${usd(lostPerDay)}</span>
            <span class="tile__note">Market rent of open units ÷ 30</span>
          </div>
          <div class="tile">
            <span class="tile__label">Average vacant days</span>
            <span class="tile__value">${avg == null ? "—" : avg}</span>
            <span class="tile__note">${measurable.length ? `From ${measurable.length} completed turn(s)` : "Not enough closed turns yet"}</span>
          </div>
        </div>

        <div class="board">
          ${STAGES.map((st) => {
            const inStage = turns.filter((t) => t.stage === st.key);
            return html`
              <div class="boardcol">
                <div class="boardcol__head"><h3>${st.label}</h3><span>${inStage.length}</span></div>
                <div class="boardcol__body">
                  ${inStage.map((t) => html`
                    <a class="boardcard" href="/app/turns/${t.id}">
                      <b>${t.line1}${t.label ? ` · ${t.label}` : ""}</b>
                      <span class="cellsub">
                        ${t.stage_since ? `${daysBetween(t.stage_since.slice(0, 10), today())}d in this stage` : "just started"}
                        ${t.open_tasks ? ` · ${t.open_tasks} task(s) open` : ""}
                      </span>
                      ${t.moveout_date ? html`<span class="cellsub">vacant ${daysBetween(t.moveout_date, today())}d</span>` : ""}
                    </a>`)}
                </div>
              </div>`;
          })}
        </div>

        ${closed.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Recently completed</h2><p>Where the days went</p></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Unit</th><th>Moved out</th><th>Ready</th><th>Listed</th><th>Leased</th><th class="num">Vacant days</th></tr></thead>
                <tbody>${closed.map((t) => html`
                  <tr>
                    <td><a href="/app/turns/${t.id}">${t.line1}${t.label ? ` · ${t.label}` : ""}</a></td>
                    <td>${human(t.moveout_date)}</td><td>${human(t.ready_date)}</td>
                    <td>${human(t.listed_date)}</td><td>${human(t.leased_date)}</td>
                    <td class="num">${t.moveout_date && t.leased_date ? daysBetween(t.moveout_date, t.leased_date) : "—"}</td>
                  </tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}`,
    }));
  });

  router.get("/app/turns/new", (ctx) => {
    const cid = ctx.staff.company_id;
    const units = all(
      `SELECT u.id, u.label, p.line1, u.status,
              (SELECT id FROM lease l WHERE l.unit_id = u.id AND l.status = 'active' LIMIT 1) AS lease_id
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ? AND u.status != 'turn' ORDER BY p.line1, u.label`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: navCounts(cid),
      title: "Start a turn",
      subtitle: "From the day notice is given, so the clock starts where the cost starts",
      body: html`
        <div class="panel" style="max-width:36rem"><div class="panel__body">
          <form method="post" action="/app/turns/new" class="formgrid">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />
            <div class="field">
              <label for="unit_id">Unit</label>
              <select id="unit_id" name="unit_id" required>
                <option value="">Choose…</option>
                ${units.map((u) => html`<option value="${u.id}">${u.line1}${u.label ? ` — unit ${u.label}` : ""} (${u.status})</option>`)}
              </select>
            </div>
            <div class="formgrid formgrid--2">
              <div class="field">
                <label for="notice_date">Notice given</label>
                <input id="notice_date" name="notice_date" type="date" value="${today()}" required />
              </div>
              <div class="field">
                <label for="moveout_date">Expected move-out</label>
                <input id="moveout_date" name="moveout_date" type="date" />
              </div>
            </div>
            <div class="field">
              <label for="target_ready_date">Target ready date</label>
              <input id="target_ready_date" name="target_ready_date" type="date" />
              <span class="field__help">Used to show whether a turn is running late, not to chase anyone.</span>
            </div>
            <div class="btnrow">
              <button class="pill solid" type="submit">Start</button>
              <a class="pill outline" href="/app/turns">Cancel</a>
            </div>
          </form>
        </div></div>`,
    }));
  });

  router.post("/app/turns/new", (ctx) => {
    const cid = ctx.staff.company_id;
    const unit = one("SELECT * FROM unit WHERE id = ? AND company_id = ?", String(ctx.fields.unit_id || ""), cid);
    const lease = get("SELECT * FROM lease WHERE unit_id = ? AND status = 'active' LIMIT 1", unit.id);
    const turnId = id();

    tx(() => {
      insert("turn", {
        id: turnId, company_id: cid, unit_id: unit.id, lease_id: lease ? lease.id : null,
        stage: "notice",
        notice_date: String(ctx.fields.notice_date || today()),
        moveout_date: String(ctx.fields.moveout_date || "") || null,
        target_ready_date: String(ctx.fields.target_ready_date || "") || null,
        status: "open", created_at: stamp(),
      });
      stageEvent(turnId, "notice", ctx.staff.name, "Turn opened");
      update("unit", unit.id, { status: "turn" });

      // A standard make-ready list, so nobody has to remember it at 7am.
      const defaults = ["Final inspection", "Clean", "Paint touch-up", "Carpet / flooring", "Keys and locks re-keyed", "Photos for listing"];
      defaults.forEach((label, i) =>
        insert("turn_task", { id: id(), turn_id: turnId, label, sort: i }));
    });
    redirect(ctx.res, `/app/turns/${turnId}`);
  });

  router.get("/app/turns/:id", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = get(
      `SELECT t.*, u.label, u.market_rent_cents, p.line1, p.city
         FROM turn t JOIN unit u ON u.id = t.unit_id JOIN property p ON p.id = u.property_id
        WHERE t.id = ? AND t.company_id = ?`, ctx.params.id, cid);
    if (!t) return sendHtml(ctx.res, "Not found", 404);

    const events = all("SELECT * FROM turn_stage_event WHERE turn_id = ? ORDER BY entered_at", t.id);
    const tasks = all("SELECT k.*, v.name AS vendor_name FROM turn_task k LEFT JOIN vendor v ON v.id = k.vendor_id WHERE k.turn_id = ? ORDER BY k.sort, k.label", t.id);
    const photos = all("SELECT * FROM turn_photo WHERE turn_id = ? ORDER BY created_at", t.id);
    const vendors = all("SELECT * FROM vendor WHERE company_id = ? AND active = 1 ORDER BY trade, name", cid);
    const spend = tasks.reduce((n, k) => n + (k.cost_cents || 0), 0);
    const stageIdx = STAGES.findIndex((s) => s.key === t.stage);
    const nextStage = STAGES[stageIdx + 1];
    const vacantDays = t.moveout_date ? daysBetween(t.moveout_date, t.leased_date || today()) : null;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: navCounts(cid),
      title: `${t.line1}${t.label ? ` · unit ${t.label}` : ""}`,
      subtitle: `${STAGES[stageIdx]?.label || t.stage}${vacantDays != null ? ` · vacant ${vacantDays} day(s)` : ""}`,
      actions: html`<a class="pill outline sm" href="/app/turns">Back to board</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${t.target_ready_date && !t.ready_date && today() > t.target_ready_date
          ? notice("warn", "Past the target ready date",
              `Targeted ${human(t.target_ready_date)} — ${daysBetween(t.target_ready_date, today())} day(s) over.`)
          : ""}

        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Vacant days</span><span class="tile__value">${vacantDays ?? "—"}</span>
            <span class="tile__note">${t.market_rent_cents ? `${usd(Math.round(t.market_rent_cents / 30))} per day` : ""}</span></div>
          <div class="tile"><span class="tile__label">Spend so far</span><span class="tile__value">${usd(spend)}</span>
            <span class="tile__note">${tasks.filter((k) => k.done_at).length} of ${tasks.length} tasks done</span></div>
          <div class="tile"><span class="tile__label">Lost rent to date</span>
            <span class="tile__value">${vacantDays && t.market_rent_cents ? usd(Math.round((t.market_rent_cents / 30) * vacantDays)) : "—"}</span>
            <span class="tile__note">What the owner will ask about</span></div>
        </div>

        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head"><h2>Make-ready</h2><p>${usd(spend)} recorded</p></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Task</th><th>Vendor</th><th class="num">Cost</th><th class="shrink"></th></tr></thead>
                <tbody>${tasks.map((k) => html`
                  <tr>
                    <td>${k.done_at ? html`<span style="color:var(--ink-soft);text-decoration:line-through">${k.label}</span>` : k.label}
                      ${k.done_at ? html`<span class="cellsub">done ${human(k.done_at.slice(0, 10))}</span>` : ""}</td>
                    <td>${k.vendor_name || "—"}</td>
                    <td class="num">${k.cost_cents != null ? usd(k.cost_cents) : "—"}</td>
                    <td class="shrink">
                      ${k.done_at ? "" : html`
                        <form method="post" action="/app/turns/${t.id}/task/${k.id}" class="btnrow">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <input name="cost" type="text" inputmode="decimal" placeholder="cost"
                                 style="width:5.5rem;padding:0.375rem 0.5rem;border:1px solid var(--hairline);border-radius:var(--radius-xl);font-size:0.8125rem" />
                          <select name="vendor_id" style="width:8rem;padding:0.375rem;border:1px solid var(--hairline);border-radius:var(--radius-xl);font-size:0.8125rem">
                            <option value="">vendor…</option>
                            ${vendors.map((v) => html`<option value="${v.id}">${v.name}</option>`)}
                          </select>
                          <button class="pill solid sm" type="submit">Done</button>
                        </form>`}
                    </td>
                  </tr>`)}</tbody>
              </table></div>
            </div>
            <div class="panel__body" style="border-top:1px solid var(--hairline)">
              <form method="post" action="/app/turns/${t.id}/task" class="btnrow">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <input name="label" type="text" required placeholder="Add a task"
                       style="flex:1;min-width:12rem;padding:0.625rem 0.875rem;border:1px solid var(--hairline);border-radius:var(--radius-xl);font-size:0.875rem" />
                <button class="pill outline sm" type="submit">Add</button>
              </form>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:1.25rem">
            ${t.status === "open" ? html`
              <div class="panel">
                <div class="panel__head"><h2>Move it on</h2></div>
                <div class="panel__body" style="display:flex;flex-direction:column;gap:1.25rem">
                  ${nextStage ? html`
                    <form method="post" action="/app/turns/${t.id}/advance" class="formgrid">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <input type="hidden" name="stage" value="${nextStage.key}" />
                      <div class="field">
                        <label for="snote">Note <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                        <input id="snote" name="note" type="text" />
                      </div>
                      <button class="pill solid sm" type="submit">Move to “${nextStage.label}”</button>
                    </form>` : notice("ok", "End of the pipeline", "Close the turn when the new lease starts.")}

                  <form method="post" action="/app/turns/${t.id}/photos" enctype="multipart/form-data" class="formgrid">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <div class="formgrid formgrid--2">
                      <div class="field">
                        <label for="phase">Photo set</label>
                        <select id="phase" name="phase" required>
                          <option value="moveout">Move-out condition</option>
                          <option value="progress">Work in progress</option>
                          <option value="movein">Move-in condition</option>
                        </select>
                        <span class="field__help">Move-out photos are the deposit-dispute record.</span>
                      </div>
                      <div class="field">
                        <label for="room">Room <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                        <input id="room" name="room" type="text" placeholder="Kitchen" />
                      </div>
                    </div>
                    <div class="field">
                      <label for="tphotos">Photos</label>
                      <input id="tphotos" name="photos" type="file" accept="image/*" multiple />
                    </div>
                    <button class="pill outline sm" type="submit">Add photos</button>
                  </form>

                  <form method="post" action="/app/turns/${t.id}/close">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <button class="pill outline sm" type="submit">Close this turn</button>
                  </form>
                </div>
              </div>` : notice("ok", "Turn closed", `Leased ${human(t.leased_date)}.`)}

            <div class="panel">
              <div class="panel__head"><h2>Where the days went</h2></div>
              <div class="panel__body">
                <div class="timeline">
                  ${events.map((e, i) => {
                    const next = events[i + 1];
                    const held = daysBetween(e.entered_at.slice(0, 10), (next ? next.entered_at : stamp()).slice(0, 10));
                    return html`
                      <div class="tl" data-tone="brand">
                        <div class="tl__dot">${icons.clock}</div>
                        <div class="tl__body">
                          <b>${STAGES.find((s) => s.key === e.stage)?.label || e.stage}</b>
                          <time>${humanStamp(e.entered_at)} · ${e.actor} · ${held} day(s) here</time>
                          ${e.note ? html`<p>${e.note}</p>` : ""}
                        </div>
                      </div>`;
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        ${photos.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Photo record</h2><p>${photos.length} image(s)</p></div>
            <div class="panel__body">
              ${["moveout", "progress", "movein"].map((phase) => {
                const set = photos.filter((p) => p.phase === phase);
                if (!set.length) return "";
                return html`
                  <div style="margin-bottom:1.25rem">
                    <span class="tile__label">${phase === "moveout" ? "Move-out condition" : phase === "movein" ? "Move-in condition" : "In progress"}</span>
                    <div class="thumbs" style="margin-top:0.5rem">
                      ${set.map((p) => html`<a href="/uploads/${p.path}" target="_blank" title="${p.room || ""}"><img src="/uploads/${p.path}" alt="${p.room || phase}" loading="lazy" /></a>`)}
                    </div>
                  </div>`;
              })}
            </div>
          </div>` : ""}`,
    }));
  });

  router.post("/app/turns/:id/advance", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = one("SELECT * FROM turn WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const stage = String(ctx.fields.stage || "");
    if (!STAGES.some((s) => s.key === stage)) throw new BadRequest("Unknown stage.");

    tx(() => {
      const patch = { stage };
      // Stages that are also dates worth reporting on get stamped.
      if (stage === "moveout" && !t.moveout_date) patch.moveout_date = today();
      if (stage === "ready" && !t.ready_date) patch.ready_date = today();
      if (stage === "listed" && !t.listed_date) patch.listed_date = today();
      if (stage === "leased" && !t.leased_date) patch.leased_date = today();
      update("turn", t.id, patch);
      stageEvent(t.id, stage, ctx.staff.name, String(ctx.fields.note || "").trim() || null);
      if (stage === "moveout") update("unit", t.unit_id, { status: "turn" });
    });
    redirect(ctx.res, `/app/turns/${t.id}?m=${encodeURIComponent("Stage updated.")}`);
  });

  router.post("/app/turns/:id/task", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = one("SELECT * FROM turn WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const label = String(ctx.fields.label || "").trim();
    if (!label) throw new BadRequest("Give the task a name.");
    const max = get("SELECT COALESCE(MAX(sort),0) AS m FROM turn_task WHERE turn_id = ?", t.id).m;
    insert("turn_task", { id: id(), turn_id: t.id, label, sort: max + 1 });
    redirect(ctx.res, `/app/turns/${t.id}`);
  });

  router.post("/app/turns/:id/task/:taskId", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = one("SELECT * FROM turn WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const task = one("SELECT * FROM turn_task WHERE id = ? AND turn_id = ?", ctx.params.taskId, t.id);
    update("turn_task", task.id, {
      done_at: stamp(),
      cost_cents: parseMoney(ctx.fields.cost),
      vendor_id: String(ctx.fields.vendor_id || "") || null,
    });
    redirect(ctx.res, `/app/turns/${t.id}`);
  });

  router.post("/app/turns/:id/photos", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = one("SELECT * FROM turn WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const phase = ["moveout", "progress", "movein"].includes(ctx.fields.phase) ? ctx.fields.phase : "progress";
    const { stored, problems } = storeMany(ctx.files, "photos");
    for (const s of stored) {
      insert("turn_photo", {
        id: id(), turn_id: t.id, phase, room: String(ctx.fields.room || "").trim() || null,
        path: s.path, mime: s.mime, bytes: s.bytes, created_at: stamp(),
      });
    }
    const msg = problems.length ? problems.join(" ") : `${stored.length} photo(s) added.`;
    redirect(ctx.res, `/app/turns/${t.id}?m=${encodeURIComponent(msg)}`);
  });

  router.post("/app/turns/:id/close", (ctx) => {
    const cid = ctx.staff.company_id;
    const t = one("SELECT * FROM turn WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    tx(() => {
      update("turn", t.id, { status: "closed", leased_date: t.leased_date || today() });
      stageEvent(t.id, "leased", ctx.staff.name, "Turn closed");
      update("unit", t.unit_id, { status: "occupied" });
    });
    redirect(ctx.res, `/app/turns?m=${encodeURIComponent("Turn closed.")}`);
  });
}

function stageEvent(turnId, stage, actor, note) {
  insert("turn_stage_event", {
    id: id(), turn_id: turnId, stage, entered_at: stamp(), actor, note: note || null,
  });
}
