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
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { log } from "../lib/logger.js";
import {
  TRIAL_DAYS, PLAN_KEY, PER_DOOR_CENTS, billableDoors, monthlyCents, isWorking, describeStatus,
} from "../lib/plans.js";
import { DODO_PAYMENTS_API_KEY, DODO_PRODUCTS, APP_BASE_URL } from "../lib/config.js";
import * as dodo from "../lib/dodo.js";

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
    const doors = billableDoors(units);
    const status = describeStatus(sub);
    const configured = Boolean(DODO_PAYMENTS_API_KEY);
    const productReady = Boolean(DODO_PRODUCTS.door);
    const bill = monthlyCents(doors);
    const subscribed = Boolean(sub.dodo_subscription_id);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "billing", counts: await navCounts(cid),
      title: "Your plan", subtitle: `${doors} door${doors === 1 ? "" : "s"} under management. This is what you pay for the software.`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${notice(status.tone, status.title, status.detail)}

        ${configured ? "" : notice("warn", "Billing is not connected yet",
          "A subscription cannot be started from here yet. The price below is what this installation would charge once billing is turned on.")}

        <div class="panel">
          <div class="panel__head"><h2>What you pay</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0 0 1rem">
              ${usd(PER_DOOR_CENTS)} a month for each door.
              ${doors
                ? html`You have ${doors}, so the bill is ${usd(bill)} a month.`
                : html`Add a door and the bill is ${usd(PER_DOOR_CENTS)} for that one.`}
              Adding a door changes the next bill. Collecting more rent does not.
              There is no fee on a tenant payment.
            </p>
            ${productReady ? html`
              <form method="post" action="/app/billing/choose">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <button class="pill solid" type="submit" ${attr("disabled", !configured || doors < 1)}>
                  ${subscribed ? `Set the next bill to ${doors} door${doors === 1 ? "" : "s"}` : "Subscribe"}
                </button>
              </form>` : html`<p class="lede" style="margin:0">The subscription product is not set up yet.</p>`}
          </div>
          <div class="panel__foot">
            The price is per door, not per person. Add as many staff as you need.
          </div>
        </div>

        ${sub.dodo_customer_id ? html`
          <div class="panel">
            <div class="panel__head"><h2>Invoices and payment method</h2></div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 0.875rem">
                Card details, invoices and cancellation are handled on Dodo Payments' own pages.
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
    const doors = billableDoors(await unitCount(cid));
    if (doors < 1) {
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
        "Add a door before subscribing. The price is per door.")}`);
    }

    const productId = DODO_PRODUCTS.door;
    if (!DODO_PAYMENTS_API_KEY || !productId) {
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
        DODO_PAYMENTS_API_KEY
          ? "The subscription is not set up for checkout yet."
          : "Billing is not connected yet.")}`);
    }

    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const sub = await subscriptionFor(cid);
    const base = APP_BASE_URL || `${ctx.url.protocol}//${ctx.url.host}`;

    try {
      if (sub.dodo_subscription_id && ["active", "past_due", "trialing"].includes(sub.status)) {
        await dodo.changeQuantity({
          subscriptionId: sub.dodo_subscription_id, productId, quantity: doors,
        });
        return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
          `The next bill is ${doors} door${doors === 1 ? "" : "s"}.`)}`);
      }
      const session = await dodo.createCheckout({
        productId,
        quantity: doors,
        email: ctx.staff.email,
        name: company.legal_name || company.name,
        companyId: cid,
        planKey: PLAN_KEY,
        returnUrl: `${base}/app/billing?m=${encodeURIComponent("Thank you. Your subscription is starting.")}`,
        trialDays: remainingTrialDays(sub),
      });
      return redirect(ctx.res, session.url);
    } catch (err) {
      log.error("checkout session failed", { err, companyId: cid, doors });
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent(
        "We could not start the subscription. Nothing was charged.")}`);
    }
  });

  router.post("/app/billing/portal", async (ctx) => {
    const cid = ctx.staff.company_id;
    const sub = await subscriptionFor(cid);
    if (!sub.dodo_customer_id) {
      return redirect(ctx.res, `/app/billing?m=${encodeURIComponent("There is no subscription to manage yet.")}`);
    }
    const base = APP_BASE_URL || `${ctx.url.protocol}//${ctx.url.host}`;
    try {
      const session = await dodo.createPortalSession({
        customerId: sub.dodo_customer_id, returnUrl: `${base}/app/billing`,
      });
      redirect(ctx.res, session.url);
    } catch (err) {
      log.error("portal session failed", { err, companyId: cid });
      redirect(ctx.res, `/app/billing?m=${encodeURIComponent("We could not open the billing portal.")}`);
    }
  });
}

