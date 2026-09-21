/* What the providers tell us after they accepted a message.

   Acceptance is not delivery. A provider takes a message, returns an id, and
   minutes or days later reports that it landed, bounced, or was marked as
   spam. Those later facts are the ones that matter — continuing to send to a
   hard bounce is how a sending domain gets blocked, and continuing to text a
   number that replied STOP is a TCPA problem.

   Two properties govern everything here.

   Nothing in the body is trusted before the signature is checked. The handlers
   receive raw bytes and verify first; a payload that fails verification is not
   parsed, not logged as an event, and not acted on.

   Everything is idempotent. Providers deliver at least once and replay on any
   non-2xx response, so the same event arrives repeatedly — sometimes for days.
   The unique index on (provider, provider_event_id) is what makes that
   harmless, and a duplicate returns 200 so the provider stops trying. */
import { get, run, insert } from "../db.js";
import { id } from "../ids.js";
import { log } from "../logger.js";
import { verifySvix, verifyTwilio } from "./signatures.js";
import { record as recordConsent, classifyInbound, normalise } from "./consent.js";
import {
  RESEND_WEBHOOK_SECRET, TWILIO_AUTH_TOKEN, APP_BASE_URL,
} from "../config.js";

const stamp = () => new Date().toISOString();

/* Resend event types, mapped onto what they mean for the address.

   A soft bounce is deliberately absent: a full mailbox or a greylist is
   temporary, and suppressing on one would permanently silence an address over
   a transient condition. */
const RESEND_CONSENT = {
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export async function handleResend({ rawBody, headers, now = Date.now() }) {
  const check = verifySvix({
    headers, rawBody, secret: RESEND_WEBHOOK_SECRET, now,
  });
  if (!check.ok) {
    log.warn("rejected resend webhook", { reason: check.reason });
    return { status: 401, outcome: check.reason };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, outcome: "unparseable body" };
  }

  const kind = String(payload.type || "unknown");
  const providerMessageId = payload?.data?.email_id || null;
  const contact = firstRecipient(payload?.data?.to);

  return await ingest({
    provider: "resend",
    providerEventId: check.eventId,
    kind,
    providerMessageId,
    contact,
    consentState: RESEND_CONSENT[kind] || null,
    consentSource: `resend ${kind}`,
    channel: "email",
    detail: JSON.stringify(payload?.data?.reason || payload?.data?.subject || "").slice(0, 300),
  });
}

/* Twilio posts form-encoded, and two different kinds of callback arrive at the
   same URL: status updates for messages we sent, and inbound messages from
   people texting back. The second is where STOP lives. */
const TWILIO_TERMINAL_FAILURE = new Set(["failed", "undelivered"]);

