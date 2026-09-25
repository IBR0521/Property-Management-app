/* F2  Owner communication.

   Owners cannot judge whether the job was done well; they can only judge
   whether they felt informed. So this feature is deliberately about producing
   one artefact — a statement with the receipts attached — and one decision
   surface: approve or decline a repair over threshold.

   Both owner-facing pages are tokenised links, not accounts. An owner who has
   to remember a password never logs in, and a statement nobody opens is the
   same as no statement. */
import { all, get, insert, update, one, tx } from "../lib/db.js";
import { id, token } from "../lib/ids.js";
import { stamp, human, humanStamp, today, prevMonthRange, monthRange } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, publicPage, notice, empty, tabs, PEOPLE_TABS } from "../views/layout.js";
import { icons } from "../views/icons.js";
import { navCounts } from "../lib/counts.js";
import { storeMany, DOC_TYPES, fileUrl } from "../lib/files.js";
import { event } from "./maintenance.js";
import { postMoney } from "../lib/ledger.js";
import { linkOwner } from "../lib/identity.js";

export function registerOwners(router) {
  /* --- list --------------------------------------------------------------- */
  router.get("/app/owners", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owners = await all(
      `SELECT o.*,
              (SELECT COUNT(*) FROM property p WHERE p.owner_id = o.id) AS properties,
              (SELECT COUNT(*) FROM unit u JOIN property p ON p.id = u.property_id WHERE p.owner_id = o.id) AS units,
              (SELECT COUNT(*) FROM owner_approval a WHERE a.owner_id = o.id AND a.status = 'pending') AS pending,
              (SELECT MAX(period_end) FROM owner_statement s WHERE s.owner_id = o.id) AS last_statement
         FROM owner o WHERE o.company_id = ? ORDER BY o.name`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(cid),
      title: "Owners", subtitle: `${owners.length} owner${owners.length === 1 ? "" : "s"}`,
      actions: html`<a class="pill solid sm" href="/app/owners/new">Add owner</a>`,
      body: html`
        ${tabs(PEOPLE_TABS, "owners")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${owners.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>Owner</th><th class="num">Doors</th><th>Approval threshold</th><th>Last statement</th><th class="shrink"></th><th class="shrink"></th></tr></thead>
            <tbody>${owners.map((o) => html`
              <tr>
                <td><a href="/app/owners/${o.id}">${o.name}</a>
                  <span class="cellsub">${o.email || "no email on file"}</span></td>
                <td class="num">${o.units}<span class="cellsub">${o.properties} propert${o.properties === 1 ? "y" : "ies"}</span></td>
                <td>${usd(o.approval_threshold_cents)}</td>
                <td>${o.last_statement ? human(o.last_statement) : html`<span style="color:var(--ink-soft)">never</span>`}</td>
                <td class="shrink">${o.pending ? html`<span class="chip" data-tone="warn">${o.pending} waiting</span>` : ""}</td>
                <td class="shrink"><a class="pill outline sm" href="/app/owners/${o.id}"
                  ${attr("aria-label", `Open ${o.name}`)}>Open</a></td>
              </tr>`)}</tbody>
          </table></div>` : empty("No owners yet", "Add an owner first — a building has to belong to somebody.")}
        </div></div>`,
    }));
  });

  /* --- add and edit ------------------------------------------------------
     Registered above /app/owners/:id on purpose: routes match in order, and
     ":id" would otherwise swallow the literal word "new". ---------------- */

  router.get("/app/owners/new", async (ctx) => {
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(ctx.staff.company_id),
      title: "Add an owner",
      subtitle: "The person or company whose building you manage",
      body: ownerForm({ csrf: ctx.csrf, owner: null, error: ctx.query.e }),
    }));
  });

  router.post("/app/owners/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const name = String(f.name || "").trim();
    if (name.length < 2) return redirect(ctx.res, `/app/owners/new?e=${encodeURIComponent("An owner needs a name.")}`);

    const ownerId = id();
    await insert("owner", {
      id: ownerId, company_id: cid, name,
      email: String(f.email || "").trim() || null,
      phone: String(f.phone || "").trim() || null,
      approval_threshold_cents: thresholdOf(f.threshold),
      statement_day: statementDayOf(f.statement_day),
      notes: String(f.notes || "").trim() || null,
      created_at: stamp(),
    });

    /* So they can sign in and read their own statements rather than waiting
       for one to be emailed. No address, no link, and nothing changes. */
    await linkOwner({ ownerId, source: "staff" });
    redirect(ctx.res, `/app/owners/${ownerId}?m=${encodeURIComponent("Owner added. Add their building next.")}`);
  });

  router.get("/app/owners/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = await one("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(cid),
      title: `Edit ${owner.name}`, subtitle: "Owner details",
      body: ownerForm({ csrf: ctx.csrf, owner, error: ctx.query.e }),
    }));
  });

  router.post("/app/owners/:id/edit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = await one("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const name = String(f.name || "").trim();
    if (name.length < 2) return redirect(ctx.res, `/app/owners/${owner.id}/edit?e=${encodeURIComponent("An owner needs a name.")}`);

    await update("owner", owner.id, {
      name,
      email: String(f.email || "").trim() || null,
      phone: String(f.phone || "").trim() || null,
      approval_threshold_cents: thresholdOf(f.threshold),
      statement_day: statementDayOf(f.statement_day),
      notes: String(f.notes || "").trim() || null,
    });
    /* A corrected address moves the portal access with it. */
    await linkOwner({ ownerId: owner.id, source: "staff" });
    redirect(ctx.res, `/app/owners/${owner.id}?m=${encodeURIComponent("Owner updated.")}`);
  });

  /* --- detail ------------------------------------------------------------- */
  router.get("/app/owners/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = await get("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (!owner) return sendHtml(ctx.res, "Not found", 404);

    const props = await all(
      `SELECT p.*, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id) AS units,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.status = 'occupied') AS occupied
         FROM property p WHERE p.owner_id = ? ORDER BY p.line1`, owner.id);
    const statements = await all(
      "SELECT * FROM owner_statement WHERE owner_id = ? ORDER BY period_end DESC LIMIT 12", owner.id);
    const approvals = await all(
      `SELECT a.*, w.reference, w.summary FROM owner_approval a
         JOIN work_order w ON w.id = a.work_order_id
        WHERE a.owner_id = ? ORDER BY a.requested_at DESC LIMIT 10`, owner.id);
    const ledger = await all(
      `SELECT * FROM ledger_entry WHERE owner_id = ? ORDER BY date DESC, created_at DESC LIMIT 25`, owner.id);
    const last = prevMonthRange(today());

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "people", counts: await navCounts(cid),
      title: owner.name,
      subtitle: `${props.length} propert${props.length === 1 ? "y" : "ies"} · approval threshold ${usd(owner.approval_threshold_cents)}`,
      actions: html`<a class="pill outline sm" href="/app/owners">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${!owner.email ? notice("warn", "No email on file", "Statements and approval requests cannot reach this owner until an address is added.") : ""}

        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head"><h2>Monthly statement</h2></div>
            <div class="panel__body">
              <p style="font-size:0.875rem;color:var(--ink-soft);margin-bottom:1rem">
                Rent, itemised costs with receipts, work done and what is coming up — as one page on a link,
                so there is no password to forget.
              </p>
              <form method="post" action="/app/owners/${owner.id}/statement" class="formgrid">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="formgrid formgrid--2">
                  <div class="field">
                    <label for="from">Period start</label>
                    <input id="from" name="from" type="date" value="${last.start}" required />
                  </div>
                  <div class="field">
                    <label for="to">Period end</label>
                    <input id="to" name="to" type="date" value="${last.end}" required />
                  </div>
                </div>
                <button class="pill solid sm" type="submit">Generate statement</button>
              </form>

              ${statements.length ? html`
                <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                  <thead><tr><th>Period</th><th class="num">Net to owner</th><th class="shrink"></th></tr></thead>
                  <tbody>${statements.map((s) => {
                    const t = JSON.parse(s.totals);
                    return html`<tr>
                      <td>${human(s.period_start)} – ${human(s.period_end)}
                        <span class="cellsub">${s.sent_at ? `sent ${humanStamp(s.sent_at)}` : "not sent"}</span></td>
                      <td class="num">${usd(t.net)}</td>
                      <td class="shrink">
                        <a class="pill outline sm" href="/o/s/${s.token}" target="_blank"
                          ${attr("aria-label", `View the statement for ${human(s.period_start)} to ${human(s.period_end)}`)}>View</a>
                        <a class="pill outline sm" href="/app/owners/${owner.id}/statements/${s.id}/pdf">PDF</a>
                      </td>
                    </tr>`;
                  })}</tbody>
                </table></div>` : ""}
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Approvals</h2><p>Repairs over ${usd(owner.approval_threshold_cents)}</p></div>
            <div class="panel__body panel__body--flush">
              ${approvals.length ? html`<div class="tablewrap"><table class="data">
                <thead><tr><th>Job</th><th class="num">Amount</th><th class="shrink">State</th></tr></thead>
                <tbody>${approvals.map((a) => html`
                  <tr>
                    <td><a href="/app/maintenance/${a.work_order_id}">${a.reference}</a>
                      <span class="cellsub">${a.summary}</span></td>
                    <td class="num">${usd(a.amount_cents)}</td>
                    <td class="shrink"><span class="chip"${attr("data-tone", a.status === "approved" ? "ok" : a.status === "declined" ? "danger" : "warn")}>${a.status}</span></td>
                  </tr>`)}</tbody>
              </table></div>` : empty("Nothing to approve", "Everything so far has been under threshold.")}
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <h2>Properties</h2>
          </div>
          <div class="panel__body panel__body--flush">
            ${props.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Address</th><th class="num">Units</th><th class="num">Occupied</th></tr></thead>
              <tbody>${props.map((p) => html`
                <tr><td>${p.line1}<span class="cellsub">${p.city}, ${p.state} ${p.zip}</span></td>
                    <td class="num">${p.units}</td><td class="num">${p.occupied}</td></tr>`)}</tbody>
            </table></div>` : empty("No properties", "Add them in Setup.")}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <h2>Ledger</h2>
            <p>Reporting only — this is not a trust account</p>
          </div>
          <div class="panel__body">
            <form method="post" action="/app/owners/${owner.id}/ledger" enctype="multipart/form-data" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="kind">Kind</label>
                  <select id="kind" name="kind" required>
                    <option value="rent_payment">Rent received</option>
                    <option value="expense">Expense</option>
                    <option value="management_fee">Management fee</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div class="field">
                  <label for="amount">Amount</label>
                  <input id="amount" name="amount" type="text" inputmode="decimal" required placeholder="1450.00" />
                  <span class="field__help">Expenses and fees are recorded as money out automatically.</span>
                </div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="date">Date</label>
                  <input id="date" name="date" type="date" value="${today()}" required />
                </div>
                <div class="field">
                  <label for="receipt">Receipt <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                  <input id="receipt" name="receipt" type="file" accept="image/*,application/pdf" />
                </div>
              </div>
              <div class="field">
                <label for="memo">Memo</label>
                <input id="memo" name="memo" type="text" required placeholder="September rent — 412 Maple Grove" />
              </div>
              <button class="pill solid sm" type="submit">Add entry</button>
            </form>

            ${ledger.length ? html`
              <div class="tablewrap" style="margin-top:1.25rem"><table class="data">
                <thead><tr><th>Date</th><th>Memo</th><th>Kind</th><th class="num">Amount</th><th class="shrink"></th></tr></thead>
                <tbody>${ledger.map((l) => html`
                  <tr>
                    <td class="shrink">${human(l.date)}</td>
                    <td>${l.memo}${l.work_order_id ? html`<span class="cellsub"><a href="/app/maintenance/${l.work_order_id}">linked job</a></span>` : ""}</td>
                    <td><span class="chip chip--plain">${l.kind.replace(/_/g, " ")}</span></td>
                    <td class="num" style="${l.amount_cents < 0 ? "color:var(--danger)" : ""}">${usd(l.amount_cents, { sign: true })}</td>
                    <td class="shrink">${l.receipt_path ? html`<a class="pill outline sm" href="${fileUrl(l.receipt_path)}" target="_blank">Receipt</a>` : ""}</td>
                  </tr>`)}</tbody>
              </table></div>` : ""}
          </div>
        </div>`,
    }));
  });

  /* --- generate a statement ---------------------------------------------- */
  router.post("/app/owners/:id/statement", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = await one("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const from = String(ctx.fields.from || "");
    const to = String(ctx.fields.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      throw new BadRequest("Give a valid period, with the end on or after the start.");
    }

    const totals = await computeStatement(owner.id, from, to);
    const existing = await get(
      "SELECT * FROM owner_statement WHERE owner_id = ? AND period_start = ? AND period_end = ?",
      owner.id, from, to);

    let tok;
    if (existing) {
      // Regenerating keeps the link the owner may already have, but refreshes
      // the snapshot.
      tok = existing.token;
      await update("owner_statement", existing.id, { totals: JSON.stringify(totals), generated_at: stamp() });
    } else {
      tok = token();
      await insert("owner_statement", {
        id: id(), company_id: cid, owner_id: owner.id,
        period_start: from, period_end: to,
        totals: JSON.stringify(totals), token: tok, generated_at: stamp(),
      });
    }

    if (owner.email) {
      await insert("outbox", {
        id: id(), company_id: cid, channel: "email", to_contact: owner.email,
        subject: `Your statement, ${human(from)} to ${human(to)}`,
        body: `Net to you for the period: ${usd(totals.net)}.\n\n`
          + `Rent collected ${usd(totals.rent)}, costs ${usd(totals.expenses)}, management fee ${usd(totals.fees)}.\n\n`
          + `Full statement with receipts: ${ctx.url.protocol}//${ctx.url.host}/o/s/${tok}`,
        about_type: "owner_statement", about_id: tok, status: "queued", queued_at: stamp(),
      });
    }
    redirect(ctx.res, `/app/owners/${owner.id}?m=${encodeURIComponent("Statement generated.")}`);
  });

  router.post("/app/owners/:id/ledger", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owner = await one("SELECT * FROM owner WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const kind = String(ctx.fields.kind || "");
    /* No "rent_charge" here. Charges are posted per lease per period from
       the lease itself, with the proration and the period recorded; one typed
       against an owner has neither, and would double with the scheduled
       one. */
    const allowed = ["rent_payment", "expense", "management_fee", "other"];
    if (!allowed.includes(kind)) throw new BadRequest("Pick a kind of entry.");
    const magnitude = parseMoney(ctx.fields.amount);
    if (magnitude == null) throw new BadRequest("That amount is not a number.");

    // Sign is derived from the kind so an operator cannot post an expense as
    // income by forgetting a minus.
    const outbound = kind === "expense" || kind === "management_fee";
    const amount = outbound ? -Math.abs(magnitude) : Math.abs(magnitude);
    const { stored, problems } = await storeMany(ctx.files, "receipt", { allow: DOC_TYPES });

    await postMoney({
      companyId: cid, ownerId: owner.id,
      date: String(ctx.fields.date || today()), kind, amountCents: amount,
      memo: String(ctx.fields.memo || "").trim(), source: "manual",
      receiptPath: stored[0] ? stored[0].path : null,
      sourceType: "owner", sourceId: owner.id, postedBy: ctx.staff.id,
    });
    const msg = problems.length ? problems.join(" ") : "Entry added.";
    redirect(ctx.res, `/app/owners/${owner.id}?m=${encodeURIComponent(msg)}`);
  });

  /* --- the statement as a PDF ---------------------------------------------
   *
   * Rendered from `owner_statement.totals` — the snapshot taken when the
   * statement was generated — and never from a fresh query. An owner sent a
   * link in April must see April's figures in April's statement whatever has
   * been posted since, and a paper copy disagreeing with the link it came
   * from is worse than either being stale: only one of them can be checked.
   *
   * Two routes to the same bytes, because there are two people who want it.
   * The owner has a token; a member of staff has a session. Neither is given
   * the other's way in. */
  router.get("/o/s/:tok/pdf", async (ctx) => {
    const s = await get("SELECT * FROM owner_statement WHERE token = ?", ctx.params.tok);
    if (!s) return sendHtml(ctx.res, "Not found", 404);
    await sendStatementPdf(ctx, s);
  });

  router.get("/app/owners/:id/statements/:sid/pdf", async (ctx) => {
    const cid = ctx.staff.company_id;
    /* Scoped to the company in the query that finds it, not checked after. */
    const s = await one(
      "SELECT * FROM owner_statement WHERE id = ? AND owner_id = ? AND company_id = ?",
      ctx.params.sid, ctx.params.id, cid);
    await sendStatementPdf(ctx, s);
  });

  /* --- public: statement -------------------------------------------------- */
  router.get("/o/s/:tok", async (ctx) => {
    const s = await get("SELECT * FROM owner_statement WHERE token = ?", ctx.params.tok);
    if (!s) return sendHtml(ctx.res, "Not found", 404);
    const owner = await one("SELECT * FROM owner WHERE id = ?", s.owner_id);
    const company = await one("SELECT * FROM company WHERE id = ?", s.company_id);

    /* The PDF path has guarded this since it was written; this one did not,
       and it is the page an owner actually opens. A bare parse takes the page
       down twice over: on a snapshot that will not parse, and on one that
       parses to the wrong shape — `t.jobs.length` is read a few lines below,
       and a statement filed before `jobs` was added to the snapshot has no
       such key. Stored JSON outlives the code that wrote it. */
    const t = readTotals(s.totals);
    if (!t) {
      return sendHtml(ctx.res, publicPage({
        company, title: "Statement", heading: "This statement cannot be shown",
        lede: "Its figures could not be read. Ask your manager to generate it again.",
        body: "",
      }), 409);
    }

    if (!s.sent_at) await update("owner_statement", s.id, { sent_at: stamp() });

    sendHtml(ctx.res, publicPage({
      company, title: `Statement ${s.period_start} to ${s.period_end}`,
      heading: `${human(s.period_start)} to ${human(s.period_end)}`,
      lede: `Statement for ${owner.name}`,
      body: html`
        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Rent collected</span><span class="tile__value">${usd(t.rent)}</span></div>
          <div class="tile"><span class="tile__label">Costs</span><span class="tile__value">${usd(t.expenses)}</span></div>
          <div class="tile" data-tone="ok"><span class="tile__label">Net to you</span><span class="tile__value">${usd(t.net)}</span></div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Every line</h2><p>Receipts attached where we have them</p></div>
          <div class="panel__body panel__body--flush">
            ${t.lines.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Date</th><th>What</th><th class="num">Amount</th><th class="shrink"></th></tr></thead>
              <tbody>${t.lines.map((l) => html`
                <tr>
                  <td class="shrink">${human(l.date)}</td>
                  <td>${l.memo}<span class="cellsub">${l.kind.replace(/_/g, " ")}</span></td>
                  <td class="num" style="${l.amount_cents < 0 ? "color:var(--danger)" : ""}">${usd(l.amount_cents, { sign: true })}</td>
                  <td class="shrink">${l.receipt_path ? html`<a class="pill outline sm" href="${fileUrl(l.receipt_path)}" target="_blank">Receipt</a>` : ""}</td>
                </tr>`)}</tbody>
            </table></div>` : empty("No entries in this period", "Nothing was recorded between these dates.")}
          </div>
          <div class="panel__foot">
            Rent collected ${usd(t.rent)} · costs ${usd(t.expenses)} · management fee ${usd(t.fees)} · <b>net ${usd(t.net)}</b>
          </div>
        </div>

        ${t.jobs.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Work done</h2><p>${t.jobs.length} job${t.jobs.length === 1 ? "" : "s"} closed in this period</p></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Ref</th><th>Property</th><th>What</th><th class="num">Cost</th></tr></thead>
                <tbody>${t.jobs.map((j) => html`
                  <tr><td class="shrink">${j.reference}</td><td>${j.line1}${j.label ? ` unit ${j.label}` : ""}</td>
                      <td>${j.summary}</td><td class="num">${usd(j.actual_cents)}</td></tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}

        ${t.upcoming.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Coming up</h2></div>
            <div class="panel__body">
              <ul style="display:grid;gap:0.5rem;font-size:0.875rem">
                ${t.upcoming.map((u) => html`<li>${u}</li>`)}
              </ul>
            </div>
          </div>` : ""}`,
      /* One `foot`, not two. An earlier draft added the download link as a
         second `foot:` key in this same object and JavaScript quietly kept
         the last one, so the button rendered nowhere and nothing complained. */
      foot: html`<a class="pill outline sm" href="/o/s/${s.token}/pdf">Download as a PDF</a>
        <span style="display:block;margin-top:.75rem">Questions on any line? Call
        <a href="tel:${company.phone}">${company.phone}</a>. This statement is a report,
        not a trust-account ledger.</span>`,
    }));
  });

  /* --- public: approve or decline a repair -------------------------------- */
  router.get("/o/a/:tok", async (ctx) => {
    const a = await get("SELECT * FROM owner_approval WHERE token = ?", ctx.params.tok);
    if (!a) return sendHtml(ctx.res, "Not found", 404);
    const company = await one("SELECT * FROM company WHERE id = ?", a.company_id);
    const wo = await one(
      `SELECT w.*, u.label, p.line1, v.name AS vendor_name, v.trade
         FROM work_order w JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
         LEFT JOIN vendor v ON v.id = w.vendor_id WHERE w.id = ?`, a.work_order_id);
    const photos = await all("SELECT * FROM work_order_photo WHERE work_order_id = ? AND phase = 'report'", wo.id);

    const decided = a.status !== "pending";
    sendHtml(ctx.res, publicPage({
      company, title: `Approve ${usd(a.amount_cents)}`,
      heading: decided ? `Already ${a.status}` : "A repair needs your approval",
      lede: `${wo.line1}${wo.label ? `, unit ${wo.label}` : ""} · ${wo.reference}`,
      body: html`
        <div class="panel">
          <div class="panel__head"><h2>${wo.summary}</h2>
            <span class="chip"${attr("data-tone", decided ? (a.status === "approved" ? "ok" : "danger") : "warn")}>${a.status}</span>
          </div>
          <div class="panel__body">
            <dl class="dl">
              <div><dt>Estimate</dt><dd><b style="font-weight:500">${usd(a.amount_cents)}</b></dd></div>
              ${wo.vendor_name ? html`<div><dt>Vendor</dt><dd>${wo.vendor_name} (${wo.trade})</dd></div>` : ""}
              <div><dt>Reported</dt><dd>${humanStamp(wo.created_at)}</dd></div>
              <div><dt>Category</dt><dd>${wo.category}</dd></div>
              ${wo.detail ? html`<div><dt>Detail</dt><dd>${wo.detail}</dd></div>` : ""}
            </dl>
            ${photos.length ? html`
              <div style="margin-top:1.25rem"><span class="tile__label">Photos from the tenant</span>
                <div class="thumbs" style="margin-top:0.5rem">
                  ${photos.map((p) => html`<a href="${fileUrl(p.path)}" target="_blank"><img src="${fileUrl(p.path)}" alt="" loading="lazy" /></a>`)}
                </div>
              </div>` : ""}
          </div>
          ${decided
            ? html`<div class="panel__foot">Decided ${humanStamp(a.decided_at)}${a.decided_note ? ` — ${a.decided_note}` : ""}.</div>`
            : html`<div class="panel__body" style="border-top:1px solid var(--hairline)">
                <form method="post" action="/o/a/${a.token}" class="formgrid">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="field">
                    <label for="note">A note back <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                    <input id="note" name="note" type="text" placeholder="Go ahead, but get a second quote if it runs over" />
                  </div>
                  <div class="btnrow">
                    <button class="pill solid" type="submit" name="decision" value="approved">Approve ${usd(a.amount_cents)}</button>
                    <button class="pill outline" type="submit" name="decision" value="declined">Decline</button>
                  </div>
                </form>
              </div>`}
        </div>`,
      foot: html`Rather talk it through? Call <a href="tel:${company.phone}">${company.phone}</a> and quote ${wo.reference}.`,
    }));
  });

  router.post("/o/a/:tok", async (ctx) => {
    const a = await get("SELECT * FROM owner_approval WHERE token = ?", ctx.params.tok);
    if (!a) return sendHtml(ctx.res, "Not found", 404);
    if (a.status !== "pending") return redirect(ctx.res, `/o/a/${a.token}`);

    const decision = ctx.fields.decision === "approved" ? "approved" : "declined";
    const note = String(ctx.fields.note || "").trim() || null;
    const owner = await one("SELECT * FROM owner WHERE id = ?", a.owner_id);

    await tx(async () => {
      await update("owner_approval", a.id, { status: decision, decided_at: stamp(), decided_note: note });
      await update("work_order", a.work_order_id, { status: decision === "approved" ? "assigned" : "triaged" });

      const [{ emit }, { approvalPayload }] = await Promise.all([
        import("../lib/webhooks/events.js"), import("../lib/webhooks/payloads.js")]);
      await emit({
        companyId: a.company_id, event: "owner_approval.decided",
        data: await approvalPayload(a.id),
      });
      await event(a.work_order_id, owner.name,
        decision === "approved" ? "owner_approved" : "owner_declined",
        `${usd(a.amount_cents)}${note ? ` — ${note}` : ""}`, 0);

      for (const s of await all("SELECT email FROM staff WHERE company_id = ? AND active = 1", a.company_id)) {
        await insert("outbox", {
          id: id(), company_id: a.company_id, channel: "email", to_contact: s.email,
          subject: `Owner ${decision}: ${usd(a.amount_cents)}`,
          body: `${owner.name} ${decision} the ${usd(a.amount_cents)} estimate.${note ? `\n\nNote: ${note}` : ""}`,
          about_type: "owner_decision", about_id: a.id, status: "queued", queued_at: stamp(),
        });
      }
    });
    redirect(ctx.res, `/o/a/${a.token}`);
  });
}

async function sendStatementPdf(ctx, statement) {
  const owner = await one("SELECT * FROM owner WHERE id = ?", statement.owner_id);
  const company = await one("SELECT * FROM company WHERE id = ?", statement.company_id);

  /* A snapshot that will not parse is a statement nobody can produce, and
     failing with a stack trace in front of an owner is the wrong way to say
     so. */
  let totals;
  try {
    totals = JSON.parse(statement.totals);
  } catch {
    throw new BadRequest("That statement's figures could not be read. Generate it again.");
  }

  const { buildStatementPdf, statementFileName } = await import("../lib/pdf/statement.js");
  const bytes = await buildStatementPdf({ company, owner, statement, totals });
  const name = statementFileName({
    companyName: company.name, ownerName: owner.name,
    from: statement.period_start, to: statement.period_end,
  });

  ctx.res.writeHead(200, {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "content-length": bytes.length,
    "x-content-type-options": "nosniff",
    /* Somebody's finances. Not in a shared cache, not in the browser's. */
    "cache-control": "no-store, private",
  });
  ctx.res.end(Buffer.from(bytes));
}

/* Snapshotted into owner_statement.totals so a statement an owner already has
   never silently changes underneath them. */
/* A stored snapshot, read defensively.

   Returns null when it cannot be trusted rather than throwing, so the caller
   can say so in words. The list arrives as a list or not at all: a statement
   written before a field existed must not be able to crash the page that
   reads it. */
function readTotals(raw) {
  let t;
  try { t = JSON.parse(raw); } catch { return null; }
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  /* Every field `computeStatement` returns, normalised to the type the page
     reads it as. The list is explicit and matches that function's return on
     purpose: when a field is added there, this is the second place to touch,
     and a missing one here shows up as an empty section rather than a 500. */
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    ...t,
    rent: Number(t.rent) || 0,
    expenses: Number(t.expenses) || 0,
    fees: Number(t.fees) || 0,
    other: Number(t.other) || 0,
    net: Number(t.net) || 0,
    lines: list(t.lines),
    jobs: list(t.jobs),
    upcoming: list(t.upcoming),
  };
}

export async function computeStatement(ownerId, from, to) {
  const lines = await all(
    `SELECT * FROM ledger_entry WHERE owner_id = ? AND date >= ? AND date <= ?
      ORDER BY date, created_at`, ownerId, from, to);

  const sum = (kinds) => lines.filter((l) => kinds.includes(l.kind))
    .reduce((n, l) => n + l.amount_cents, 0);

  const rent = sum(["rent_payment"]);
  const expenses = sum(["expense"]);
  const fees = sum(["management_fee"]);
  const other = sum(["other", "rent_charge", "deposit_held", "deposit_returned"]);
  const net = rent + expenses + fees + other;

  const jobs = await all(
    `SELECT w.reference, w.summary, w.actual_cents, u.label, p.line1
       FROM work_order w
       JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
      WHERE p.owner_id = ? AND w.status = 'complete'
        AND w.closed_at >= ? AND w.closed_at <= ?
      ORDER BY w.closed_at`, ownerId, from, `${to}T23:59:59.999Z`);

  const leaseEnds = await all(
    `SELECT l.end_date, u.label, p.line1 FROM lease l
       JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
      WHERE p.owner_id = ? AND l.status = 'active' AND l.end_date IS NOT NULL
        AND l.end_date <= ((?)::date + 90)::text ORDER BY l.end_date`, ownerId, to);
  const vacant = await all(
    `SELECT u.label, p.line1 FROM unit u JOIN property p ON p.id = u.property_id
      WHERE p.owner_id = ? AND u.status IN ('vacant','turn')`, ownerId);

  const upcoming = [
    ...leaseEnds.map((l) => `Lease ends ${human(l.end_date)} — ${l.line1}${l.label ? ` unit ${l.label}` : ""}`),
    ...vacant.map((v) => `Currently vacant — ${v.line1}${v.label ? ` unit ${v.label}` : ""}`),
  ];

  return { rent, expenses, fees, other, net, lines, jobs, upcoming };
}

/* --- add/edit views -------------------------------------------------------- */

/* A blank threshold means "use the default", not "approve everything". Getting
   that backwards would dispatch unlimited spend without asking anyone. */
function thresholdOf(v) {
  const cents = parseMoney(v);
  return cents != null && cents >= 0 ? cents : 40000;
}

function statementDayOf(v) {
  const n = parseInt(String(v || ""), 10);
  /* 1 to 31. The ceiling was 28 because "29th to 31st do not exist in every
     month", which is true of the number and not of the arrangement: the run
     clamps the day to the length of the month, so 31 means the last day. */
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : 1;
}

function ownerForm({ csrf, owner, error }) {
  const action = owner ? `/app/owners/${owner.id}/edit` : "/app/owners/new";
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>${owner ? "Owner details" : "New owner"}</h2></div>
      <div class="panel__body">
        <form method="post" action="${action}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="name">Name</label>
            <input id="name" name="name" type="text" required maxlength="120"
                   value="${owner ? owner.name : ""}" placeholder="Okafor Holdings LLC" />
            <span class="field__help">A person or a company — whoever the statement is made out to.</span>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" maxlength="160"
                     value="${owner && owner.email ? owner.email : ""}" />
              <span class="field__help">Where approval requests and statements go.</span>
            </div>
            <div class="field">
              <label for="phone">Phone</label>
              <input id="phone" name="phone" type="tel" inputmode="tel" maxlength="40"
                     value="${owner && owner.phone ? owner.phone : ""}" />
            </div>
          </div>

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="threshold">Approval threshold</label>
              <input id="threshold" name="threshold" type="text" inputmode="decimal"
                     value="${owner ? (owner.approval_threshold_cents / 100).toFixed(2) : "400.00"}" />
              <span class="field__help">A repair costing more than this waits for their yes before anyone is dispatched.</span>
            </div>
            <div class="field">
              <label for="statement_day">Statement day</label>
              <input id="statement_day" name="statement_day" type="number" min="1" max="31"
                     value="${owner ? owner.statement_day : 1}" />
              <span class="field__help">Day of the month, where 31 means the last day. The previous
                month's statement is prepared for you on this day; sending it stays your call.</span>
            </div>
          </div>

          <div class="field">
            <label for="notes">Notes <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
            <input id="notes" name="notes" type="text" maxlength="400"
                   value="${owner && owner.notes ? owner.notes : ""}"
                   placeholder="Prefers a call before any work over $1,000" />
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">${owner ? "Save changes" : "Add owner"}</button>
            <a class="pill outline" href="${owner ? `/app/owners/${owner.id}` : "/app/owners"}">Cancel</a>
          </div>
        </form>
      </div>
    </div>`;
}
