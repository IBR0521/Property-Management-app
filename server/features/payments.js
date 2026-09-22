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
import { human, humanStamp, monthKey, today, dueDateFor, stamp } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr, raw } from "../lib/render.js";
import { publicPage, notice, empty } from "../views/layout.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { APP_BASE_URL } from "../lib/config.js";
import { quote, describeQuote, availableMethods } from "../lib/fees.js";
import { id } from "../lib/ids.js";
import {
  balanceFor, blockedReason, startCheckout, enrolAutopay, cancelAutopay,
  autopayDueToday, settlePayment, failPayment, returnPayment,
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
        ${ctx.query.e ? notice("warn", null, decodeURIComponent(ctx.query.e)) : ""}
        ${ctx.query.m ? notice("ok", null, decodeURIComponent(ctx.query.m)) : ""}

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
          ? `Rent is due on the ${ordinal(lease.rent_due_day)} of each month.` : ""}
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
                ? `the ${ordinal(lease.rent_due_day)}, the day it is due`
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

function ordinal(n) {
  const v = Number(n) || 1;
  const s = ["th", "st", "nd", "rd"][((v % 100) - 20) % 10] || ["th", "st", "nd", "rd"][v % 100] || "th";
  return `${v}${s}`;
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
