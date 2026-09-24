/* F16  The reports section.

   Fourteen reports, a filter bar, and two download buttons. Nothing here
   computes anything — the registry does that, and these routes exist so a
   person can reach it.

   ## Authorisation is per report, not per path

   This application enforces authorisation once, in the app-level gate, and
   that is right almost everywhere. It cannot be right here: the capability
   depends on which report, and a single gate over `/app/reports` would have
   to be either the loosest of them — handing a leasing agent the balance
   sheet — or the strictest, hiding the rent roll from the person whose job it
   is.

   So this is the same shape as the portal and the technician's view: the
   authority is a property of the thing being asked for, and it is asked about
   the record. The index lists only what this person may run, and the handler
   refuses the rest rather than trusting that the index was honest. */
import { all, one, get } from "../lib/db.js";
import { sendHtml, redirect, Forbidden, BadRequest } from "../lib/http.js";
import { html, attr, raw } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { can, roleLabel } from "../lib/auth.js";
import { usd } from "../lib/money.js";
import { human, today } from "../lib/dates.js";
import { toCsv, csvFileName } from "../lib/csv.js";
import { buildReportPdf, pdfFileName } from "../lib/pdf/report.js";
import {
  REPORTS, PARAMS, reportsFor, reportDefinition, runReport, tableFor, subtitleFor,
} from "../lib/reports/index.js";
import {
  PERIODS, saveReport, savedReports, deleteSavedReport,
  scheduleReport, schedulesFor, setScheduleActive, deleteSchedule,
} from "../lib/reports/saved.js";

