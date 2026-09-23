/* What this application will tell somebody else about.

   ## A small catalogue, on purpose

   Every event here is a promise: a customer writes a handler for it and that
   handler runs for years. Five things worth telling somebody about is better
   than twenty things nobody consumes, and it is the direction that does not
   break anybody — adding an event costs nothing, removing one costs a
   customer their integration.

   ## Queued in the same transaction as the thing it describes

   `emit()` writes delivery rows, it does not send. Called from inside the
   transaction that did the thing, so either the work order exists and the
   webhook is queued or neither happened. The alternative — send after the
   transaction commits — loses events whenever the process dies in between,
   silently, and "silently" is the part that matters.

   ## The payload is frozen when it fires

   A webhook says what was true at the moment it fired. Re-deriving the body
   at send time would mean a delivery and its retry describe different states
   under the same id, and a receiver that de-duplicates on id would keep the
   wrong one. So the body is built once, stored, and sent verbatim. */
import { all, insert } from "../db.js";
import { id } from "../ids.js";
import { stamp } from "../dates.js";

export const EVENTS = {
  "work_order.raised": {
    describes: "A repair was reported, however it was reported.",
    payload: "The work order, in the shape /api/v1/work-orders returns it, plus "
      + "`emergency` when it is one.",
  },
  "work_order.completed": {
    describes: "A repair was closed out, with what it came to.",
    payload: "The work order, plus `actual_cents`.",
  },
  "payment.recorded": {
    describes: "Rent was received and reached both books.",
    payload: "The ledger entry and the journal behind it.",
  },
  "lease.signed": {
    describes: "Every party a lease document needed has signed it.",
    payload: "The document, the lease and the unit.",
  },
  "owner_approval.decided": {
    describes: "An owner approved or declined a spend above their threshold.",
    payload: "The approval, the decision, and the work order it was for.",
  },
};

export const EVENT_NAMES = Object.keys(EVENTS);

/* Queues one delivery per endpoint that wants this event.

   Returns the deliveries it created, which is what lets a test assert that
   raising a work order queued something rather than assert on a side effect
   two layers away.

   Never throws. An emit that failed would roll back the thing it describes,
   and a webhook is not worth refusing a repair over — but it is logged, and
   a delivery that was never queued is visible as its absence on the
   endpoint's own screen. */
export async function emit({ companyId, event, data, now = stamp }) {
  if (!EVENTS[event]) throw new Error(`There is no event called "${event}".`);

  try {
    const endpoints = await all(
      `SELECT id, events FROM webhook_endpoint
        WHERE company_id = ? AND active = 1 AND disabled_at IS NULL`, companyId);
    if (!endpoints.length) return [];

    const at = now();
    const body = JSON.stringify({
      /* The delivery's own id goes in the headers rather than the body: the
         body is what was signed, and a receiver should be able to compare two
         bodies for equality without the envelope getting in the way. */
      type: event,
      created_at: at,
      data,
    });

    const made = [];
    for (const endpoint of endpoints) {
      if (!wants(endpoint.events, event)) continue;
      const deliveryId = id();
      await insert("webhook_delivery", {
        id: deliveryId, company_id: companyId, endpoint_id: endpoint.id,
        event, payload: body,
        status: "pending", attempts: 0,
        /* Due immediately. The scheduler picks it up; nothing sends inside
           the request that caused it. */
        next_attempt_at: at,
        created_at: at,
      });
      made.push({ id: deliveryId, endpointId: endpoint.id });
    }
    return made;
  } catch (err) {
    console.error("[webhooks] could not queue:", err.message);
    return [];
  }
}

/* An empty list means every event. Stated rather than implied, because the
   other reading — an endpoint that wants nothing — is a row that exists and
   does nothing, which nobody creates on purpose. */
export function wants(events, event) {
  const list = parseEvents(events);
  return list.length === 0 || list.includes(event);
}

export function parseEvents(value) {
  if (Array.isArray(value)) return value.filter((e) => EVENTS[e]);
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((e) => EVENTS[e]) : [];
  } catch { return []; }
}
