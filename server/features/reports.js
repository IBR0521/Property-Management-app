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
import { sendHtml, Forbidden, BadRequest } from "../lib/http.js";
import { html, attr, raw } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { can } from "../lib/auth.js";
import { usd } from "../lib/money.js";
import { human, today } from "../lib/dates.js";
import { toCsv, csvFileName } from "../lib/csv.js";
import { buildReportPdf, pdfFileName } from "../lib/pdf/report.js";
import {
  REPORTS, PARAMS, reportsFor, reportDefinition, runReport, tableFor, subtitleFor,
} from "../lib/reports/index.js";

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
        <a class="pill outline sm" href="/app/reports">All reports</a>`,
      body: html`
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
        </div>`,
    }));
  });

  /* --- the same thing, as a file ------------------------------------------ */

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
