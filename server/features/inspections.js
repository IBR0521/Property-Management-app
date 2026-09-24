/* Move-in and move-out inspections.

   ## The move-out screen is a comparison, not a checklist

   Every line shows what it was at move-in beside what it is now, and the ones
   that got worse are the only ones that can justify keeping somebody's money.
   A screen that showed today's condition alone would be asking the person
   filling it in to remember.

   ## Signed in person, on the device in somebody's hand

   A move-in inspection is signed at the walkthrough: the agent and the tenant
   are standing in the same room looking at the same thing. So there is no
   emailed link and no token — the tenant types their name on the screen in
   front of them, and the staff member who was there is recorded beside it.

   That is also why the signature panel says who is witnessing it. A typed
   name with nobody's name against it is worth less than one with. */
import { all, get, one, insert } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs, PROPERTY_TABS } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { storeMany, fileUrl } from "../lib/files.js";
import { clientIp } from "../lib/ratelimit.js";
import {
  startInspection, startMoveOut, setCondition, addItem, attachPhoto,
  completeInspection, signInspection, inspectionDetail, inspectionsFor,
  renderInspection, intact, conditionLabel, CONDITIONS, KINDS, InspectionRefused,
} from "../lib/inspections.js";

const KIND_LABEL = { movein: "Move-in", moveout: "Move-out", periodic: "Periodic" };

