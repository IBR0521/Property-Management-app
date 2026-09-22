/* Inbound email.

   A reply a tenant typed in their own mail client, arriving as a webhook from
   the provider's inbound parse.

   **Refused outright when unverified.** This endpoint writes into a company's
   inbox as a named tenant, so an unauthenticated version of it would let
   anybody post a message from anybody. With no secret configured it returns
   401 rather than accepting on trust — an inbound feature that is off is a
   missing feature, and one that is open is a way to impersonate a tenant.

   Transport only: the threading and the filing live in lib/threading.js and
   lib/inbox.js, so the rules that decide which conversation a reply joins are
   testable without a socket. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ready } from "../../server/lib/db.js";
import { RESEND_INBOUND_SECRET } from "../../server/lib/config.js";
import { fileInbound } from "../../server/lib/inbox.js";
import { tokenFromAny } from "../../server/lib/threading.js";
import { log } from "../../server/lib/logger.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method not allowed");
  }

  if (!RESEND_INBOUND_SECRET) {
    log.warn("inbound email refused: no RESEND_INBOUND_SECRET configured");
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, reason: "inbound email is not configured" }));
  }

  try {
    await ready();
    const rawBody = await readRaw(req);

    if (!verify(rawBody, req.headers, RESEND_INBOUND_SECRET)) {
      log.warn("rejected inbound email webhook");
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, reason: "bad signature" }));
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false }));
    }

    const result = await ingestEmail(payload);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    log.error("inbound email failed", { err });
    /* 500 so the provider retries. Losing a tenant's reply is worse than
       handling it twice, and the filing is idempotent on the message id. */
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false }));
  }
}

/* Exported so the mapping from the provider's payload onto a filed message is
   testable against a recorded fixture, which is as close to verified as this
   gets without a domain. */
export async function ingestEmail(payload) {
  const data = payload?.data || payload || {};

  const from = addressOf(data.from);
  const to = [].concat(data.to || [], data.cc || [], data.envelope?.to || [])
    .map(addressOf).filter(Boolean);

  const body = String(data.text || stripHtml(data.html) || "").trim();
  if (!from || !body) return { filed: false, reason: "nothing usable in the payload" };

  /* The company is whichever the reply token names. Without one there is
     nothing here that identifies a company — an address alone could belong to
     a tenant of two different companies — so the message is refused rather
     than guessed at. Configuring PORTAL_REPLY_DOMAIN is what turns inbound
     email on properly, and OPEN-ITEMS says so. */
  const replyToken = tokenFromAny(to);
  if (!replyToken) {
    log.warn("inbound email with no reply token", { from });
    return { filed: false, reason: "no reply token, so no company" };
  }

  return await fileInbound({
    companyId: null,
    channel: "email",
    fromContact: from,
    toContacts: to,
    body,
    subject: data.subject || null,
    providerMessageId: data.message_id || data.messageId || null,
    messageIdHeader: header(data, "message-id"),
    inReplyTo: header(data, "in-reply-to"),
  });
}

function addressOf(value) {
  if (!value) return null;
  if (Array.isArray(value)) return addressOf(value[0]);
  if (typeof value === "object") return value.address || value.email || null;
  const m = /<([^>]+)>/.exec(String(value));
  return (m ? m[1] : String(value)).trim() || null;
}

function header(data, name) {
  const headers = data.headers || {};
  if (Array.isArray(headers)) {
    const found = headers.find((h) => String(h.name || "").toLowerCase() === name);
    return found ? String(found.value).replace(/^<|>$/g, "") : null;
  }
  const value = headers[name] ?? headers[name.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())];
  return value ? String(value).replace(/^<|>$/g, "") : null;
}

/* Crude on purpose. The body is stored and displayed as text, never rendered
   as HTML, so this only has to be readable rather than faithful — and never
   rendering it is what keeps an inbound email from carrying script into a
   member of staff's browser. */
function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function verify(rawBody, headers, secret) {
  const signature = headers["x-resend-signature"] || headers["x-webhook-signature"];
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(String(signature).replace(/^sha256=/, ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error("inbound email too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
