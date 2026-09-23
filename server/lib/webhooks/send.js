/* Sending a webhook, and what happens when it does not arrive.

   ## The connection is pinned to the address that was checked

   `resolveAndCheck` says whether every address a hostname resolves to is
   public. That answer is only worth something if the connection then goes to
   one of those addresses — if the HTTP client resolves the name a second
   time, the answer can differ, and the gap between the two resolutions is
   exactly the DNS rebinding attack.

   So this uses `node:https` with a `lookup` that returns the address already
   vetted, and never consults DNS again. `fetch` cannot do this without
   reaching into undici's dispatcher, which is a larger dependency on an
   internal shape than a hand-written request is.

   ## What counts as a failure worth retrying

   2xx      delivered.
   408, 429 the endpoint is busy or asked us to slow down: retry.
   other 4xx a considered refusal — the URL is wrong, or gone, or the
            receiver rejected the signature. Retrying a 404 for six hours
            helps nobody, so it stops and says so.
   5xx      their fault, probably temporary: retry.
   network  retry.

   ## Backoff, and then stopping

   A minute, five, half an hour, two hours, six. Five attempts over about
   nine hours, which covers an ordinary deploy or outage and does not turn a
   decommissioned URL into a long slow scan of somebody's network. */
import { get, run } from "../db.js";
import { stamp } from "../dates.js";
import { resolveAndCheck, signedHeaders, checkUrl, WebhookRefused } from "./sign.js";

/* Minutes. The length of this array is the number of attempts. */
export const BACKOFF = [1, 5, 30, 120, 360];

export const TIMEOUT_MS = 10_000;

/* An endpoint that has failed this many times in a row has gone, rather than
   having a bad afternoon. */
export const DISABLE_AFTER = 20;

/* Enough to recognise an error page; not enough to be a copy of somebody
   else's application. */
const BODY_KEPT = 500;

/* --- one attempt -------------------------------------------------------------- */

/* Returns the delivery row as it now stands. Never throws: a webhook that
   cannot be sent is a recorded failure, not an exception for the scheduler
   to trip over. */