export function registerInspections(router) {
  router.get("/app/inspections", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await inspectionsFor({ companyId: cid });
    const units = await all(
      `SELECT u.id, u.label, p.line1, u.status,
              (SELECT l.id FROM lease l
                WHERE l.unit_id = u.id AND l.status = 'active' LIMIT 1) AS lease_id
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ? ORDER BY p.line1, u.label`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: "Inspections",
      subtitle: "What it looked like then, and what it looks like now",
      body: html`
        ${tabs(PROPERTY_TABS, "inspections")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <div class="panel">
          <div class="panel__head"><h2>Start one</h2>
            <p>A move-out is made from the move-in, so the comparison is there before you begin</p>
          </div>
          <div class="panel__body">
            <form method="post" action="/app/inspections/new" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="unit_id">Unit</label>
                  <select id="unit_id" name="unit_id" required>
                    ${units.map((u) => html`<option value="${u.id}"${attr("data-lease", u.lease_id || "")}>${u.line1}${u.label ? `, unit ${u.label}` : ""}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="kind">Which</label>
                  <select id="kind" name="kind" required>
                    <option value="movein">Move-in</option>
                    <option value="moveout">Move-out</option>
                    <option value="periodic">Periodic</option>
                  </select>
                  <span class="field__help">A move-out copies the signed move-in for that
                    tenancy, if there is one.</span>
                </div>
              </div>
              <div class="field" style="max-width:16rem">
                <label for="performed_on">Date</label>
                <input id="performed_on" name="performed_on" type="date" value="${today()}" required />
              </div>
              <button class="pill solid sm" type="submit">Start</button>
            </form>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>All of them</h2></div>
          <div class="panel__body panel__body--flush">
            ${rows.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Where</th><th class="shrink">Which</th><th>Date</th>
                <th class="shrink">State</th><th class="num">Lines left</th><th class="shrink"></th></tr></thead>
              <tbody>${rows.map((r) => html`
                <tr>
                  <td><a href="/app/inspections/${r.id}">${r.line1}${r.unit_label ? `, unit ${r.unit_label}` : ""}</a></td>
                  <td class="shrink">${KIND_LABEL[r.kind] || r.kind}</td>
                  <td class="shrink">${human(r.performed_on)}</td>
                  <td class="shrink"><span class="chip"${attr("data-tone",
                    r.status === "signed" ? "ok" : r.status === "complete" ? null : "warn")}>${r.status}</span></td>
                  <td class="num">${r.unmarked || ""}</td>
                  <td class="shrink"><a class="pill outline sm" href="/app/inspections/${r.id}">Open</a></td>
                </tr>`)}</tbody>
            </table></div>` : empty("None yet",
              "Start one above. A move-in is the record a deposit dispute turns on.")}
          </div>
        </div>`,
    }));
  });

  router.get("/app/inspections/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const detail = await inspectionDetail({ companyId: cid, inspectionId: ctx.params.id });
    const where = `${detail.line1}${detail.unit_label ? `, unit ${detail.unit_label}` : ""}`;
    const comparing = Boolean(detail.compares_to);
    const done = detail.status !== "draft";
    const signed = detail.status === "signed";

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "properties", counts: await navCounts(cid),
      title: `${KIND_LABEL[detail.kind] || detail.kind} — ${where}`,
      subtitle: `${human(detail.performed_on)} · ${detail.performed_by || "—"}`,
      actions: html`<a class="pill outline sm" href="/app/inspections">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${signed ? notice(intact(detail) ? "ok" : "danger",
          intact(detail) ? "Signed" : "Signed, and the record has been altered",
          intact(detail)
            ? html`${detail.signed_name} on ${humanStamp(detail.signed_at)}. What they signed is
                kept exactly as it stood.`
            : "Its stored hash no longer matches its own text. Do not rely on it.") : ""}

        ${detail.kind === "moveout" && !comparing ? notice("warn", "Nothing to compare with",
          "There is no signed move-in inspection for this tenancy, so this cannot say what "
          + "changed — only what the condition is now. That is still worth recording.") : ""}

        ${detail.kind === "moveout" && comparing && done ? html`
          ${detail.worse.length
            ? notice("warn", `${detail.worse.length} line(s) got worse`,
                html`These are the only ones that can justify keeping any of the deposit.
                  They are offered as deductions on the
                  <a href="/app/deposits">deposit return</a>.`)
            : notice("ok", "Nothing got worse", "The whole deposit goes back.")}` : ""}

        ${detail.rooms.map((room) => html`
          <div class="panel">
            <div class="panel__head"><h2>${room.name}</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr>
                  <th>Item</th>
                  ${comparing ? html`<th class="shrink">At move-in</th>` : ""}
                  <th class="shrink">${comparing ? "Now" : "Condition"}</th>
                  <th>Note</th>
                  <th class="shrink">Photos</th>
                </tr></thead>
                <tbody>${room.items.map((item) => html`
                  <tr${attr("style", item.changed ? "background:var(--warn-bg,#fff8e6)" : null)}>
                    <td>${item.label}
                      ${item.changed ? html`<span class="cellsub" style="color:var(--danger)">worse than at move-in</span>` : ""}</td>
                    ${comparing ? html`<td class="shrink"><span class="cellsub">${conditionLabel(item.before_condition)}</span>
                      ${item.before_note ? html`<span class="cellsub">${item.before_note}</span>` : ""}</td>` : ""}
                    <td class="shrink">${signed
                      ? html`<span class="chip chip--plain">${conditionLabel(item.condition)}</span>`
                      : html`
                        <form method="post" action="/app/inspections/${detail.id}/item/${item.id}"
                              enctype="multipart/form-data" class="formgrid" style="gap:0.35rem">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <select name="condition" style="min-width:8rem">
                            <option value="">—</option>
                            ${CONDITIONS.map((c) => html`<option value="${c.key}"${attr("selected", item.condition === c.key)}>${c.label}</option>`)}
                          </select>
                          <input name="note" type="text" maxlength="200" placeholder="Note"
                                 value="${item.note || ""}" />
                          <input name="photos" type="file" accept="image/*" capture="environment" multiple />
                          <button class="pill outline sm" type="submit">Save</button>
                        </form>`}</td>
                    <td>${signed ? (item.note || "") : ""}</td>
                    <td class="shrink">${item.photos.map((p) => html`
                      <a href="${fileUrl(p.path)}" target="_blank">
                        <img src="${fileUrl(p.path)}" alt="" style="width:2.5rem;height:2.5rem;object-fit:cover;border-radius:0.25rem;margin:0.1rem" />
                      </a>`)}</td>
                  </tr>`)}</tbody>
              </table></div>
            </div>
          </div>`)}

        ${signed ? "" : html`
          <div class="panel">
            <div class="panel__head"><h2>Add a line</h2>
              <p>Anything the checklist does not cover</p>
            </div>
            <div class="panel__body">
              <form method="post" action="/app/inspections/${detail.id}/item" class="formgrid">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="formgrid formgrid--2">
                  <div class="field">
                    <label for="room">Room</label>
                    <input id="room" name="room" type="text" maxlength="60" placeholder="Kitchen" />
                  </div>
                  <div class="field">
                    <label for="label">What</label>
                    <input id="label" name="label" type="text" maxlength="120" required
                           placeholder="Dishwasher" />
                  </div>
                </div>
                <button class="pill outline sm" type="submit">Add</button>
              </form>
            </div>
          </div>`}

        ${detail.status === "draft" ? html`
          <div class="panel">
            <div class="panel__body">
              ${detail.unmarked ? notice("warn", `${detail.unmarked} line(s) still blank`,
                "An inspection with gaps is worse than none, because the gaps are where the "
                + "argument happens.") : ""}
              <form method="post" action="/app/inspections/${detail.id}/complete">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill solid sm" type="submit">Finish</button>
              </form>
            </div>
          </div>` : ""}

        ${detail.status === "complete" && detail.kind === "movein" ? html`
          <div class="panel">
            <div class="panel__head"><h2>The tenant signs</h2>
              <p>On this screen, here, with you</p>
            </div>
            <div class="panel__body">
              ${notice("info", "What signing does",
                html`It freezes this record exactly as it reads now, with a hash over it, and
                  it is what a deposit dispute turns on a year from now. You are witnessing
                  it as <b>${ctx.staff.name}</b>.`)}
              <div class="tablewrap" style="margin-top:1rem"><table class="data"><tbody><tr><td>
                <pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;font-size:0.85em">${renderInspection(detail)}</pre>
              </td></tr></tbody></table></div>
              <form method="post" action="/app/inspections/${detail.id}/sign" class="formgrid"
                    style="margin-top:1rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="field" style="max-width:22rem">
                  <label for="typed_name">Tenant types their full name</label>
                  <input id="typed_name" name="typed_name" type="text" required
                         autocomplete="off" />
                </div>
                <button class="pill solid sm" type="submit">Sign</button>
              </form>
            </div>
          </div>` : ""}`,
    }));
  });

  /* --- writing ------------------------------------------------------------ */

  router.post("/app/inspections/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const kind = String(ctx.fields.kind || "movein");
    const unitId = String(ctx.fields.unit_id || "");
    const performedOn = String(ctx.fields.performed_on || today()).slice(0, 10);
    const back = (m) => redirect(ctx.res, `/app/inspections?m=${encodeURIComponent(m)}`);

    if (!KINDS.includes(kind)) return back("That is not a kind of inspection.");

    const lease = await get(
      `SELECT id FROM lease WHERE unit_id = ? AND company_id = ? AND status = 'active' LIMIT 1`,
      unitId, cid);

    let inspection;
    try {
      if (kind === "moveout") {
        /* A move-out needs the tenancy, which may already have ended — the
           most recent one for this unit is the one being moved out of. */
        const ending = lease || await get(
          `SELECT id FROM lease WHERE unit_id = ? AND company_id = ?
            ORDER BY COALESCE(moveout_date, end_date, start_date) DESC LIMIT 1`, unitId, cid);
        if (!ending) return back("There is no tenancy on that unit to move out of.");
        inspection = await startMoveOut({
          companyId: cid, leaseId: ending.id, performedOn, by: ctx.staff.name });
      } else {
        inspection = await startInspection({
          companyId: cid, unitId, leaseId: lease?.id || null,
          kind, performedOn, by: ctx.staff.name });
      }
    } catch (err) {
      if (err instanceof InspectionRefused) return back(err.message);
      throw err;
    }

    redirect(ctx.res, `/app/inspections/${inspection.id}`);
  });

  router.post("/app/inspections/:id/item/:itemId", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res,
      `/app/inspections/${ctx.params.id}${m ? `?m=${encodeURIComponent(m)}` : ""}`);

    try {
      await setCondition({
        companyId: cid, itemId: ctx.params.itemId,
        condition: String(ctx.fields.condition || "") || null,
        note: ctx.fields.note,
      });
    } catch (err) {
      if (err instanceof InspectionRefused) return back(err.message);
      throw err;
    }

    const { stored, problems } = await storeMany(ctx.files, "photos");
    for (const file of stored) {
      await attachPhoto({
        companyId: cid, inspectionId: ctx.params.id, itemId: ctx.params.itemId, file });
    }
    back(problems.length ? problems.join(" ") : null);
  });

  router.post("/app/inspections/:id/item", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res,
      `/app/inspections/${ctx.params.id}${m ? `?m=${encodeURIComponent(m)}` : ""}`);
    try {
      await addItem({
        companyId: cid, inspectionId: ctx.params.id,
        room: ctx.fields.room, label: ctx.fields.label });
    } catch (err) {
      if (err instanceof InspectionRefused) return back(err.message);
      throw err;
    }
    back(null);
  });

  router.post("/app/inspections/:id/complete", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res,
      `/app/inspections/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    try {
      await completeInspection({ companyId: cid, inspectionId: ctx.params.id });
    } catch (err) {
      if (err instanceof InspectionRefused) return back(err.message);
      throw err;
    }
    back("Finished.");
  });

  router.post("/app/inspections/:id/sign", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res,
      `/app/inspections/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    try {
      await signInspection({
        companyId: cid, inspectionId: ctx.params.id,
        typedName: ctx.fields.typed_name, ip: clientIp(ctx.req),
      });
    } catch (err) {
      if (err instanceof InspectionRefused) return back(err.message);
      throw err;
    }
    await insert("audit_log", {
      id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
      entity: "inspection", entity_id: ctx.params.id, action: "signed",
      detail: `witnessed by ${ctx.staff.name}`,
    });
    back("Signed. This is the record a deposit dispute turns on.");
  });
}
