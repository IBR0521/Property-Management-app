/* Resend delivery events.

   Its own function rather than a route in the app, for two reasons. vercel.json
   rewrites everything except /api/* into the main handler, so a path under
   /api needs a real file. And a webhook must not carry the session and CSRF
   machinery: it is authenticated by a signature over its bytes, and running it
   through a pipeline built for browsers would mean exempting it from that
   pipeline's checks one by one. */
import { handleResend } from "../../server/lib/delivery/webhooks.js";
import { ready } from "../../server/lib/db.js";
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
    /* Raw bytes. The signature covers exactly what was sent, so parsing and
       re-serialising would produce different bytes and a signature that never
       matches. */
    const rawBody = await readRaw(req);
    const result = await handleResend({ rawBody, headers: req.headers });
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: result.status === 200, outcome: result.outcome }));
  } catch (err) {
    log.error("resend webhook failed", { err });
    /* 500 so the provider retries. The alternative is losing a bounce because
       our database was briefly unavailable. */
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
      // A delivery event is under a kilobyte; anything larger is not one.
      if (data.length > 1_000_000) reject(new Error("webhook body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
