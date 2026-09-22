/* Paying owners and contractors.

   The screens are shaped around the one decision that matters: assembling a
   run and releasing it are separate acts. A draft can be looked at, argued
   over and thrown away; approval posts the journals, takes the cheque numbers
   and freezes the file, and from that moment the numbers are used and the
   bank may have the file. So the approve button says what it is about to do
   and the screen after it says what happened.

   Nothing here moves money. Every path ends at a file the company downloads
   and hands to their own bank. */
import { all, get, one, run } from "../lib/db.js";
import { usd, parseMoney } from "../lib/money.js";
import { human, humanStamp, today, addDays, stamp } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { tryOpen } from "../lib/crypto.js";
import { validRoutingNumber } from "../lib/nacha.js";
import { buildAlignmentSheet } from "../lib/checks.js";
import {
  ownerBalances, vendorPayables, savePayeeAccount,
  draftOwnerRun, draftVendorRun, approveBatch, renderChecks,
  cancelBatch, voidItem, markIssued,
} from "../lib/payouts.js";

const PAYOUT_TABS = [
  { key: "runs", href: "/app/payouts", label: "Runs" },
  { key: "owners", href: "/app/payouts/owners", label: "Owners due" },
  { key: "vendors", href: "/app/payouts/vendors", label: "Invoices to pay" },
  { key: "bank", href: "/app/payouts/bank", label: "Bank details" },
];

const STATUS_TONE = { draft: "warn", approved: "ok", issued: "", cancelled: "danger" };

