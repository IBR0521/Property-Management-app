/* Bringing a portfolio in from somewhere else.

   This is the largest single act the application performs on somebody else's
   data, and the screens are shaped around that rather than around making it
   feel quick.

   ## Three pages, and the middle one is the point

   Upload, preview, commit. The preview is not a summary of what will happen —
   it is the actual validation, run by the same function the commit runs, over
   the same bytes. It is re-run every time the page is opened, so it cannot
   grow stale against a portfolio that changed underneath it, and the commit
   runs it once more before writing a row. If the two ever disagree, the
   commit refuses; a preview somebody approved and a commit that does
   something else is the failure this whole shape exists to prevent.

   ## What it shows before it will let anybody continue

   Every column that was read and what it became. Every column that was
   **not** read, by name — AppFolio exports forty and this uses eight, and
   discovering months later that a field went nowhere is worse than being told
   now. Every row with a problem, with its row number. And the money: what
   tenants owe, what they have paid ahead, what is held as a deposit, because
   those three numbers become a journal and a person should see them before
   that happens rather than afterwards.

   ## The trust balance is asked for and never invented

   The files say what is owed. Only a bank says what is held. If the person
   migrating supplies their trust balance it is posted and the reconciliation
   is meaningful from the first day; if they do not, the screen says plainly
   that the deposits will read as unbacked until a statement is reconciled —
   which is true, and better than a number nobody chose.

   ## Authorisation

   Nothing here gates itself. `/app/setup` requires `settings.manage` and
   these paths sit under it, so the app-level gate has already answered before
   a handler runs — which is where this application answers it, once. */
import { all, insert, update, one, run as sqlRun } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, securityHeaders, BadRequest } from "../lib/http.js";
import { BOM, CSV_TYPE, csvRow } from "../lib/csv.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { ENTITIES, SOURCE_SYSTEMS, entityOrder } from "../lib/import/mappings.js";
import { validateImport } from "../lib/import/validate.js";
import { commitImport } from "../lib/import/commit.js";

/* Enough to hold a large portfolio and not enough to hold a video somebody
   renamed. Six files at this size is still inside the request body cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/* Typed in full before anything is written. Not a checkbox: a checkbox is
   clicked by the same reflex that clicks past a cookie banner, and this posts
   a journal and creates a portfolio. */
const CONFIRMATION = "import my portfolio";

