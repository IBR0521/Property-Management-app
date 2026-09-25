/* PayPal checkout on the property company's own account.

   The client id and secret belong to that company. This server creates the
   order and, when the tenant comes back, captures it. The capture is what
   settles the payment on the lease. The money is already in their PayPal
   account; nothing here is a balance of ours. */
const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

function host(live) {
  return live ? LIVE : SANDBOX;
}

export async function accessToken({ clientId, secret, live }) {
  const res = await fetch(`${host(live)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    const err = new Error(payload?.error_description || "PayPal refused those keys.");
    err.status = res.status;
    throw err;
  }
  return payload.access_token;
}

export async function createOrder({
  clientId, secret, live, amountCents, description, customId, returnUrl, cancelUrl,
}) {
  const token = await accessToken({ clientId, secret, live });
  const value = (Math.round(Number(amountCents) || 0) / 100).toFixed(2);
  const res = await fetch(`${host(live)}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        custom_id: customId,
        description: description || "Rent",
        amount: { currency_code: "USD", value },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const order = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(order?.message || order?.details?.[0]?.description || "PayPal could not start the payment.");
  }
  const approve = (order.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!approve?.href) throw new Error("PayPal did not return a payment page.");
  return { id: order.id, url: approve.href };
}

export async function captureOrder({ clientId, secret, live, orderId }) {
  const token = await accessToken({ clientId, secret, live });
  const res = await fetch(`${host(live)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const order = await res.json().catch(() => ({}));
  const already = order?.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
  if (!res.ok && !already) {
    throw new Error(order?.message || order?.details?.[0]?.description || "PayPal could not capture the payment.");
  }
  return { id: order.id || orderId, status: already ? "COMPLETED" : order.status };
}
