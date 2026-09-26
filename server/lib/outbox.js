/* Putting a message in the outbox.

   Twelve call sites used to build their own `insert("outbox", …)`, which was
   fine while the outbox was a table nothing read. Now that messages actually
   leave, three things have to be true of every one of them, and a rule that
   twelve call sites each have to remember is a rule that eleven of them keep.

   **Mail goes out as the company, not as the platform.** Migration 013 added
   `from_email`, `from_name`, `reply_to` and `sms_from` to `company` and
   nothing read them — so every customer's mail would have gone out from one
   platform address, which is wrong for a B2B product and ruinous for
   deliverability the first time one customer gets marked as spam.

   **An unverified company does not send.** Anyone can type an address into
   the signup form, including somebody else's. Until the person holding that
   inbox clicks a link, this company does not get to send mail to owners and
   tenants under our sending domain. The verification message itself is the
   documented exception, or a new company could never escape.

   **Every message declares whether it is transactional.** A rent notice is
   not marketing and cannot be unsubscribed from; a reminder can. The producer
   knows which; the delivery layer cannot guess. */
import { get, insert } from "./db.js";
import { id } from "./ids.js";
import { stamp } from "./dates.js";
import { EMAIL_FROM } from "./config.js";
import { asDeliverable } from "./delivery/gmail.js";
import { log } from "./logger.js";

/* The address a company types is where a reply should land. A Gmail address
   cannot be the envelope sender: Google will not let this app stamp
   gmail.com, and asking the company for an app password is a ritual standing
   between "paste the address" and "press send". The message goes out, and
   the reply goes to the address they typed. */
export function buildFrom({ name, fromName, fromEmail, replyTo, emailFrom = EMAIL_FROM } = {}) {
  const label = String(fromName || name || "").replace(/[<>"\r\n]/g, "").trim();
  const chosen = fromEmail || emailFrom || "";
  const wrapped = label && chosen ? `${label} <${chosen}>` : chosen;
  if (!chosen) return { from: null, replyTo: replyTo || null };
  return asDeliverable(wrapped, replyTo, emailFrom || chosen);
}

/* Resolved per message rather than cached, because a company changing its
   from-address should affect the next message and not the next restart. */
export async function senderFor(companyId, channel) {
  const company = await get(
    "SELECT name, from_email, from_name, reply_to, sms_from FROM company WHERE id = ?", companyId);
  if (!company) return { from: channel === "email" ? EMAIL_FROM : null, replyTo: null };

  if (channel === "sms") {
    return { from: company.sms_from || null, replyTo: null };
  }

  /* A display name makes the difference between "notices@…" and "Leafridge
     Property Management" in a tenant's inbox, which is the difference between
     mail that gets opened and mail that gets reported. */
  return buildFrom({
    name: company.name,
    fromName: company.from_name,
    fromEmail: company.from_email,
    replyTo: company.reply_to,
  });
}

/* Whether this company may send at all, and why not when it may not. */
export async function sendingBlockedReason(companyId, { allowUnverified = false } = {}) {
  if (allowUnverified) return null;
  const company = await get("SELECT verified_at, name FROM company WHERE id = ?", companyId);
  if (!company) return "no such company";
  if (!company.verified_at) {
    return "the company's email address has not been confirmed";
  }
  return null;
}

/* The one way a message enters the outbox.

   Returns the row id, or null when it was refused. Refusal is recorded as a
   suppressed row rather than dropped silently — a message that never existed
   is one nobody can explain later, and "why did the owner not get the
   approval request" is a question that gets asked. */
export async function queueMessage({
  companyId, channel, to, subject, body,
  kind = "transactional", aboutType = null, aboutId = null,
  allowUnverified = false,
}) {
  if (!companyId || !channel || !to || !body) {
    throw new Error("queueMessage needs a company, a channel, a recipient and a body");
  }

  const rowId = id();
  const blocked = await sendingBlockedReason(companyId, { allowUnverified });

  if (blocked) {
    await insert("outbox", {
      id: rowId, company_id: companyId, channel, to_contact: String(to),
      subject: subject || null, body, kind,
      about_type: aboutType, about_id: aboutId,
      status: "suppressed", last_error: blocked,
      failed_at: stamp(), queued_at: stamp(),
    });
    log.warn("message not queued", { companyId, channel, aboutType, reason: blocked });
    return null;
  }

  await insert("outbox", {
    id: rowId, company_id: companyId, channel, to_contact: String(to),
    subject: subject || null, body, kind,
    about_type: aboutType, about_id: aboutId,
    status: "queued", queued_at: stamp(),
  });
  return rowId;
}
