/* Email, via Resend, over fetch.

   One POST. The SDK exists but wraps this same request, and a dependency whose
   job is to build a JSON body is a dependency that also has to be kept current
   and audited.

   The interesting work here is not sending — it is deciding which failures are
   worth another attempt. Resend answers with an HTTP status and a named error,
   and the mapping below is the only place that knows what those names mean.
   Getting it wrong in the permissive direction means retrying a malformed
   address five times; getting it wrong in the strict direction means dropping
   a rent notice because the provider hiccupped once. */
import { RESEND_API_KEY, EMAIL_FROM } from "../config.js";

export const name = "resend";

const ENDPOINT = "https://api.resend.com/emails";

/* Names Resend returns that no amount of retrying will change: the message or
   the address is wrong, or the account is not permitted to send it. */
const PERMANENT = new Set([
  "validation_error",
  "invalid_parameter",
  "missing_required_field",
  "invalid_from_address",
  "invalid_to_address",
  "not_found",
  "restricted_api_key",
  "invalid_api_key",
  "daily_quota_exceeded",
]);

export async function send({ to, subject, body, from, replyTo }) {
  if (!RESEND_API_KEY) {
    return { ok: false, providerMessageId: null, error: "RESEND_API_KEY is not set", retryable: false };
  }

  const sender = from || EMAIL_FROM;
  if (!sender) {
    return { ok: false, providerMessageId: null, error: "no from address configured", retryable: false };
  }

  let res, payload;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: sender,
        to: [to],
        subject: subject || "(no subject)",
        /* Plain text. Every message this app composes is plain text, and
           sending it as HTML would mean escaping tenant-supplied content into
           markup for no gain. */
        text: body,
        /* Where a tenant's reply goes. Without it, replies land on a
           no-reply address and the tenant believes nobody read them. */
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      /* Shorter than the function's own budget, so a hanging provider fails as
         one slow message rather than taking the whole drain with it. */
      signal: AbortSignal.timeout(10_000),
    });
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    // DNS, socket, timeout: the provider never judged the message.
    return {
      ok: false, providerMessageId: null,
      error: `resend unreachable: ${String(err?.message || err).slice(0, 160)}`,
      retryable: true,
    };
  }

  if (res.ok && payload.id) {
    return { ok: true, providerMessageId: payload.id, error: null, retryable: false };
  }

  const errorName = payload.name || payload.error || `http_${res.status}`;
  const message = payload.message || `Resend returned ${res.status}`;

  /* 429 is explicitly retryable — it means slow down, not stop. Anything 5xx
     is theirs, not ours. */
  const retryable = res.status === 429 || res.status >= 500
    ? true
    : !PERMANENT.has(String(errorName));

  return {
    ok: false,
    providerMessageId: null,
    error: `${errorName}: ${String(message).slice(0, 200)}`,
    retryable,
  };
}
