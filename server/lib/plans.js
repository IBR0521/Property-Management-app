/* What the platform charges, and how the customer can check it.

   The transparent-pricing rule in this product's brief is not decoration. Most
   property software prices by "contact us", or meters something the customer
   cannot count, or takes a slice of each rent payment that never appears on a
   statement. The counter-position only works if the number is knowable in
   advance from something the customer already knows — and every property
   manager knows exactly how many doors they have.

   So: a flat monthly price per band of units. No per-transaction fee, no
   percentage of rent, nothing that grows with how much money moves through the
   system. A company that collects more rent this month owes us the same as
   last month.

   The prices here are the source of truth for what is *displayed*. What is
   charged is the matching product in Dodo Payments. A missing product is a
   configuration error the billing page names, rather than something to hide. */

export const PLANS = [
  {
    key: "starter",
    name: "Starter",
    maxUnits: 25,
    monthlyCents: 4900,
    blurb: "For a small portfolio, or a manager just getting off spreadsheets.",
  },
  {
    key: "growth",
    name: "Growth",
    maxUnits: 100,
    monthlyCents: 14900,
    blurb: "The usual size for a firm with a full-time maintenance coordinator.",
  },
  {
    key: "professional",
    name: "Professional",
    maxUnits: 500,
    monthlyCents: 39900,
    blurb: "Several portfolios, several staff, owner reporting that has to be right.",
  },
  {
    key: "scale",
    name: "Scale",
    maxUnits: null,                    // no ceiling
    monthlyCents: 79900,
    blurb: "Over five hundred doors. Everything, no per-unit escalation.",
  },
];

export const TRIAL_DAYS = 30;

export function planByKey(key) {
  return PLANS.find((p) => p.key === key) || null;
}

/* The band a portfolio of this size falls into. Chosen by unit count rather
   than by sales conversation, so a customer can work out their own bill. */
export function planForUnits(units) {
  const n = Number(units) || 0;
  return PLANS.find((p) => p.maxUnits === null || n <= p.maxUnits) || PLANS[PLANS.length - 1];
}

/* Whether a company on this plan has outgrown it. Reported rather than
   enforced: a portfolio that grows past its band keeps working, and the
   billing page says so. Cutting somebody off mid-month because they added a
   building is the behaviour this product exists to be unlike. */
export function outgrown(planKey, units) {
  const plan = planByKey(planKey);
  if (!plan || plan.maxUnits === null) return null;
  const n = Number(units) || 0;
  if (n <= plan.maxUnits) return null;
  return { plan, units: n, suggested: planForUnits(n) };
}

/* The Stripe price id for a band. Kept for anything still reading the old name. */
export function stripePriceEnvKey(planKey) {
  return `STRIPE_PRICE_${String(planKey).toUpperCase()}`;
}

/* The Dodo Payments product for a band. One variable each, so a missing one
   names itself. */
export function dodoProductEnvKey(planKey) {
  return `DODO_PRODUCT_${String(planKey).toUpperCase()}`;
}

/* States in which the company may keep working. Anything else is read-only.

   `past_due` is deliberately included. A card that failed this morning is
   usually a card that expired, not a customer who left, and locking a property
   manager out of their emergency queue over a failed retry would be a far
   worse failure than carrying them for the days Stripe spends retrying. */
export const WORKING_STATUSES = new Set(["trialing", "active", "past_due"]);

export function isWorking(subscription, now = new Date()) {
  if (!subscription) return true;            // nothing recorded yet: do not lock anyone out
  if (!WORKING_STATUSES.has(subscription.status)) return false;

  /* A trial that has run out is not a working subscription, whatever the row
     says — Stripe will say so too, eventually, but the trial is the one state
     we can judge locally without disagreeing with the processor about money. */
  if (subscription.status === "trialing" && subscription.trial_ends_at) {
    return new Date(subscription.trial_ends_at) > now;
  }
  return true;
}

export function describeStatus(subscription, now = new Date()) {
  if (!subscription || subscription.status === "none") {
    return { tone: "warn", title: "No subscription yet", detail: "Choose a plan to keep working past your trial." };
  }
  switch (subscription.status) {
    case "trialing": {
      const ends = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null;
      const days = ends ? Math.ceil((ends - now) / 86400000) : null;
      if (days !== null && days <= 0) {
        return { tone: "danger", title: "Your trial has ended", detail: "Choose a plan to start writing again. Nothing has been deleted." };
      }
      return {
        tone: days !== null && days <= 5 ? "warn" : "ok",
        title: days === null ? "Trial" : `${days} day${days === 1 ? "" : "s"} left of your trial`,
        detail: "Everything works. Choose a plan whenever you are ready.",
      };
    }
    case "active":
      return { tone: "ok", title: "Subscribed", detail: "Thank you. Your next invoice is below." };
    case "past_due":
      return {
        tone: "warn", title: "A payment did not go through",
        detail: "Everything still works while the card is retried. Update it to avoid interruption.",
      };
    case "canceled":
      return {
        tone: "danger", title: "Subscription cancelled",
        detail: "Your data is intact and readable. Start a plan to make changes again.",
      };
    case "unpaid":
      return {
        tone: "danger", title: "Unpaid",
        detail: "Reading works, writing does not. Nothing has been deleted.",
      };
    case "paused":
      return { tone: "warn", title: "Paused", detail: "Reading works, writing does not." };
    default:
      return { tone: "warn", title: subscription.status, detail: "" };
  }
}
