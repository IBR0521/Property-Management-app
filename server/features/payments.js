/* Paying rent, from the tenant's side.

   A tenant has no account here and never will. The link on their lease
   carries a token, the same way the QR sticker and the owner statement do,
   and that token is the whole credential. Asking somebody to invent a
   password to pay their rent is how a product ends up with a phone number
   people call instead.

   Card and bank details never reach this server. The tenant is handed to
   Stripe's own hosted page on the company's connected account, which keeps
   the PCI surface there, needs no third-party script, and leaves the content
   security policy at `script-src 'self'`. Every screen here works with
   JavaScript switched off, because a page that takes somebody's money is the
   wrong place to require it.

   The money is never ours at any point. It goes from the tenant to the
   property manager's own Stripe account and their own bank. This app
   orchestrates and records; it is never the custodian. */
import { all, get, one, insert, update, run } from "../lib/db.js";
import { usd, parseMoney } from "../lib/money.js";
import { human, humanStamp, monthKey, today, dueDateFor, stamp, rentDayLabel } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr, raw } from "../lib/render.js";
import { appPage, publicPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { log } from "../lib/logger.js";
import { token } from "../lib/ids.js";
import {
  connectConfigured, authorizeUrl, exchangeCode, accountStatus,
} from "../lib/connect.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { APP_BASE_URL } from "../lib/config.js";
import { quote, describeQuote, availableMethods } from "../lib/fees.js";
import { id } from "../lib/ids.js";
import {
  balanceFor, blockedReason, startCheckout, enrolAutopay, cancelAutopay,
  autopayDueToday, settlePayment, failPayment, returnPayment, recordStripePayout,
} from "../lib/payments.js";

const METHOD_LABEL = { ach: "Bank account", card: "Debit or credit card" };
const STATUS_LABEL = {
  pending: "Not finished", processing: "On its way", succeeded: "Paid",
  failed: "Did not go through", returned: "Returned by the bank", refunded: "Refunded",
};
const STATUS_TONE = {
  succeeded: "ok", processing: "", returned: "danger", failed: "warn",
  refunded: "warn", pending: "warn",
};

export function registerPayments(router) {
  registerPaymentSettings(router);

  /* --- the page ----------------------------------------------------------- */

  router.get("/pay/:tok", async (ctx) => {
    const { company, lease, unit } = await resolve(ctx.params.tok);
    const period = monthKey(today());
    const balance = await balanceFor(lease.id, period);
    const methods = availableMethods(company);
    const blocked = blockedReason(lease);

    const [autopay, method, history] = await Promise.all([
      get("SELECT * FROM autopay WHERE lease_id = ?", lease.id),
      get(`SELECT * FROM tenant_payment_method WHERE lease_id = ? AND status = 'active'
            ORDER BY created_at DESC LIMIT 1`, lease.id),
      all(`SELECT * FROM tenant_payment WHERE lease_id = ?
            ORDER BY created_at DESC LIMIT 6`, lease.id),
    ]);

    sendHtml(ctx.res, publicPage({
      company,
      title: `Pay rent · ${company.name}`,
      heading: "Pay your rent",
      lede: `${unit.line1}${unit.label ? `, unit ${unit.label}` : ""}`,
      body: html`
        ${ctx.query.e ? notice("warn", null, ctx.query.e) : ""}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${balanceTiles(balance)}

        ${blocked
          ? notice("warn", "Online payment is not available for this home", blocked)
          : methods.length === 0
            ? notice("warn", "Online payment is not set up yet",
                html`Please pay the way you normally do${company.phone
                  ? html`, or call <a href="tel:${company.phone}">${company.phone}</a>` : ""}.`)
            : payForm({ company, lease, balance, methods, csrf: ctx.csrf, tok: ctx.params.tok })}

        ${blocked || methods.length === 0 ? "" : autopayPanel({
          company, lease, autopay, method, csrf: ctx.csrf, tok: ctx.params.tok,
        })}

        ${historyPanel(history)}`,
      foot: html`${company.name}${company.phone
        ? html` · <a href="tel:${company.phone}">${company.phone}</a>` : ""}
        · Payments are handled by Stripe on ${company.name}'s account.`,
    }));
  });

  /* --- starting a payment -------------------------------------------------- */

  router.post("/pay/:tok", async (ctx) => {
    const { company, lease } = await resolve(ctx.params.tok);
    const back = (m) => redirect(ctx.res, `/pay/${ctx.params.tok}?e=${encodeURIComponent(m)}`);

    /* Anyone with the link can post here, and each post creates a Stripe
       session. Generous enough for somebody who mistypes an amount twice,
       tight enough that the link cannot be used to run up API calls. */
    const gate = await check("pay", clientIp(ctx.req));
    if (!gate.allowed) {
      return back("Too many attempts from this connection. Please wait a few minutes, or call the office.");
    }

    const blocked = blockedReason(lease);
    if (blocked) return back(blocked);

    const kind = String(ctx.fields.kind || "ach");
    if (!availableMethods(company).includes(kind)) {
      return back("That payment method is not available.");
    }

    const amount = parseMoney(ctx.fields.amount);
    if (amount == null || amount <= 0) return back("Enter the amount you want to pay.");

    /* An upper bound so a mistyped amount cannot become a $145,000 debit.
       Deliberately loose — somebody paying several months ahead is normal. */
    const ceiling = Number(lease.rent_cents) * 12 + 500000;
    if (amount > ceiling) {
      return back(`That is more than we can take online. Please call the office to arrange it.`);
    }

    const base = APP_BASE_URL || `${ctx.url.protocol}//${ctx.url.host}`;
    const res = await startCheckout({
      companyId: company.id, leaseId: lease.id, amountCents: amount, kind,
      saveForFuture: String(ctx.fields.save_method || "") === "on",
      successUrl: `${base}/pay/${ctx.params.tok}/back?s={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/pay/${ctx.params.tok}?e=${encodeURIComponent("Payment cancelled. Nothing was charged.")}`,
    });

    if (!res.ok) return back(res.reason || "We could not start that payment.");
    /* 303 so the browser follows with GET and a refresh on Stripe's page does
       not repost this form. */
    return redirect(ctx.res, res.url, 303);
  });

  /* --- coming back from Stripe --------------------------------------------- */

  /* The tenant lands here the moment they authorise, which is *before* the
     money has moved — an ACH debit takes days. So this page confirms what was
     authorised and says plainly when it will be complete. It does not say
     "paid", because that is not yet true, and the webhook is what makes it
     true. */
  router.get("/pay/:tok/back", async (ctx) => {
    const { company, lease, unit } = await resolve(ctx.params.tok);
    const payment = ctx.query.s
      ? await get("SELECT * FROM tenant_payment WHERE stripe_checkout_session_id = ? AND lease_id = ?",
          String(ctx.query.s), lease.id)
      : null;

    if (!payment) {
      return redirect(ctx.res, `/pay/${ctx.params.tok}?m=${encodeURIComponent(
        "Thanks. If you completed the payment it will appear below shortly.")}`);
    }

    sendHtml(ctx.res, publicPage({
      company,
      title: `Payment started · ${company.name}`,
      heading: "Thank you",
      lede: `${unit.line1}${unit.label ? `, unit ${unit.label}` : ""}`,
      body: html`
        ${payment.status === "succeeded"
          ? notice("ok", "Payment complete",
              `${usd(payment.charged_cents)} received on ${humanStamp(payment.settled_at)}.`)
          : notice("ok", "Payment authorised",
              payment.kind === "ach"
                ? html`We have asked your bank for ${usd(payment.charged_cents)}. Bank transfers
                       usually take two to five working days to clear, and your rent counts as
                       paid on the day you authorised it. We will not ask you for it again while
                       it is on its way.`
                : html`${usd(payment.charged_cents)} has been authorised and should clear within a day.`)}

        <div class="panel">
          <div class="panel__head"><h2>What you authorised</h2></div>
          <div class="panel__body">
            <dl class="dl">
              <div><dt>Amount</dt><dd><b style="font-weight:500">${usd(payment.charged_cents)}</b></dd></div>
              ${Number(payment.tenant_fee_cents) > 0
                ? html`<div><dt>Of which processing fee</dt><dd>${usd(payment.tenant_fee_cents)}</dd></div>`
                : ""}
              <div><dt>For</dt><dd>Rent ${payment.period ? human(`${payment.period}-01`).replace(/^\d+\s/, "") : ""}</dd></div>
              <div><dt>Method</dt><dd>${METHOD_LABEL[payment.kind] || payment.kind}</dd></div>
              <div><dt>Reference</dt><dd>${payment.id.slice(-10)}</dd></div>
              <div><dt>Started</dt><dd>${humanStamp(payment.created_at)}</dd></div>
            </dl>
          </div>
          <div class="panel__foot">
            Keep this reference. ${company.phone
              ? html`Questions: <a href="tel:${company.phone}">${company.phone}</a>.` : ""}
          </div>
        </div>

        <div class="btnrow">
          <a class="pill outline" href="/pay/${ctx.params.tok}">Back to your rent</a>
        </div>`,
    }));
  });

  /* --- autopay ------------------------------------------------------------- */

  router.post("/pay/:tok/autopay", async (ctx) => {
    const { company, lease } = await resolve(ctx.params.tok);
    const back = (q) => redirect(ctx.res, `/pay/${ctx.params.tok}?${q}`);
    const fail = (m) => back(`e=${encodeURIComponent(m)}`);

    if (String(ctx.fields.action || "") === "cancel") {
      await cancelAutopay(lease.id);
      return back(`m=${encodeURIComponent(
        "Automatic payments are off. You will need to pay each month yourself.")}`);
    }

    const method = await get(
      `SELECT * FROM tenant_payment_method WHERE lease_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1`, lease.id);
    if (!method) {
      return fail("Make one payment first and tick “save this account”, then autopay can be switched on.");
    }

    /* The ceiling is required, not optional. An unbounded instruction to take
       whatever is owed is the thing that turns a rent rise into an overdraft,
       and the default offered on the form is this month's rent. */
    const ceiling = parseMoney(ctx.fields.max_amount);
    if (ceiling == null || ceiling <= 0) {
      return fail("Set the most we may take in one month.");
    }
    if (ceiling < Number(lease.rent_cents)) {
      return fail(`That limit is below your current rent of ${usd(lease.rent_cents)}, `
        + `so every payment would be declined.`);
    }

    const res = await enrolAutopay({
      companyId: company.id, leaseId: lease.id, paymentMethodId: method.id,
      daysBeforeDue: Number(ctx.fields.days_before || 3),
      maxAmountCents: ceiling, ip: clientIp(ctx.req),
    });
    if (!res.ok) return fail(res.reason);

    return back(`m=${encodeURIComponent(
      `Automatic payments are on, up to ${usd(ceiling)} a month. You can turn this off at any time.`)}`);
  });
}

/* --- resolving the link ----------------------------------------------------

   The token names a lease, and the lease names its company. That order
   matters: choosing a company first and looking for the token inside it is
   the bug that made every sticker outside the first company fail. */
async function resolve(tok) {
  const row = await get(
    `SELECT l.*, c.id AS cid, c.name AS company_name, c.phone AS company_phone,
            c.slug AS company_slug, c.stripe_account_id, c.stripe_charges_enabled,
            c.accept_ach, c.accept_card, c.ach_fee_model, c.card_fee_model,
            c.ach_fee_split_percent, c.card_fee_split_percent,
            c.ach_fee_bps, c.ach_fee_cap_cents, c.card_fee_bps, c.card_fee_fixed_cents,
            u.label, u.id AS uid, p.line1, p.city, p.state
       FROM lease l
       JOIN company c ON c.id = l.company_id
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.pay_token = ?`, String(tok || ""));
  if (!row) throw new NotFound("That payment link is not valid. Please check with the office.");

  return {
    company: {
      id: row.cid, name: row.company_name, phone: row.company_phone, slug: row.company_slug,
      stripe_account_id: row.stripe_account_id,
      stripe_charges_enabled: row.stripe_charges_enabled,
      accept_ach: row.accept_ach, accept_card: row.accept_card,
      ach_fee_model: row.ach_fee_model, card_fee_model: row.card_fee_model,
      ach_fee_split_percent: row.ach_fee_split_percent,
      card_fee_split_percent: row.card_fee_split_percent,
      ach_fee_bps: row.ach_fee_bps, ach_fee_cap_cents: row.ach_fee_cap_cents,
      card_fee_bps: row.card_fee_bps, card_fee_fixed_cents: row.card_fee_fixed_cents,
    },
    lease: row,
    unit: { id: row.uid, label: row.label, line1: row.line1, city: row.city, state: row.state },
  };
}

/* --- views ----------------------------------------------------------------- */

function balanceTiles(b) {
  return html`
    <div class="grid grid--3">
      <div class="tile"><span class="tile__label">Rent this month</span><span class="tile__value">${usd(b.rentCents)}</span></div>
      ${b.feeCents > 0
        ? html`<div class="tile"><span class="tile__label">Late fees</span><span class="tile__value">${usd(b.feeCents)}</span></div>`
        : html`<div class="tile"><span class="tile__label">Already paid</span><span class="tile__value">${usd(b.paidCents)}</span></div>`}
      <div class="tile"${attr("data-tone", b.outstandingCents > 0 ? "warn" : "ok")}>
        <span class="tile__label">${b.outstandingCents > 0 ? "Still owing" : "Nothing owing"}</span>
        <span class="tile__value">${usd(b.outstandingCents)}</span>
      </div>
    </div>
    ${b.pendingCents > 0
      ? notice("ok", "A payment is on its way",
          `${usd(b.pendingCents)} has been authorised and is still clearing. We have taken it off `
          + `what you owe so you are not asked for it twice.`)
      : ""}`;
}

function payForm({ company, lease, balance, methods, csrf, tok }) {
  const amount = balance.outstandingCents > 0 ? balance.outstandingCents : balance.rentCents;

  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Make a payment</h2>
        <p>You will finish on Stripe's secure page. We never see your bank or card details.</p>
      </div>
      <div class="panel__body">
        <form method="post" action="/pay/${tok}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="amount">Amount</label>
            <input id="amount" name="amount" type="text" inputmode="decimal"
                   value="${(amount / 100).toFixed(2)}" required />
            <span class="field__help">
              ${balance.outstandingCents > 0
                ? `This is what is outstanding for ${human(`${balance.period}-01`).replace(/^\d+\s/, "")}. You can change it.`
                : "Nothing is outstanding, but you can pay ahead if you want to."}
            </span>
          </div>

          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">
              How you want to pay
            </span>
            <div class="radioset">
              ${methods.map((m, i) => html`
                <label class="radiotile">
                  <input type="radio" name="kind" value="${m}"${attr("checked", i === 0)} />
                  <span>${METHOD_LABEL[m]}
                    <small>${describeQuote(quote({ company, method: m, amountCents: amount }))}</small>
                  </span>
                </label>`)}
            </div>
            ${methods.includes("ach") && methods.includes("card")
              ? html`<span class="field__help" style="display:block;margin-top:0.5rem">
                  A bank transfer costs less because the fee is capped. A card fee is a
                  percentage of the rent, so on a large amount it is much more.
                </span>` : ""}
          </div>

          <div class="field">
            <div class="radioset">
              <label class="radiotile">
                <input type="checkbox" name="save_method" />
                <span>Save this account for automatic payments
                  <small>Saving it does not switch anything on. You choose the limit and the
                  date afterwards, and you can remove it whenever you like.</small>
                </span>
              </label>
            </div>
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">Continue to pay</button>
          </div>
        </form>
      </div>
      <div class="panel__foot">
        Payments go directly to ${company.name}. ${lease.rent_due_day
          ? `Rent is due on ${rentDayLabel(lease.rent_due_day)} of each month.` : ""}
      </div>
    </div>`;
}

function autopayPanel({ company, lease, autopay, method, csrf, tok }) {
  const on = autopay && Number(autopay.active) === 1;

  if (on) {
    const { charge, due } = autopayDueToday(lease, autopay, today());
    return html`
      <div class="panel">
        <div class="panel__head">
          <h2>Automatic payments</h2>
          <p>On</p>
        </div>
        <div class="panel__body">
          <dl class="dl">
            <div><dt>Most we may take</dt>
              <dd>${autopay.max_amount_cents == null ? "No limit set" : usd(autopay.max_amount_cents)}</dd></div>
            <div><dt>Taken on</dt>
              <dd>${Number(autopay.days_before_due) === 0
                ? `${rentDayLabel(lease.rent_due_day)}, the day it is due`
                : `${autopay.days_before_due} day${Number(autopay.days_before_due) === 1 ? "" : "s"} before it is due`}
                — next on ${human(charge > today() ? charge : nextCharge(lease, autopay))}</dd></div>
            ${autopay.last_period
              ? html`<div><dt>Last taken for</dt><dd>${human(`${autopay.last_period}-01`).replace(/^\d+\s/, "")}</dd></div>`
              : ""}
          </dl>

          ${autopay.last_error
            ? notice("danger", "The last attempt did not work", autopay.last_error)
            : autopay.last_skip_reason
              ? notice("warn", "Nothing was taken last time", `We did not charge you because ${autopay.last_skip_reason}.`)
              : ""}
        </div>
        <div class="panel__foot">
          <form method="post" action="/pay/${tok}/autopay">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <input type="hidden" name="action" value="cancel" />
            <button class="pill outline sm" type="submit">Turn automatic payments off</button>
          </form>
        </div>
      </div>`;
  }

  if (!method) {
    return html`
      <div class="panel">
        <div class="panel__head"><h2>Automatic payments</h2><p>Off</p></div>
        <div class="panel__body">
          ${empty("Not set up",
            html`Make a payment above and tick “save this account for automatic payments”.
                 Once we have an account on file you can set a monthly limit, and we will
                 take the rent for you each month.`)}
        </div>
      </div>`;
  }

  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Automatic payments</h2>
        <p>Off — your ${method.label || METHOD_LABEL[method.kind]} ending ${method.last4 || "••••"} is saved</p>
      </div>
      <div class="panel__body">
        <form method="post" action="/pay/${tok}/autopay" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />

          <div class="field">
            <label for="max_amount">The most we may take in one month</label>
            <input id="max_amount" name="max_amount" type="text" inputmode="decimal"
                   value="${(Number(lease.rent_cents) / 100).toFixed(2)}" required />
            <span class="field__help">
              Required, and it is the point of this. If your rent goes up past this limit we
              stop and tell you rather than taking the larger amount.
            </span>
          </div>

          <div class="field">
            <label for="days_before">How many days before it is due</label>
            <select id="days_before" name="days_before">
              <option value="0">On the day</option>
              <option value="1">1 day before</option>
              <option value="3" selected>3 days before</option>
              <option value="5">5 days before</option>
              <option value="7">7 days before</option>
            </select>
            <span class="field__help">
              A bank transfer takes two to five working days to clear, so taking it a few days
              early means it lands on time.
            </span>
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">Turn automatic payments on</button>
          </div>
        </form>
      </div>
      <div class="panel__foot">
        You can turn this off at any time, on this page.
      </div>
    </div>`;
}

function historyPanel(history) {
  if (!history.length) return "";
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Your payments</h2></div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
            <tbody>
              ${history.map((p) => html`
                <tr>
                  <td>${humanStamp(p.created_at)}<div class="cellsub">${p.id.slice(-10)}</div></td>
                  <td class="num">${usd(p.charged_cents)}</td>
                  <td>${METHOD_LABEL[p.kind] || p.kind}</td>
                  <td>
                    <span class="chip"${attr("data-tone", STATUS_TONE[p.status] || "")}>
                      ${STATUS_LABEL[p.status] || p.status}
                    </span>
                    ${p.status === "returned" && p.return_code
                      ? html`<div class="cellsub">Your bank returned it (${p.return_code})</div>` : ""}
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function nextCharge(lease, autopay) {
  /* This month's charge date has passed, so the next one is next month's. */
  const now = today();
  const [y, m] = monthKey(now).split("-").map(Number);
  const nextPeriod = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const due = dueDateFor(nextPeriod, lease.rent_due_day);
  const d = new Date(`${due}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Number(autopay.days_before_due || 0));
  return d.toISOString().slice(0, 10);
}


/* --- Connect webhooks -------------------------------------------------------

   Events about tenant payments arrive on a different endpoint from the
   platform's own subscription events, because they happen on the *company's*
   connected account. Stripe puts that account id on the event, which is how a
   payment is attributed to a company without trusting anything in the body.

   The design point here is the failure mapping. Stripe's exact event names for
   an ACH return are the part of this I have not been able to verify without
   real keys — the documented shapes differ between `charge.failed`,
   `payment_intent.payment_failed` and a dispute, depending on the return code
   and when it arrives. So rather than enumerate names and hope, every failure
   is routed by *what the payment's own state says*: a payment that already
   settled and has now failed is a return, and one that never settled is a
   failure. That is correct whichever event carries the news, and it is why a
   name I have not anticipated degrades into a recorded unknown rather than
   into money silently staying on the books. */
export async function applyConnectEvent(event) {
  const kind = String(event?.type || "");
  const object = event?.data?.object || {};
  const accountId = String(event?.account || "");

  const company = accountId
    ? await get("SELECT * FROM company WHERE stripe_account_id = ?", accountId)
    : null;
  if (!company) return { outcome: `${kind}: no connected company` };

  const payment = await paymentForEvent(company.id, object);

  switch (kind) {
    /* The tenant finished on Stripe's page. For a card that means the money
       has moved; for a bank debit it means only that it has been asked for,
       and `payment_status` is what tells them apart. Settling on the wrong
       one would put unsettled money on an owner's statement. */
    case "checkout.session.completed": {
      if (!payment) return { companyId: company.id, outcome: "checkout: unknown payment" };
      await rememberSavedMethod(company, payment, object);
      if (object.payment_status === "paid") {
        await settlePayment({ paymentId: payment.id, chargeId: null });
        return { companyId: company.id, outcome: "checkout settled" };
      }
      await update("tenant_payment", payment.id, { status: "processing", submitted_at: stamp() });
      return { companyId: company.id, outcome: "checkout authorised, clearing" };
    }

    case "checkout.session.async_payment_succeeded":
    case "payment_intent.succeeded":
    case "charge.succeeded": {
      if (!payment) return { companyId: company.id, outcome: `${kind}: unknown payment` };
      const res = await settlePayment({
        paymentId: payment.id,
        chargeId: object.latest_charge || object.id || null,
      });
      return { companyId: company.id, outcome: res.alreadySettled ? "already settled" : "settled" };
    }

    /* Everything that means "this money is not there". */
    case "checkout.session.async_payment_failed":
    case "payment_intent.payment_failed":
    case "charge.failed":
    case "charge.dispute.created": {
      if (!payment) return { companyId: company.id, outcome: `${kind}: unknown payment` };
      return { companyId: company.id, outcome: await unwind(payment, object, kind) };
    }

    case "charge.refunded": {
      if (!payment) return { companyId: company.id, outcome: "refund: unknown payment" };
      await update("tenant_payment", payment.id, { status: "refunded" });
      return { companyId: company.id, outcome: "refunded" };
    }

    /* Stripe deposits a batch of settled rent into the company's bank. The
       bank will show one line for it; recording the payout is what lets that
       line be reconciled against the payments inside it. */
    case "payout.created":
    case "payout.updated":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled": {
      await recordStripePayout({ companyId: company.id, payout: object });
      return { companyId: company.id, outcome: `payout ${object.status || kind}` };
    }

    /* The company's ability to take money at all, read back from Stripe
       rather than assumed from "they clicked connect". */
    case "account.updated": {
      await run(
        `UPDATE company SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?,
                stripe_requirements = ?, stripe_checked_at = ? WHERE id = ?`,
        object.charges_enabled ? 1 : 0, object.payouts_enabled ? 1 : 0,
        JSON.stringify(object?.requirements?.currently_due || []).slice(0, 900),
        stamp(), company.id);
      return { companyId: company.id, outcome: `account charges=${object.charges_enabled ? "on" : "off"}` };
    }

    default:
      /* Recorded, not swallowed. An event nobody handled is a question for a
         person, and the row is where they find it. */
      return { companyId: company.id, outcome: `${kind}: not handled` };
  }
}

/* Settled money that has now failed is a return; money that never settled is
   a failure. Deciding from the payment's own state rather than the event's
   name is what makes this robust to the event names I could not verify. */
async function unwind(payment, object, kind) {
  const code = object?.failure_code
    || object?.last_payment_error?.decline_code
    || object?.last_payment_error?.code
    || (kind === "charge.dispute.created" ? "R10" : null);
  const reason = object?.failure_message
    || object?.last_payment_error?.message
    || (kind === "charge.dispute.created" ? "The tenant's bank disputed this payment." : kind);

  if (payment.status === "succeeded") {
    const res = await returnPayment({
      paymentId: payment.id, returnCode: normaliseReturnCode(code), reason,
    });
    return res.alreadyReturned ? "already returned" : "returned and reversed";
  }

  const res = await failPayment({ paymentId: payment.id, code, reason });
  return res.ok ? "failed" : String(res.reason);
}

/* Stripe reports ACH returns with its own strings for some codes and the bare
   NACHA code for others. The ladder downstream keys on the NACHA code. */
const RETURN_CODE_ALIASES = {
  insufficient_funds: "R01",
  account_closed: "R02",
  no_account: "R03",
  invalid_account_number: "R04",
  debit_not_authorized: "R07",
  payment_stopped: "R08",
  bank_account_restricted: "R16",
  account_frozen: "R16",
  incorrect_account_holder_name: "R03",
};

function normaliseReturnCode(code) {
  if (!code) return null;
  const c = String(code);
  if (/^R\d{2}$/i.test(c)) return c.toUpperCase();
  return RETURN_CODE_ALIASES[c] || c;
}

/* Which payment an event is about.

   The metadata we set is authoritative; the ids are the fallback for events
   that do not carry it. Both are scoped to the company, so an event naming
   another company's payment finds nothing rather than acting on it. */
async function paymentForEvent(companyId, object) {
  const metaId = object?.metadata?.payment_id;
  if (metaId) {
    const row = await get(
      "SELECT * FROM tenant_payment WHERE id = ? AND company_id = ?", metaId, companyId);
    if (row) return row;
  }

  for (const [column, value] of [
    ["stripe_checkout_session_id", object?.id],
    ["stripe_payment_intent_id", object?.payment_intent || object?.id],
    ["stripe_charge_id", object?.latest_charge || object?.id],
  ]) {
    if (!value) continue;
    const row = await get(
      `SELECT * FROM tenant_payment WHERE ${column} = ? AND company_id = ?`,
      String(value), companyId);
    if (row) return row;
  }
  return null;
}

/* A bank account the tenant asked us to keep.

   Only when they ticked the box: `setup_future_usage` is what put it there,
   and its absence is the tenant declining. The mandate text and the moment
   they accepted it are recorded because a disputed autopay is answered with
   that or not at all. */
async function rememberSavedMethod(company, payment, session) {
  const pmId = session?.setup_intent?.payment_method
    || session?.payment_intent?.payment_method
    || session?.payment_method;
  if (!pmId || typeof pmId !== "string") return null;

  const existing = await get(
    "SELECT id FROM tenant_payment_method WHERE company_id = ? AND stripe_payment_method_id = ?",
    company.id, pmId);
  if (existing) return existing.id;

  const methodId = id();
  await insert("tenant_payment_method", {
    id: methodId, company_id: company.id, lease_id: payment.lease_id,
    kind: payment.kind, stripe_payment_method_id: pmId,
    label: payment.kind === "ach" ? "Bank account" : "Card",
    last4: session?.payment_method_details?.last4 || null,
    status: "active",
    mandate_accepted_at: stamp(),
    mandate_text:
      `Authorised on ${stamp()} while paying rent, to let ${company.name} take future `
      + `rent payments from this account automatically, up to a limit the tenant sets, `
      + `until cancelled.`,
    created_at: stamp(),
  });
  return methodId;
}

/* ==========================================================================
   Staff: connecting an account, and what it costs
   --------------------------------------------------------------------------
   Everything the tenant-facing half needs in order to work at all lives here,
   and until now none of it had a screen — the connection, the fee model and
   the payment blocks could only be set with a database client, which makes
   them settings nobody can actually change.
   ========================================================================== */

function registerPaymentSettings(router) {
  router.get("/app/payments", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const origin = `${ctx.url.protocol}//${ctx.url.host}`;

    const [blocked, recent, totals, payouts, inTransit] = await Promise.all([
      all(`SELECT l.id, l.payments_blocked_reason, l.payments_blocked_at, l.payments_blocked_by,
                  u.label, p.line1
             FROM lease l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
            WHERE l.company_id = ? AND l.payments_blocked = 1
            ORDER BY l.payments_blocked_at DESC`, cid),
      all(`SELECT tp.*, u.label, p.line1 FROM tenant_payment tp
             LEFT JOIN unit u ON u.id = tp.unit_id
             LEFT JOIN property p ON p.id = u.property_id
            WHERE tp.company_id = ? ORDER BY tp.created_at DESC LIMIT 10`, cid),
      get(`SELECT
             COUNT(*) FILTER (WHERE status = 'processing')::int AS clearing,
             COALESCE(SUM(amount_cents) FILTER (WHERE status = 'processing'), 0)::bigint AS clearing_cents,
             COUNT(*) FILTER (WHERE status = 'returned')::int AS returned,
             COUNT(*) FILTER (WHERE status = 'succeeded')::int AS settled
           FROM tenant_payment WHERE company_id = ?`, cid),
      all(`SELECT p.*, (SELECT COUNT(*)::int FROM bank_match m
                         WHERE m.target_type = 'stripe_payout' AND m.target_id = p.id) AS reconciled
             FROM stripe_payout p WHERE p.company_id = ?
            ORDER BY p.arrival_date DESC NULLS LAST, p.created_at DESC LIMIT 8`, cid),
      /* What the processor is holding: settled rent that has not yet reached
         the bank. It is the balance of 1020, which is a figure a manager can
         check against their Stripe dashboard. */
      get(`SELECT COALESCE(SUM(s.debit_cents) - SUM(s.credit_cents), 0)::bigint AS c
             FROM journal_split s JOIN account a ON a.id = s.account_id
             JOIN journal j ON j.id = s.journal_id
            WHERE a.code = '1020' AND j.company_id = ?`, cid),
    ]);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "payments", counts: await navCounts(cid),
      title: "Tenant payments",
      subtitle: company.stripe_account_id
        ? "Rent paid online, into your own account"
        : "Not connected yet",
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${connectPanel({ company, csrf: ctx.csrf, connectReady: connectConfigured() })}

        ${company.stripe_account_id ? html`
          ${totalsPanel(totals)}
          ${payoutsPanel({ payouts, inTransitCents: Number(inTransit?.c || 0) })}
          ${feesPanel({ company, csrf: ctx.csrf })}
          ${linksPanel({ company, origin })}
        ` : ""}

        ${blockPanel({ blocked, csrf: ctx.csrf })}
        ${recentPanel(recent)}`,
    }));
  });

  /* --- connecting ---------------------------------------------------------- */

  /* The state parameter is ours and is checked on the way back. Without it
     anybody could hand a signed-in manager a link that attaches somebody
     else's Stripe account to their company, and every rent payment after that
     would settle into a stranger's bank. */
  router.post("/app/payments/connect", async (ctx) => {
    const cid = ctx.staff.company_id;
    if (!connectConfigured()) {
      return redirect(ctx.res, `/app/payments?e=${encodeURIComponent(
        "Stripe Connect is not configured on this deployment yet.")}`);
    }
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const state = token();
    await putSetting(cid, CONNECT_STATE_KEY, JSON.stringify({ state, at: stamp(), by: ctx.staff.id }));
    return redirect(ctx.res, authorizeUrl({ state, email: company.billing_email || ctx.staff.email }));
  });

  router.get("/app/payments/connected", async (ctx) => {
    const cid = ctx.staff.company_id;
    const fail = (m) => redirect(ctx.res, `/app/payments?e=${encodeURIComponent(m)}`);

    if (ctx.query.error) {
      return fail(String(ctx.query.error_description || ctx.query.error));
    }

    const stored = await readSetting(cid, CONNECT_STATE_KEY);
    await putSetting(cid, CONNECT_STATE_KEY, null);

    /* Expired as well as wrong. A state that has been sitting in the database
       for a week is one somebody left in a browser tab, not a flow in
       progress. */
    if (!stored || stored.state !== String(ctx.query.state || "")) {
      return fail("That connection link did not match. Start again from this page.");
    }
    if (minutesSince(stored.at) > 30) {
      return fail("That connection attempt expired. Start again from this page.");
    }

    let accountId;
    try {
      const payload = await exchangeCode(String(ctx.query.code || ""));
      accountId = payload.stripe_user_id;
    } catch (err) {
      return fail(err.message || "Stripe refused the connection.");
    }

    /* One Stripe account per company. The column is unique, so the second
       company to try gets a clear message rather than a constraint error. */
    const taken = await get(
      "SELECT id FROM company WHERE stripe_account_id = ? AND id <> ?", accountId, cid);
    if (taken) {
      return fail("That Stripe account is already connected to another company on this platform.");
    }

    await update("company", cid, { stripe_account_id: accountId, stripe_checked_at: stamp() });
    await refreshAccount(cid, accountId);

    log.info("stripe account connected", { company: cid, by: ctx.staff.id });
    return redirect(ctx.res, `/app/payments?m=${encodeURIComponent("Your Stripe account is connected.")}`);
  });

  /* What the account can actually do, read from Stripe rather than assumed
     from "they clicked connect". An account can exist and still be unable to
     take a payment — a document rejected weeks later does that. */
  router.post("/app/payments/refresh", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    if (!company.stripe_account_id) return redirect(ctx.res, "/app/payments");

    try {
      await refreshAccount(cid, company.stripe_account_id);
    } catch (err) {
      return redirect(ctx.res, `/app/payments?e=${encodeURIComponent(
        `Stripe could not be reached: ${err.message}`)}`);
    }
    return redirect(ctx.res, `/app/payments?m=${encodeURIComponent("Checked with Stripe.")}`);
  });

  router.post("/app/payments/disconnect", async (ctx) => {
    const cid = ctx.staff.company_id;

    /* Money in flight is the reason this is not a simple clear. A payment
       that is still clearing settles against the account it was created on,
       and forgetting the id would leave the webhook unable to find the
       company it belongs to. */
    const inFlight = await get(
      `SELECT COUNT(*)::int AS n FROM tenant_payment
        WHERE company_id = ? AND status IN ('pending', 'processing')`, cid);
    if (Number(inFlight.n) > 0) {
      return redirect(ctx.res, `/app/payments?e=${encodeURIComponent(
        `${inFlight.n} payment${Number(inFlight.n) === 1 ? " is" : "s are"} still clearing. `
        + `Disconnecting now would lose track of ${Number(inFlight.n) === 1 ? "it" : "them"}. `
        + `Try again once they have settled.`)}`);
    }

    await update("company", cid, {
      stripe_account_id: null, stripe_charges_enabled: 0, stripe_payouts_enabled: 0,
      stripe_requirements: null, stripe_checked_at: null,
    });
    log.warn("stripe account disconnected", { company: cid, by: ctx.staff.id });
    return redirect(ctx.res, `/app/payments?m=${encodeURIComponent(
      "Disconnected. Tenants can no longer pay online.")}`);
  });

  /* --- what it costs, and who bears it ------------------------------------- */

  router.post("/app/payments/fees", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;

    const model = (v, fallback) =>
      ["absorb", "pass", "split"].includes(String(v)) ? String(v) : fallback;
    const percent = (v) => Math.min(100, Math.max(0, Number(v) || 0));

    await update("company", cid, {
      accept_ach: f.accept_ach ? 1 : 0,
      accept_card: f.accept_card ? 1 : 0,
      ach_fee_model: model(f.ach_fee_model, "absorb"),
      card_fee_model: model(f.card_fee_model, "pass"),
      ach_fee_split_percent: percent(f.ach_fee_split_percent),
      card_fee_split_percent: percent(f.card_fee_split_percent),
      /* The rates used to quote a tenant. Stored rather than hard-coded
         because they change and are negotiable at volume, and a quoted fee
         that does not match what is charged is worse than not quoting one. */
      ach_fee_bps: Math.max(0, Number(f.ach_fee_bps) || 0),
      ach_fee_cap_cents: Math.max(0, parseMoney(f.ach_fee_cap) ?? 0),
      card_fee_bps: Math.max(0, Number(f.card_fee_bps) || 0),
      card_fee_fixed_cents: Math.max(0, parseMoney(f.card_fee_fixed) ?? 0),
    });

    return redirect(ctx.res, `/app/payments?m=${encodeURIComponent("Saved.")}`);
  });

  /* --- blocking a lease ----------------------------------------------------- */

  router.post("/app/payments/block", async (ctx) => {
    const cid = ctx.staff.company_id;
    const lease = await one(
      "SELECT * FROM lease WHERE id = ? AND company_id = ?",
      String(ctx.fields.lease_id || ""), cid);

    if (String(ctx.fields.action) === "unblock") {
      await run(
        `UPDATE lease SET payments_blocked = 0, payments_blocked_reason = NULL,
                payments_blocked_at = NULL, payments_blocked_by = NULL WHERE id = ?`, lease.id);
      return redirect(ctx.res, `/app/payments?m=${encodeURIComponent("Online payment is back on for that home.")}`);
    }

    /* A reason is required and is shown to the tenant verbatim. "Payment
       unavailable" with no explanation generates the phone call this product
       exists to remove. */
    const reason = String(ctx.fields.reason || "").trim();
    if (reason.length < 10) {
      return redirect(ctx.res, `/app/payments?e=${encodeURIComponent(
        "Give a reason the tenant can act on — they see it on their payment page.")}`);
    }

    await run(
      `UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ?,
              payments_blocked_at = ?, payments_blocked_by = ? WHERE id = ?`,
      reason.slice(0, 300), stamp(), ctx.staff.id, lease.id);
    await run("UPDATE autopay SET active = 0, last_error = ? WHERE lease_id = ?",
      "online payment was switched off for this home", lease.id);

    return redirect(ctx.res, `/app/payments?m=${encodeURIComponent(
      "That home is now cash-only, and any automatic payment has been stopped.")}`);
  });
}

/* --- reading the account back from Stripe ---------------------------------- */

async function refreshAccount(companyId, accountId) {
  const status = await accountStatus(accountId);
  await update("company", companyId, {
    stripe_charges_enabled: status.chargesEnabled ? 1 : 0,
    stripe_payouts_enabled: status.payoutsEnabled ? 1 : 0,
    stripe_requirements: JSON.stringify(status.requirements).slice(0, 900),
    stripe_checked_at: stamp(),
  });
  return status;
}

const CONNECT_STATE_KEY = "stripe_connect_state";

async function putSetting(companyId, key, value) {
  if (value === null) {
    await run("DELETE FROM setting WHERE company_id = ? AND key = ?", companyId, key);
    return;
  }
  await run(
    `INSERT INTO setting (company_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    companyId, key, value);
}

async function readSetting(companyId, key) {
  const row = await get("SELECT value FROM setting WHERE company_id = ? AND key = ?", companyId, key);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

/* --- staff views ----------------------------------------------------------- */

function connectPanel({ company, csrf, connectReady }) {
  if (!company.stripe_account_id) {
    return html`
      <div class="panel">
        <div class="panel__head">
          <h2>Connect your Stripe account</h2>
          <p>Rent goes from your tenant to your bank. It never passes through us.</p>
        </div>
        <div class="panel__body">
          ${empty("Not connected",
            html`Tenants cannot pay online until this is done. You will complete Stripe's own
                 onboarding and hold the account yourself, which is what keeps your money out
                 of our hands and your chargebacks in yours.`)}
          ${connectReady ? "" : notice("warn", "Not available on this deployment",
            "Stripe Connect needs STRIPE_SECRET_KEY and STRIPE_CONNECT_CLIENT_ID to be set.")}
        </div>
        <div class="panel__foot">
          <form method="post" action="/app/payments/connect">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <button class="pill solid"${attr("disabled", !connectReady)} type="submit">
              Connect with Stripe
            </button>
          </form>
        </div>
      </div>`;
  }

  const requirements = parseList(company.stripe_requirements);
  const charges = Number(company.stripe_charges_enabled) === 1;
  const payouts = Number(company.stripe_payouts_enabled) === 1;

  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Your Stripe account</h2>
        <p>${company.stripe_account_id}</p>
      </div>
      <div class="panel__body">
        ${charges ? notice("ok", "Ready to take payments",
            payouts ? "Charges and payouts are both enabled."
              : "Charges are enabled. Payouts to your bank are not yet — Stripe still needs something from you.")
          : requirements.length
            ? notice("warn", "Stripe needs something from you",
                html`Tenants cannot pay until this is resolved.
                     <span style="display:block;margin-top:0.5rem">${requirements.join(", ")}</span>`)
            : notice("warn", "Stripe is still reviewing your account",
                "Nothing is outstanding and nothing you do will speed it up. This is the "
                + "common case a day or two after connecting.")}

        <dl class="dl" style="margin-top:1rem">
          <div><dt>Take payments</dt><dd>${charges ? "Yes" : "Not yet"}</dd></div>
          <div><dt>Pay out to your bank</dt><dd>${payouts ? "Yes" : "Not yet"}</dd></div>
          <div><dt>Last checked</dt>
            <dd>${company.stripe_checked_at ? humanStamp(company.stripe_checked_at) : "never"}</dd></div>
        </dl>
      </div>
      <div class="panel__foot">
        <div class="btnrow">
          <form method="post" action="/app/payments/refresh">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <button class="pill outline sm" type="submit">Check with Stripe again</button>
          </form>
          <a class="pill outline sm" href="https://dashboard.stripe.com/" target="_blank" rel="noopener">
            Open your Stripe dashboard
          </a>
          <form method="post" action="/app/payments/disconnect">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <button class="pill outline sm" type="submit">Disconnect</button>
          </form>
        </div>
      </div>
    </div>`;
}

function totalsPanel(t) {
  return html`
    <div class="grid grid--3">
      <div class="tile"><span class="tile__label">Settled</span><span class="tile__value">${Number(t.settled)}</span></div>
      <div class="tile"${attr("data-tone", Number(t.clearing) ? "warn" : null)}>
        <span class="tile__label">Clearing</span>
        <span class="tile__value">${usd(t.clearing_cents)}</span>
      </div>
      <div class="tile"${attr("data-tone", Number(t.returned) ? "danger" : null)}>
        <span class="tile__label">Returned</span><span class="tile__value">${Number(t.returned)}</span>
      </div>
    </div>`;
}

/* What Stripe is holding, and what it has already sent.

   The bank shows one line for a dozen rents, so the question a manager
   actually has — "is that deposit the one from Tuesday, and what was in
   it?" — is answered here and reconciled under Banking. */
function payoutsPanel({ payouts, inTransitCents }) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Deposits from Stripe</h2>
        <p>Rent reaches your bank in batches, a few days behind the tenant</p>
      </div>
      <div class="panel__body">
        ${inTransitCents > 0
          ? notice("ok", `${usd(inTransitCents)} is on its way to you`,
              "Settled rent that Stripe has not deposited yet. This figure should match "
              + "the balance on your Stripe dashboard.")
          : notice("ok", "Nothing in transit", "Everything settled has reached your bank.")}
      </div>
      <div class="panel__body panel__body--flush">
        ${payouts.length === 0
          ? html`<div class="panel__body">${empty("No deposits yet",
              "They appear here once Stripe sends the first one.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Arriving</th><th class="num">Amount</th><th>In it</th>
                  <th>State</th><th>Bank line</th></tr></thead>
                <tbody>
                  ${payouts.map((p) => html`
                    <tr>
                      <td>${p.arrival_date ? human(p.arrival_date) : "—"}
                        <div class="cellsub">${p.destination || p.stripe_payout_id}</div></td>
                      <td class="num">${usd(p.amount_cents)}</td>
                      <td>${p.payment_count == null
                        ? html`<span class="cellsub">not itemised</span>`
                        : `${p.payment_count} payment${Number(p.payment_count) === 1 ? "" : "s"}`}</td>
                      <td><span class="chip"${attr("data-tone",
                        p.status === "paid" ? "ok" : p.status === "failed" ? "danger" : "warn")}>${p.status}</span>
                        ${p.failure_message ? html`<div class="cellsub">${p.failure_message}</div>` : ""}</td>
                      <td>${Number(p.reconciled)
                        ? html`<span class="chip" data-tone="ok">matched</span>`
                        : p.status === "paid"
                          ? html`<a class="pill outline sm" href="/app/banking">Reconcile</a>`
                          : "—"}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function feesPanel({ company, csrf }) {
  const q = (method, amount) => describeQuote(quote({ company, method, amountCents: amount }));

  return html`
    <form method="post" action="/app/payments/fees">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <div class="panel">
        <div class="panel__head">
          <h2>What tenants can use, and who pays the fee</h2>
          <p>Shown to the tenant in full before they authorise anything.</p>
        </div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            ${methodFields({ company, method: "ach", label: "Bank transfer (ACH)",
              help: "The fee is capped, which is why rent belongs here." })}
            ${methodFields({ company, method: "card", label: "Debit or credit card",
              help: "The fee is a percentage with no cap, so it scales with the rent." })}
          </div>

          ${notice("warn", "Passing a card fee on is regulated",
            "Card-network rules restrict surcharging, and several US states restrict it "
            + "further, with different limits for credit and debit. This setting does what "
            + "you tell it. Check it against the states you operate in.")}

          <div style="margin-top:1rem">
            <span class="tile__label">On a $1,450 rent, today's settings mean</span>
            <ul style="margin:0.5rem 0 0;padding-left:1.1rem">
              ${company.accept_ach ? html`<li>Bank transfer — ${q("ach", 145000)}</li>` : ""}
              ${company.accept_card ? html`<li>Card — ${q("card", 145000)}</li>` : ""}
              ${!company.accept_ach && !company.accept_card
                ? html`<li>Nothing. No method is switched on, so no tenant can pay online.</li>` : ""}
            </ul>
          </div>
        </div>
        <div class="panel__foot">
          <button class="pill solid sm" type="submit">Save</button>
        </div>
      </div>
    </form>`;
}

function methodFields({ company, method, label, help }) {
  const on = Number(company[`accept_${method}`]) === 1;
  const model = company[`${method}_fee_model`];
  return html`
    <div class="field">
      <div class="radioset">
        <label class="radiotile">
          <input type="checkbox" name="accept_${method}"${attr("checked", on)} />
          <span>Offer ${label}<small>${help}</small></span>
        </label>
      </div>

      <label for="${method}_fee_model" style="margin-top:0.75rem">Who pays the processing fee</label>
      <select id="${method}_fee_model" name="${method}_fee_model">
        <option value="absorb"${attr("selected", model === "absorb")}>We do — the tenant is charged the rent exactly</option>
        <option value="pass"${attr("selected", model === "pass")}>The tenant does — added to what they are charged</option>
        <option value="split"${attr("selected", model === "split")}>Split it</option>
      </select>

      <label for="${method}_fee_split_percent" style="margin-top:0.5rem">Tenant's share when split (%)</label>
      <input id="${method}_fee_split_percent" name="${method}_fee_split_percent" type="number"
             min="0" max="100" step="1" value="${Number(company[`${method}_fee_split_percent`] ?? 50)}" />

      <label for="${method}_fee_bps" style="margin-top:0.5rem">Your Stripe rate (basis points)</label>
      <input id="${method}_fee_bps" name="${method}_fee_bps" type="number" min="0" step="1"
             value="${Number(company[`${method}_fee_bps`] ?? 0)}" />
      <span class="field__help">
        ${method === "ach" ? "80 is Stripe's published 0.80%." : "290 is Stripe's published 2.90%."}
        Change it if you have negotiated a different rate — a quote that does not match what
        is charged is worse than no quote.
      </span>

      ${method === "ach"
        ? html`
          <label for="ach_fee_cap" style="margin-top:0.5rem">Fee cap</label>
          <input id="ach_fee_cap" name="ach_fee_cap" type="text" inputmode="decimal"
                 value="${(Number(company.ach_fee_cap_cents ?? 0) / 100).toFixed(2)}" />
          <span class="field__help">Stripe's published cap is $5.00. Zero means no cap.</span>`
        : html`
          <label for="card_fee_fixed" style="margin-top:0.5rem">Fixed amount per card payment</label>
          <input id="card_fee_fixed" name="card_fee_fixed" type="text" inputmode="decimal"
                 value="${(Number(company.card_fee_fixed_cents ?? 0) / 100).toFixed(2)}" />
          <span class="field__help">Stripe's published fixed amount is $0.30.</span>`}
    </div>`;
}

function linksPanel({ company, origin }) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>How a tenant gets to their page</h2>
        <p>Each lease has its own link. There is no account and no password.</p>
      </div>
      <div class="panel__body">
        ${empty("On the unit",
          html`Open a unit under Properties and its payment link is on the tenancy panel. Send
               it once and the tenant can bookmark it — it does not expire, and it only ever
               shows that one home.`)}
        <span class="field__help" style="display:block;margin-top:0.75rem">
          Links look like <code>${origin}/pay/&hellip;</code>
        </span>
      </div>
    </div>`;
}

function blockPanel({ blocked, csrf }) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Homes on cash only</h2>
        <p>During an eviction, accepting rent can waive the proceeding.</p>
      </div>
      <div class="panel__body">
        ${blocked.length === 0
          ? empty("None", "Every active tenancy can pay online.")
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Home</th><th>What the tenant is told</th><th>Since</th><th></th></tr></thead>
                <tbody>
                  ${blocked.map((l) => html`
                    <tr>
                      <td>${l.line1}${l.label ? html`<div class="cellsub">Unit ${l.label}</div>` : ""}</td>
                      <td>${l.payments_blocked_reason || "—"}</td>
                      <td>${l.payments_blocked_at ? humanStamp(l.payments_blocked_at) : "—"}</td>
                      <td class="shrink">
                        <form method="post" action="/app/payments/block">
                          <input type="hidden" name="_csrf" value="${csrf}" />
                          <input type="hidden" name="lease_id" value="${l.id}" />
                          <input type="hidden" name="action" value="unblock" />
                          <button class="pill outline sm" type="submit">Allow again</button>
                        </form>
                      </td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function recentPanel(recent) {
  if (!recent.length) return "";
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Recent payments</h2></div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <thead><tr><th>When</th><th>Home</th><th>Amount</th><th>Fee</th><th>Status</th></tr></thead>
            <tbody>
              ${recent.map((p) => html`
                <tr>
                  <td>${humanStamp(p.created_at)}</td>
                  <td>${p.line1 || "—"}${p.label ? html`<div class="cellsub">Unit ${p.label}</div>` : ""}</td>
                  <td class="num">${usd(p.amount_cents)}</td>
                  <td class="num">${usd(p.fee_cents)}
                    ${Number(p.tenant_fee_cents) > 0
                      ? html`<div class="cellsub">${usd(p.tenant_fee_cents)} from the tenant</div>` : ""}</td>
                  <td>
                    <span class="chip"${attr("data-tone", STATUS_TONE[p.status] || "")}>
                      ${STATUS_LABEL[p.status] || p.status}
                    </span>
                    ${p.return_code ? html`<div class="cellsub">${p.return_code}</div>` : ""}
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function parseList(json) {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
