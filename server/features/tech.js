/* F5  The technician's view.

   `/app/jobs` already listed the jobs assigned to one person. It could not be
   worked from: no way to say you had arrived, add a photo, record a part or
   close the job. A technician standing in a stairwell had to ring the office
   and have somebody at a desk do it. This is the rest of it.

   Phone first, and that is not a style choice — it is the only place this
   screen is ever used. One column, big targets, and every action a form that
   posts. There is no JavaScript on this page at all, so it works with one bar
   of signal and a browser that gave up on the stylesheet.

   ## Check-in records a time and deliberately not a place

   The obvious version of this captures GPS so the office can prove the
   technician was where they said they were. That is staff surveillance. It
   needs a permission this application denies outright in its
   Permissions-Policy, it changes what the product is for, and it is a
   decision for a company to take deliberately rather than inherit from a
   default somebody chose on their behalf. The button records that they said
   they arrived, and when.

   ## Authority is per record, not per role

   `maintenance.own` means exactly what it says: the jobs assigned to me. So
   every handler loads the work order scoped to this staff member in the same
   query that finds it, rather than loading it and then checking. A manager
   who wants somebody else's job has `/app/maintenance/:id` and the capability
   that goes with it. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, humanStamp, human, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { storeMany, fileUrl } from "../lib/files.js";
import { todayIn } from "../lib/timezone.js";
import { closeOut, event, entryLabel } from "./maintenance.js";

const SEVERITY_TONE = { emergency: "danger", urgent: "warn", normal: null };

export function registerTech(router) {
  /* --- the list ----------------------------------------------------------- */

  router.get("/app/jobs", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT timezone FROM company WHERE id = ?", cid);
    const localToday = todayIn(company.timezone);

    const jobs = await all(
      `SELECT w.*, u.label, p.line1, p.city, p.state, p.zip
         FROM work_order w
         JOIN unit u ON u.id = w.unit_id
         JOIN property p ON p.id = u.property_id
        WHERE w.company_id = ? AND w.assigned_staff_id = ?
          AND w.status NOT IN ('complete', 'cancelled')
        ORDER BY
          CASE w.severity WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
          w.scheduled_start NULLS LAST,
          w.created_at`, cid, ctx.staff.id);

    /* Today is: booked for today, already started, or booked for a day that
       has been and gone. An overdue job belongs at the top of today's list
       rather than in a section called "later", which is where it would sit if
       this sorted on the date alone. */
    const isToday = (j) =>
      Boolean(j.checked_in_at && !j.checked_out_at)
      || !j.scheduled_start
      || j.scheduled_start.slice(0, 10) <= localToday;

    const now = jobs.filter(isToday);
    const later = jobs.filter((j) => !isToday(j));

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "jobs", counts: {},
      title: "Your jobs",
      subtitle: now.length
        ? `${now.length} job${now.length === 1 ? "" : "s"} today · ${human(today())}`
        : `Nothing today · ${human(today())}`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${now.length ? html`<div class="qlist">${now.map(jobRow)}</div>` : ""}

        ${later.length ? html`
          <div class="panel" style="margin-top:1.25rem">
            <div class="panel__head"><h2>Booked for later</h2><p>${later.length}</p></div>
            <div class="panel__body panel__body--flush">
              ${later.map((j) => html`
                <a class="minirow" href="/app/jobs/${j.id}">
                  <div class="minirow__main">
                    <b>${j.summary}</b>
                    <span class="cellsub">${humanStamp(j.scheduled_start)} · ${j.line1}${j.label ? `, unit ${j.label}` : ""}</span>
                  </div>
                </a>`)}
            </div>
          </div>` : ""}

        ${jobs.length ? "" : empty("Nothing assigned to you",
          "Jobs appear here when a manager assigns them to you.")}`,
    }));
  });

  /* --- one job ------------------------------------------------------------ */

  router.get("/app/jobs/:id", async (ctx) => {
    const wo = await mine(ctx);
    const parts = await all(
      "SELECT * FROM work_order_part WHERE work_order_id = ? ORDER BY created_at", wo.id);
    const photos = await all(
      "SELECT * FROM work_order_photo WHERE work_order_id = ? ORDER BY created_at", wo.id);
    const notes = await all(
      `SELECT * FROM work_order_event WHERE work_order_id = ? AND kind IN ('note', 'arrived', 'left')
        ORDER BY at DESC LIMIT 20`, wo.id);

    const partsTotal = parts.reduce((n, p) => n + Number(p.cost_cents), 0);
    /* What happens to the number they are about to type. A technician told
       afterwards that their figure was replaced reads it as the application
       losing their work. */
    const { costOutlook } = await import("../lib/repaircost.js");
    const outlook = await costOutlook(ctx.staff.company_id, wo);
    const address = [wo.line1, wo.city, wo.state, wo.zip].filter(Boolean).join(", ");
    const onSite = Boolean(wo.checked_in_at) && !wo.checked_out_at;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "jobs", counts: {},
      title: wo.summary,
      subtitle: `${wo.reference} · ${wo.line1}${wo.label ? `, unit ${wo.label}` : ""}`,
      actions: html`<a class="pill outline sm" href="/app/jobs">All jobs</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, decodeURIComponent(ctx.query.e)) : ""}

        ${wo.severity === "emergency"
          ? notice("danger", "Emergency", "This one was flagged at intake. If it is unsafe, ring the tenant before you travel.")
          : ""}

        <div class="panel">
          <div class="panel__head">
            <h2>Where and what</h2>
            <span class="chip"${attr("data-tone", SEVERITY_TONE[wo.severity])}>${wo.severity}</span>
          </div>
          <div class="panel__body">
            <dl class="dl">
              <div><dt>Address</dt><dd>${address}</dd></div>
              ${wo.label ? html`<div><dt>Unit</dt><dd>${wo.label}</dd></div>` : ""}
              <div><dt>Entry</dt><dd>${entryLabel(wo.entry_permission)}</dd></div>
              ${wo.access_note ? html`<div><dt>Access</dt><dd>${wo.access_note}</dd></div>` : ""}
              ${wo.detail ? html`<div><dt>Detail</dt><dd>${wo.detail}</dd></div>` : ""}
              ${wo.scheduled_start ? html`<div><dt>Booked</dt><dd>${humanStamp(wo.scheduled_start)}</dd></div>` : ""}
            </dl>

            <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.25rem">
              <!-- A plain maps URL. No SDK, no key, no third party loaded into
                   the page, and it opens whichever map app the phone prefers. -->
              <a class="pill solid" target="_blank" rel="noopener"
                 href="https://maps.google.com/?q=${encodeURIComponent(address)}">Directions</a>
              ${wo.reported_by_phone
                ? html`<a class="pill outline" href="tel:${wo.reported_by_phone}">Call the tenant</a>`
                : ""}
            </div>
          </div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <div class="panel__head">
            <h2>On site</h2>
            ${onSite ? html`<span class="chip" data-tone="brand">here now</span>` : ""}
          </div>
          <div class="panel__body">
            <dl class="dl">
              <div><dt>Arrived</dt><dd>${wo.checked_in_at ? humanStamp(wo.checked_in_at) : "not yet"}</dd></div>
              ${wo.checked_out_at ? html`<div><dt>Left</dt><dd>${humanStamp(wo.checked_out_at)}</dd></div>` : ""}
            </dl>
            <form method="post" action="/app/jobs/${wo.id}/${onSite ? "check-out" : "check-in"}" style="margin-top:1rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <button class="pill ${onSite ? "outline" : "solid"}" type="submit">
                ${onSite ? "I have finished here" : wo.checked_out_at ? "Back on site" : "I have arrived"}
              </button>
            </form>
            <p class="field__help" style="margin-top:.75rem">
              This records the time only. It does not record where you are.
            </p>
          </div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <div class="panel__head"><h2>Parts and materials</h2><p>${parts.length ? usd(partsTotal) : "0"}</p></div>
          ${parts.length ? html`
            <div class="panel__body panel__body--flush">
              ${parts.map((p) => html`
                <div class="minirow">
                  <div class="minirow__main">
                    <b>${p.description}</b>
                    <span class="cellsub">${usd(p.cost_cents)} · ${humanStamp(p.created_at)}</span>
                  </div>
                  <form method="post" action="/app/jobs/${wo.id}/part/remove">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <input type="hidden" name="part_id" value="${p.id}" />
                    <button class="pill outline sm" type="submit">Remove</button>
                  </form>
                </div>`)}
            </div>` : ""}
          <div class="panel__body"${attr("style", parts.length ? "border-top:1px solid var(--hairline)" : null)}>
            <form method="post" action="/app/jobs/${wo.id}/part" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="description">What you used</label>
                <input id="description" name="description" type="text" required
                       placeholder="2m of 15mm copper" autocomplete="off" />
              </div>
              <div class="field">
                <label for="cost">What it cost</label>
                <input id="cost" name="cost" type="text" inputmode="decimal" placeholder="14.60" />
              </div>
              <button class="pill outline" type="submit">Add it</button>
            </form>
          </div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <div class="panel__head"><h2>Photos</h2><p>${photos.length}</p></div>
          ${photos.length ? html`
            <div class="panel__body">
              <div class="thumbs">
                ${photos.map((p) => html`
                  <a href="${fileUrl(p.path)}" target="_blank">
                    <img src="${fileUrl(p.path)}" alt="${p.phase}" loading="lazy" />
                  </a>`)}
              </div>
            </div>` : ""}
          <div class="panel__body"${attr("style", photos.length ? "border-top:1px solid var(--hairline)" : null)}>
            <form method="post" action="/app/jobs/${wo.id}/photos" enctype="multipart/form-data" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="photos">Add a photo</label>
                <!-- capture="environment" opens the back camera rather than
                     the photo library, which is what somebody standing in
                     front of the problem wants. -->
                <input id="photos" name="photos" type="file" accept="image/*" capture="environment" multiple />
              </div>
              <button class="pill outline" type="submit">Upload</button>
            </form>
          </div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <div class="panel__head"><h2>Notes</h2></div>
          <div class="panel__body">
            <form method="post" action="/app/jobs/${wo.id}/note" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="note">Add a note</label>
                <input id="note" name="note" type="text" required placeholder="Isolated the supply, waiting on a part" />
                <span class="field__help">The tenant can read this on their status page.</span>
              </div>
              <button class="pill outline" type="submit">Save it</button>
            </form>
          </div>
          ${notes.length ? html`
            <div class="panel__body panel__body--flush" style="border-top:1px solid var(--hairline)">
              ${notes.map((e) => html`
                <div class="minirow">
                  <div class="minirow__main">
                    <b>${e.kind === "arrived" ? "Arrived" : e.kind === "left" ? "Left" : e.note}</b>
                    <span class="cellsub">${humanStamp(e.at)} · ${e.actor}</span>
                  </div>
                </div>`)}
            </div>` : ""}
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <div class="panel__head"><h2>Finish the job</h2></div>
          ${outlook.reason
            ? html`<div class="panel__body">${notice("warn", "Already billed", outlook.reason)}</div>`
            : ""}
          <div class="panel__body">
            <form method="post" action="/app/jobs/${wo.id}/complete"
                  enctype="multipart/form-data" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="field">
                <label for="actual">Total cost</label>
                <input id="actual" name="actual" type="text" inputmode="decimal"
                       value="${partsTotal ? (partsTotal / 100).toFixed(2) : ""}" placeholder="0.00" />
                <span class="field__help">
                  ${outlook.reason ? html`${outlook.reason}`
                    : outlook.warning ? html`${outlook.warning}`
                    : html`${parts.length
                        ? "Filled in from the parts above. Change it if labour or anything else should be included."
                        : "Leave it empty if somebody at the office is invoicing this."}
                       It posts to the owner's ledger with this job attached.`}
                </span>
              </div>
              <div class="field">
                <label for="cnote">What you did</label>
                <input id="cnote" name="note" type="text" placeholder="Replaced supply line and trap" />
              </div>
              <div class="field">
                <label for="cphotos">Photos of the finished work</label>
                <input id="cphotos" name="photos" type="file" accept="image/*" capture="environment" multiple />
              </div>
              <button class="pill solid" type="submit">Mark it complete</button>
              <span class="field__help">This closes the job and tells the tenant.</span>
            </form>
          </div>
        </div>`,
    }));
  });

  /* --- working it --------------------------------------------------------- */

  router.post("/app/jobs/:id/check-in", async (ctx) => {
    const wo = await mine(ctx);
    await tx(async () => {
      await update("work_order", wo.id, {
        checked_in_at: stamp(), checked_out_at: null, checked_in_by: ctx.staff.id,
      });
      /* Visible to the tenant: somebody waiting in for a repair wants to know
         the engineer has arrived, and this is the cheapest honest way to say
         it. */
      await event(wo.id, ctx.staff.name, "arrived", null, 1);
    });
    back(ctx, wo, "Arrival recorded.");
  });

  router.post("/app/jobs/:id/check-out", async (ctx) => {
    const wo = await mine(ctx);
    if (!wo.checked_in_at) throw new BadRequest("Record arriving before leaving.");
    await tx(async () => {
      await update("work_order", wo.id, { checked_out_at: stamp() });
      await event(wo.id, ctx.staff.name, "left", null, 1);
    });
    back(ctx, wo, "Recorded. The job is still open.");
  });

  router.post("/app/jobs/:id/note", async (ctx) => {
    const wo = await mine(ctx);
    const note = String(ctx.fields.note || "").trim();
    if (!note) return back(ctx, wo, "Nothing to save.");
    await event(wo.id, ctx.staff.name, "note", note, 1);
    back(ctx, wo, "Note added.");
  });

  router.post("/app/jobs/:id/photos", async (ctx) => {
    const wo = await mine(ctx);
    const { stored, problems } = await storeMany(ctx.files, "photos");
    for (const s of stored) {
      await insert("work_order_photo", {
        id: id(), work_order_id: wo.id, path: s.path, phase: "progress",
        mime: s.mime, bytes: s.bytes, created_at: stamp(),
      });
    }
    /* Said plainly rather than rounded up to "uploaded": a photo that was
       rejected for being the wrong type has not been stored, and a technician
       who thinks it has will not take another. */
    if (problems.length) return back(ctx, wo, null, problems.join(" "));
    back(ctx, wo, stored.length
      ? `${stored.length} photo${stored.length === 1 ? "" : "s"} added.`
      : "No photo was chosen.");
  });

  router.post("/app/jobs/:id/part", async (ctx) => {
    const wo = await mine(ctx);
    const description = String(ctx.fields.description || "").trim();
    if (!description) return back(ctx, wo, null, "Say what the part was.");

    /* A cost is optional. Somebody recording "the tenant's own washer" has
       used a part and spent nothing, and forcing a zero would be a lie about
       what was asked. */
    const cost = parseMoney(ctx.fields.cost);
    await insert("work_order_part", {
      id: id(), company_id: ctx.staff.company_id, work_order_id: wo.id,
      description: description.slice(0, 200),
      cost_cents: cost != null ? Math.abs(cost) : 0,
      added_by: ctx.staff.id, created_at: stamp(),
    });
    back(ctx, wo, "Added.");
  });

  router.post("/app/jobs/:id/part/remove", async (ctx) => {
    const wo = await mine(ctx);
    /* Scoped to this job in the DELETE itself. A part id from another job
       would otherwise be removable by anybody holding one of their own. */
    await run("DELETE FROM work_order_part WHERE id = ? AND work_order_id = ?",
      String(ctx.fields.part_id || ""), wo.id);
    back(ctx, wo, "Removed.");
  });

  router.post("/app/jobs/:id/complete", async (ctx) => {
    const wo = await mine(ctx);

    /* The same close-out a manager runs, not a second copy of it. It posts the
       expense to the owner's ledger inside one transaction, and a technician
       finishing a job on a phone must do exactly that and nothing less. */
    const { message } = await closeOut({
      companyId: ctx.staff.company_id, wo, staff: ctx.staff,
      actualCents: parseMoney(ctx.fields.actual),
      files: ctx.files, note: ctx.fields.note,
    });

    /* Back to the list rather than to the job. The job is finished; what the
       person holding the phone wants next is the next one. */
    redirect(ctx.res, `/app/jobs?m=${encodeURIComponent(message)}`);
  });
}

/* --- shared --------------------------------------------------------------- */

/* The whole of the authorisation on this surface, in the query that finds the
   row. `maintenance.own` is the capability; this is what "own" means. */
async function mine(ctx) {
  /* `one` raises NotFound, which the application renders as a 404. A job
     assigned to somebody else and a job that does not exist look identical
     from here, which is the right answer to both. */
  return await one(
    `SELECT w.*, u.label, p.line1, p.city, p.state, p.zip
       FROM work_order w
       JOIN unit u ON u.id = w.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE w.id = ? AND w.company_id = ? AND w.assigned_staff_id = ?`,
    ctx.params.id, ctx.staff.company_id, ctx.staff.id);
}

function back(ctx, wo, message, error = null) {
  const q = error
    ? `e=${encodeURIComponent(error)}`
    : `m=${encodeURIComponent(message || "Saved.")}`;
  redirect(ctx.res, `/app/jobs/${wo.id}?${q}`);
}

const jobRow = (j) => html`
  <div class="q"${attr("data-tone", SEVERITY_TONE[j.severity])}>
    <span class="q__icon">${j.severity === "emergency" ? icons.alert : icons.wrench}</span>
    <div class="q__body">
      <a class="q__title" href="/app/jobs/${j.id}">${j.summary}</a>
      <span class="q__why">${j.reference} · ${j.category}${j.checked_in_at && !j.checked_out_at ? " · on site" : ""}</span>
      <span class="q__where">${j.line1}${j.label ? `, unit ${j.label}` : ""}, ${j.city}</span>
    </div>
    <span class="q__act">
      <a class="pill outline sm" href="/app/jobs/${j.id}">Open</a>
    </span>
  </div>`;

