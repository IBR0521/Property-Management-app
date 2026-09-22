/* What the tenant is actually charged.

   Integer cents throughout, and basis points rather than percentages, because
   this arithmetic decides what comes out of somebody's bank account. A
   rounding error here is a real complaint from a real person about a real
   number, and floating point makes those complaints unreproducible.

   The fee is *quoted* here and *charged* by Stripe, so the two can disagree —
   rates change, a negotiated rate differs from the published one, a card turns
   out to be international. A quote that is wrong is worse than no quote, so
   the company's own configured rates are used rather than assumed ones, and
   the interface says "estimated" where it is an estimate. */

/* Stripe's fee on an amount, under this company's configured rates.

   ACH is a percentage with a cap — which is why rent goes on ACH: 0.8% of
   $1,450 would be $11.60 but the cap makes it $5. Card is a percentage plus a
   fixed amount and has no cap, which is why $1,450 on a card costs $42.35 and
   why almost nobody absorbs that. */
export function processorFee(company, method, amountCents) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!amount) return 0;

  if (method === "ach") {
    const bps = Number(company?.ach_fee_bps ?? 80);
    const cap = Number(company?.ach_fee_cap_cents ?? 500);
    const raw = Math.round((amount * bps) / 10000);
    return cap > 0 ? Math.min(raw, cap) : raw;
  }

  const bps = Number(company?.card_fee_bps ?? 290);
  const fixed = Number(company?.card_fee_fixed_cents ?? 30);
  return Math.round((amount * bps) / 10000) + fixed;
}

function modelFor(company, method) {
  return method === "ach"
    ? {
        model: company?.ach_fee_model || "absorb",
        splitPercent: Number(company?.ach_fee_split_percent ?? 50),
      }
    : {
        model: company?.card_fee_model || "pass",
        splitPercent: Number(company?.card_fee_split_percent ?? 50),
      };
}

/* The whole quote, itemised, for one payment.

   Returned rather than formatted so the tenant's page, the confirmation and
   the receipt all show the same numbers from one calculation. Showing a
   tenant one total and charging another is the fastest way to a chargeback.

   `rentCents` is what is owed. `tenantPaysCents` is what leaves their account.
   `companyBearsCents` is what the company gives up. Those three plus the fee
   always reconcile, and the test asserts it. */
export function quote({ company, method, amountCents }) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  const fee = processorFee(company, method, amount);
  const { model, splitPercent } = modelFor(company, method);

  let tenantFeeShare = 0;
  if (model === "pass") {
    tenantFeeShare = fee;
  } else if (model === "split") {
    const pct = Math.min(100, Math.max(0, splitPercent));
    /* Rounded down, so a split never charges the tenant more than the share
       the company configured. Any rounding remainder lands on the company,
       which is the side that chose the arrangement. */
    tenantFeeShare = Math.floor((fee * pct) / 100);
  }

  const companyFeeShare = fee - tenantFeeShare;

  return {
    method,
    model,
    amountCents: amount,
    feeCents: fee,
    tenantFeeCents: tenantFeeShare,
    companyFeeCents: companyFeeShare,
    tenantPaysCents: amount + tenantFeeShare,
    /* What the company nets once Stripe has taken its cut, ignoring any
       later refund or dispute. Shown to the manager, never to the tenant. */
    companyNetCents: amount + tenantFeeShare - fee,
    /* An estimate whenever the published rate might not be the real one. */
    estimated: true,
  };
}

/* One line a tenant reads before authorising. Deliberately plain: no
   "convenience", no "service", just what it is and who charges it. */
export function describeQuote(q, { currency = "USD" } = {}) {
  const money = (cents) => formatMoney(cents, currency);
  if (q.tenantFeeCents === 0) {
    return `You pay ${money(q.amountCents)}. There is no charge for paying this way.`;
  }
  if (q.model === "pass") {
    return `You pay ${money(q.tenantPaysCents)} — ${money(q.amountCents)} rent plus a `
      + `${money(q.tenantFeeCents)} processing fee.`;
  }
  return `You pay ${money(q.tenantPaysCents)} — ${money(q.amountCents)} rent plus `
    + `${money(q.tenantFeeCents)} towards the ${money(q.feeCents)} processing fee. `
    + `Your landlord pays the rest.`;
}

function formatMoney(cents, currency) {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

/* Whether a company may offer this method at all. Kept here so the tenant
   page, the autopay enrolment and the API all agree. */
export function methodAvailable(company, method) {
  if (!company?.stripe_account_id) return false;
  if (!company.stripe_charges_enabled) return false;
  if (method === "ach") return Boolean(company.accept_ach);
  if (method === "card") return Boolean(company.accept_card);
  return false;
}

export function availableMethods(company) {
  return ["ach", "card"].filter((m) => methodAvailable(company, m));
}
