/* Which conversation does this belong to?

   Everything else in messaging is storage. This is the part where a mistake
   shows one tenant another tenant's correspondence, so the rules are ordered
   by how certain each signal is and the least certain one is deliberately
   refused.

     1. a reply token in the address it was sent to      certain
     2. In-Reply-To, matched against a message we sent   near certain
     3. the sender's contact plus an open thread with
        them, inside a window                            probable
     4. otherwise a new thread                            safe

   **Subject lines are never used.** "Re: Rent" from two different tenants is
   two conversations. Matching on it would merge them, and the merge is
   invisible until somebody notices they can read a stranger's mail. There is
   a test asserting this module never looks at a subject when resolving.

   Rule 3 is the only judgement call, and it is bounded two ways: the contact
   has to match exactly after normalising, and the thread has to be recent.
   Somebody who emailed about a leak in March and emails about a rent
   increase in November gets a new conversation, which is right — they are
   not the same errand. */
import { all, get, one, insert, update, run } from "./db.js";
import { id, token } from "./ids.js";
import { stamp } from "./dates.js";
import { log } from "./logger.js";
import { normalise } from "./delivery/consent.js";
import { PORTAL_REPLY_DOMAIN } from "./config.js";

/* How long an existing conversation stays the default home for a reply from
   the same person. Long enough to cover a repair that drags on, short enough
   that a new errand starts a new thread. */
export const CONTINUES_WITHIN_DAYS = 21;

/* --- the reply address ------------------------------------------------------

   `reply+<token>@domain`. The token is the whole credential for rule 1, so it
   is as long as every other token here and it identifies a thread rather than
   a person — forwarding the email gives somebody the conversation, not the
   account. */
export function replyAddress(thread) {
  if (!PORTAL_REPLY_DOMAIN || !thread?.reply_token) return null;
  return `reply+${thread.reply_token}@${PORTAL_REPLY_DOMAIN}`;
}

export function tokenFromAddress(address) {
  const m = /(?:^|[<\s])reply\+([A-Za-z0-9_-]{16,})@/.exec(String(address || ""));
  return m ? m[1] : null;
}

/* Every address a provider might report as the recipient, because an email
   reaches the reply address through To, Cc or the envelope depending on how
   it was sent and who forwarded it. */
export function tokenFromAny(values) {
  for (const value of [].concat(values || [])) {
    const found = tokenFromAddress(value);
    if (found) return found;
  }
  return null;
}

/* --- resolving --------------------------------------------------------------

   Returns { thread, rule } so the caller can record *why* a message landed
   where it did. That is worth keeping: when somebody eventually reports a
   message in the wrong place, the first question is which rule put it there.

   `companyId` may be null when nothing identifies the company yet; the caller
   resolves that first and a message with no company is not threaded at all. */
export async function resolveThread({
  companyId, channel, fromContact, toContacts = [], inReplyTo = null,
  subject = null, now = new Date(),
}) {
  /* 1. The reply token. Checked before the company is even considered,
        because the token identifies a thread outright and carries its own
        company with it. */
  const replyToken = tokenFromAny(toContacts);
  if (replyToken) {
    const byToken = await get("SELECT * FROM thread WHERE reply_token = ?", replyToken);
    if (byToken) return { thread: byToken, rule: "reply-token" };
    /* A token we issued and can no longer find means the thread was deleted.
       Falling through is right; pretending it matched is not. */
    log.warn("reply token did not resolve", { replyToken });
  }

  if (!companyId) return { thread: null, rule: "no-company" };

  /* 2. In-Reply-To, matched against something we actually sent. Matching it
        against anything at all would let a sender name any Message-ID and be
        put into that conversation. */
  if (inReplyTo) {
    const parent = await get(
      `SELECT m.* FROM message m
        WHERE m.company_id = ? AND m.message_id_header = ? AND m.direction = 'out'
        ORDER BY m.created_at DESC LIMIT 1`,
      companyId, String(inReplyTo).replace(/^<|>$/g, ""));
    if (parent) {
      const thread = await get("SELECT * FROM thread WHERE id = ?", parent.thread_id);
      if (thread) return { thread, rule: "in-reply-to" };
    }
  }

  /* 3. The same person, still talking. Exact match on the normalised contact,
        and only a conversation that is recent and not resolved. */
  const contact = normalise(channel === "sms" ? "sms" : "email", fromContact);
  if (contact) {
    const since = new Date(now.getTime() - CONTINUES_WITHIN_DAYS * 86_400_000).toISOString();
    const column = channel === "sms" ? "contact_phone" : "contact_email";
    const recent = await get(
      `SELECT * FROM thread
        WHERE company_id = ? AND ${column} = ? AND state <> 'resolved'
          AND last_message_at > ?
        ORDER BY last_message_at DESC LIMIT 1`,
      companyId, contact, since);
    if (recent) return { thread: recent, rule: "same-contact" };
  }

  /* 4. Nothing matched. A new conversation is always safe; a wrong match
        never is. `subject` is passed in only so the new thread can be named
        after it — it is never used to find an existing one. */
  return { thread: null, rule: "new" };
}

