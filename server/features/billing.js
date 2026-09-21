/* F17  Subscription billing.

   The platform's own revenue, kept away from the accounting tables on purpose:
   the double-entry journal is the customer's book, and our invoice has no
   business in it.

   The consequential decision here is what happens when somebody stops paying.
   A lapsed subscription makes a company **read-only**. Nothing is deleted,
   nothing is hidden, every screen still loads and every report still runs —
   what stops is writing. Deleting a customer's portfolio because a card
   expired would be indefensible, and "export your data before we delete it" is
   a threat dressed as a feature.

   Read-only is enforced in the same gate as capabilities, for the same reason:
   a rule that every handler has to remember is a rule that one of them will
   not. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp } from "../lib/dates.js";
import { usd } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { log } from "../lib/logger.js";
import {
  PLANS, TRIAL_DAYS, planByKey, planForUnits, outgrown, isWorking, describeStatus,
} from "../lib/plans.js";
import { STRIPE_PRICES, STRIPE_SECRET_KEY, APP_BASE_URL } from "../lib/config.js";
import * as stripe from "../lib/stripe.js";

/* Paths a read-only company may still write to. Paying is the whole point, so
   the billing routes cannot themselves be blocked by not having paid — and
   signing out should never be refused to anybody. */
const READONLY_EXEMPT = [
  "/app/billing",
  "/app/sign-out",
  "/app/account",
  "/app/verify/resend",
];

export function readOnlyExempt(path) {
  return READONLY_EXEMPT.some((p) => path === p || path.startsWith(p + "/"));
}

export async function subscriptionFor(companyId) {
  let row = await get("SELECT * FROM subscription WHERE company_id = ?", companyId);
  if (!row) {
    /* A company created before billing existed, or by a path that did not
       start one. A trial rather than a lockout: the alternative reads as an
       outage to somebody who was working fine a moment ago. */
    const rowId = id();
    await insert("subscription", {
      id: rowId, company_id: companyId, status: "trialing",
      trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(),
      created_at: stamp(), updated_at: stamp(),
    });
    row = await get("SELECT * FROM subscription WHERE id = ?", rowId);
  }
  return row;
}

export async function companyIsReadOnly(companyId) {
  const sub = await subscriptionFor(companyId);
  return !isWorking(sub);
}

async function unitCount(companyId) {
  const row = await get("SELECT COUNT(*)::int AS n FROM unit WHERE company_id = ?", companyId);
  return Number(row?.n || 0);
}

