/* Sending a notification to a device.

   The crypto is in `encrypt.js` and `vapid.js` and is checked against the
   specifications. This is the part around it: who is subscribed, what
   happened when we tried, and when to stop trying.

   Three rules shape it.

   **A dead subscription is deleted, not retried.** A push service answering
   404 or 410 is saying this device is gone — the browser was uninstalled, the
   person cleared their data, the subscription expired. Keeping the row means
   failing forever against an endpoint that will never answer, and there is no
   history in it worth holding.

   **A failure to notify is never a failure of the thing being notified
   about.** An emergency work order is created whether or not a phone buzzes.
   Every send is best effort, errors are logged and swallowed, and nothing
   here is inside a caller's transaction.

   **Push is off unless it is fully configured.** Unset keys mean every screen
   says so rather than offering a button that silently does nothing. */
import { all, get, one, insert, update, run } from "../db.js";
import { id } from "../ids.js";
import { stamp } from "../dates.js";
import { log } from "../logger.js";
import {
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_CONFIGURED,
} from "../config.js";
import { encryptPayload } from "./encrypt.js";
import { authorizationHeader } from "./vapid.js";
import { build, urgencyOf } from "./payload.js";

export { PUSH_CONFIGURED };
export const publicKey = () => VAPID_PUBLIC_KEY || null;

/* What a push service says when the device is gone for good. */
const GONE = new Set([404, 410]);

/* --- subscribing -------------------------------------------------------------- */

export async function subscribe({
  companyId, staffId = null, personId = null, subscription, userAgent = null,
}) {
  if (Boolean(staffId) === Boolean(personId)) {
    throw new Error("A subscription belongs to a member of staff or to a person, not both.");
  }

  const endpoint = String(subscription?.endpoint || "");
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;

  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return { ok: false, reason: "That is not a usable subscription." };
  }

  /* The same browser resubscribing gives the same endpoint. Updating rather
     than inserting is what stops one device getting two of every buzz. */
  const existing = await get("SELECT * FROM push_subscription WHERE endpoint = ?", endpoint);
  if (existing) {
    await update("push_subscription", existing.id, {
      company_id: companyId, staff_id: staffId, person_id: personId,
      p256dh, auth, user_agent: String(userAgent || "").slice(0, 200),
      failures: 0, last_error: null,
    });
    return { ok: true, subscriptionId: existing.id, updated: true };
  }

  const subscriptionId = id();
  await insert("push_subscription", {
    id: subscriptionId, company_id: companyId,
    staff_id: staffId, person_id: personId,
    endpoint, p256dh, auth,
    label: deviceLabel(userAgent),
    user_agent: String(userAgent || "").slice(0, 200),
    created_at: stamp(),
  });
  return { ok: true, subscriptionId };
}

export async function unsubscribe({ endpoint }) {
  const r = await run("DELETE FROM push_subscription WHERE endpoint = ?", String(endpoint || ""));
  return { ok: true, removed: r.changes };
}

export async function subscriptionsFor({ staffId = null, personId = null }) {
  if (staffId) {
    return await all("SELECT * FROM push_subscription WHERE staff_id = ?", staffId);
  }
  if (personId) {
    return await all("SELECT * FROM push_subscription WHERE person_id = ?", personId);
  }
  return [];
}

/* Enough to tell one device from another on a screen listing them. Not
   parsing the user agent properly: this only has to let somebody recognise
   which of their own phones to remove. */
function deviceLabel(userAgent) {
  const ua = String(userAgent || "");
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Android/.test(ua)) return "Android device";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "A device";
}

/* --- sending -------------------------------------------------------------------

   `fetch` is injected so the whole path can be exercised without a network
   and without a real push service, which is the only way any of this is
   testable before real keys exist. */
export async function sendTo({ subscription, kind, url = null, tag = null, fetchImpl = fetch }) {
  if (!PUSH_CONFIGURED) return { ok: false, reason: "push is not configured" };

  /* Built through `build`, which refuses anything carrying money, a name or
     an address. There is no path here that sends arbitrary text. */
  const payload = build(kind, { url, tag });

  const { body } = encryptPayload({
    payload: JSON.stringify(payload),
    p256dh: subscription.p256dh,
    auth: subscription.auth,
  });

  const headers = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    "content-length": String(body.length),
    /* Twelve hours. A notification about an emergency is worthless tomorrow,
       and telling the push service so means it stops trying. */
    ttl: "43200",
    urgency: urgencyOf(kind),
    authorization: authorizationHeader({
      endpoint: subscription.endpoint,
      subject: VAPID_SUBJECT,
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: VAPID_PRIVATE_KEY,
    }),
  };

  let res;
  try {
    res = await fetchImpl(subscription.endpoint, {
      method: "POST", headers, body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    await noteFailure(subscription, String(err.message).slice(0, 200));
    return { ok: false, reason: err.message };
  }

  if (res.status >= 200 && res.status < 300) {
    await run(
      "UPDATE push_subscription SET last_used_at = ?, failures = 0, last_error = NULL WHERE id = ?",
      stamp(), subscription.id);
    return { ok: true, status: res.status };
  }

  if (GONE.has(res.status)) {
    /* The device is gone. Deleting is the whole response: keeping it means
       failing forever against an endpoint that will never answer again. */
    await run("DELETE FROM push_subscription WHERE id = ?", subscription.id);
    log.info("push subscription is gone, removed", { status: res.status });
    return { ok: false, gone: true, status: res.status };
  }

  const detail = await res.text().catch(() => "");
  await noteFailure(subscription, `${res.status} ${detail}`.slice(0, 200));
  return { ok: false, status: res.status, reason: detail || `status ${res.status}` };
}

async function noteFailure(subscription, reason) {
  await run(
    "UPDATE push_subscription SET failures = failures + 1, last_error = ? WHERE id = ?",
    reason, subscription.id);
}

/* --- notifying somebody ---------------------------------------------------------

   Every device they have, and never a reason for the caller to care whether
   it worked. A repair does not stop being reported because a phone was off. */
export async function notify({ staffId = null, personId = null, kind, url = null, tag = null, fetchImpl }) {
  if (!PUSH_CONFIGURED) return { sent: 0, configured: false };

  const subscriptions = await subscriptionsFor({ staffId, personId });
  let sent = 0;
  let gone = 0;

  for (const subscription of subscriptions) {
    try {
      const res = await sendTo({ subscription, kind, url, tag, fetchImpl });
      if (res.ok) sent += 1;
      if (res.gone) gone += 1;
    } catch (err) {
      /* Swallowed on purpose. Whatever this was about happened regardless. */
      log.warn("could not push", { reason: String(err.message).slice(0, 160) });
    }
  }

  return { sent, gone, devices: subscriptions.length, configured: true };
}

/* Subscriptions that have failed repeatedly without ever being told they are
   gone — a push service that has been answering 500 for a fortnight, or an
   endpoint that no longer resolves. Swept by the scheduler so the table does
   not fill with devices nobody holds. */
export async function pruneDeadSubscriptions({ failureLimit = 20 } = {}) {
  const r = await run("DELETE FROM push_subscription WHERE failures >= ?", failureLimit);
  return { pushSubscriptionsPruned: r.changes };
}
