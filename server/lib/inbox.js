/* Filing something that arrived.

   The threading rules live in `threading.js`. This is the layer above: work
   out who sent it, find or open the conversation, and record it.

   Identifying the sender is a best effort and is treated as one. A number or
   an address that matches nobody produces a thread marked `unknown` rather
   than a message that is dropped — a tenant whose phone changed is exactly
   the person who most needs to get through, and silently discarding them is
   the worst possible failure. Staff see the conversation and can attach it to
   the right person themselves. */
import { all, get, one, insert, update, run } from "./db.js";
import { id } from "./ids.js";
import { stamp } from "./dates.js";
import { log } from "./logger.js";
import { normalise } from "./delivery/consent.js";
import {
  resolveThread, openThread, recordInbound, cleanSubject,
} from "./threading.js";

/* --- who sent it -------------------------------------------------------------

   Looked up per company, never across the platform. Two companies can each
   have a tenant at the same address — a letting agent and the landlord's own
   manager, say — and merging them would put one company's mail in another's
   inbox. */
export async function identifySender({ companyId, channel, contact }) {
  const value = normalise(channel === "sms" ? "sms" : "email", contact);
  if (!value || !companyId) return { type: "unknown" };

  const column = channel === "sms" ? "phone" : "email";
  /* Normalising both sides: a phone typed "(614) 555-0200" on a tenancy has
     to match "+16145550200" arriving from a carrier. */
  const norm = channel === "sms"
    ? `regexp_replace(lower(coalesce(${column}, '')), '[^0-9]', '', 'g')`
    : `lower(trim(coalesce(${column}, '')))`;
  const needle = channel === "sms" ? value.replace(/\D/g, "") : value;
  if (!needle) return { type: "unknown" };

  /* Phone numbers arrive with a country code that the stored one usually
     lacks, so the comparison is on the last ten digits. */
  const match = channel === "sms"
    ? `right(${norm}, 10) = right(?, 10) AND length(${norm}) >= 10`
    : `${norm} = ?`;

  const tenant = await get(
    `SELECT * FROM tenant WHERE company_id = ? AND ${match} ORDER BY created_at DESC LIMIT 1`,
    companyId, needle);
  if (tenant) {
    const person = tenant.email
      ? await get("SELECT id FROM person WHERE email = lower(trim(?))", tenant.email) : null;
    return { type: "tenant", tenantId: tenant.id, personId: person?.id || null, name: tenant.name };
  }

  const owner = await get(
    `SELECT * FROM owner WHERE company_id = ? AND ${match} ORDER BY created_at DESC LIMIT 1`,
    companyId, needle);
  if (owner) {
    const person = owner.email
      ? await get("SELECT id FROM person WHERE email = lower(trim(?))", owner.email) : null;
    return { type: "owner", ownerId: owner.id, personId: person?.id || null, name: owner.name };
  }

  const vendor = await get(
    `SELECT * FROM vendor WHERE company_id = ? AND ${match} ORDER BY created_at DESC LIMIT 1`,
    companyId, needle);
  if (vendor) return { type: "vendor", vendorId: vendor.id, name: vendor.name };

  return { type: "unknown" };
}

/* --- filing it ---------------------------------------------------------------- */

/* One inbound message: resolve the conversation, open one if there is none,
   record what was said. Returns what happened and which rule decided, because
   the first question about a misfiled message is which rule put it there. */
export async function fileInbound({
  companyId, channel, fromContact, toContacts = [], body,
  subject = null, providerMessageId = null,
  messageIdHeader = null, inReplyTo = null,
}) {
  const resolved = await resolveThread({
    companyId, channel, fromContact, toContacts, inReplyTo, subject,
  });

  let thread = resolved.thread;

  /* A reply token carries its own company, which may not be the one the
     caller guessed from a phone number. The thread's company wins. */
  const company = thread?.company_id || companyId;
  if (!company) return { ok: false, reason: "nothing identifies a company" };

  if (!thread) {
    const sender = await identifySender({ companyId: company, channel, contact: fromContact });
    thread = await openThread({
      companyId: company,
      subject: cleanSubject(subject) || defaultSubject(channel, sender),
      channel, fromContact,
      party: sender.type === "unknown" ? null : sender,
    });
    if (sender.type === "unknown") {
      log.info("inbound message from somebody we cannot place", { company, channel });
    }
  }

  const sender = thread.person_id
    ? { personId: thread.person_id } : {};

  const recorded = await recordInbound({
    companyId: company, thread, channel, body,
    subject: cleanSubject(subject),
    fromContact,
    toContact: [].concat(toContacts || [])[0] || null,
    providerMessageId, messageIdHeader, inReplyTo,
    authorPersonId: sender.personId || null,
  });

  return {
    ok: true,
    threadId: thread.id,
    messageId: recorded.messageId,
    duplicate: recorded.duplicate,
    rule: resolved.rule,
  };
}

function defaultSubject(channel, sender) {
  const who = sender?.name ? ` from ${sender.name}` : "";
  return channel === "sms" ? `Text message${who}` : `Message${who}`;
}

/* --- reading the inbox --------------------------------------------------------- */