const REPORT_TABS = [
  { key: "all", href: "/app/reports", label: "All reports" },
  { key: "saved", href: "/app/reports/saved", label: "Saved and scheduled" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n) => {
  const v = Number(n);
  const suffix = v % 100 >= 11 && v % 100 <= 13 ? "th"
    : v % 10 === 1 ? "st" : v % 10 === 2 ? "nd" : v % 10 === 3 ? "rd" : "th";
  return `${v}${suffix}`;
};

export function registerReports(router) {
  /* --- the index ---------------------------------------------------------- */

  router.get("/app/reports", async (ctx) => {
    const cid = ctx.staff.company_id;
    const available = reportsFor(ctx.staff);

    /* Grouped as the registry groups them, in the order they were declared,
       so the list does not reshuffle itself when somebody adds one. */
    const groups = [];
    for (const report of available) {
      let group = groups.find((g) => g.name === report.group);
      if (!group) groups.push((group = { name: report.group, reports: [] }));
      group.reports.push(report);
    }

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "reports", counts: await navCounts(cid),
      title: "Reports",
      subtitle: available.length
        ? `${available.length} you can run`
        : "None you can run",
      body: html`
        ${available.length ? groups.map((group) => html`
          <div class="panel">
            <div class="panel__head"><h2>${group.name}</h2><p>${group.reports.length}</p></div>
            <div class="panel__body panel__body--flush">
              ${group.reports.map((report) => html`
                <a class="minirow" href="/app/reports/${report.key}">
                  <div class="minirow__main">
                    <b>${report.title}</b>
                    <span class="cellsub">${report.description}</span>
                  </div>
                  <span class="pill outline sm">Open</span>
                </a>`)}
            </div>
          </div>`)
        : empty("Nothing here for your account",
            "Reports need access to the money or the portfolio. An administrator can change your role.")}`,
    }));
  });

  /* --- saved and scheduled -------------------------------------------------
   *
   * Registered before `/:key`, and that is load-bearing rather than tidy.
   * Routes match in registration order, so `/app/reports/saved` would
   * otherwise be swallowed by `/app/reports/:key` and answer "there is no
   * report by that name". The same mistake once hid `/app/payouts/bank`
   * behind `/app/payouts/:id`, so there is a test for this one. */
  router.get("/app/reports/saved", async (ctx) => {
    const cid = ctx.staff.company_id;
    const [saved, schedules, people] = await Promise.all([
      savedReports(cid),
      schedulesFor(cid),
      all("SELECT id, name, email, role FROM staff WHERE company_id = ? AND active = 1 ORDER BY name", cid),
    ]);

    /* Only what this person could open anyway. A saved view of a report they
       cannot run is a link that 403s. */
    const mine = saved.filter((r) => !r.need || can(ctx.staff, r.need));
    const byId = new Map(people.map((p) => [p.id, p.name]));

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "reports", counts: await navCounts(cid),
      title: "Saved and scheduled",
      subtitle: `${mine.length} saved · ${schedules.length} scheduled`,
      actions: html`<a class="pill outline sm" href="/app/reports">All reports</a>`,
      body: html`
        ${tabs(REPORT_TABS, "saved")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, decodeURIComponent(ctx.query.e)) : ""}

        <div class="panel">
          <div class="panel__head"><h2>Saved views</h2><p>${mine.length}</p></div>
          <div class="panel__body panel__body--flush">
            ${mine.length ? mine.map((row) => html`
              <div class="minirow">
                <div class="minirow__main">
                  <b>${row.name}</b>
                  <span class="cellsub">${row.title}${row.known ? "" : " — this report no longer exists"}</span>
                </div>
                ${row.known ? html`
                  <a class="pill outline sm" href="/app/reports/${row.report_key}?${new URLSearchParams(row.params).toString()}">Open</a>` : ""}
                <form method="post" action="/app/reports/saved/${row.id}/delete">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <button class="pill outline sm" type="submit">Remove</button>
                </form>
              </div>`)
            : html`<div class="panel__body">${empty("Nothing saved yet",
                "Open a report, set the filters you want, and save the view from there.")}</div>`}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Sent on a schedule</h2><p>${schedules.length}</p></div>
          <div class="panel__body panel__body--flush">
            ${schedules.length ? schedules.map((row) => html`
              <div class="minirow">
                <div class="minirow__main">
                  <b>${row.report_name}</b>
                  <span class="cellsub">
                    ${row.cadence === "monthly" ? `On the ${ordinal(row.day_of)} of each month` : `Every ${WEEKDAYS[row.day_of]}`}
                    · ${row.periodLabel}
                    · to ${row.recipients.map((r) => byId.get(r) || "somebody who has left").join(", ")}
                    ${row.last_sent_on ? ` · last sent ${human(row.last_sent_on)}` : " · not sent yet"}
                  </span>
                  ${row.last_error ? html`<span class="cellsub" style="color:var(--danger)">${row.last_error}</span>` : ""}
                </div>
                <span class="chip"${attr("data-tone", row.active ? "ok" : null)}>${row.active ? "on" : "off"}</span>
                <form method="post" action="/app/reports/schedules/${row.id}/toggle">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <button class="pill outline sm" type="submit">${row.active ? "Turn off" : "Turn on"}</button>
                </form>
                <form method="post" action="/app/reports/schedules/${row.id}/delete">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <button class="pill outline sm" type="submit">Remove</button>
                </form>
              </div>`)
            : html`<div class="panel__body">${empty("Nothing scheduled",
                "A saved view can be sent to people on a monthly or weekly cadence.")}</div>`}
          </div>

          ${mine.filter((r) => r.known).length ? html`
            <div class="panel__body" style="border-top:1px solid var(--hairline)">
              <form method="post" action="/app/reports/saved/new/schedule" class="formgrid">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <div class="formgrid formgrid--2">
                  <div class="field">
                    <label for="saved_report_id">Which saved view</label>
                    <select id="saved_report_id" name="saved_report_id" required>
                      ${mine.filter((r) => r.known).map((r) => html`<option value="${r.id}">${r.name}</option>`)}
                    </select>
                  </div>
                  <div class="field">
                    <label for="period">Covering</label>
                    <select id="period" name="period" required>
                      ${Object.entries(PERIODS).map(([key, spec]) => html`<option value="${key}">${spec.label}</option>`)}
                    </select>
                  </div>
                  <div class="field">
                    <label for="cadence">How often</label>
                    <select id="cadence" name="cadence" required>
                      <option value="monthly">Monthly</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="day_of">On</label>
                    <input id="day_of" name="day_of" type="number" min="0" max="31" value="1" required />
                    <span class="field__help">Monthly: day of the month, 1 to 31, where 31 means the
                      last day. Weekly: 0 is Sunday, 6 is Saturday.</span>
                  </div>
                </div>
                <div class="field">
                  <label for="recipients">Send to</label>
                  <select id="recipients" name="recipients" multiple size="4" required>
                    ${people.map((p) => html`<option value="${p.id}">${p.name} — ${roleLabel(p.role)}</option>`)}
                  </select>
                  <span class="field__help">
                    It sends a link, not a file. Anybody who cannot open the report is refused here
                    rather than emailed something that will not work for them.
                  </span>
                </div>
                <button class="pill solid sm" type="submit">Schedule it</button>
              </form>
            </div>` : ""}
        </div>`,
    }));
  });

  router.post("/app/reports/saved/:id/delete", async (ctx) => {
    await deleteSavedReport(ctx.staff.company_id, ctx.params.id);
    redirect(ctx.res, `/app/reports/saved?m=${encodeURIComponent("Removed.")}`);
  });

  router.post("/app/reports/saved/new/schedule", async (ctx) => {
    const f = ctx.fields;
    const recipients = [].concat(f.recipients || []);
    try {
      await scheduleReport({
        companyId: ctx.staff.company_id,
        savedReportId: String(f.saved_report_id || ""),
        cadence: String(f.cadence || "monthly"),
        dayOf: f.day_of, period: String(f.period || "last_month"),
        recipients, by: ctx.staff.id,
      });
    } catch (err) {
      return redirect(ctx.res, `/app/reports/saved?e=${encodeURIComponent(err.message)}`);
    }
    redirect(ctx.res, `/app/reports/saved?m=${encodeURIComponent("Scheduled. It sends a link, not a file.")}`);
  });

  router.post("/app/reports/schedules/:id/toggle", async (ctx) => {
    const list = await schedulesFor(ctx.staff.company_id);
    const current = list.find((s) => s.id === ctx.params.id);
    if (current) await setScheduleActive(ctx.staff.company_id, current.id, !current.active);
    redirect(ctx.res, `/app/reports/saved?m=${encodeURIComponent("Updated.")}`);
  });

  router.post("/app/reports/schedules/:id/delete", async (ctx) => {
    await deleteSchedule(ctx.staff.company_id, ctx.params.id);
    redirect(ctx.res, `/app/reports/saved?m=${encodeURIComponent("Removed.")}`);
  });

  /* --- one report --------------------------------------------------------- */

  router.get("/app/reports/:key", async (ctx) => {
    const { report, run, table } = await load(ctx);
    const cid = ctx.staff.company_id;
    const query = new URLSearchParams(ctx.query).toString();

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "reports", counts: await navCounts(cid),
      title: report.title,
      subtitle: subtitleFor(report.key, run.params),
      actions: html`
        <a class="pill outline sm" href="/app/reports/${report.key}/csv?${query}">CSV</a>
        <a class="pill outline sm" href="/app/reports/${report.key}/pdf?${query}">PDF</a>
        <a class="pill outline sm" href="/app/reports/saved">Saved</a>`,
      body: html`
        ${tabs(REPORT_TABS, "all")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, decodeURIComponent(ctx.query.e)) : ""}
        <div class="panel">
          ${await filterBar(ctx, report, run.params)}
          ${table.note ? html`<div class="panel__body">${notice(
            /not explained|OUT OF BALANCE|does not balance|truncated/.test(table.note) ? "danger" : null,
            null, table.note)}</div>` : ""}
          <div class="panel__body panel__body--flush">
            ${table.rows.length ? html`
              <div class="tablewrap"><table class="data">
                <thead><tr>${table.columns.map((c) => html`
                  <th${attr("class", c.money ? "num" : null)}>${c.label}</th>`)}</tr></thead>
                <tbody>
                  ${table.rows.map((row) => html`<tr>${table.columns.map((c) => html`
                    <td${attr("class", c.money ? "num" : null)}>${cell(c, row)}</td>`)}</tr>`)}
                </tbody>
                ${table.totals ? html`<tfoot><tr>${table.columns.map((c) => html`
                  <td${attr("class", c.money ? "num" : null)}><b style="font-weight:500">${cell(c, table.totals)}</b></td>`)}</tr></tfoot>` : ""}
              </table></div>`
            : empty("Nothing to show",
                "No postings match this period. Widen the dates, or check the report is the one you meant.")}
          </div>
          <div class="panel__body" style="border-top:1px solid var(--hairline)">
            <form method="post" action="/app/reports/${report.key}/save" class="filterbar">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              ${report.params.map((name) => html`<input type="hidden" name="${name}" value="${run.params[name] ?? ""}" />`)}
              <div class="field">
                <label for="name">Save this view as</label>
                <input id="name" name="name" type="text" required maxlength="60"
                       placeholder="${report.title}, last month" />
              </div>
              <button class="pill outline sm" type="submit">Save</button>
              <span class="filterbar__note">Saved views can be sent on a schedule.</span>
            </form>
          </div>
        </div>`,
    }));
  });

  /* --- the same thing, as a file ------------------------------------------ */

  router.post("/app/reports/:key/save", async (ctx) => {
    const key = String(ctx.params.key || "");
    if (!REPORTS[key]) throw new BadRequest("There is no report by that name.");
    const report = reportDefinition(key);
    if (report.need && !can(ctx.staff, report.need)) {
      throw new Forbidden("Your account does not have access to that report.");
    }
    try {
      await saveReport({
        companyId: ctx.staff.company_id, reportKey: key,
        name: ctx.fields.name, params: ctx.fields, by: ctx.staff.id,
      });
    } catch (err) {
      return redirect(ctx.res, `/app/reports/${key}?e=${encodeURIComponent(err.message)}`);
    }
    redirect(ctx.res, `/app/reports/saved?m=${encodeURIComponent("Saved.")}`);
  });

  router.get("/app/reports/:key/csv", async (ctx) => {
    const { report, run, table, company } = await load(ctx);
    const body = toCsv(table);

    download(ctx, {
      body, type: "text/csv; charset=utf-8",
      name: csvFileName({
        companyName: company.name, report: report.title,
        from: run.params.from || null, to: run.params.to || run.params.asOf || null,
      }),
    });
  });

  router.get("/app/reports/:key/pdf", async (ctx) => {
    const { report, run, table, company } = await load(ctx);
    const bytes = await buildReportPdf({
      company, title: report.title,
      subtitle: subtitleFor(report.key, run.params),
      ...table,
    });

    download(ctx, {
      body: Buffer.from(bytes), type: "application/pdf",
      name: pdfFileName({
        companyName: company.name, report: report.title,
        from: run.params.from || null, to: run.params.to || run.params.asOf || null,
      }),
    });
  });
}

