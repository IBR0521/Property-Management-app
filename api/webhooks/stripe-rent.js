/* Delivery events for a property company's own Stripe account.

   The company id is on the query string because the signature can only be
   checked with that company's webhook secret, and the secret is not known
   until we know which company Stripe is calling. The body is not trusted
   before that check. */
import { verifyWebhookSignature } from "../../server/lib/stripe.js";
import { applyConnectEvent } from "../../server/features/payments.js";
import { ready, get, insert, update } from "../../server/lib/db.js";
import { open as openSeal } from "../../server/lib/crypto.js";
import { id } from "../../server/lib/ids.js";
import { log } from "../../server/lib/logger.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method not allowed");
  }

  try {
    await ready();
    const rawBody = await readRaw(req);
    const companyId = new URL(req.url, "http://localhost").searchParams.get("company");
    const company = companyId
      ? await get("SELECT id, stripe_webhook_sealed FROM company WHERE id = ?", companyId)
      : null;
    const secret = company?.stripe_webhook_sealed ? openSeal(company.stripe_webhook_sealed) : null;

    const check = verifyWebhookSignature({
      rawBody, header: req.headers["stripe-signature"], secret,
    });
    if (!check.ok) {
      log.warn("rejected company stripe webhook", { reason: check.reason });
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, reason: check.reason }));
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false }));
    }

    const eventId = id();
    try {
      await insert("connect_event", {
        id: eventId,
        company_id: company.id,
        stripe_id: String(event.id),
        account_id: event.account || company.id,
        kind: String(event.type || "unknown"),
        received_at: new Date().toISOString(),
      });
    } catch (err) {
      if (String(err.message).includes("duplicate key")) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, outcome: "duplicate" }));
      }
      throw err;
    }

    const result = await applyConnectEvent(event, { companyId: company.id });
    await update("connect_event", eventId, {
      processed_at: new Date().toISOString(),
      outcome: String(result.outcome || "").slice(0, 200),
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, outcome: result.outcome }));
  } catch (err) {
    log.error("company stripe webhook failed", { err });
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false }));
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("webhook body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