function remainingTrialDays(sub) {
  if (sub.status !== "trialing" || !sub.trial_ends_at) return 0;
  const ms = new Date(sub.trial_ends_at).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.min(365, Math.ceil(ms / 86400000));
}

/* --- what a Dodo webhook does ---------------------------------------------

   Exported for api/webhooks/dodo.js, which is transport only.

   Subscription state is a copy of Dodo's, never computed locally from dates. */
export async function applyDodoEvent(event) {
  const kind = String(event?.type || "");
  const data = event?.data || {};
  const customerId = data?.customer?.customer_id || data?.customer_id || null;
  const subscriptionId = data?.subscription_id || null;

  const companyId =
    data?.metadata?.company_id ||
    (await companyForDodoCustomer(customerId)) ||
    (await companyForDodoSubscription(subscriptionId));

  if (!companyId) return { outcome: `${kind}: no company` };

  const sub = await subscriptionFor(companyId);
  const status = statusFromDodo(kind, data.status);
  if (!status) return { companyId, outcome: `${kind}: ignored` };

  const planKey = data?.metadata?.plan_key || planKeyForProduct(data?.product_id) || sub.plan_key;
  await update("subscription", sub.id, {
    dodo_customer_id: customerId || sub.dodo_customer_id,
    dodo_subscription_id: subscriptionId || sub.dodo_subscription_id,
    plan_key: planKey,
    status,
    current_period_end: data.next_billing_date || sub.current_period_end,
    cancel_at_period_end: data.cancel_at_next_billing_date == null
      ? sub.cancel_at_period_end
      : (data.cancel_at_next_billing_date ? 1 : 0),
    updated_at: stamp(),
  });
  return { companyId, outcome: `${kind} ${status}` };
}

function statusFromDodo(kind, status) {
  if (kind === "subscription.on_hold" || kind === "payment.failed") return "past_due";
  if (kind === "subscription.cancelled" || kind === "subscription.canceled" || kind === "subscription.expired") {
    return "canceled";
  }
  if (kind === "subscription.failed") return "incomplete";
  if (kind === "subscription.active" || kind === "subscription.renewed" || kind === "payment.succeeded") {
    return "active";
  }
  if (kind !== "subscription.updated") return null;
  const known = {
    active: "active", on_hold: "past_due", cancelled: "canceled", canceled: "canceled",
    expired: "canceled", failed: "incomplete", pending: "incomplete",
  };
  /* An unrecognised status is more likely a new Dodo state than a customer
     who stopped paying, so it stays working. */
  return known[status] || "active";
}

function planKeyForProduct(productId) {
  if (!productId) return null;
  return Object.entries(DODO_PRODUCTS).find(([, id]) => id && id === productId)?.[0] || null;
}

async function companyForDodoCustomer(customerId) {
  if (!customerId) return null;
  const row = await get("SELECT company_id FROM subscription WHERE dodo_customer_id = ?", customerId);
  return row?.company_id || null;
}

async function companyForDodoSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const row = await get("SELECT company_id FROM subscription WHERE dodo_subscription_id = ?", subscriptionId);
  return row?.company_id || null;
}

/* --- what the Stripe webhook does -----------------------------------------

   Still applied if a subscription that was started on Stripe sends an event.
   New plans are started on Dodo. Exported for api/webhooks/stripe.js.

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