export async function handleTwilio({ rawBody, headers, url, now = Date.now() }) {
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = headers["x-twilio-signature"] || headers["X-Twilio-Signature"];

  /* The URL Twilio signed, not the one this process thinks it is serving.
     Behind a proxy those differ and every callback would be rejected. */
  const signedUrl = url || `${APP_BASE_URL || ""}/api/webhooks/twilio`;

  const check = verifyTwilio({
    url: signedUrl, params, signature, authToken: TWILIO_AUTH_TOKEN,
  });
  if (!check.ok) {
    log.warn("rejected twilio webhook", { reason: check.reason });
    return { status: 401, outcome: check.reason };
  }

  const inboundBody = params.Body;
  const from = params.From;
  const messageSid = params.MessageSid || params.SmsSid;

  /* An inbound message. Only the exact keywords count — a tenant texting
     "please stop the leaking tap" has not opted out, and treating it as one
     would cut them off from their own repair updates. */
  if (inboundBody != null && from) {
    const intent = classifyInbound(inboundBody);
    const company = await companyForNumber(from);

    if (intent === "stop" || intent === "start") {
      if (company) {
        await recordConsent(
          company, "sms", from,
          intent === "stop" ? "revoked" : "granted",
          `inbound ${intent.toUpperCase()}`);
      }
      return await ingest({
        provider: "twilio",
        providerEventId: messageSid || `inbound-${from}-${Date.now()}`,
        kind: `inbound.${intent}`,
        providerMessageId: null,
        contact: from,
        companyId: company,
        /* Consent was recorded above against the resolved company; ingest()
           does not repeat it. */
        consentState: null,
        channel: "sms",
        detail: String(inboundBody).slice(0, 300),
      });
    }

    return await ingest({
      provider: "twilio",
      providerEventId: messageSid || `inbound-${from}-${Date.now()}`,
      kind: "inbound.message",
      providerMessageId: null,
      contact: from,
      companyId: company,
      consentState: null,
      channel: "sms",
      detail: String(inboundBody).slice(0, 300),
    });
  }

  // A status callback for something we sent.
  const status = String(params.MessageStatus || params.SmsStatus || "unknown");
  const errorCode = Number(params.ErrorCode || 0);

  return await ingest({
    provider: "twilio",
    providerEventId: `${messageSid}:${status}`,
    kind: `message.${status}`,
    providerMessageId: messageSid,
    contact: params.To,
    /* 21610 is the carrier telling us this number opted out. Recorded as
       consent so it applies to every future message, not just this one. */
    consentState: errorCode === 21610 ? "revoked" : null,
    consentSource: "carrier opt-out (21610)",
    channel: "sms",
    detail: errorCode ? `error ${errorCode}` : status,
    terminalFailure: TWILIO_TERMINAL_FAILURE.has(status),
  });
}

/* The shared tail: store the event once, attach it to its message, update
   consent when the event says to. */
async function ingest({
  provider, providerEventId, kind, providerMessageId, contact,
  consentState, consentSource, channel, detail, companyId = null, terminalFailure = false,
}) {
  const outbox = providerMessageId
    ? await get("SELECT id, company_id, to_contact FROM outbox WHERE provider_message_id = ?", providerMessageId)
    : null;

  const resolvedCompany = companyId || outbox?.company_id || null;

  try {
    await insert("delivery_event", {
      id: id(), company_id: resolvedCompany, outbox_id: outbox?.id || null,
      provider, provider_event_id: String(providerEventId), kind,
      contact: contact || outbox?.to_contact || null,
      detail: detail || null, received_at: stamp(),
    });
  } catch (err) {
    /* Seen it. Returning 200 rather than an error is what stops the provider
       replaying the same event for the next three days. */
    if (String(err.message).includes("duplicate key")) {
      return { status: 200, outcome: "duplicate" };
    }
    throw err;
  }

  if (outbox && terminalFailure) {
    /* The provider accepted it and then could not deliver it. That is a dead
       letter, not a retry: the carrier has already made its decision. */
    await run(
      "UPDATE outbox SET status = 'dead', last_error = ?, failed_at = ? WHERE id = ? AND status <> 'dead'",
      `provider reported ${kind}`, stamp(), outbox.id);
  }

  if (consentState && resolvedCompany && (contact || outbox?.to_contact)) {
    await recordConsent(
      resolvedCompany, channel, contact || outbox.to_contact,
      consentState, consentSource || provider, detail);
  }

  return { status: 200, outcome: kind, outboxId: outbox?.id || null };
}

/* An inbound SMS names a number, not a company. The company is whichever one
   last sent to that number — which is right in practice and ambiguous in
   principle, so it is recorded on the event either way and the consent row it
   produces is scoped to that company alone. */
async function companyForNumber(from) {
  const row = await get(
    `SELECT company_id FROM outbox
      WHERE channel = 'sms' AND to_contact IN (?, ?)
      ORDER BY queued_at DESC LIMIT 1`,
    String(from), normalise("sms", from));
  return row?.company_id || null;
}

function firstRecipient(to) {
  if (!to) return null;
  return Array.isArray(to) ? String(to[0]) : String(to);
}
