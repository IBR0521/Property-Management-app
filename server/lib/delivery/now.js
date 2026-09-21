/* Sending during the request, for the one message that cannot wait.

   Everything else in this app queues, and queuing is right: a reminder that
   goes out four minutes late is a reminder that went out. The on-call
   emergency alert is different. The tenant is standing in front of something
   that is flooding, and the whole design of the emergency path is that it
   never becomes a queue entry. A scheduler that runs daily would deliver that
   alert tomorrow.

   So this sends inside the request, with a short timeout, and records what
   happened either way. It never throws: the tenant must see the stop card
   whatever the provider did, because the stop card is the actual guarantee —
   it tells them to phone, and phoning works when nothing else does.

   The outbox row is still written, as a record rather than as a thing to be
   drained. Three outcomes, all visible to a manager:

     sent        the provider accepted it
     dead        the provider refused or timed out — nobody is coming from this
     queued      delivery is off, so it was never going to leave

   A failure here is logged at error level and shown on the work order, because
   the one thing worse than an alert that did not send is an alert nobody knows
   did not send. */
import { insert, run } from "../db.js";
import { id } from "../ids.js";
import { log } from "../logger.js";
import { deliver } from "./index.js";
import { DELIVERY_MODE } from "../config.js";
import { drains } from "./mode.js";
import { senderFor } from "../outbox.js";

const stamp = () => new Date().toISOString();

/* Deliberately shorter than the provider adapters' own 10s. A tenant is
   waiting on this response, and an alert that takes eight seconds to fail has
   already cost more than it is worth. */
const URGENT_TIMEOUT_MS = 5000;

export async function sendNow({
  companyId, channel, to, subject, body, aboutType, aboutId,
  send = deliver, mode = DELIVERY_MODE,
}) {
  const rowId = id();

  /* Written first, so the attempt exists in the record even if this process
     dies halfway through it. */
  await insert("outbox", {
    id: rowId, company_id: companyId, channel, to_contact: to,
    subject, body, about_type: aboutType || null, about_id: aboutId || null,
    status: "queued", kind: "transactional", queued_at: stamp(),
  });

  if (!drains(mode)) {
    /* Not a failure, and not pretended to be a success. It stays queued and
       every screen that counts queued messages counts this one. */
    return { ok: false, reason: "delivery is off", outboxId: rowId, state: "queued" };
  }

  let result;
  try {
    const sender = await senderFor(companyId, channel);
    result = await Promise.race([
      send({ channel, to, subject, body, companyId, kind: "transactional",
             from: sender.from, replyTo: sender.replyTo }),
      new Promise((resolve) =>
        setTimeout(() => resolve({
          ok: false, error: `no answer from provider in ${URGENT_TIMEOUT_MS}ms`, retryable: true,
        }), URGENT_TIMEOUT_MS)),
    ]);
  } catch (err) {
    result = { ok: false, error: String(err?.message || err), retryable: true };
  }

  if (result.ok) {
    await run(
      `UPDATE outbox SET status = 'sent', sent_at = ?, attempts = 1,
              provider = ?, provider_message_id = ? WHERE id = ?`,
      stamp(), result.provider || null, result.providerMessageId || null, rowId);
    return { ok: true, outboxId: rowId, state: "sent", providerMessageId: result.providerMessageId };
  }

  /* Dead rather than queued for retry. A retry in half an hour is not an
     emergency alert, and leaving it queued would let a later drain send a
     stale "EMERGENCY" hours after the event. */
  await run(
    `UPDATE outbox SET status = 'dead', attempts = 1, last_error = ?, failed_at = ?,
            provider = ? WHERE id = ?`,
    String(result.error || "send failed").slice(0, 300), stamp(), result.provider || null, rowId);

  log.error("urgent send failed", {
    channel, aboutType, aboutId, outboxId: rowId,
    error: String(result.error || "").slice(0, 200),
  });

  return { ok: false, reason: result.error, outboxId: rowId, state: "dead" };
}