export function registerPayouts(router) {
  /* --- the runs ------------------------------------------------------------ */

  router.get("/app/payouts", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batches = await all(
      `SELECT * FROM payout_batch WHERE company_id = ?
        ORDER BY created_at DESC LIMIT 25`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payouts", counts: await navCounts(cid),
      title: "Payments out", subtitle: "Owner distributions and contractor payments",
      body: html`
        ${tabs(PAYOUT_TABS, "runs")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${notice("ok", "The money does not pass through us",
          "A run produces a file you upload to your own bank, or cheques you print. "
          + "We record what was issued; your bank moves the funds.")}

        <div class="panel">
          <div class="panel__head"><h2>Recent runs</h2></div>
          <div class="panel__body panel__body--flush">
            ${batches.length === 0
              ? html`<div class="panel__body">${empty("Nothing yet",
                  "Start from Owners due or Invoices to pay.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Run</th><th>For</th><th>How</th><th class="num">Total</th><th>State</th></tr></thead>
                    <tbody>
                      ${batches.map((b) => html`
                        <tr>
                          <td><a href="/app/payouts/${b.id}">${human(b.effective_date)}</a>
                            <div class="cellsub">${humanStamp(b.created_at)}</div></td>
                          <td>${b.kind === "owner" ? "Owners" : "Contractors"}
                            <div class="cellsub">${b.item_count} payment${Number(b.item_count) === 1 ? "" : "s"}</div></td>
                          <td>${b.method === "ach" ? "Bank transfer" : "Cheque"}</td>
                          <td class="num">${usd(b.total_cents)}</td>
                          <td><span class="chip"${attr("data-tone", STATUS_TONE[b.status])}>${b.status}</span></td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
        </div>`,
    }));
  });

  /* --- owners due ----------------------------------------------------------- */

  router.get("/app/payouts/owners", async (ctx) => {
    const cid = ctx.staff.company_id;
    const owners = await ownerBalances(cid);
    const due = owners.filter((o) => o.distributableCents > 0);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payouts", counts: await navCounts(cid),
      title: "Owners due", subtitle: `${due.length} owner${due.length === 1 ? "" : "s"} with a balance`,
      body: html`
        ${tabs(PAYOUT_TABS, "owners")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        <div class="panel">
          <div class="panel__head">
            <h2>What each owner is owed</h2>
            <p>From the ledger, less anything already in a run</p>
          </div>
          <div class="panel__body panel__body--flush">
            ${owners.length === 0
              ? html`<div class="panel__body">${empty("No owners yet", "Add one under People.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Owner</th><th>How they are paid</th><th class="num">On the ledger</th>
                      <th class="num">In a run</th><th class="num">Due now</th></tr></thead>
                    <tbody>
                      ${owners.map((o) => html`
                        <tr>
                          <td>${o.name}</td>
                          <td>${payeeMethod(o.account)}</td>
                          <td class="num">${usd(o.balanceCents)}</td>
                          <td class="num">${o.pendingCents ? usd(o.pendingCents) : "—"}</td>
                          <td class="num"><b style="font-weight:500">${usd(o.distributableCents)}</b></td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
          ${due.length === 0 ? "" : html`
            <div class="panel__foot">
              ${startRunForm({ csrf: ctx.csrf, action: "/app/payouts/owners/draft", owners: due })}
            </div>`}
        </div>`,
    }));
  });

  router.post("/app/payouts/owners/draft", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await draftOwnerRun({
      companyId: cid,
      effectiveDate: String(ctx.fields.effective_date || addDays(today(), 1)),
      method: String(ctx.fields.method || "ach"),
      minimumCents: parseMoney(ctx.fields.minimum) ?? 0,
      createdBy: ctx.staff.id,
    });
    if (!res.ok) {
      return redirect(ctx.res, `/app/payouts/owners?e=${encodeURIComponent(res.reason)}`);
    }
    return redirect(ctx.res, `/app/payouts/${res.batchId}`);
  });

  /* --- invoices to pay ------------------------------------------------------ */

  router.get("/app/payouts/vendors", async (ctx) => {
    const cid = ctx.staff.company_id;
    const payables = await vendorPayables(cid);
    const ready = payables.filter((p) => p.payable && !p.alreadyInARun);
    const blocked = payables.filter((p) => !p.payable);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payouts", counts: await navCounts(cid),
      title: "Invoices to pay",
      subtitle: `${ready.length} ready${blocked.length ? `, ${blocked.length} held` : ""}`,
      body: html`
        ${tabs(PAYOUT_TABS, "vendors")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${blocked.length ? html`
          <div class="panel">
            <div class="panel__head">
              <h2>Held by a compliance problem</h2>
              <p>These are not in any run and will not be</p>
            </div>
            <div class="panel__body">
              ${notice("warn", "A contractor without current workers' compensation cannot be paid",
                "This is the barrier the whole compliance module exists for. Fix the certificate "
                + "under Contractors and the invoice becomes payable on its own.")}
              <div class="tablewrap" style="margin-top:1rem">
                <table class="data">
                  <thead><tr><th>Contractor</th><th>Invoice</th><th class="num">Amount</th><th>Why</th></tr></thead>
                  <tbody>
                    ${blocked.map((p) => html`
                      <tr>
                        <td>${p.vendorName}</td>
                        <td>${p.invoiceNo || "—"}<div class="cellsub">${human(p.invoiceDate)}</div></td>
                        <td class="num">${usd(p.amountCents)}</td>
                        <td>${p.blockedReasons.join(" ")}</td>
                      </tr>`)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>Ready to pay</h2></div>
          <div class="panel__body panel__body--flush">
            ${ready.length === 0
              ? html`<div class="panel__body">${empty("Nothing waiting",
                  "Approved invoices appear here. Approve them under Contractors.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Contractor</th><th>Invoice</th><th>Due</th>
                      <th>How they are paid</th><th class="num">Amount</th></tr></thead>
                    <tbody>
                      ${ready.map((p) => html`
                        <tr>
                          <td>${p.vendorName}</td>
                          <td>${p.invoiceNo || "—"}</td>
                          <td>${p.dueDate ? human(p.dueDate) : "—"}</td>
                          <td>${payeeMethod(p.account)}</td>
                          <td class="num">${usd(p.amountCents)}</td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
          ${ready.length === 0 ? "" : html`
            <div class="panel__foot">
              ${startRunForm({ csrf: ctx.csrf, action: "/app/payouts/vendors/draft", defaultMethod: "check" })}
            </div>`}
        </div>`,
    }));
  });

  router.post("/app/payouts/vendors/draft", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await draftVendorRun({
      companyId: cid,
      effectiveDate: String(ctx.fields.effective_date || addDays(today(), 1)),
      method: String(ctx.fields.method || "check"),
      createdBy: ctx.staff.id,
    });
    if (!res.ok) {
      return redirect(ctx.res, `/app/payouts/vendors?e=${encodeURIComponent(res.reason)}`);
    }
    return redirect(ctx.res, `/app/payouts/${res.batchId}`);
  });

  /* Registered before /app/payouts/:id, which would otherwise swallow them:
     a path parameter matches any single segment, so "bank" and "alignment"
     would be looked up as run ids and 404. */
  /* --- bank details --------------------------------------------------------- */

  router.get("/app/payouts/bank", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const register = await get("SELECT * FROM check_register WHERE company_id = ?", cid);
    const accounts = await all(
      `SELECT pa.*, o.name AS owner_name, v.name AS vendor_name
         FROM payee_account pa
         LEFT JOIN owner o ON o.id = pa.owner_id
         LEFT JOIN vendor v ON v.id = pa.vendor_id
        WHERE pa.company_id = ? ORDER BY COALESCE(o.name, v.name)`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payouts", counts: await navCounts(cid),
      title: "Bank details", subtitle: "Yours, and where each payee is paid",
      body: html`
        ${tabs(PAYOUT_TABS, "bank")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        <form method="post" action="/app/payouts/bank">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
          <div class="panel">
            <div class="panel__head">
              <h2>Your account</h2>
              <p>Where an ACH file says the money comes from</p>
            </div>
            <div class="panel__body">
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="ach_bank_name">Your bank</label>
                  <input id="ach_bank_name" name="ach_bank_name" type="text"
                         value="${company.ach_bank_name || ""}" />
                </div>
                <div class="field">
                  <label for="ach_routing_number">Routing number</label>
                  <input id="ach_routing_number" name="ach_routing_number" type="text" inputmode="numeric"
                         value="${company.ach_routing_number || ""}" />
                  <span class="field__help">Nine digits. We check the last one against the other eight.</span>
                </div>
                <div class="field">
                  <label for="ach_account">Account number</label>
                  <input id="ach_account" name="ach_account" type="text" inputmode="numeric"
                         placeholder="${company.ach_account_last4 ? `ending ${company.ach_account_last4} — leave blank to keep` : ""}" />
                  <span class="field__help">Stored encrypted. Only the last four are ever shown.</span>
                </div>
                <div class="field">
                  <label for="ach_company_id">Company identification</label>
                  <input id="ach_company_id" name="ach_company_id" type="text"
                         value="${company.ach_company_id || ""}" />
                  <span class="field__help">
                    Ten digits, assigned by your bank when they set up ACH origination.
                    Ask them — it is not your tax number unless they say it is.
                  </span>
                </div>
              </div>

              <div class="field">
                <div class="radioset">
                  <label class="radiotile">
                    <input type="checkbox" name="ach_balanced_file"${attr("checked", Number(company.ach_balanced_file) === 1)} />
                    <span>My bank wants a balanced file
                      <small>Some banks want the offsetting debit written into the file; others take it
                      from the account. Ask them which — sending the wrong one gets the file rejected.</small>
                    </span>
                  </label>
                </div>
              </div>
            </div>
            <div class="panel__foot"><button class="pill solid sm" type="submit">Save</button></div>
          </div>
        </form>

        <form method="post" action="/app/payouts/register">
          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
          <div class="panel">
            <div class="panel__head">
              <h2>Cheque book</h2>
              <p>The next number, and the account they are drawn on</p>
            </div>
            <div class="panel__body">
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="next_number">Next cheque number</label>
                  <input id="next_number" name="next_number" type="number" min="1" step="1"
                         value="${register ? register.next_number : 1001}" />
                  <span class="field__help">
                    Set this to match the stock in your printer. It only ever moves forward:
                    a used number is never issued again, even if a cheque is voided.
                  </span>
                </div>
                <div class="field">
                  <label for="account_number">Account for positive pay</label>
                  <input id="account_number" name="account_number" type="text"
                         value="${register?.account_number || ""}" />
                  <span class="field__help">As your bank writes it on the positive-pay file.</span>
                </div>
              </div>
            </div>
            <div class="panel__foot"><button class="pill solid sm" type="submit">Save</button></div>
          </div>
        </form>

        <div class="panel">
          <div class="panel__head">
            <h2>Where each payee is paid</h2>
            <p>Account numbers are encrypted; only the last four are shown</p>
          </div>
          <div class="panel__body panel__body--flush">
            ${accounts.length === 0
              ? html`<div class="panel__body">${empty("None recorded",
                  "Add them from an owner's or a contractor's page.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Payee</th><th>Method</th><th>Account</th><th>Posted to</th></tr></thead>
                    <tbody>
                      ${accounts.map((a) => html`
                        <tr>
                          <td>${a.owner_name || a.vendor_name}
                            <div class="cellsub">${a.owner_name ? "Owner" : "Contractor"}</div></td>
                          <td>${a.method === "ach" ? "Bank transfer" : "Cheque"}</td>
                          <td>${a.account_last4 ? `${a.routing_number} · ending ${a.account_last4}` : "—"}</td>
                          <td>${a.mail_to || "—"}</td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
        </div>`,
    }));
  });

  router.post("/app/payouts/bank", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const routing = String(f.ach_routing_number || "").replace(/\D/g, "");

    if (routing && !validRoutingNumber(routing)) {
      return redirect(ctx.res, `/app/payouts/bank?e=${encodeURIComponent(
        "That routing number's check digit does not match the rest of it. It is almost always a typo.")}`);
    }

    const { seal } = await import("../lib/crypto.js");
    const account = String(f.ach_account || "").replace(/\s/g, "");
    const patch = {
      ach_bank_name: String(f.ach_bank_name || "").trim() || null,
      ach_routing_number: routing || null,
      ach_company_id: String(f.ach_company_id || "").replace(/\D/g, "") || null,
      ach_balanced_file: f.ach_balanced_file ? 1 : 0,
    };
    /* Blank means unchanged, because the form only ever shows the last four. */
    if (account) {
      patch.ach_account_enc = seal(account);
      patch.ach_account_last4 = account.slice(-4);
    }

    await run(
      `UPDATE company SET ach_bank_name = ?, ach_routing_number = ?, ach_company_id = ?,
              ach_balanced_file = ?${account ? ", ach_account_enc = ?, ach_account_last4 = ?" : ""}
        WHERE id = ?`,
      patch.ach_bank_name, patch.ach_routing_number, patch.ach_company_id,
      patch.ach_balanced_file,
      ...(account ? [patch.ach_account_enc, patch.ach_account_last4] : []),
      cid);

    return redirect(ctx.res, `/app/payouts/bank?m=${encodeURIComponent("Saved.")}`);
  });

  router.post("/app/payouts/register", async (ctx) => {
    const cid = ctx.staff.company_id;
    const next = Math.max(1, Math.round(Number(ctx.fields.next_number) || 1001));

    const existing = await get("SELECT * FROM check_register WHERE company_id = ?", cid);

    /* Forward only. Setting it back would reissue a number that is already on
       a positive-pay file, and the bank would then have two different cheques
       claiming to be the same one. */
    if (existing && next < Number(existing.next_number)) {
      return redirect(ctx.res, `/app/payouts/bank?e=${encodeURIComponent(
        `The cheque book is at ${existing.next_number}. It cannot go backwards — `
        + `a reissued number would collide with one your bank already has.`)}`);
    }

    const accountNumber = String(ctx.fields.account_number || "").trim() || null;
    if (existing) {
      await run(
        "UPDATE check_register SET next_number = ?, account_number = ?, account_last4 = ?, updated_at = ? WHERE company_id = ?",
        next, accountNumber, accountNumber ? accountNumber.slice(-4) : null, stamp(), cid);
    } else {
      const { insert } = await import("../lib/db.js");
      await insert("check_register", {
        company_id: cid, next_number: next, account_number: accountNumber,
        account_last4: accountNumber ? accountNumber.slice(-4) : null, updated_at: stamp(),
      });
    }
    return redirect(ctx.res, `/app/payouts/bank?m=${encodeURIComponent("Saved.")}`);
  });

  /* --- a payee's account ---------------------------------------------------- */

  router.post("/app/payouts/payee", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const back = String(f.back || "/app/payouts/bank");

    const res = await savePayeeAccount({
      companyId: cid,
      ownerId: f.owner_id ? String(f.owner_id) : null,
      vendorId: f.vendor_id ? String(f.vendor_id) : null,
      method: String(f.method || "check"),
      routingNumber: String(f.routing_number || "").replace(/\D/g, "") || null,
      accountNumber: String(f.account_number || "").replace(/\s/g, ""),
      accountType: String(f.account_type || "checking"),
      accountName: String(f.account_name || "").trim() || null,
      mailTo: String(f.mail_to || "").trim() || null,
    });

    if (!res.ok) return redirect(ctx.res, `${back}?e=${encodeURIComponent(res.reason)}`);
    return redirect(ctx.res, `${back}?m=${encodeURIComponent("Saved.")}`);
  });

  /* Printed on plain paper and held against a blank cheque. Stock varies
     between suppliers and a cheque two millimetres out is rejected by the
     bank's reader, so this exists to be checked before a run is committed to
     expensive paper. */
  router.get("/app/payouts/alignment", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const pdf = await buildAlignmentSheet({
      company, layout: parseLayout(company.check_layout),
    });
    ctx.res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="cheque-alignment.pdf"',
      "cache-control": "no-store",
    });
    ctx.res.end(Buffer.from(pdf));
  });

  /* --- one run -------------------------------------------------------------- */

  router.get("/app/payouts/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const items = await all(
      "SELECT * FROM payout_item WHERE batch_id = ? ORDER BY check_number NULLS FIRST, payee_name",
      batch.id);

    /* A positive-pay file with an empty account column is one the bank will
       reject, and the rejection arrives long after the cheques are posted. */
    const register = batch.method === "check"
      ? await get("SELECT * FROM check_register WHERE company_id = ?", cid) : null;
    const missingPositivePayAccount = batch.method === "check"
      && batch.status !== "draft" && !register?.account_number;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payouts", counts: await navCounts(cid),
      title: `${batch.kind === "owner" ? "Owner distribution" : "Contractor payments"} — ${human(batch.effective_date)}`,
      subtitle: `${batch.method === "ach" ? "Bank transfer" : "Cheque"} · ${batch.status}`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${missingPositivePayAccount
          ? notice("warn", "The positive-pay file has no account number on it",
              html`Most banks reject one without it, and they reject it after the cheques are
                   posted. Add the account under <a href="/app/payouts/bank">Bank details</a>
                   and download the file again.`)
          : ""}

        ${batch.status === "draft"
          ? notice("warn", "Nothing has been committed yet",
              "No money has moved and nothing is on the books. Approving posts the journals, "
              + (batch.method === "check" ? "takes the cheque numbers " : "")
              + "and produces the file — and cannot be undone.")
          : batch.status === "approved"
            ? notice("ok", "Approved",
                html`The books are posted and the file is fixed.
                     <b>Download it and give it to your bank</b>, then mark the run as sent.`)
            : batch.status === "issued"
              ? notice("ok", "Sent to the bank", `Marked as sent ${humanStamp(batch.issued_at)}.`)
              : notice("danger", "Cancelled", batch.cancel_reason || "")}

        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Payments</span><span class="tile__value">${batch.item_count}</span></div>
          <div class="tile"><span class="tile__label">Total</span><span class="tile__value">${usd(batch.total_cents)}</span></div>
          <div class="tile"><span class="tile__label">Effective</span><span class="tile__value">${human(batch.effective_date)}</span></div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Payments in this run</h2></div>
          <div class="panel__body panel__body--flush">
            <div class="tablewrap">
              <table class="data">
                <thead><tr>
                  ${batch.method === "check" ? html`<th>Cheque</th>` : ""}
                  <th>Payee</th><th>Account</th><th>For</th><th class="num">Amount</th>
                  ${batch.status === "approved" || batch.status === "issued" ? html`<th></th>` : ""}
                </tr></thead>
                <tbody>
                  ${items.map((i) => html`
                    <tr${attr("style", i.voided_at ? "opacity:0.5" : null)}>
                      ${batch.method === "check" ? html`<td>${i.check_number || "—"}</td>` : ""}
                      <td>${i.payee_name}${i.voided_at
                        ? html`<div class="cellsub">Void — ${i.void_reason || ""}</div>` : ""}</td>
                      <td>${i.account_last4 ? `ending ${i.account_last4}` : "cheque"}</td>
                      <td>${i.memo || "—"}</td>
                      <td class="num">${usd(i.amount_cents)}</td>
                      ${batch.status === "approved" || batch.status === "issued"
                        ? html`<td class="shrink">${i.voided_at ? "" : html`
                            <form method="post" action="/app/payouts/${batch.id}/void"
                                  style="display:flex;gap:0.5rem;align-items:center">
                              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                              <input type="hidden" name="item_id" value="${i.id}" />
                              <input type="text" name="reason" placeholder="Why" required
                                     aria-label="Why this cheque was voided" style="max-width:10rem" />
                              <button class="pill outline sm" type="submit">Void</button>
                            </form>`}</td>`
                        : ""}
                    </tr>`)}
                </tbody>
              </table>
            </div>
          </div>

          <div class="panel__foot">
            ${batch.status === "draft" ? html`
              <div class="btnrow">
                <form method="post" action="/app/payouts/${batch.id}/approve">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <button class="pill solid" type="submit">
                    Approve and produce the ${batch.method === "ach" ? "bank file" : "cheques"}
                  </button>
                </form>
                <form method="post" action="/app/payouts/${batch.id}/cancel"
                      style="display:flex;gap:0.5rem;align-items:center">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <input type="text" name="reason" placeholder="Why" required
                         aria-label="Why this run is being discarded" style="max-width:12rem" />
                  <button class="pill outline" type="submit">Discard this run</button>
                </form>
              </div>` : ""}

            ${batch.status === "approved" || batch.status === "issued" ? html`
              <div class="btnrow">
                ${batch.method === "ach"
                  ? html`<a class="pill solid sm" href="/app/payouts/${batch.id}/file">Download the ACH file</a>`
                  : html`
                    <a class="pill solid sm" href="/app/payouts/${batch.id}/checks">Print the cheques</a>
                    <a class="pill outline sm" href="/app/payouts/${batch.id}/file">Positive-pay CSV</a>
                    <a class="pill outline sm" href="/app/payouts/alignment">Alignment test page</a>`}
                ${batch.status === "approved" ? html`
                  <form method="post" action="/app/payouts/${batch.id}/issued">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <button class="pill outline sm" type="submit">Mark as sent to the bank</button>
                  </form>` : ""}
              </div>` : ""}
          </div>
        </div>`,
    }));
  });

  router.post("/app/payouts/:id/approve", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await approveBatch({ batchId: ctx.params.id, companyId: cid, by: ctx.staff.id });
    if (!res.ok) {
      return redirect(ctx.res, `/app/payouts/${ctx.params.id}?e=${encodeURIComponent(res.reason)}`);
    }
    return redirect(ctx.res, `/app/payouts/${ctx.params.id}?m=${encodeURIComponent(
      "Approved. Download the file and give it to your bank.")}`);
  });

  router.post("/app/payouts/:id/cancel", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await cancelBatch({
      batchId: ctx.params.id, companyId: cid,
      reason: String(ctx.fields.reason || ""), by: ctx.staff.id,
    });
    if (!res.ok) {
      return redirect(ctx.res, `/app/payouts/${ctx.params.id}?e=${encodeURIComponent(res.reason)}`);
    }
    return redirect(ctx.res, `/app/payouts?m=${encodeURIComponent("That run was discarded.")}`);
  });

  router.post("/app/payouts/:id/void", async (ctx) => {
    const cid = ctx.staff.company_id;
    const reason = String(ctx.fields.reason || "").trim();
    if (reason.length < 3) {
      return redirect(ctx.res, `/app/payouts/${ctx.params.id}?e=${encodeURIComponent(
        "Say why it was voided — a spoiled cheque number stays on the register and somebody will ask.")}`);
    }
    await voidItem({
      itemId: String(ctx.fields.item_id || ""), companyId: cid, reason, by: ctx.staff.id,
    });
    return redirect(ctx.res, `/app/payouts/${ctx.params.id}?m=${encodeURIComponent("Voided.")}`);
  });

  router.post("/app/payouts/:id/issued", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await markIssued({ batchId: ctx.params.id, companyId: cid, by: ctx.staff.id });
    if (!res.ok) {
      return redirect(ctx.res, `/app/payouts/${ctx.params.id}?e=${encodeURIComponent(res.reason)}`);
    }
    return redirect(ctx.res, `/app/payouts/${ctx.params.id}?m=${encodeURIComponent("Marked as sent.")}`);
  });

  /* --- the files ------------------------------------------------------------ */

  router.get("/app/payouts/:id/file", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (!batch.file_text) throw new BadRequest("That run has no file yet. Approve it first.");

    /* Served as an attachment rather than rendered: an ACH file opened in a
       browser is a wall of digits somebody will copy and paste, and the
       whitespace matters. */
    ctx.res.writeHead(200, {
      "content-type": batch.method === "ach" ? "text/plain; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${batch.file_name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    ctx.res.end(batch.file_text);
  });

  router.get("/app/payouts/:id/checks", async (ctx) => {
    const cid = ctx.staff.company_id;
    const batch = await one(
      "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const company = await one("SELECT * FROM company WHERE id = ?", cid);

    const pdf = await renderChecks({
      batchId: batch.id, companyId: cid, layout: parseLayout(company.check_layout),
    });
    ctx.res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="cheques-${batch.effective_date}.pdf"`,
      "cache-control": "no-store",
    });
    ctx.res.end(Buffer.from(pdf));
  });
}

/* --- views ------------------------------------------------------------------ */

function payeeMethod(account) {
  if (!account) return html`<span class="chip" data-tone="warn">not set</span>`;
  if (account.method === "ach") {
    return html`Bank transfer<div class="cellsub">ending ${account.accountLast4 || "••••"}</div>`;
  }
  return html`Cheque`;
}

function startRunForm({ csrf, action, defaultMethod = "ach" }) {
  return html`
    <form method="post" action="${action}" class="formgrid formgrid--2">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <div class="field">
        <label for="effective_date-${action}">Effective date</label>
        <input id="effective_date-${action}" name="effective_date" type="date"
               value="${addDays(today(), 1)}" required />
        <span class="field__help">The day you are asking the bank to move it.</span>
      </div>
      <div class="field">
        <label for="method-${action}">How</label>
        <select id="method-${action}" name="method">
          <option value="ach"${attr("selected", defaultMethod === "ach")}>Bank transfer (ACH file)</option>
          <option value="check"${attr("selected", defaultMethod === "check")}>Cheque</option>
        </select>
        <span class="field__help">One method per run — it produces one thing to hand to the bank.</span>
      </div>
      <div class="btnrow">
        <button class="pill solid" type="submit">Assemble a run</button>
      </div>
    </form>`;
}

function parseLayout(json) {
  try { return JSON.parse(json || "{}") || {}; } catch { return {}; }
}
