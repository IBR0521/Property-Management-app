/* Stripe Connect webhooks: events about tenant payments on a company's own
   account, not about our subscription to them.

   A separate endpoint from api/webhooks/stripe.js because they are separate
   things with separate signing secrets. Sharing one endpoint would mean a leak
   of either secret could forge the other's events, and a rent payment and a
   subscription cancellation should not be authenticated by the same key.

   Transport only: verification lives in lib/stripe.js and the effect in
   features/payments.js, so the rules are testable without a socket. */
import { verifyWebhookSignature } from "../../server/lib/stripe.js";
import { applyConnectEvent } from "../../server/features/payments.js";
import { ready, insert, update } from "../../server/lib/db.js";
import { STRIPE_CONNECT_WEBHOOK_SECRET } from "../../server/lib/config.js";
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
      secret: STRIPE_CONNECT_WEBHOOK_SECRET,
    });
    if (!check.ok) {
      log.warn("rejected connect webhook", { reason: check.reason });
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

    /* Idempotency before effect, and in its own table: a Connect event and a
       platform event can share an id space only by accident, and settling a
       rent payment twice would post rent twice. */
    const rowId = id();
    try {
      await insert("connect_event", {
        id: rowId, stripe_id: String(event.id), account_id: event.account || null,
        kind: String(event.type || "unknown"), received_at: new Date().toISOString(),
      });
    } catch (err) {
      if (String(err.message).includes("duplicate key")) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, outcome: "duplicate" }));
      }
      throw err;
    }

    const result = await applyConnectEvent(event);
    await update("connect_event", rowId, {
      company_id: result.companyId || null,
      processed_at: new Date().toISOString(),
      outcome: String(result.outcome || "").slice(0, 200),
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, outcome: result.outcome }));
  } catch (err) {
    log.error("connect webhook failed", { err });
    /* 500 so Stripe retries. Losing a settlement here means an owner is not
       told about rent that arrived; losing a return means they are told about
       rent that did not. */
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