/* --- shared ----------------------------------------------------------------- */

/* Runs the report the URL names, for the person asking, or refuses.

   The refusal is here rather than left to the index having been honest: a URL
   is typed, guessed and bookmarked, and "it is not in your menu" is not a
   permission check. */
async function load(ctx) {
  const key = String(ctx.params.key || "");
  if (!REPORTS[key]) throw new BadRequest("There is no report by that name.");

  const report = reportDefinition(key);
  if (report.need && !can(ctx.staff, report.need)) {
    throw new Forbidden(
      `Your account does not have access to the ${report.title.toLowerCase()}. `
      + "If you need it, an administrator can change your role.");
  }

  const run = await runReport(key, ctx.staff.company_id, ctx.query);
  const table = tableFor(key, run.result);
  const company = await one("SELECT * FROM company WHERE id = ?", ctx.staff.company_id);
  return { report, run, table, company };
}

function download(ctx, { body, type, name }) {
  ctx.res.writeHead(200, {
    "content-type": type,
    "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    /* A report is a snapshot of somebody's finances. It does not belong in a
       shared cache, and it does not belong in the browser's either. */
    "cache-control": "no-store, private",
  });
  ctx.res.end(body);
}

const cell = (column, row) => {
  const raw = column.map ? column.map(row) : row[column.key];
  if (column.money) return raw == null ? "—" : usd(Number(raw));
  return raw == null || raw === "" ? "—" : String(raw);
};