/* --- creating ---------------------------------------------------------------- */

export async function openThread({
  companyId, subject = null, channel = "email",
  fromContact = null, party = null, about = null, state = "open",
}) {
  const threadId = id();
  const contact = fromContact
    ? normalise(channel === "sms" ? "sms" : "email", fromContact) : null;

  await insert("thread", {
    id: threadId, company_id: companyId,
    subject: cleanSubject(subject),
    party_type: party?.type || "unknown",
    tenant_id: party?.tenantId || null,
    owner_id: party?.ownerId || null,
    vendor_id: party?.vendorId || null,
    person_id: party?.personId || null,
    about_type: about?.type || null,
    about_id: about?.id || null,
    contact_email: channel === "sms" ? null : contact,
    contact_phone: channel === "sms" ? contact : null,
    reply_token: token(),
    state,
    created_at: stamp(),
  });
  return await get("SELECT * FROM thread WHERE id = ?", threadId);
}

/* "Re: Re: FW: Rent" is one conversation's subject wearing four hats. Kept for
   display only — nothing matches on it. */
export function cleanSubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return null;
  return s.replace(/^((re|fw|fwd)\s*:\s*)+/i, "").trim().slice(0, 200) || null;
}

/* --- recording a message ------------------------------------------------------ */

/* Inbound. Idempotent on the provider's message id, because every provider
   delivers webhooks at least once and a replay must not duplicate what
   somebody said. */
export async function recordInbound({
  companyId, thread, channel, body, subject = null,
  fromContact, toContact = null, providerMessageId = null,
  messageIdHeader = null, inReplyTo = null, authorPersonId = null,
}) {
  if (providerMessageId) {
    const seen = await get(
      "SELECT * FROM message WHERE company_id = ? AND provider_message_id = ?",
      companyId, providerMessageId);
    if (seen) return { messageId: seen.id, duplicate: true };
  }

  const messageId = id();
  await insert("message", {
    id: messageId, company_id: companyId, thread_id: thread.id,
    direction: "in", channel,
    subject: subject ? String(subject).slice(0, 200) : null,
    body: String(body || "").slice(0, 20_000),
    from_contact: fromContact || null,
    to_contact: toContact || null,
    author_person_id: authorPersonId || null,
    message_id_header: messageIdHeader || null,
    in_reply_to: inReplyTo || null,
    provider_message_id: providerMessageId || null,
    created_at: stamp(),
  });

  /* An inbound message reopens the conversation, whatever a member of staff
     decided. Somebody who is still writing to you has not finished, and a
     reply landing silently in a resolved thread is a reply nobody reads. */
  await update("thread", thread.id, {
    last_message_at: stamp(), last_direction: "in",
    unread: 1,
    state: thread.state === "resolved" ? "open" : thread.state,
    resolved_at: null, resolved_by: null,
  });

  if (thread.state === "resolved") {
    await insert("thread_event", {
      id: id(), company_id: companyId, thread_id: thread.id, at: stamp(),
      actor: null, kind: "reopened", detail: "a reply arrived",
    });
  }

  return { messageId, duplicate: false };
}

/* Outbound. The outbox row is created by the caller and linked here, so the
   inbox shows what the outbox says about delivery rather than asserting that
   anything was sent. */
export async function recordOutbound({
  companyId, thread, channel, body, subject = null,
  toContact, authorStaffId = null, outboxId = null,
  messageIdHeader = null, isNote = false,
}) {
  const messageId = id();
  await insert("message", {
    id: messageId, company_id: companyId, thread_id: thread.id,
    direction: "out", channel: isNote ? "note" : channel,
    subject: subject ? String(subject).slice(0, 200) : null,
    body: String(body || "").slice(0, 20_000),
    to_contact: toContact || null,
    author_staff_id: authorStaffId || null,
    outbox_id: outboxId || null,
    message_id_header: messageIdHeader || null,
    created_at: stamp(),
  });

  if (outboxId) await run("UPDATE outbox SET message_id = ? WHERE id = ?", messageId, outboxId);

  /* A private note does not change whose turn it is. Only something actually
     sent moves the conversation to `waiting`. */
  if (!isNote) {
    await update("thread", thread.id, {
      last_message_at: stamp(), last_direction: "out",
      state: thread.state === "resolved" ? "waiting" : "waiting",
      unread: 0,
    });
  }

  return { messageId };
}

/* The Message-ID we put on an outbound email, so a reply's In-Reply-To can be
   matched against something we know we sent. */
export function messageIdFor(messageId, domain) {
  const host = domain || PORTAL_REPLY_DOMAIN || "localhost";
  return `${messageId}@${host}`;
}