export function registerBilling(router) {
  router.get("/app/billing", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const sub = await subscriptionFor(cid);
    const units = await unitCount(cid);
    const status = describeStatus(sub);
    const suggested = planForUnits(units);
    const over = sub.plan_key ? outgrown(sub.plan_key, units) : null;
    const configured = Boolean(STRIPE_SECRET_KEY);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "billing", counts: await navCounts(cid),
      title: "Billing", subtitle: `${units} unit${units === 1 ? "" : "s"} under management`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${notice(status.tone, status.title, status.detail)}

        ${over ? notice("warn", `You have outgrown ${over.plan.name}`,
          html`${over.units} units is past the ${over.plan.maxUnits} this plan covers.
               Nothing stops working — move to ${over.suggested.name} when it suits you.`) : ""}

        ${configured ? "" : notice("warn", "Billing is not connected yet",
          "No Stripe keys are configured, so plans cannot be started from here. Everything else on this page is real.")}

        <div class="panel">
          <div class="panel__head"><h2>What you pay</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0 0 1rem">
              A flat monthly price for the band your portfolio falls into. No fee per
              payment, no percentage of rent collected, nothing that grows with how much
              money moves through the system. Collect more rent this month and you owe us
              exactly the same.
            </p>

            <div class="tablewrap tablewrap--narrow"><table class="data">
              <thead><tr><th>Plan</th><th>Units</th><th class="num">Monthly</th><th class="shrink"></th></tr></thead>
              <tbody>${PLANS.map((plan) => {
                const current = sub.plan_key === plan.key;
                const fits = plan.maxUnits === null || units <= plan.maxUnits;
                return html`
                <tr>
                  <td><b>${plan.name}</b>${current ? html` <span class="chip" data-tone="ok">current</span>` : ""}
                    <span class="cellsub">${plan.blurb}</span></td>
                  <td>${plan.maxUnits === null ? "No limit" : `Up to ${plan.maxUnits}`}
                    ${suggested.key === plan.key ? html`<span class="cellsub">your size</span>` : ""}</td>
                  <td class="num">${usd(plan.monthlyCents)}</td>
                  <td class="shrink">
                    ${current ? "" : html`
                      <form method="post" action="/app/billing/choose">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <input type="hidden" name="plan" value="${plan.key}" />
                        <button class="pill ${fits ? "solid" : "outline"} sm" type="submit"
                                ${attr("disabled", !configured)}>Choose</button>
                      </form>`}
                  </td>
                </tr>`;
              })}</tbody>
            </table></div>
          </div>
          <div class="panel__foot">
            Prices are per company, not per user. Add as many staff as you need.
          </div>
        </div>

        ${sub.stripe_customer_id ? html`
          <div class="panel">
            <div class="panel__head"><h2>Invoices and payment method</h2></div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 0.875rem">
                Card details, invoices and cancellation are handled on Stripe's own pages.
                We never see or store a card number.
              </p>
              ${sub.current_period_end ? html`
                <p class="lede" style="margin:0 0 0.875rem">
                  ${sub.cancel_at_period_end
                    ? html`Your subscription ends ${human(sub.current_period_end.slice(0, 10))}.`
                    : html`Next invoice ${human(sub.current_period_end.slice(0, 10))}.`}
                </p>` : ""}
              <form method="post" action="/app/billing/portal">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill outline" type="submit">Manage billing</button>
              </form>
            </div>
          </div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>If you stop paying</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0">
              Your account becomes read-only. Every screen still loads, every report still
              runs, and you can export everything. What stops is changing things. Nothing
              is ever deleted, and there is no window after which your data disappears —
              it is yours, and holding it hostage is not a business model we are willing
              to have.
            </p>
          </div>
        </div>`,
    }));
  });

  router.post("/app/billing/choose", async (ctx) => {
    const cid = ctx.staff.company_id;
    const plan = planByKey(String(ctx.fields.plan || ""));
    if (!plan) throw new BadRequest("That is not a plan.");

    const priceId = STRIPE_PRICES[plan.key];
    if (!STRIPE_SECRET_KEY || !priceId) {
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
        `Billing is not connected yet — ${priceId ? "no Stripe key" : `no price configured for ${plan.name}`}.`)}`);
    }

    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const sub = await subscriptionFor(cid);
    const base = APP_BASE_URL || `${ctx.url.protocol}//${ctx.url.host}`;

    try {
      let customerId = sub.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.createCustomer({
          companyId: cid, name: company.legal_name || company.name, email: ctx.staff.email,
        });
        customerId = customer.id;
        await update("subscription", sub.id, { stripe_customer_id: customerId, updated_at: stamp() });
      }

      const session = await stripe.createCheckoutSession({
        customerId, priceId, companyId: cid, planKey: plan.key,
        successUrl: `${base}/app/billing?m=${encodeURIComponent("Thank you. Your subscription is starting.")}`,
        cancelUrl: `${base}/app/billing`,
        /* Carry the remaining trial across, so choosing a plan early does not
           cost somebody the days they had left. */
        trialEndsAt: sub.status === "trialing" ? sub.trial_ends_at : null,
      });

      return redirect(ctx.res, session.url);
    } catch (err) {
      log.error("checkout session failed", { err, companyId: cid, plan: plan.key });
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
        "We could not start the subscription. Nothing was charged.")}`);
    }
  });

  router.post("/app/billing/portal", async (ctx) => {
    const cid = ctx.staff.company_id;
    const sub = await subscriptionFor(cid);
    if (!sub.stripe_customer_id) {
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent("There is no subscription to manage yet.")}`);
    }
    const base = APP_BASE_URL || `${ctx.url.protocol}//${ctx.url.host}`;
    try {
      const session = await stripe.createPortalSession({
        customerId: sub.stripe_customer_id, returnUrl: `${base}/app/billing`,
      });
      redirect(ctx.res, session.url);
    } catch (err) {
      log.error("portal session failed", { err, companyId: cid });
      redirect(ctx.res, `/app/billing?m=${encodeURIComponent("We could not open the billing portal.")}`);
    }
  });
}

