/* Security deposits: what is held, what is coming out of it, and the clock.

   ## The list leads with the deadline

   A deposit return is the one obligation in this application that carries a
   statutory penalty for being late in most states, and the compliance engine
   has been counting forward to it since Phase 1. So the list is ordered by
   when it is due and says how long is left, rather than by when it opened.

   ## The itemisation is shown before it is sent

   Somebody is about to tell a person why they are not getting their money
   back. They should be able to read the exact words first — a screen that
   settles and then reveals what went out is a screen that produces disputes. */
import { all, get, one } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today, daysBetween } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { insert } from "../lib/db.js";
import {
  returnDetail, addDeduction, removeDeduction, settleReturn, renderItemisation,
  deductibleFrom, DepositRefused,
} from "../lib/deposits.js";
import { conditionLabel } from "../lib/inspections.js";

export function registerDeposits(router) {
  router.get("/app/deposits", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await all(
      `SELECT r.*, u.label, p.line1, p.city,
              (SELECT COALESCE(SUM(d.amount_cents), 0) FROM deposit_deduction d
                WHERE d.return_id = r.id)::bigint AS deducted,
              (SELECT string_agg(t.name, ', ') FROM lease_tenant lt
                 JOIN tenant t ON t.id = lt.tenant_id WHERE lt.lease_id = r.lease_id) AS tenants
         FROM deposit_return r
         JOIN lease l ON l.id = r.lease_id
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
        WHERE r.company_id = ?
        ORDER BY r.status, r.due_by NULLS LAST, r.opened_at DESC`, cid);

    const open = rows.filter((r) => r.status === "open");
    const done = rows.filter((r) => r.status !== "open");

    /* What the books say is held against tenancies with no return open at
       all. A figure that should be the deposits of everybody still living
       here, and is worth showing beside the returns so the two add up. */
    const stillHeld = await get(
      `SELECT COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
         FROM journal_split s
         JOIN account a ON a.id = s.account_id
        WHERE a.company_id = ? AND a.code = '2100'`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "deposits", counts: await navCounts(cid),
      title: "Deposits",
      subtitle: `${usd(stillHeld?.cents || 0)} held in trust`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${open.some((r) => r.due_by && today() > r.due_by)
          ? notice("danger", "A return is past its deadline",
            "In most states a missed deposit-return window carries a penalty well beyond "
            + "the deposit itself. These are the ones to do today.")
          : ""}

        <div class="panel">
          <div class="panel__head"><h2>Open</h2>
            <p>Ordered by when they are due, not by when they opened</p>
          </div>
          <div class="panel__body panel__body--flush">
            ${open.length ? html`<div class="tablewrap"><table class="data">
              <thead><tr><th>Where</th><th>Tenant</th><th>Moved out</th><th>Due</th>
                <th class="num">Held</th><th class="num">Deducted</th><th class="shrink"></th></tr></thead>
              <tbody>${open.map((r) => {
                const late = r.due_by && today() > r.due_by;
                const left = r.due_by ? daysBetween(today(), r.due_by) : null;
                return html`
                  <tr>
                    <td><a href="/app/deposits/${r.id}">${r.line1}${r.label ? `, unit ${r.label}` : ""}</a>
                      <span class="cellsub">${r.city || ""}</span></td>
                    <td>${r.tenants || "—"}</td>
                    <td class="shrink">${human(r.moveout_date)}</td>
                    <td class="shrink">${r.due_by
                      ? html`<span class="chip"${attr("data-tone", late ? "danger" : left <= 7 ? "warn" : null)}>${human(r.due_by)}</span>
                          <span class="cellsub">${late ? `${Math.abs(left)} days late` : `${left} days left`}</span>`
                      : html`<span class="cellsub">no rule set</span>`}</td>
                    <td class="num">${usd(r.held_cents)}</td>
                    <td class="num">${Number(r.deducted) ? usd(r.deducted) : "—"}</td>
                    <td class="shrink"><a class="pill outline sm" href="/app/deposits/${r.id}"
                  ${attr("aria-label", `Open the deposit return for ${r.line1 || "this home"}`)}>Open</a></td>
                  </tr>`;
              })}</tbody>
            </table></div>` : empty("Nothing open",
              "A return opens by itself when a move-out is recorded.")}
          </div>
        </div>

        ${done.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Settled</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Where</th><th>Settled</th><th class="num">Held</th>
                  <th class="num">Deducted</th><th class="num">Returned</th><th class="shrink"></th></tr></thead>
                <tbody>${done.map((r) => html`
                  <tr>
                    <td><a href="/app/deposits/${r.id}">${r.line1}${r.label ? `, unit ${r.label}` : ""}</a></td>
                    <td class="shrink">${r.settled_at ? humanStamp(r.settled_at) : "—"}</td>
                    <td class="num">${usd(r.held_cents)}</td>
                    <td class="num">${Number(r.deducted) ? usd(r.deducted) : "—"}</td>
                    <td class="num">${usd(r.returned_cents || 0)}</td>
                    <td class="shrink">${r.itemisation_outbox_id
                      ? html`<span class="cellsub">statement queued</span>`
                      : html`<span class="cellsub">no email on file</span>`}</td>
                  </tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}`,
    }));
  });

  router.get("/app/deposits/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const detail = await returnDetail({ companyId: cid, returnId: ctx.params.id });
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const jobs = await all(
      `SELECT w.id, w.reference, w.summary, w.actual_cents
         FROM work_order w
        WHERE w.company_id = ? AND w.unit_id = ? AND w.status = 'complete'
        ORDER BY w.closed_at DESC NULLS LAST LIMIT 20`, cid, detail.unit_id);

    /* What the move-out inspection found worse than the move-in. This is the
       join the inspection feature exists for: a deduction with the room, both
       conditions and the photographs behind it survives being disputed. */
    const found = await deductibleFrom({ companyId: cid, returnId: ctx.params.id });
    const preview = renderItemisation({ detail, company });
    const where = `${detail.line1}${detail.label ? `, unit ${detail.label}` : ""}`;
    const settled = detail.status === "settled";

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "deposits", counts: await navCounts(cid),
      title: `Deposit — ${where}`,
      subtitle: `${detail.tenants.map((t) => t.name).join(", ") || "no tenant on file"} · moved out ${human(detail.moveout_date)}`,
      actions: html`<a class="pill outline sm" href="/app/deposits">Back</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${detail.overdue ? notice("danger", "Past the deadline",
          html`This was due ${human(detail.due_by)}${detail.basis ? ` — ${detail.basis}` : ""}.
            In most states a missed window carries a penalty beyond the deposit.`) : ""}

        ${settled ? notice("ok", "Settled",
          html`${humanStamp(detail.settled_at)} by ${detail.settled_by}.
            ${usd(detail.returned_cents || 0)} returned.
            ${detail.itemisation_outbox_id
              ? html` The statement is in the <a href="/app/messages/sent">outbox</a>.`
              : " No email was on file, so the statement was written and not sent."}`) : ""}

        <div class="grid grid--2">
          <div class="panel">
            <div class="panel__head"><h2>The money</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <tbody>
                  <tr><td>Held in trust</td><td class="num">${usd(detail.held_cents)}</td></tr>
                  <tr><td>Deductions</td><td class="num">${usd(detail.deducted)}</td></tr>
                  <tr><td><b>${settled ? "Returned" : "Would be returned"}</b></td>
                      <td class="num"><b>${usd(detail.balance)}</b></td></tr>
                </tbody>
              </table></div>
              ${Number(detail.held_cents) === 0 ? html`<div class="panel__body">
                ${notice("warn", "The books say nothing is held",
                  html`The lease may have a deposit on it, but no posting was ever made
                    against <code>2100</code> for this tenancy. Until that is put right there
                    is nothing to return. See the deposit conversion in the README, or ask
                    for it to be run.`)}</div>` : ""}
            </div>
          </div>

          <div class="panel">
            <div class="panel__head"><h2>Deductions</h2>
              <p>Each one in the words the tenant will read</p>
            </div>
            <div class="panel__body panel__body--flush">
              ${detail.deductions.length ? html`<div class="tablewrap"><table class="data">
                <tbody>${detail.deductions.map((d) => html`
                  <tr>
                    <td>${d.reason}
                      ${d.reference ? html`<span class="cellsub">repair ${d.reference} — ${d.work_order_summary}</span>` : ""}
                      ${d.inspection_label ? html`<span class="cellsub">${conditionLabel(d.inspection_before)} at move-in,
                        ${conditionLabel(d.inspection_condition)} at move-out</span>` : ""}</td>
                    <td class="num">${usd(d.amount_cents)}</td>
                    <td class="shrink">${settled ? "" : html`
                      <form method="post" action="/app/deposits/${detail.id}/deduction/${d.id}/delete">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <button class="pill outline sm" type="submit">Remove</button>
                      </form>`}</td>
                  </tr>`)}</tbody>
              </table></div>` : empty("None", "The whole deposit goes back.")}

              ${settled ? "" : html`<div class="panel__body">
                <form method="post" action="/app/deposits/${detail.id}/deduction" class="formgrid">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="field">
                    <label for="reason">What for</label>
                    <input id="reason" name="reason" type="text" required maxlength="200"
                           placeholder="Carpet in the second bedroom, beyond fair wear" />
                    <span class="field__help">The tenant reads this word for word. "Damages"
                      is the thing an itemisation exists to prevent.</span>
                  </div>
                  <div class="formgrid formgrid--2">
                    <div class="field">
                      <label for="amount">Amount</label>
                      <input id="amount" name="amount" type="text" inputmode="decimal" required
                             placeholder="150.00" />
                    </div>
                    <div class="field">
                      <label for="work_order_id">From a repair <span
                        style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                      <select id="work_order_id" name="work_order_id">
                        <option value="">Not from a repair</option>
                        ${jobs.map((j) => html`<option value="${j.id}">${j.reference} — ${j.summary}${j.actual_cents ? ` (${usd(j.actual_cents)})` : ""}</option>`)}
                      </select>
                      <span class="field__help">A repair that was actually done is the
                        strongest evidence there is.</span>
                    </div>
                  </div>
                  <button class="pill solid sm" type="submit">Add deduction</button>
                </form>
              </div>`}
            </div>
          </div>
        </div>

        ${!settled && found.items.some((i) => !i.taken) ? html`
          <div class="panel">
            <div class="panel__head"><h2>From the move-out inspection</h2>
              <p>The lines that got worse — the only ones that can justify keeping any of it</p>
            </div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
                <thead><tr><th>Where</th><th class="shrink">At move-in</th>
                  <th class="shrink">At move-out</th><th>Photos</th><th class="shrink"></th></tr></thead>
                <tbody>${found.items.filter((i) => !i.taken).map((item) => html`
                  <tr>
                    <td>${item.room} — ${item.label}
                      ${item.note ? html`<span class="cellsub">${item.note}</span>` : ""}</td>
                    <td class="shrink"><span class="cellsub">${conditionLabel(item.before_condition)}</span></td>
                    <td class="shrink"><span class="chip" data-tone="warn">${conditionLabel(item.condition)}</span></td>
                    <td><span class="cellsub">${item.photos || 0}</span></td>
                    <td class="shrink">
                      <form method="post" action="/app/deposits/${detail.id}/deduction" class="formgrid" style="gap:0.35rem">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <input type="hidden" name="inspection_item_id" value="${item.id}" />
                        <input type="hidden" name="reason"
                               value="${item.room} — ${item.label}${item.note ? `: ${item.note}` : ""}" />
                        <input name="amount" type="text" inputmode="decimal" required
                               placeholder="0.00" style="max-width:7rem" />
                        <button class="pill outline sm" type="submit">Deduct</button>
                      </form>
                    </td>
                  </tr>`)}</tbody>
              </table></div>
              <div class="panel__body">
                <span class="cellsub">The reason is filled in for you from the inspection —
                  a deduction that says which room, what it was and what it became survives
                  being disputed. One that says "damages" does not.</span>
              </div>
            </div>
          </div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>${settled ? "What was sent" : "What will be sent"}</h2>
            <p>${settled ? "Exactly as it went out" : "Read it before you settle"}</p>
          </div>
          <div class="panel__body">
            <div class="tablewrap"><table class="data"><tbody><tr><td>
              <pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;font-size:0.9em">${settled ? detail.itemisation : preview}</pre>
            </td></tr></tbody></table></div>

            ${settled ? "" : html`
              <div style="margin-top:1.25rem">
                ${notice("info", "What settling does",
                  html`Posts <code>${usd(detail.held_cents)}</code> off deposits held, returns
                    <code>${usd(detail.balance)}</code> from the trust account, and credits
                    <code>${usd(detail.deducted)}</code> to the owner — a deduction reimburses
                    whoever paid to put the damage right, which is them.
                    ${detail.tenants.some((t) => t.email)
                      ? " The statement above is queued to the tenant."
                      : " No email is on file, so the statement is kept here to print."}`)}
                <form method="post" action="/app/deposits/${detail.id}/settle" class="formgrid"
                      style="margin-top:1rem">
                  <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                  <div class="field" style="max-width:16rem">
                    <label for="date">Date</label>
                    <input id="date" name="date" type="date" value="${today()}" required />
                  </div>
                  <div class="btnrow">
                    <button class="pill solid sm" type="submit">Settle and send</button>
                  </div>
                </form>
              </div>`}
          </div>
        </div>`,
    }));
  });

  router.post("/app/deposits/:id/deduction", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res, `/app/deposits/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    const cents = parseMoney(ctx.fields.amount);
    if (cents == null) return back("That amount is not an amount.");

    try {
      await addDeduction({
        companyId: cid, returnId: ctx.params.id,
        reason: ctx.fields.reason, amountCents: cents,
        workOrderId: String(ctx.fields.work_order_id || "") || null,
        inspectionItemId: String(ctx.fields.inspection_item_id || "") || null,
        by: ctx.staff.name,
      });
    } catch (err) {
      if (err instanceof DepositRefused) return back(err.message);
      throw err;
    }
    back("Deduction added.");
  });

  router.post("/app/deposits/:id/deduction/:deductionId/delete", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res, `/app/deposits/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    try {
      await removeDeduction({ companyId: cid, deductionId: ctx.params.deductionId });
    } catch (err) {
      if (err instanceof DepositRefused) return back(err.message);
      throw err;
    }
    back("Removed.");
  });

  router.post("/app/deposits/:id/settle", async (ctx) => {
    const cid = ctx.staff.company_id;
    const back = (m) => redirect(ctx.res, `/app/deposits/${ctx.params.id}?m=${encodeURIComponent(m)}`);
    const date = String(ctx.fields.date || today()).slice(0, 10);

    let settled;
    try {
      settled = await settleReturn({
        companyId: cid, returnId: ctx.params.id, date, by: ctx.staff.name });
    } catch (err) {
      if (err instanceof DepositRefused) return back(err.message);
      /* A closed period refuses the posting, and that is the operator's
         business rather than a fault. `periodClosed` rather than the class
         name, because that is the flag accounting.js sets for exactly this. */
      if (err?.periodClosed) return back(err.message);
      throw err;
    }

    await insert("audit_log", {
      id: id(), company_id: cid, at: stamp(), actor: ctx.staff.name,
      entity: "lease", entity_id: settled.lease_id, action: "deposit_returned",
      detail: `${usd(settled.returned_cents || 0)} returned of ${usd(settled.held_cents)} held`,
    });

    back(settled.itemisation_outbox_id
      ? "Settled. The statement is queued — check Messages for delivery."
      : "Settled. No email was on file, so the statement is here to print.");
  });
}
