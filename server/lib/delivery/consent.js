/* Who has said no, and how we know.

   Three ways an address stops being sendable, and they are not the same thing:

     revoked     a person replied STOP, or clicked unsubscribe
     bounced     the address does not exist
     complained  the recipient marked it as spam

   All three suppress. They are recorded separately because the remedy differs:
   a revocation is the person's decision and stands until they say otherwise, a
   bounce is a data problem somebody should fix, and a complaint is a warning
   that the sending domain is in trouble.

   Transactional mail is the exception, and only for revocation. A rent notice
   or an emergency alert is not marketing: a tenant cannot unsubscribe from
   being told their lease is ending, and pretending otherwise would break the
   notice rather than respect the tenant. A hard bounce still suppresses
   everything, because a nonexistent address receives nothing either way. */
import { get, run, insert } from "../db.js";
import { id } from "../ids.js";

const stamp = () => new Date().toISOString();

/* Stored normalised so "Bob@Example.COM " and "bob@example.com" are one row,
   and so a phone number matches whichever way it was typed. */
export function normalise(channel, contact) {
  const v = String(contact || "").trim();
  if (channel === "email") return v.toLowerCase();
  // Keep a leading + for E.164, drop everything else that is not a digit.
  const digits = v.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : digits.replace(/\D/g, "");
}

export async function stateFor(companyId, channel, contact) {
  const row = await get(
    "SELECT state, source, updated_at FROM contact_consent WHERE company_id = ? AND channel = ? AND contact = ?",
    companyId, channel, normalise(channel, contact));
  return row || null;
}

/* The question the sender asks. Returns null when it may go, or a reason when
   it may not — a reason rather than a boolean because the outbox row records
   why it was suppressed, and "false" explains nothing to whoever reads it in
   three months. */
export async function blockedReason(companyId, channel, contact, kind = "transactional") {
  const row = await stateFor(companyId, channel, contact);
  if (!row || row.state === "granted") return null;

  if (row.state === "bounced") return "the address hard-bounced";
  if (row.state === "complained") return "the recipient marked mail as spam";
  if (row.state === "revoked") {
    /* SMS revocation is absolute. A STOP reply is a carrier-level instruction
       and a legal one; there is no transactional exemption to it. */
    if (channel === "sms") return "the number replied STOP";
    if (kind === "informational") return "the recipient unsubscribed";
    return null;                  // transactional email survives an unsubscribe
  }
  return null;
}

/* Upsert, because consent changes and the history that matters is on the
   delivery_event trail rather than here. */
export async function record(companyId, channel, contact, state, source, detail = null) {
  const key = normalise(channel, contact);
  const existing = await get(
    "SELECT id FROM contact_consent WHERE company_id = ? AND channel = ? AND contact = ?",
    companyId, channel, key);

  if (existing) {
    await run(
      "UPDATE contact_consent SET state = ?, source = ?, detail = ?, updated_at = ? WHERE id = ?",
      state, source, detail, stamp(), existing.id);
    return existing.id;
  }
  const rowId = id();
  await insert("contact_consent", {
    id: rowId, company_id: companyId, channel, contact: key,
    state, source, detail, created_at: stamp(), updated_at: stamp(),
  });
  return rowId;
}

/* STOP, START and HELP as the carriers define them. Matched on the whole
   message because "please stop the leaking tap" is not an opt-out, and
   treating it as one would silently cut a tenant off from their own repair
   updates. */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

export function classifyInbound(body) {
  const word = String(body || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}
