/* What the platform charges, and how the customer can check it.

   The transparent-pricing rule in this product's brief is not decoration. Most
   property software prices by "contact us", or meters something the customer
   cannot count, or takes a slice of each rent payment that never appears on a
   statement. The counter-position only works if the number is knowable in
   advance from something the customer already knows — and every property
   manager knows exactly how many doors they have.

   So: one monthly price per door. A company with ten doors pays ten times
   that price. A company with one door pays it once. No band that charges a
   one-door firm for twenty-five, no per-payment fee, and no percentage of
   rent. Collecting more rent does not change the bill. Adding a door does.

   The price here is the source of truth for what is *displayed*. What is
   charged is the Dodo product, once per door. That product has to be priced
   at the same rate, because checkout sends the door count as the quantity. */

/* $2.00 a door. $49 for a band of 25 doors was about this, and a band is
   what a one-door company should not have to buy. */
export const PER_DOOR_CENTS = 200;
export const PLAN_KEY = "door";

export const TRIAL_DAYS = 30;

/* Doors are units the company has added. An empty company is not billed. */
export function billableDoors(units) {
  const n = Math.floor(Number(units) || 0);
  return n > 0 ? n : 0;
}

export function monthlyCents(units) {
  return billableDoors(units) * PER_DOOR_CENTS;
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