/* The filter bar, built from what the report says it takes.

   A report that grew a bespoke filter would be one nobody could schedule, so
   the parameter kinds are deliberately few and this renders all of them. */
async function filterBar(ctx, report, params) {
  const cid = ctx.staff.company_id;

  const options = {};
  if (report.params.includes("propertyId")) {
    options.property = await all(
      "SELECT id, line1, city FROM property WHERE company_id = ? ORDER BY line1", cid);
  }
  if (report.params.includes("ownerId")) {
    options.owner = await all(
      "SELECT id, name FROM owner WHERE company_id = ? ORDER BY name", cid);
  }
  if (report.params.includes("code")) {
    options.account = await all(
      "SELECT code, name FROM account WHERE company_id = ? AND active = 1 ORDER BY code", cid);
  }

  return html`
    <form method="get" action="/app/reports/${report.key}" class="filterbar">
      ${report.params.map((name) => field(name, params[name], options))}
      <button class="pill outline sm" type="submit">Apply</button>
      <span class="filterbar__note">${subtitleFor(report.key, params)}</span>
    </form>`;
}

function field(name, value, options) {
  const spec = PARAMS[name];
  if (!spec) return "";
  const label = spec.label;

  if (spec.type === "date") {
    return html`<div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="date" value="${value || ""}" />
    </div>`;
  }

  if (spec.type === "year" || spec.type === "days") {
    return html`<div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="number" value="${value ?? ""}"
             ${spec.type === "days" ? raw('min="1" max="3650"') : raw('min="2000" max="2100"')} />
    </div>`;
  }

  const list = spec.type === "property" ? options.property
    : spec.type === "owner" ? options.owner
    : spec.type === "account" ? options.account : [];

  return html`<div class="field">
    <label for="${name}">${label}</label>
    <select id="${name}" name="${name}">
      <option value="">Everything</option>
      ${(list || []).map((row) => {
        const id = row.id || row.code;
        const text = row.line1 ? `${row.line1}, ${row.city}`
          : row.code ? `${row.code} ${row.name}` : row.name;
        return html`<option value="${id}"${attr("selected", String(value) === String(id))}>${text}</option>`;
      })}
    </select>
  </div>`;
}
