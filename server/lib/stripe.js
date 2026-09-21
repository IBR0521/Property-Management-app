/* The Stripe boundary.

   Same shape as the Plaid and Resend boundaries: plain `fetch`, no SDK, one
   file that every outbound call goes through, so there is one place to audit
   for a secret key escaping into a log or an error page.

   Stripe's API is form-encoded rather than JSON, and nested parameters use
   bracket notation (`items[0][price]`). That encoding is the only genuinely
   fiddly part and it lives in `encode()` below.

   Nothing here has run against a live Stripe account. It is written against
   their documented API and exercised in tests with `fetch` replaced, and the
   signature verification is checked against signatures generated with their
   documented algorithm. Treat the first call with real keys as the test. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "./config.js";

const API = "https://api.stripe.com/v1";

export function stripeConfigured() {
  return Boolean(STRIPE_SECRET_KEY);
}

/* Stripe wants application/x-www-form-urlencoded with bracketed paths for
   anything nested. `{ items: [{ price: "p" }] }` becomes `items[0][price]=p`. */
export function encode(params, prefix = "") {
  const out = new URLSearchParams();

  const walk = (value, path) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}[${k}]` : k);
    } else {
      out.append(path, String(value));
    }
  };

  walk(params, prefix);
  return out.toString();
}

async function call(path, { method = "POST", body = null, idempotencyKey = null } = {}) {
  if (!STRIPE_SECRET_KEY) {
    const err = new Error("Stripe is not configured — STRIPE_SECRET_KEY is unset.");
    err.notConfigured = true;
    throw err;
  }

  const headers = {
    authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded",
    /* Pinned rather than floating. An API version that changes underneath a
       running deployment changes the shape of webhook payloads, which is how
       a billing integration silently stops recognising a cancellation. */
    "stripe-version": "2024-06-20",
  };
  /* Retrying a create without this makes two customers or two subscriptions.
     Stripe deduplicates on it for 24 hours. */
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? encode(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload?.error?.message || `Stripe ${path} failed (${res.status})`);
    err.stripeCode = payload?.error?.code;
    err.stripeType = payload?.error?.type;
    err.status = res.status;
    throw err;
  }
  return payload;
}

export async function createCustomer({ companyId, name, email }) {
  return await call("/customers", {
    body: {
      name, email,
      /* The link back. Without it a webhook naming a customer cannot be
         resolved to a company except by a lookup we would have to maintain. */
      metadata: { company_id: companyId },
    },
    idempotencyKey: `customer:${companyId}`,
  });
}

/* Stripe Checkout rather than collecting card details ourselves. Card data
   never touches this server, which removes the entire PCI surface — the
   browser talks to Stripe and comes back with a session id. */
export async function createCheckoutSession({
  customerId, priceId, companyId, planKey, successUrl, cancelUrl, trialEndsAt,
}) {
  const body = {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: companyId,
    metadata: { company_id: companyId, plan_key: planKey },
    subscription_data: { metadata: { company_id: companyId, plan_key: planKey } },
    /* Stripe's own tax handling, off by default: switching it on has
       registration consequences in every jurisdiction it collects for, and
       that is a decision for the operator rather than a default. */
    automatic_tax: { enabled: false },
  };

  /* Carry the remaining trial into the subscription rather than ending it the
     moment somebody chooses a plan. Choosing early should not cost days. */
  if (trialEndsAt) {
    const seconds = Math.floor(new Date(trialEndsAt).getTime() / 1000);
    if (seconds > Math.floor(Date.now() / 1000)) {
      body.subscription_data.trial_end = seconds;
    }
  }

  return await call("/checkout/sessions", { body });
}

/* Stripe's own billing portal, so changing a card, seeing invoices and
   cancelling all happen on their pages. Rebuilding those is a large surface
   for no benefit, and they are the pages a customer's finance person already
   recognises. */
export async function createPortalSession({ customerId, returnUrl }) {
  return await call("/billing_portal/sessions", {
    body: { customer: customerId, return_url: returnUrl },
  });
}

export async function getSubscription(subscriptionId) {
  return await call(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET" });
}

/* --- webhook signatures ---------------------------------------------------

   `Stripe-Signature: t=1680000000,v1=<hex>,v1=<hex>` — the signed payload is
   `${t}.${rawBody}`, HMAC-SHA256 under the endpoint secret, hex.

   Several v1 entries appear while a secret is being rotated, so any match is
   a pass. The timestamp is checked for the usual reason: a signature with no
   expiry makes a captured request replayable forever. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature({
  rawBody, header, secret = STRIPE_WEBHOOK_SECRET, now = Date.now(),
}) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!header) return { ok: false, reason: "missing Stripe-Signature" };

  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") timestamp = v?.trim();
    if (k?.trim() === "v1" && v) signatures.push(v.trim());
  }

  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed Stripe-Signature" };

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: "unparseable timestamp" };
  if (age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  let matched = false;
  for (const candidate of signatures) {
    // No early exit: the time taken must not reveal which candidate matched.
    if (safeEqual(candidate, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/* Exported so tests can produce a real signature rather than asserting against
   a string copied out of documentation. */
export function signWebhook({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