export function registerImport(router) {
  /* --- where it starts ---------------------------------------------------- */

  router.get("/app/setup/import", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batches = await all(
      `SELECT * FROM import_batch WHERE company_id = ? ORDER BY created_at DESC LIMIT 15`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
      title: "Import a portfolio",
      subtitle: "Owners, properties, units, tenants, leases and vendors, from CSV",
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <div class="panel">
          <div class="panel__head">
            <h2>Upload</h2>
            <p>Nothing is written until you have seen what it found</p>
          </div>
          <div class="panel__body">
            ${notice("info", "How this works",
              html`Upload one CSV per kind of record. The next screen shows every column that
                was read, every column that was not, and every row with a problem — and nothing
                is written until you confirm it there.
                <br /><br />
                <b>One bad row stops the whole import.</b> A portfolio that is half here is
                worse than one that is not here at all, because nobody can tell which half.`)}

            <form method="post" action="/app/setup/import" enctype="multipart/form-data"
                  class="formgrid" style="margin-top:1.25rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />

              <div class="field">
                <label for="source_system">Where the files came from</label>
                <select id="source_system" name="source_system" required>
                  ${Object.entries(SOURCE_SYSTEMS).map(([key, label]) => html`
                    <option value="${key}">${label}</option>`)}
                </select>
                <span class="field__help">This decides how the ids in the files are remembered,
                  so uploading the same export twice updates rather than duplicates.</span>
              </div>

              <div class="formgrid formgrid--2">
                ${entityOrder().map((entity) => {
                  const spec = ENTITIES[entity];
                  const required = Object.entries(spec.fields)
                    .filter(([, def]) => def.required).map(([field]) => field);
                  return html`
                    <div class="field">
                      <label for="file-${entity}">${spec.label}
                        <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                      <input id="file-${entity}" name="${entity}" type="file" accept=".csv,text/csv" />
                      <span class="field__help">${required.length
                        ? html`Must have a column for: ${required.join(", ")}.`
                        : "Every column is optional."}
                        <a href="/app/setup/import/template/${entity}.csv">Blank template</a></span>
                    </div>`;
                })}
              </div>

              <button class="pill solid sm" type="submit">Read the files</button>
            </form>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>What each file may contain</h2>
            <p>Column names this recognises, whatever the other system calls them</p>
          </div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th>File</th><th>Field</th><th>Column names looked for</th></tr></thead>
              <tbody>${entityOrder().flatMap((entity) => {
                const spec = ENTITIES[entity];
                const fields = Object.entries(spec.fields);
                return fields.map(([field, def], i) => html`
                  <tr>
                    <td class="shrink">${i === 0 ? spec.label : ""}</td>
                    <td class="shrink">${field}${def.required
                      ? html` <span class="chip" data-tone="warn">required</span>` : ""}</td>
                    <td><span class="cellsub">${def.aliases.join(", ")}</span>
                      ${def.note ? html`<span class="cellsub">${def.note}</span>` : ""}</td>
                  </tr>`);
              })}</tbody>
            </table></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Previous imports</h2></div>
          <div class="panel__body panel__body--flush">
            ${batches.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>When</th><th>From</th><th>State</th><th>What it did</th><th class="shrink"></th></tr></thead>
              <tbody>${batches.map((b) => html`
                <tr>
                  <td class="shrink">${human(b.created_at.slice(0, 10))}</td>
                  <td class="shrink">${SOURCE_SYSTEMS[b.source_system] || b.source_system}</td>
                  <td class="shrink"><span class="chip"${attr("data-tone",
                    b.status === "done" ? "ok" : b.status === "failed" ? "danger" : "warn")}>${b.status}</span></td>
                  <td>${describeResult(b)}</td>
                  <td class="shrink">${b.status === "draft"
                    ? html`<a class="pill outline sm" href="/app/setup/import/${b.id}">Open</a>`
                    : html`<a class="pill outline sm" href="/app/setup/import/${b.id}">View</a>`}</td>
                </tr>`)}</tbody>
            </table></div>` : empty("Nothing imported yet",
              "Every import that is started shows up here, whether or not it was committed.")}
          </div>
        </div>`,
    }));
  });

  /* --- a blank file to start from ----------------------------------------- */

  /* A file to start from, for the company whose old system has no export.

     Headings only, and the first spelling of each alias rather than all of
     them. No example row: an example row is a row, and somebody will import
     it and then wonder who "Jane Example" is.

     It does not collide with `/app/setup/import/:id` — that pattern is four
     segments and this is five. */
  router.get("/app/setup/import/template/:entity", async (ctx) => {
    const entity = String(ctx.params.entity).replace(/\.csv$/i, "");
    const spec = ENTITIES[entity];
    if (!spec) throw new BadRequest("There is no file of that kind.");

    const headers = Object.entries(spec.fields).map(([, def]) => def.aliases[0]);
    const body = BOM + csvRow(headers) + "\r\n";

    ctx.res.writeHead(200, {
      "Content-Type": CSV_TYPE,
      "Content-Length": Buffer.byteLength(body),
      "Content-Disposition": `attachment; filename="${entity}-template.csv"`,
      ...securityHeaders(ctx.req),
    });
    ctx.res.end(body);
  });

  /* --- reading the files -------------------------------------------------- */

  router.post("/app/setup/import", async (ctx) => {
    const cid = ctx.staff.company_id;
    const sourceSystem = String(ctx.fields.source_system || "generic");
    if (!SOURCE_SYSTEMS[sourceSystem]) throw new BadRequest("That is not a system I know about.");

    const files = {};
    const names = {};
    for (const file of ctx.files || []) {
      if (!ENTITIES[file.field]) continue;
      if (!file.data?.length) continue;
      if (file.data.length > MAX_FILE_BYTES) {
        throw new BadRequest(
          `${file.filename} is larger than ${Math.round(MAX_FILE_BYTES / 1048576)}MB. `
          + "If a portfolio really is that big, split it by property and import in parts.");
      }
      files[file.field] = file.data.toString("utf8");
      names[file.field] = file.filename;
    }

    if (!Object.keys(files).length) {
      return redirect(ctx.res, `/app/setup/import?m=${encodeURIComponent(
        "No files were uploaded, so there was nothing to read.")}`);
    }

    const batchId = id();
    await insert("import_batch", {
      id: batchId, company_id: cid, source_system: sourceSystem,
      status: "draft",
      file_name: Object.values(names).join(", ").slice(0, 300),
      file_hash: await hashFiles(files),
      files: JSON.stringify(files),
      created_by: ctx.staff.id, created_at: stamp(),
    });

    redirect(ctx.res, `/app/setup/import/${batchId}`);
  });

  /* --- the preview -------------------------------------------------------- */

  router.get("/app/setup/import/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM import_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);

    if (batch.status !== "draft") return sendHtml(ctx.res, await committedPage(ctx, batch));

    /* Re-validated on every view rather than read back from the preview
       column. The preview and the commit have to be the same act, and the
       only way to be sure of that is to run the same code over the same
       bytes each time. */
    const files = JSON.parse(batch.files || "{}");
    const validated = await validateImport({ companyId: cid, sourceSystem: batch.source_system, files });

    /* What it said, kept for the question asked afterwards. */
    await update("import_batch", batch.id, {
      preview: JSON.stringify({
        at: stamp(), ok: validated.ok,
        summary: validated.summary, opening: validated.opening,
        notes: validated.notes,
        problems: validated.problems.slice(0, 500),
      }),
    });

    /* What this company already holds. An import onto an empty company is the
       ordinary case and the amount entered is simply the opening balance; an
       import onto a company that has been trading is not, and the entered
       amount is *added* to what is already booked rather than replacing it.
       Said on the screen, because the difference is invisible otherwise and
       the mistake it produces is a trust account that reads double. */
    const held = await trustCashHeld(cid);

    const problems = validated.problems;
    const byEntity = entityOrder()
      .map((key) => ({ key, state: validated.entities[key], summary: validated.summary[key] }))
      .filter((e) => e.state);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(cid),
      title: "Check before importing",
      subtitle: `${SOURCE_SYSTEMS[batch.source_system] || batch.source_system} — ${batch.file_name}`,
      body: html`
        ${ctx.flash ? notice("warn", null, ctx.flash) : ""}

        ${validated.ok
          ? notice("ok", "Nothing is wrong with these files",
            "Every row read cleanly. Check the numbers below, then confirm at the bottom.")
          : notice("danger", `${problems.length} problem${problems.length === 1 ? "" : "s"} — nothing has been written`,
            html`Fix them in the spreadsheet and upload it again. All of it stops on any one
              of them, because a portfolio that is half here is worse than one that is not
              here at all.`)}

        <div class="panel">
          <div class="panel__head"><h2>What was read</h2></div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th>File</th><th class="num">Rows</th><th class="num">New</th>
                <th class="num">Already here</th><th class="num">With a problem</th></tr></thead>
              <tbody>${byEntity.map(({ summary }) => html`
                <tr>
                  <td>${summary.label}
                    ${summary.usable ? "" : html`<span class="cellsub" style="color:var(--danger)">a required column is missing — no rows were read</span>`}</td>
                  <td class="num">${summary.total}</td>
                  <td class="num">${summary.create}</td>
                  <td class="num">${summary.update}</td>
                  <td class="num"${attr("style", summary.error ? "color:var(--danger)" : "")}>${summary.error}</td>
                </tr>`)}</tbody>
            </table></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Columns</h2>
            <p>What each one became, and what was not read at all</p>
          </div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th>File</th><th>Read</th><th>Not read</th></tr></thead>
              <tbody>${byEntity.map(({ state }) => html`
                <tr>
                  <td class="shrink">${state.label}</td>
                  <td>${Object.entries(state.mapping).map(([field, header]) => html`
                    <span class="chip chip--plain">${header} → ${field}</span> `)}</td>
                  <td>${state.ignored.length
                    ? state.ignored.map((h) => html`<span class="chip" data-tone="warn">${h}</span> `)
                    : html`<span class="cellsub">everything was read</span>`}</td>
                </tr>`)}</tbody>
            </table></div>
          </div>
        </div>

        ${problems.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Problems</h2>
              <p>Every one has to be fixed before any of it can be written</p>
            </div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th class="shrink">File</th><th class="shrink">Row</th><th>What is wrong</th></tr></thead>
                <tbody>${problems.slice(0, 200).map((p) => html`
                  <tr>
                    <td class="shrink">${ENTITIES[p.entity]?.label || p.entity}</td>
                    <td class="shrink num">${p.row}</td>
                    <td>${p.message}</td>
                  </tr>`)}</tbody>
              </table></div>
              ${problems.length > 200 ? html`<div class="panel__body">
                <span class="cellsub">${problems.length - 200} more are not shown. They are the
                  same kinds of thing; fixing these usually fixes those.</span></div>` : ""}
            </div>
          </div>` : ""}

        ${moneyNotes(validated.notes)}

        ${openingPanel(validated.opening)}

        ${validated.ok ? commitPanel(ctx, batch, validated, held) : html`
          <div class="panel">
            <div class="panel__body">
              <form method="post" action="/app/setup/import/${batch.id}/discard">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill outline sm" type="submit">Discard this upload</button>
              </form>
            </div>
          </div>`}`,
    }));
  });

  /* --- writing it --------------------------------------------------------- */

  router.post("/app/setup/import/:id/commit", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM import_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);

    const back = `/app/setup/import/${batch.id}`;
    if (batch.status !== "draft" || !batch.files) {
      return redirect(ctx.res, `${back}?m=${encodeURIComponent(
        "This import has already been committed. Nothing was written a second time.")}`);
    }

    if (String(ctx.fields.confirm || "").trim().toLowerCase() !== CONFIRMATION) {
      return redirect(ctx.res, `${back}?m=${encodeURIComponent(
        `Nothing was written. To confirm, type "${CONFIRMATION}" exactly.`)}`);
    }

    const conversionDate = String(ctx.fields.conversion_date || "").trim() || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(conversionDate)) {
      return redirect(ctx.res, `${back}?m=${encodeURIComponent("That conversion date is not a date.")}`);
    }

    const trustRaw = String(ctx.fields.trust_cash || "").trim();
    let trustCashCents = null;
    if (trustRaw) {
      trustCashCents = parseMoney(trustRaw);
      if (trustCashCents == null || trustCashCents < 0) {
        return redirect(ctx.res, `${back}?m=${encodeURIComponent(
          "That trust balance is not an amount. Leave it blank rather than guessing.")}`);
      }
    }

    /* Validated once more, here, against the portfolio as it is now. The
       preview was true when it was drawn; between then and now somebody may
       have added the very owner this file references. */
    const files = JSON.parse(batch.files || "{}");
    const validated = await validateImport({ companyId: cid, sourceSystem: batch.source_system, files });
    if (!validated.ok) {
      await update("import_batch", batch.id, {
        status: "failed",
        error: `${validated.problems.length} problem(s) found when committing`,
        preview: JSON.stringify({
          at: stamp(), ok: false, summary: validated.summary,
          opening: validated.opening, notes: validated.notes,
          problems: validated.problems.slice(0, 500),
        }),
      });
      return redirect(ctx.res, `${back}?m=${encodeURIComponent(
        "Something changed since this was checked, and it no longer validates. Nothing was written.")}`);
    }

    let result;
    try {
      result = await commitImport({
        companyId: cid, validated, sourceSystem: batch.source_system,
        batchId: batch.id, by: ctx.staff.id,
        conversionDate, trustCashCents,
        /* Ticked on the preview, where the charges that would be created are
           listed by name and amount. Unticked, the columns are read and
           nothing is created — which is what happened to every import before
           this application could hold them. */
        recurringCharges: String(ctx.fields.recurring_charges || "") === "on",
      });
    } catch (err) {
      await update("import_batch", batch.id, {
        status: "failed", error: String(err.message).slice(0, 500),
      });
      ctx.log.error("import failed", { batch: batch.id, message: String(err.message).slice(0, 200) });
      return redirect(ctx.res, `${back}?m=${encodeURIComponent(
        "The import failed and nothing was written. " + String(err.message).slice(0, 200))}`);
    }

    /* The upload has done its job. It held a customer's whole portfolio in
       plain text and there is no reason to keep it now. */
    await update("import_batch", batch.id, { files: null });

    ctx.log.info("import committed", { batch: batch.id, created: result.created });
    redirect(ctx.res, `/app/setup/import/${batch.id}?m=${encodeURIComponent("Imported.")}`);
  });

  router.post("/app/setup/import/:id/discard", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM import_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (batch.status === "done") {
      throw new BadRequest("A committed import cannot be discarded. What it wrote is in the books.");
    }
    await sqlRun("DELETE FROM import_batch WHERE id = ? AND company_id = ?", batch.id, cid);
    redirect(ctx.res, `/app/setup/import?m=${encodeURIComponent("Upload discarded. Nothing had been written.")}`);
  });
}

/* --- pieces of the preview -------------------------------------------------- */

/* Money a tenant pays every month that this application has nowhere to hold.

   It would already appear under "columns that were not read", and that is not
   enough — in a list of thirty unread headings it reads as something that did
   not matter, and $50 of pet rent on every lease is not that. */
function moneyNotes(notes) {
  const money = (notes || []).filter((n) => n.kind === "recurring_money");
  if (!money.length) return "";
  const columns = money.flatMap((n) => n.columns);

  return html`
    <div class="panel">
      <div class="panel__body">
        ${notice("warn", "Money charged every month, beside the rent",
          html`Your lease file has ${columns.map((c) => html`<span class="chip" data-tone="warn">${c}</span> `)}
            in it — money a tenant pays every month beside the rent.
            <br /><br />
            These can be brought across now and billed with the rent from next month,
            due on the same day, shown to the tenant itemised. They are charged to the
            owner, because they are the owner's property being paid for.
            <br /><br />
            <b>Nothing is created unless you tick the box on the form below.</b> A
            column heading is not a decision to start billing somebody, so the figures
            are read and left alone until you say so.`)}
      </div>
    </div>`;
}

/* The tick, listed by name and amount.

   The warning above says these columns exist. This says what would be created
   from them, so the decision is made against figures rather than headings. */
function recurringOffer(validated) {
  const rows = (validated.entities?.lease?.rows || [])
    .flatMap((r) => (r.data.recurring || []).map((x) => ({ ...x, row: r.row })));
  if (!rows.length) return "";

  const total = rows.reduce((n, r) => n + r.cents, 0);
  const byLabel = new Map();
  for (const r of rows) byLabel.set(r.label, (byLabel.get(r.label) || 0) + r.cents);

  return html`
    <div class="field" style="margin-top:1rem">
      <label class="radiotile" for="recurring_charges">
        <input id="recurring_charges" name="recurring_charges" type="checkbox" />
        <span>
          Also create ${rows.length} monthly charge${rows.length === 1 ? "" : "s"},
          ${usd(total)} a month in total
          <small>${[...byLabel].map(([label, cents]) =>
            html`${label} ${usd(cents)}. `)}Billed with the rent from next month, due on
            the same day, and charged to the owner. Leave this unticked and the money is
            not billed, which is what happened before this application could hold it.</small>
        </span>
      </label>
    </div>`;
}

function openingPanel(opening) {
  const anything = opening.arrearsCents || opening.creditCents || opening.depositsCents;
  return html`
    <div class="panel">
      <div class="panel__head"><h2>The position each lease arrives in</h2>
        <p>One journal, dated the conversion date — not a history</p>
      </div>
      <div class="panel__body">
        ${anything ? html`
          <div class="tablewrap"><table class="data">
            <tbody>
              <tr><td>Owed by tenants at conversion</td><td class="num">${usd(opening.arrearsCents)}</td></tr>
              <tr><td>Paid ahead by tenants at conversion</td><td class="num">${usd(opening.creditCents)}</td></tr>
              <tr><td>Deposits held</td><td class="num">${usd(opening.depositsCents)}</td></tr>
              <tr><td>Leases carrying a position</td><td class="num">${opening.leases}</td></tr>
            </tbody>
          </table></div>
          <div style="margin-top:1rem">${notice("info", "Why one journal and not a history",
            html`What each tenant owes today is a fact the file knows. Which account it hit on
              which date, two years ago, is not — it would be inferred from a spreadsheet and
              recorded as though it had been observed. So one journal carries the position, and
              everything after it is recorded as it happens.`)}</div>`
          : notice("info", "Nothing carried a balance",
            "No lease in this file has an outstanding balance, a credit or a deposit, so no "
            + "opening journal will be posted.")}
      </div>
    </div>`;
}

function commitPanel(ctx, batch, validated, heldCents) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Write it</h2>
        <p>One transaction — all of it, or none of it</p>
      </div>
      <div class="panel__body">
        <form method="post" action="/app/setup/import/${batch.id}/commit" class="formgrid">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />

          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="conversion_date">Conversion date</label>
              <input id="conversion_date" name="conversion_date" type="date" value="${today()}" required />
              <span class="field__help">The date the opening journal is dated. Usually the day
                you stopped using the other system.</span>
            </div>
            <div class="field">
              <label for="trust_cash">Trust account balance on that date
                <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
              <input id="trust_cash" name="trust_cash" type="text" inputmode="decimal" placeholder="0.00" />
              <span class="field__help">From the bank, not from the files.${heldCents
                ? html` This company's books already show ${usd(heldCents)} in trust, and
                  whatever you enter is <b>added</b> to that.` : ""}</span>
            </div>
          </div>

          ${recurringOffer(validated)}

          ${validated.opening.depositsCents ? notice("warn", "If you leave the balance blank",
            html`${usd(validated.opening.depositsCents)} of deposits will be recorded as held
              with nothing in the books to back them, and the trust reconciliation will read
              that as a shortfall — correctly. It stays that way until a bank balance is
              entered or a statement is reconciled.`) : ""}

          <div class="field" style="margin-top:1rem">
            <label for="confirm">Type <b>${CONFIRMATION}</b> to confirm</label>
            <input id="confirm" name="confirm" type="text" autocomplete="off" required
                   placeholder="${CONFIRMATION}" />
            <span class="field__help">This creates records and posts a journal. Typed rather
              than ticked, on purpose.</span>
          </div>

          <div class="btnrow">
            <button class="pill solid sm" type="submit">Import</button>
          </div>
        </form>

        <form method="post" action="/app/setup/import/${batch.id}/discard" style="margin-top:1rem">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
          <button class="pill outline sm" type="submit">Discard this upload instead</button>
        </form>
      </div>
    </div>`;
}