/* --- what the webhook does ------------------------------------------------

   Exported for api/webhooks/stripe.js, which is transport only.

   Subscription state is a copy of Stripe's, never computed locally from dates.
   A local guess about whether somebody has paid eventually disagrees with the
   processor, and when it does it locks out a paying customer. */
export async function applyStripeEvent(event) {
  const kind = String(event?.type || "");
  const object = event?.data?.object || {};

  const companyId =
    object?.metadata?.company_id ||
    object?.subscription_details?.metadata?.company_id ||
    object?.client_reference_id ||
    (await companyForCustomer(object?.customer));

  if (!companyId) return { outcome: `${kind}: no company` };

  const sub = await subscriptionFor(companyId);

  switch (kind) {
    case "checkout.session.completed": {
      await update("subscription", sub.id, {
        stripe_customer_id: object.customer || sub.stripe_customer_id,
        stripe_subscription_id: object.subscription || sub.stripe_subscription_id,
        plan_key: object?.metadata?.plan_key || sub.plan_key,
        updated_at: stamp(),
      });
      return { companyId, outcome: "checkout completed" };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await update("subscription", sub.id, {
        stripe_subscription_id: object.id || sub.stripe_subscription_id,
        stripe_customer_id: object.customer || sub.stripe_customer_id,
        plan_key: object?.metadata?.plan_key || sub.plan_key,
        status: normaliseStatus(kind === "customer.subscription.deleted" ? "canceled" : object.status),
        current_period_end: secondsToIso(object.current_period_end),
        trial_ends_at: secondsToIso(object.trial_end) || sub.trial_ends_at,
        cancel_at_period_end: object.cancel_at_period_end ? 1 : 0,
        updated_at: stamp(),
      });
      return { companyId, outcome: `subscription ${object.status || "deleted"}` };
    }

    case "invoice.payment_failed": {
      /* Not a lockout. A failed card is usually an expired card, and Stripe
         will retry for days — locking a property manager out of their
         emergency queue over the first retry would be a worse failure than
         carrying them. */
      await update("subscription", sub.id, { status: "past_due", updated_at: stamp() });
      return { companyId, outcome: "payment failed" };
    }

    case "invoice.paid": {
      await update("subscription", sub.id, {
        status: "active",
        current_period_end: secondsToIso(object?.lines?.data?.[0]?.period?.end) || sub.current_period_end,
        updated_at: stamp(),
      });
      return { companyId, outcome: "invoice paid" };
    }

    default:
      return { companyId, outcome: `${kind}: ignored` };
  }
}

async function companyForCustomer(customerId) {
  if (!customerId) return null;
  const row = await get("SELECT company_id FROM subscription WHERE stripe_customer_id = ?", customerId);
  return row?.company_id || null;
}

/* Stripe's vocabulary, with anything unrecognised treated as working rather
   than as a lockout. A status we have not seen before is far more likely to be
   a new Stripe state than a customer who stopped paying. */
function normaliseStatus(status) {
  const known = ["trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "paused"];
  return known.includes(status) ? status : "active";
}

function secondsToIso(seconds) {
  if (!seconds) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}
