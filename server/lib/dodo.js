/* Dodo Payments, for the platform's own subscription.

   Tenant rent does not come through here. That money goes to the property
   company's own account. This file only starts a plan, opens the page where
   a card is changed, and checks that a webhook was really sent by Dodo.

   The API speaks JSON and a bearer key. The webhook speaks Standard Webhooks:
   the signed string is id, timestamp and the raw body, joined by dots. */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DODO_PAYMENTS_API_KEY, DODO_PAYMENTS_WEBHOOK_KEY, DODO_API_BASE,
} from "./config.js";

export function configured() {
  return Boolean(DODO_PAYMENTS_API_KEY);
}

export async function createCheckout({
  productId, email, name, companyId, planKey, returnUrl, trialDays = 0,
}) {
  const body = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email, name },
    return_url: returnUrl,
    metadata: { company_id: companyId, plan_key: planKey },
  };
  if (trialDays > 0) body.subscription_data = { trial_period_days: trialDays };

  const session = await call("/checkouts", { body });
  if (!session?.checkout_url) {
    throw new Error("Dodo Payments did not return a checkout page.");
  }
  return { url: session.checkout_url, sessionId: session.session_id || null };
}

/* The portal is where a card, an invoice and a cancellation live. Sending
   the link by email as well would surprise somebody who only clicked a button. */
export async function createPortalSession({ customerId, returnUrl }) {
  const session = await call(
    `/customers/${encodeURIComponent(customerId)}/customer-portal/session`,
    { query: { return_url: returnUrl, send_email: "false" } },
  );
  if (!session?.link) throw new Error("Dodo Payments did not return a billing page.");
  return { url: session.link };
}

async function call(path, { body, query } = {}) {
  if (!DODO_PAYMENTS_API_KEY) {
    throw new Error("Dodo Payments is not configured.");
  }
  const url = new URL(path, DODO_API_BASE);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DODO_PAYMENTS_API_KEY}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const message = json?.message || json?.error || `Dodo Payments refused the request (${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* --- webhook signatures ---------------------------------------------------

   Headers: webhook-id, webhook-timestamp, webhook-signature.
   The signature header is one or more `v1,<base64>` entries separated by
   spaces, so a secret can be rotated without dropping deliveries.
   The key in the dashboard is `whsec_` plus base64. The HMAC uses the
   decoded bytes, not the whole string. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature({
  rawBody, id, timestamp, signature, secret = DODO_PAYMENTS_WEBHOOK_KEY, now = Date.now(),
}) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing webhook signature" };

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: "unparseable timestamp" };
  if (age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  let key;
  try { key = webhookKey(secret); } catch { return { ok: false, reason: "webhook secret is not usable" }; }

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const candidates = String(signature).split(" ").map((part) => {
    const [version, value] = part.split(",");
    return version === "v1" ? value : null;
  }).filter(Boolean);

  if (!candidates.length) return { ok: false, reason: "malformed webhook signature" };

  let matched = false;
  for (const candidate of candidates) {
    if (safeEqual(candidate, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export function signWebhook({
  rawBody, secret, id = "msg_test", timestamp = Math.floor(Date.now() / 1000),
}) {
  const sig = createHmac("sha256", webhookKey(secret)).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { id, timestamp: String(timestamp), signature: `v1,${sig}` };
}

function webhookKey(secret) {
  const bare = String(secret).startsWith("whsec_") ? String(secret).slice(6) : String(secret);
  const key = Buffer.from(bare, "base64");
  if (!key.length) throw new Error("empty webhook key");
  return key;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