/* What the books already say is in the trust account. Nought for the company
   this feature is really for — one that has not started yet — and the reason
   the field's help changes for one that has. */
async function trustCashHeld(companyId) {
  const row = await one(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = '1010'`, companyId);
  return Number(row?.cents || 0);
}

/* --- after the fact --------------------------------------------------------- */

async function committedPage(ctx, batch) {
  const result = parse(batch.result);
  const preview = parse(batch.preview);
  const opening = result?.opening || null;

  return appPage({
    staff: ctx.staff, csrf: ctx.csrf, active: "setup", counts: await navCounts(ctx.staff.company_id),
    title: batch.status === "done" ? "Imported" : "This import did not run",
    subtitle: `${SOURCE_SYSTEMS[batch.source_system] || batch.source_system} — ${human(batch.created_at.slice(0, 10))}`,
    body: html`
      ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

      ${batch.status === "failed"
        ? notice("danger", "Nothing was written", batch.error || "It did not validate.")
        : notice("ok", "Written in one transaction",
          "Every record below, and the opening journal, were committed together.")}

      ${result ? html`
        <div class="panel">
          <div class="panel__head"><h2>What it created</h2></div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th>Record</th><th class="num">Created</th><th class="num">Updated</th></tr></thead>
              <tbody>${entityOrder().filter((k) => result.created?.[k] != null).map((k) => html`
                <tr>
                  <td>${ENTITIES[k].label}</td>
                  <td class="num">${result.created[k]}</td>
                  <td class="num">${result.updated?.[k] ?? 0}</td>
                </tr>`)}
                <tr><td>Tenancies</td><td class="num">${result.tenancies ?? 0}</td><td class="num"></td></tr>
              </tbody>
            </table></div>
          </div>
        </div>` : ""}

      ${opening?.posted ? html`
        <div class="panel">
          <div class="panel__head"><h2>The opening journal</h2>
            <p>Dated the conversion date</p>
          </div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <tbody>
                <tr><td>Owed by tenants</td><td class="num">${usd(opening.arrears)}</td></tr>
                <tr><td>Paid ahead by tenants</td><td class="num">${usd(opening.credits)}</td></tr>
                <tr><td>Deposits held</td><td class="num">${usd(opening.deposits)}</td></tr>
                <tr><td>Trust balance entered</td><td class="num">${usd(opening.trustCash || 0)}</td></tr>
              </tbody>
            </table></div>
            ${opening.unbacked ? html`<div class="panel__body">
              ${notice("warn", "The reconciliation will report a shortfall", opening.unbacked)}</div>` : ""}
          </div>
        </div>` : ""}

      ${preview?.problems?.length ? html`
        <div class="panel">
          <div class="panel__head"><h2>What stopped it</h2></div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap"><table class="data">
              <thead><tr><th class="shrink">File</th><th class="shrink">Row</th><th>What is wrong</th></tr></thead>
              <tbody>${preview.problems.slice(0, 100).map((p) => html`
                <tr><td class="shrink">${ENTITIES[p.entity]?.label || p.entity}</td>
                    <td class="shrink num">${p.row}</td><td>${p.message}</td></tr>`)}</tbody>
            </table></div>
          </div>
        </div>` : ""}

      <div class="panel">
        <div class="panel__body">
          <a class="pill outline sm" href="/app/setup/import">Back to imports</a>
        </div>
      </div>`,
  });
}

function describeResult(batch) {
  const result = parse(batch.result);
  if (result?.created) {
    const bits = entityOrder()
      .filter((k) => result.created[k] || result.updated?.[k])
      .map((k) => `${(result.created[k] || 0) + (result.updated?.[k] || 0)} ${ENTITIES[k].label.toLowerCase()}`);
    return bits.length ? bits.join(", ") : "nothing";
  }
  if (batch.error) return html`<span class="cellsub">${batch.error}</span>`;
  const preview = parse(batch.preview);
  if (preview?.problems?.length) {
    return html`<span class="cellsub">${preview.problems.length} problem(s) — not written</span>`;
  }
  return html`<span class="cellsub">uploaded, not yet written</span>`;
}

function parse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function hashFiles(files) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for (const key of Object.keys(files).sort()) h.update(key).update("\0").update(files[key]);
  return h.digest("hex");
}
