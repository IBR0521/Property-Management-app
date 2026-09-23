/* Taking everything and leaving.

   A customer who cannot get their data out is a customer who cannot leave,
   and a platform that knows that is a platform that behaves differently. So
   this is one button, it produces one archive, and the archive is complete:
   every table, every uploaded file, and a README that says what was left out
   and why.

   No ticket to raise, no wait, nothing to ask us for. The one thing it asks
   of the person is that they be an administrator of the company, which the
   gate on `/app/setup` has already settled before a handler here runs.

   ## Why the download is a POST

   It reads every table and every uploaded file this company has. A GET would
   be fetched by a link preview, a crawler, or a browser's own prefetch, and
   the first anybody would know is the bill. */
import { insert } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp } from "../lib/dates.js";
import { sendHtml, securityHeaders } from "../lib/http.js";
import { html } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { slug } from "../lib/csv.js";
import { exportArchive } from "../lib/export/archive.js";
import { exported, skipped } from "../lib/export/tables.js";

/* Waits for the socket to catch up — or for it to go away.

   `once("drain")` alone is a promise that never settles when the person
   closes the tab halfway through a download: the socket will not drain
   because there is nothing at the other end, and the handler waits for ever
   holding an open generator. A cancelled download is the ordinary case for a
   file this size, not an edge. */
function drain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

export function registerExport(router) {
  router.get("/app/setup/export", async (ctx) => {
    const cid = ctx.staff.company_id;
    const tables = exported();
    const left = skipped();

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
      title: "Export everything",
      subtitle: "One archive: every table, every uploaded file",
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <div class="panel">
          <div class="panel__head"><h2>Your data</h2>
            <p>Yours to take, whenever you want it</p>
          </div>
          <div class="panel__body">
            <p class="lede">A ZIP with every photograph, receipt and certificate that has been
              uploaded, and your records twice over.</p>

            <div class="tablewrap"><table class="data">
              <tbody>
                <tr>
                  <td><b>data/</b><span class="cellsub">${tables.length} CSV files, one per table,
                    columns named as the database names them and amounts in cents</span></td>
                  <td>The record as it is held, for whoever you move to, to map.</td>
                </tr>
                <tr>
                  <td><b>import/</b><span class="cellsub">owners, properties, units, tenants,
                    leases and contractors, money in dollars</span></td>
                  <td>The same portfolio in the shape this application's own import reads, so
                    leaving and coming back are the same act.</td>
                </tr>
                <tr>
                  <td><b>files/</b><span class="cellsub">the uploads themselves</span></td>
                  <td>Indexed back to the record each one belongs to.</td>
                </tr>
              </tbody>
            </table></div>

            <div style="margin-top:1.25rem">${notice("info", "It is the record, not a report",
              html`Reports are a view with decisions baked into them, and the decisions are
                ours. What you need in order to leave is the record in the shape it is kept.
                <br /><br />
                A README inside the archive lists what is in it, what is not, and why — and
                says plainly that <b>import/</b> is not everything: work orders, journals and
                messages are exported and there is nothing here that reads them back in.`)}</div>

            <form method="post" action="/app/setup/export" style="margin-top:1.25rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <button class="pill solid sm" type="submit">Download everything</button>
            </form>
            <p class="lede" style="margin-top:0.75rem;color:var(--ink-soft)">
              A large portfolio takes a minute or two to build. Leave the tab open.</p>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>What is left out</h2>
            <p>And why — the same list is inside the archive</p>
          </div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th class="shrink">Not included</th><th>Why</th></tr></thead>
              <tbody>${left.map((s) => html`
                <tr><td class="shrink">${s.name}</td><td>${s.why}</td></tr>`)}</tbody>
            </table></div>
            <div class="panel__body">
              <span class="cellsub">None of these is a figure, a date, or a record of
                something that happened. Those are all in the archive.</span>
            </div>
          </div>
        </div>`,
    }));
  });

  router.post("/app/setup/export", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = ctx.staff.company_name || "portfolio";
    const filename = `${slug(company, 40)}-export-${stamp().slice(0, 10)}.zip`;

    /* Recorded before it runs, not after. An export that timed out halfway is
       still somebody having read the whole portfolio. */
    await insert("audit_log", {
      id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
      entity: "company", entity_id: cid, action: "export",
      detail: "downloaded a full data export",
    });

    /* Chunked rather than buffered: the length is not known until the last
       byte, and holding a portfolio's worth of photographs in memory to find
       it out would be the one thing this feature must not do. */
    ctx.res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      ...securityHeaders(ctx.req),
    });

    try {
      for await (const chunk of exportArchive({ companyId: cid, requestedBy: ctx.staff.name })) {
        if (ctx.res.writableEnded || ctx.res.destroyed) break;
        /* Backpressure: a fast database and a slow connection would otherwise
           queue the whole archive in this process's memory. */
        if (!ctx.res.write(chunk)) await drain(ctx.res);
      }
      if (!ctx.res.writableEnded) ctx.res.end();
    } catch (err) {
      /* The headers went out with the first chunk, so there is no status left
         to change. Destroying the socket is what tells the browser the
         download is incomplete — far better than a truncated archive that
         opens and is quietly missing the end of itself. */
      ctx.log.error("export failed", { message: String(err.message).slice(0, 200) });
      ctx.res.destroy();
    }
  });
}
