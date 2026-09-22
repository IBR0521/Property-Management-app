/* Stripe Connect: the company's own account, never ours.

   Every call here carries a `Stripe-Account` header. That single header is
   what makes a charge belong to the property manager rather than to the
   platform — the funds are theirs from the moment the tenant authorises, they
   settle to their bank, and no platform balance exists at any point in the
   flow.

   Standard Connect, so the property manager holds a full Stripe account and
   carries their own chargebacks. The platform takes **no application fee**:
   this product charges a subscription, and skimming a slice of each rent
   payment is the pricing behaviour it exists to be unlike. That is enforced
   here by the absence of an `application_fee_amount` parameter anywhere in
   this file, and by a test asserting it.

   Nothing in this file has run against Stripe. It follows their documented
   API, the request shapes are exercised with `fetch` replaced, and the first
   call with real keys is the test. */
import { STRIPE_SECRET_KEY, STRIPE_CONNECT_CLIENT_ID, APP_BASE_URL } from "./config.js";
import { encode } from "./stripe.js";

const API = "https://api.stripe.com/v1";
const OAUTH_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const OAUTH_TOKEN = "https://connect.stripe.com/oauth/token";

export function connectConfigured() {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_CONNECT_CLIENT_ID);
}

/* A call against a connected account.

   `accountId` is not optional and there is no default: a call that forgets it
   would be made as the platform, which for a charge means the platform
   receiving the money. Making it a required first argument means that mistake
   cannot be made by omission. */
async function callAs(accountId, path, { method = "POST", body = null, idempotencyKey = null } = {}) {
  if (!STRIPE_SECRET_KEY) {
    const err = new Error("Stripe is not configured — STRIPE_SECRET_KEY is unset.");
    err.notConfigured = true;
    throw err;
  }
  if (!accountId) {
    throw new Error("A connected account id is required — a charge without one would be ours.");
  }

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2024-06-20",
      "stripe-account": accountId,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? encode(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload?.error?.message || `Stripe ${path} failed (${res.status})`);
    err.stripeCode = payload?.error?.code;
    err.stripeType = payload?.error?.type;
    err.declineCode = payload?.error?.decline_code;
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* --- connecting ----------------------------------------------------------- */

/* Where the manager is sent to connect. `state` is ours and is checked on the
   way back — without it, anybody could hand a signed-in manager a link that
   attaches somebody else's Stripe account to their company. */
export function authorizeUrl({ state, email }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: STRIPE_CONNECT_CLIENT_ID,
    scope: "read_write",
    state,
    redirect_uri: `${APP_BASE_URL || ""}/app/payments/connected`,
  });
  if (email) params.set("stripe_user[email]", email);
  return `${OAUTH_AUTHORIZE}?${params}`;
}

/* The code from the redirect becomes the connected account id. Called as the
   platform rather than as an account, because there is no account yet. */
export async function exchangeCode(code) {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: encode({ grant_type: "authorization_code", code }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.stripe_user_id) {
    throw new Error(payload?.error_description || "Stripe refused the connection.");
  }
  return payload;   // { stripe_user_id, ... }
}

/* What the account can actually do, read from Stripe rather than assumed.

   `charges_enabled` false with an empty requirements list is the common and
   confusing case: Stripe is still reviewing, nothing is owed, and nothing the
   manager does will speed it up. The screen says that rather than listing
   nothing and looking broken. */
export async function accountStatus(accountId) {
  const account = await callAs(accountId, `/accounts/${encodeURIComponent(accountId)}`, { method: "GET" });
  const due = [
    ...(account?.requirements?.currently_due || []),
    ...(account?.requirements?.past_due || []),
  ];
  return {
    id: account.id,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    requirements: [...new Set(due)],
    disabledReason: account?.requirements?.disabled_reason || null,
    businessName: account?.business_profile?.name || account?.settings?.dashboard?.display_name || null,
  };
}

/* --- taking a payment ------------------------------------------------------ */

/* A payment intent on the company's account.

   `on_behalf_of` and `transfer_data` are deliberately absent: with a direct
   charge on a connected account, the money is already theirs. Those parameters
   belong to the destination-charge model, where funds land on the platform
   first — which is the model this design refuses. */
export async function createPaymentIntent({
  accountId, amountCents, currency = "usd", paymentMethodId, customerId,
  description, metadata = {}, confirm = true, offSession = false, mandateId = null,
  idempotencyKey = null,
}) {
  const body = {
    amount: Math.round(amountCents),
    currency,
    description,
    metadata,
    confirm,
    /* An autopay run has nobody present to answer a bank's challenge, so the
       charge says so. A card that needs authentication then fails cleanly and
       is retried with the tenant there, rather than hanging. */
    off_session: offSession,
  };
  if (paymentMethodId) body.payment_method = paymentMethodId;
  if (customerId) body.customer = customerId;
  if (mandateId) body.mandate = mandateId;
  if (confirm) body.payment_method_types = ["us_bank_account", "card"];

  return await callAs(accountId, "/payment_intents", { body, idempotencyKey });
}

export async function getPaymentIntent(accountId, intentId) {
  return await callAs(accountId, `/payment_intents/${encodeURIComponent(intentId)}`, { method: "GET" });
}

/* A customer on the company's account, so a saved bank account belongs to
   them rather than to us. */
export async function createCustomer({ accountId, name, email, metadata = {} }) {
  return await callAs(accountId, "/customers", {
    body: { name, email, metadata },
    idempotencyKey: metadata.lease_id ? `cust:${metadata.lease_id}` : null,
  });
}

/* A short-lived secret the browser uses to collect bank or card details
   directly with Stripe. The details never reach this server, which is what
   keeps the entire PCI surface off it. */
export async function createSetupIntent({ accountId, customerId, kinds = ["us_bank_account"] }) {
  return await callAs(accountId, "/setup_intents", {
    body: {
      customer: customerId,
      payment_method_types: kinds,
      /* Recorded against the mandate: this instruction is to be reusable
         without the tenant present, which is what autopay is. */
      usage: "off_session",
    },
  });
}

export async function listPayouts(accountId, { limit = 20 } = {}) {
  return await callAs(accountId, `/payouts?limit=${Number(limit)}`, { method: "GET" });
}

/* Deliberately exported so a test can assert the platform never takes a cut.
   If an application fee is ever added, this list is where it would have to be
   declared, and the test fails. */
export const PLATFORM_FEE_PARAMETERS = [];
