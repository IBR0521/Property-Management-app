/* Stripe webhooks.

   Transport only: verification and effect live in lib/stripe.js and
   features/billing.js, so the rules that decide whether somebody keeps working
   are testable without a socket.

   Raw bytes, because the signature covers exactly what Stripe sent and
   re-serialising produces different bytes and a signature that never matches. */
import { verifyWebhookSignature } from "../../server/lib/stripe.js";
import { applyStripeEvent } from "../../server/features/billing.js";
import { ready, get, insert, update } from "../../server/lib/db.js";
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

    const check = verifyWebhookSignature({
      rawBody, header: req.headers["stripe-signature"],
    });
    if (!check.ok) {
      log.warn("rejected stripe webhook", { reason: check.reason });
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

    /* Idempotency before effect. Stripe delivers at least once and replays on
       any non-2xx, so the same event arrives repeatedly — sometimes for days. */
    const eventId = id();
    try {
      await insert("stripe_event", {
        id: eventId, stripe_id: String(event.id), kind: String(event.type || "unknown"),
        received_at: new Date().toISOString(),
      });
    } catch (err) {
      if (String(err.message).includes("duplicate key")) {
        /* 200, so Stripe stops retrying something already handled. */
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, outcome: "duplicate" }));
      }
      throw err;
    }

    const result = await applyStripeEvent(event);
    await update("stripe_event", eventId, {
      company_id: result.companyId || null,
      processed_at: new Date().toISOString(),
      outcome: String(result.outcome || "").slice(0, 200),
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, outcome: result.outcome }));
  } catch (err) {
    log.error("stripe webhook failed", { err });
    /* 500 so Stripe retries. Losing a cancellation because the database was
       briefly unavailable would leave somebody paying for nothing, or working
       for free. */
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
