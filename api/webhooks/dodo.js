/* Dodo Payments webhooks.

   Transport only. The signature check and the effect on a subscription live
   in lib/dodo.js and features/billing.js. Raw bytes, because the signature
   covers exactly the body they sent. */
import { verifyWebhookSignature } from "../../server/lib/dodo.js";
import { applyDodoEvent } from "../../server/features/billing.js";
import { ready, insert, update } from "../../server/lib/db.js";
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
      rawBody,
      id: req.headers["webhook-id"],
      timestamp: req.headers["webhook-timestamp"],
      signature: req.headers["webhook-signature"],
    });
    if (!check.ok) {
      log.warn("rejected dodo webhook", { reason: check.reason });
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
      await insert("dodo_event", {
        id: eventId,
        webhook_id: String(req.headers["webhook-id"]),
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

    const result = await applyDodoEvent(event);
    await update("dodo_event", eventId, {
      company_id: result.companyId || null,
      processed_at: new Date().toISOString(),
      outcome: String(result.outcome || "").slice(0, 200),
    });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, outcome: result.outcome }));
  } catch (err) {
    log.error("dodo webhook failed", { err });
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