export async function threadsFor(companyId, { state = "open", assignedTo = null, limit = 50 } = {}) {
  const clauses = ["t.company_id = ?"];
  const params = [companyId];

  if (state === "mine" && assignedTo) {
    clauses.push("t.assigned_to = ?", "t.state <> 'resolved'");
    params.push(assignedTo);
  } else if (state === "unassigned") {
    clauses.push("t.assigned_to IS NULL", "t.state <> 'resolved'");
  } else if (state && state !== "all") {
    clauses.push("t.state = ?");
    params.push(state);
  }

  return await all(
    `SELECT t.*, s.name AS assignee_name,
            COALESCE(te.name, o.name, v.name) AS party_name,
            (SELECT body FROM message m WHERE m.thread_id = t.id
              ORDER BY m.created_at DESC LIMIT 1) AS preview
       FROM thread t
       LEFT JOIN staff s ON s.id = t.assigned_to
       LEFT JOIN tenant te ON te.id = t.tenant_id
       LEFT JOIN owner o ON o.id = t.owner_id
       LEFT JOIN vendor v ON v.id = t.vendor_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY t.unread DESC, t.last_message_at DESC NULLS LAST
      LIMIT ${Number(limit)}`,
    ...params);
}

export async function threadWithMessages(companyId, threadId) {
  const thread = await get(
    `SELECT t.*, s.name AS assignee_name,
            COALESCE(te.name, o.name, v.name) AS party_name,
            COALESCE(te.email, o.email, v.email) AS party_email,
            COALESCE(te.phone, o.phone, v.phone) AS party_phone
       FROM thread t
       LEFT JOIN staff s ON s.id = t.assigned_to
       LEFT JOIN tenant te ON te.id = t.tenant_id
       LEFT JOIN owner o ON o.id = t.owner_id
       LEFT JOIN vendor v ON v.id = t.vendor_id
      WHERE t.id = ? AND t.company_id = ?`, threadId, companyId);
  if (!thread) return null;

  const [messages, events] = await Promise.all([
    all(
      `SELECT m.*, s.name AS author_name, o.status AS delivery_status, o.last_error
         FROM message m
         LEFT JOIN staff s ON s.id = m.author_staff_id
         LEFT JOIN outbox o ON o.id = m.outbox_id
        WHERE m.thread_id = ? ORDER BY m.created_at`, threadId),
    all("SELECT * FROM thread_event WHERE thread_id = ? ORDER BY at", threadId),
  ]);

  return { thread, messages, events };
}

export async function markRead(companyId, threadId) {
  await run("UPDATE thread SET unread = 0 WHERE id = ? AND company_id = ?", threadId, companyId);
}

export async function unreadCount(companyId) {
  const row = await get(
    "SELECT COUNT(*)::int AS n FROM thread WHERE company_id = ? AND unread = 1 AND state <> 'resolved'",
    companyId);
  return Number(row?.n || 0);
}

/* --- acting on one -------------------------------------------------------------- */

export async function assignThread({ companyId, threadId, staffId, by }) {
  const thread = await one(
    "SELECT * FROM thread WHERE id = ? AND company_id = ?", threadId, companyId);

  /* Checked rather than trusted: the id comes from a form, and assigning a
     conversation to somebody in another company would make it unreachable. */
  if (staffId) {
    const staff = await get(
      "SELECT id, name FROM staff WHERE id = ? AND company_id = ? AND active = 1", staffId, companyId);
    if (!staff) return { ok: false, reason: "That person is not on your team." };
    await update("thread", threadId, { assigned_to: staffId });
    await note(companyId, threadId, by, "assigned", `to ${staff.name}`);
  } else {
    await update("thread", threadId, { assigned_to: null });
    await note(companyId, threadId, by, "unassigned", null);
  }
  return { ok: true };
}

export async function resolveThreadById({ companyId, threadId, by }) {
  const thread = await one(
    "SELECT * FROM thread WHERE id = ? AND company_id = ?", threadId, companyId);
  if (thread.state === "resolved") return { ok: true, already: true };

  await update("thread", threadId, {
    state: "resolved", resolved_at: stamp(), resolved_by: by, unread: 0,
  });
  await note(companyId, threadId, by, "resolved", null);
  return { ok: true };
}

export async function reopenThread({ companyId, threadId, by }) {
  await one("SELECT * FROM thread WHERE id = ? AND company_id = ?", threadId, companyId);
  await update("thread", threadId, { state: "open", resolved_at: null, resolved_by: null });
  await note(companyId, threadId, by, "reopened", "by hand");
  return { ok: true };
}

/* Attaching a conversation to whoever it turned out to be. The common case is
   a text from a number nobody recognised. */
export async function attachParty({ companyId, threadId, party, by }) {
  await one("SELECT * FROM thread WHERE id = ? AND company_id = ?", threadId, companyId);

  const table = { tenant: "tenant", owner: "owner", vendor: "vendor" }[party.type];
  if (!table) return { ok: false, reason: "That is not somebody we can attach." };

  const row = await get(
    `SELECT id, name FROM ${table} WHERE id = ? AND company_id = ?`, party.id, companyId);
  if (!row) return { ok: false, reason: "That record is not one of yours." };

  await update("thread", threadId, {
    party_type: party.type,
    tenant_id: party.type === "tenant" ? row.id : null,
    owner_id: party.type === "owner" ? row.id : null,
    vendor_id: party.type === "vendor" ? row.id : null,
  });
  await note(companyId, threadId, by, "attached", `${party.type}: ${row.name}`);
  return { ok: true };
}

async function note(companyId, threadId, actor, kind, detail) {
  await insert("thread_event", {
    id: id(), company_id: companyId, thread_id: threadId,
    at: stamp(), actor: actor || null, kind, detail: detail || null,
  });
}
