/* SMS, via Twilio, over fetch.

   Form-encoded POST with HTTP basic auth. Again no SDK: the request is six
   fields and the response is JSON.

   Twilio's error codes are numeric and well documented, which makes the
   retryable decision more precise here than for email. The ones below are the
   ones that actually turn up in property management: numbers typed wrong,
   landlines, and recipients who have replied STOP. */
import {
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID, APP_BASE_URL,
} from "../config.js";

export const name = "twilio";

/* Codes where the message will never be delivered however many times it is
   sent. Everything else defaults to retryable, because a code we have not seen
   before is more likely a transient network condition than a permanent
   rejection, and the attempt limit bounds the cost of being wrong. */
const PERMANENT_CODES = new Set([
  21211,  // invalid 'To' number
  21212,  // invalid 'From' number
  21214,  // 'To' number is not a valid mobile number
  21408,  // permission to send to this region is not enabled
  21610,  // recipient has replied STOP — do not attempt again
  21612,  // this From/To pair is not reachable
  21614,  // 'To' number is not SMS-capable, e.g. a landline
  30003,  // handset unreachable, permanently
  30005,  // unknown destination handset
  30006,  // landline or unreachable carrier
]);

export async function send({ to, body }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return { ok: false, providerMessageId: null, error: "Twilio is not configured", retryable: false };
  }
  if (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID) {
    return {
      ok: false, providerMessageId: null,
      error: "neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is set",
      retryable: false,
    };
  }

  const form = new URLSearchParams();
  form.set("To", to);
  /* A messaging service is preferred when present: it handles number pooling
     and carrier registration, which is what US A2P traffic needs. */
  if (TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", TWILIO_FROM_NUMBER);
  form.set("Body", body);

  /* Where Twilio reports what happened after it accepted the message. Without
     it, "accepted" is the last thing we ever learn — and accepted is not
     delivered. */
  if (APP_BASE_URL) form.set("StatusCallback", `${APP_BASE_URL}/api/webhooks/twilio`);

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  let res, payload;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    return {
      ok: false, providerMessageId: null,
      error: `twilio unreachable: ${String(err?.message || err).slice(0, 160)}`,
      retryable: true,
    };
  }

  if (res.ok && payload.sid) {
    return { ok: true, providerMessageId: payload.sid, error: null, retryable: false };
  }

  const code = Number(payload.code || 0);
  const message = payload.message || `Twilio returned ${res.status}`;
  const retryable = res.status === 429 || res.status >= 500
    ? true
    : !PERMANENT_CODES.has(code);

  return {
    ok: false,
    providerMessageId: null,
    error: `${code || res.status}: ${String(message).slice(0, 200)}`,
    retryable,
    /* A 21610 is Twilio telling us the recipient opted out at the carrier.
       Surfaced so the caller can record consent rather than just a failure —
       the number should stop being tried across every future message, not
       only this one. */
    carrierOptOut: code === 21610,
  };
}
