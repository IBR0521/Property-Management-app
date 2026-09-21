/* Webhook signature verification, with node:crypto and no SDK.

   A webhook endpoint is a public URL that causes writes. Without verification
   anyone who finds it can mark messages delivered, suppress a phone number, or
   flood the delivery log. Both schemes below are documented, stable, and about
   thirty lines each — which is why this is a file rather than a dependency.

   Three rules apply to both.

   Verify before parsing. The signature covers the raw bytes; parsing first and
   re-serialising produces different bytes and a signature that never matches.
   So the handlers read the body as a string and pass it here untouched.

   Compare in constant time. A byte-by-byte comparison that returns early leaks
   where it diverged, and a signature can be recovered from enough timings.

   Reject old timestamps. A signature stays valid forever unless something
   makes it expire, and a captured request replayed next month is otherwise
   indistinguishable from a real one. */
import { createHmac, timingSafeEqual } from "node:crypto";

/* Five minutes each way. Long enough for a provider's retry and some clock
   drift, short enough that a captured request is not useful for long. */
export const TOLERANCE_SECONDS = 300;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/* --- Resend (Svix) --------------------------------------------------------

   Signs `${svix-id}.${svix-timestamp}.${body}` with HMAC-SHA256 under a
   base64 secret carried as `whsec_<base64>`.

   The signature header holds a space-separated list — `v1,<sig> v1,<sig>` —
   because a secret being rotated means two are briefly valid at once. Any one
   matching is a pass, and all of them are compared so the timing does not
   depend on which position matched. */
export function verifySvix({ headers, rawBody, secret, now = Date.now() }) {
  if (!secret) return { ok: false, reason: "no signing secret configured" };

  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signature = header(headers, "svix-signature");
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing svix headers" };

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, reason: "unparseable timestamp" };
  if (age > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  let matched = false;
  for (const part of String(signature).split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    // No early exit: every candidate is compared so timing reveals nothing.
    if (safeEqual(value, expected)) matched = true;
  }
  return matched ? { ok: true, eventId: id } : { ok: false, reason: "signature mismatch" };
}

/* --- Twilio ---------------------------------------------------------------

   Signs the full request URL with the POST parameters appended: keys sorted,
   then each key immediately followed by its value, with no separators.
   HMAC-SHA1 under the account's auth token, base64.

   The URL must be byte-identical to the one Twilio was configured with,
   including scheme, host, path and any query string. This is the usual reason
   verification fails in production: behind a proxy the app sees http and the
   internal host, while Twilio signed https and the public one. Hence
   APP_BASE_URL rather than anything derived from the request. */
export function verifyTwilio({ url, params, signature, authToken }) {
  if (!authToken) return { ok: false, reason: "no auth token configured" };
  if (!signature) return { ok: false, reason: "missing X-Twilio-Signature" };

  let payload = String(url);
  for (const key of Object.keys(params || {}).sort()) {
    payload += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
  return safeEqual(signature, expected)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/* Headers arrive lower-cased from node:http but not from every test harness or
   proxy, so this does not assume. */
function header(headers, name) {
  if (!headers) return null;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct != null) return Array.isArray(direct) ? direct[0] : direct;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

/* --- for tests and for signing our own outbound links ---------------------

   Exported so the test suite can produce a genuine signature rather than
   asserting against a hard-coded string copied out of documentation. A test
   that only checks a fixed vector proves the algorithm was transcribed, not
   that it round-trips. */
export function signSvix({ id, timestamp, body, secret }) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${sig}`;
}

export function signTwilio({ url, params, authToken }) {
  let payload = String(url);
  for (const key of Object.keys(params || {}).sort()) payload += key + params[key];
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}