export async function attempt(delivery, {
  send = httpSend,
  lookup = undefined,
  now = () => new Date(),
} = {}) {
  const endpoint = await get(
    "SELECT * FROM webhook_endpoint WHERE id = ?", delivery.endpoint_id);
  if (!endpoint) {
    return await finish(delivery, { status: "failed", error: "the endpoint was deleted" });
  }

  const attempts = Number(delivery.attempts) + 1;
  const at = stamp();

  /* Checked again here, not only when it was saved. Saving is not sending,
     and the answer can have changed in between — which is the whole reason
     the check is at send time. */
  const shape = checkUrl(endpoint.url);
  if (!shape.ok) {
    await noteFailure(endpoint, { fatal: true, why: shape.reason });
    return await finish(delivery, {
      status: "blocked", attempts, at, error: shape.reason,
    });
  }

  let pinned;
  try {
    const answers = await resolveAndCheck(shape.url.hostname, lookup ? { lookup } : {});
    pinned = answers[0];
  } catch (err) {
    if (err instanceof WebhookRefused) {
      await noteFailure(endpoint, { fatal: true, why: err.message });
      return await finish(delivery, {
        status: "blocked", attempts, at, error: err.message,
      });
    }
    return await retryOrGiveUp(delivery, endpoint, attempts, at, String(err.message), now);
  }

  const timestamp = Math.floor(now().getTime() / 1000);
  const headers = {
    "content-type": "application/json",
    "user-agent": "property-ops-webhooks/1",
    ...signedHeaders({
      id: delivery.id, timestamp, body: delivery.payload, secret: endpoint.secret,
    }),
  };

  let response;
  try {
    response = await send({
      url: shape.url, body: delivery.payload, headers,
      pinned, timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return await retryOrGiveUp(delivery, endpoint, attempts, at,
      String(err.message).slice(0, 300), now);
  }

  const code = Number(response.status);
  const body = String(response.body || "").slice(0, BODY_KEPT);

  if (code >= 200 && code < 300) {
    await run(
      `UPDATE webhook_endpoint
          SET consecutive_failures = 0, last_success_at = ?, disabled_at = NULL, disabled_why = NULL
        WHERE id = ?`, at, endpoint.id);
    return await finish(delivery, {
      status: "delivered", attempts, at, responseStatus: code, body,
      deliveredAt: at,
    });
  }

  /* A considered refusal. Retrying it for six hours helps nobody. */
  if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
    await noteFailure(endpoint, { fatal: false });
    return await finish(delivery, {
      status: "failed", attempts, at, responseStatus: code, body,
      error: `the endpoint answered ${code}, which is a refusal rather than a wobble`,
    });
  }

  await noteFailure(endpoint, { fatal: false });
  return await retryOrGiveUp(delivery, endpoint, attempts, at,
    `the endpoint answered ${code}`, now, { responseStatus: code, body });
}

async function retryOrGiveUp(delivery, endpoint, attempts, at, error, now, extra = {}) {
  if (attempts >= BACKOFF.length) {
    await noteFailure(endpoint, { fatal: false });
    return await finish(delivery, {
      status: "dead", attempts, at, error: `${error} — out of attempts`, ...extra,
    });
  }
  const minutes = BACKOFF[attempts];
  const next = new Date(now().getTime() + minutes * 60_000).toISOString();
  return await finish(delivery, {
    status: "pending", attempts, at, nextAttemptAt: next, error, ...extra,
  });
}

async function finish(delivery, {
  status, attempts = Number(delivery.attempts), at = stamp(),
  nextAttemptAt = null, responseStatus = null, body = null, error = null,
  deliveredAt = null,
}) {
  await run(
    `UPDATE webhook_delivery
        SET status = ?, attempts = ?, last_attempt_at = ?, next_attempt_at = ?,
            response_status = ?, response_body = ?, error = ?, delivered_at = ?
      WHERE id = ?`,
    status, attempts, at, nextAttemptAt, responseStatus, body, error,
    deliveredAt, delivery.id);

  /* The row can be gone: removing an endpoint cascades to its deliveries, and
     the scheduler may be holding one it read a moment earlier. Returning the
     state it would have had, rather than undefined, so a caller reading
     `.status` gets an answer rather than a crash in the middle of a run. */
  const row = await get("SELECT * FROM webhook_delivery WHERE id = ?", delivery.id);
  return row || {
    ...delivery, status, attempts, last_attempt_at: at,
    next_attempt_at: nextAttemptAt, response_status: responseStatus,
    response_body: body, error, delivered_at: deliveredAt,
  };
}

/* A URL that cannot be sent to at all is fatal — it will be exactly as wrong
   in six hours — so the endpoint is turned off now rather than after twenty
   identical refusals. Anything else counts towards the limit. */
async function noteFailure(endpoint, { fatal, why = null }) {
  const at = stamp();
  const failures = Number(endpoint.consecutive_failures) + 1;

  if (fatal) {
    return await run(
      `UPDATE webhook_endpoint
          SET consecutive_failures = ?, last_failure_at = ?, active = 0,
              disabled_at = ?, disabled_why = ?
        WHERE id = ?`,
      failures, at, at,
      why || "this URL cannot be sent to", endpoint.id);
  }

  if (failures >= DISABLE_AFTER) {
    return await run(
      `UPDATE webhook_endpoint
          SET consecutive_failures = ?, last_failure_at = ?, active = 0,
              disabled_at = ?, disabled_why = ?
        WHERE id = ?`,
      failures, at, at,
      `${failures} deliveries in a row failed. Turned off rather than kept retrying `
      + "a URL that looks decommissioned — switch it back on when it is fixed.",
      endpoint.id);
  }

  await run(
    "UPDATE webhook_endpoint SET consecutive_failures = ?, last_failure_at = ? WHERE id = ?",
    failures, at, endpoint.id);
}

/* --- the run ------------------------------------------------------------------ */

/* Everything due, oldest first. Called by the scheduler tick. */
export async function sendDue({ limit = 200, now = () => new Date(), ...opts } = {}) {
  const { all } = await import("../db.js");
  const due = await all(
    `SELECT * FROM webhook_delivery
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at LIMIT ${Number(limit)}`, now().toISOString());

  const out = { webhooksAttempted: 0, webhooksDelivered: 0, webhooksBlocked: 0, webhooksDead: 0 };
  for (const delivery of due) {
    const result = await attempt(delivery, { now, ...opts });
    out.webhooksAttempted += 1;
    if (result.status === "delivered") out.webhooksDelivered += 1;
    if (result.status === "blocked") out.webhooksBlocked += 1;
    if (result.status === "dead") out.webhooksDead += 1;
  }
  return out;
}

/* --- the request --------------------------------------------------------------- */

/* `node:https` rather than `fetch`, so the connection can be pinned to the
   address that was checked. See the header. */
export async function httpSend({ url, body, headers, pinned, timeoutMs }) {
  const https = await import("node:https");

  return await new Promise((resolve, reject) => {
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
      /* The whole point. DNS is not consulted again; the address that was
         vetted is the address connected to. The hostname is still sent in the
         TLS handshake and in the Host header, so certificate verification is
         unaffected. */
      lookup: (_hostname, _options, cb) => cb(null, pinned.address, pinned.family),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        /* A receiver that answers with a gigabyte must not be able to use
           that as a way to exhaust this process. */
        if (size <= BODY_KEPT * 4) chunks.push(c);
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });

    req.on("timeout", () => {
      req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on("error", reject);
    req.end(body);
  });
}
