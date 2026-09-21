/* Provider webhooks: verification, idempotency, and what they change.

   The signature algorithms have their own tests. This is about what happens
   after a request is believed: which event rows appear, which messages get
   dead-lettered, and which addresses stop being sendable. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("resend-test-secret-32-bytes-long").toString("base64");
process.env.TWILIO_AUTH_TOKEN = "twilio_test_auth_token";
process.env.APP_BASE_URL = "https://app.example.com";

const { handleResend, handleTwilio } = await import("../server/lib/delivery/webhooks.js");
const { signSvix, signTwilio } = await import("../server/lib/delivery/signatures.js");
const { freshDatabase, truncateAll, closeDb, all, get, run } = await import("./helpers/db.js");
const f = await import("./helpers/factories.js");
const { insert } = await import("../server/lib/db.js");
const { id } = await import("../server/lib/ids.js");

const SECRET = process.env.RESEND_WEBHOOK_SECRET;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_URL = "https://app.example.com/api/webhooks/twilio";

let companyId;

before(async () => {
  await freshDatabase();
  await truncateAll();
  companyId = await f.makeCompany("Webhook Co");
});

after(async () => { await closeDb(); });

beforeEach(async () => {
  await run("DELETE FROM delivery_event");
  await run("DELETE FROM contact_consent");
  await run("DELETE FROM outbox");
});

async function queueSent({ channel = "email", to = "t@example.com", providerMessageId }) {
  const rowId = id();
  await insert("outbox", {
    id: rowId, company_id: companyId, channel, to_contact: to,
    subject: "Test", body: "Body", status: "sent",
    provider: channel === "email" ? "resend" : "twilio",
    provider_message_id: providerMessageId,
    queued_at: new Date().toISOString(), sent_at: new Date().toISOString(),
  });
  return rowId;
}

function resendRequest(payload, { eventId = "msg_" + Math.random().toString(36).slice(2) } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    rawBody,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": signSvix({ id: eventId, timestamp, body: rawBody, secret: SECRET }),
    },
  };
}

function twilioRequest(params) {
  const rawBody = new URLSearchParams(params).toString();
  return {
    rawBody,
    url: TWILIO_URL,
    headers: {
      "x-twilio-signature": signTwilio({ url: TWILIO_URL, params, authToken: AUTH }),
    },
  };
}

describe("an unverified webhook changes nothing", () => {
  test("a bad Resend signature is refused and stores no event", async () => {
    const req = resendRequest({ type: "email.bounced", data: { email_id: "e1", to: ["x@y.com"] } });
    req.headers["svix-signature"] = "v1,AAAA";
    const res = await handleResend(req);
    assert.equal(res.status, 401);
    assert.equal((await all("SELECT id FROM delivery_event")).length, 0,
      "an unverified payload must not be parsed, stored or acted on");
  });

  test("a bad Twilio signature is refused", async () => {
    const req = twilioRequest({ MessageSid: "SM1", MessageStatus: "delivered" });
    req.headers["x-twilio-signature"] = "nope";
    const res = await handleTwilio(req);
    assert.equal(res.status, 401);
    assert.equal((await all("SELECT id FROM delivery_event")).length, 0);
  });
});

describe("Resend events", () => {
  test("a delivery is recorded against its message", async () => {
    const outboxId = await queueSent({ providerMessageId: "e_del_1" });
    const res = await handleResend(resendRequest({
      type: "email.delivered", data: { email_id: "e_del_1", to: ["t@example.com"] },
    }));
    assert.equal(res.status, 200);
    const ev = await get("SELECT * FROM delivery_event LIMIT 1");
    assert.equal(ev.outbox_id, outboxId);
    assert.equal(ev.company_id, companyId, "the company is resolved from the message");
    assert.equal(ev.kind, "email.delivered");
  });

  test("a hard bounce suppresses the address for everything", async () => {
    await queueSent({ providerMessageId: "e_bounce_1", to: "gone@example.com" });
    await handleResend(resendRequest({
      type: "email.bounced", data: { email_id: "e_bounce_1", to: ["gone@example.com"], reason: "no such user" },
    }));
    const { blockedReason } = await import("../server/lib/delivery/consent.js");
    assert.match(await blockedReason(companyId, "email", "gone@example.com", "transactional"), /bounce/,
      "continuing to send to a hard bounce is how a sending domain gets blocked");
  });

  test("a spam complaint suppresses the address", async () => {
    await queueSent({ providerMessageId: "e_spam_1", to: "angry@example.com" });
    await handleResend(resendRequest({
      type: "email.complained", data: { email_id: "e_spam_1", to: ["angry@example.com"] },
    }));
    const row = await get("SELECT state FROM contact_consent WHERE contact = ?", "angry@example.com");
    assert.equal(row.state, "complained");
  });

  test("a soft outcome does not suppress", async () => {
    await queueSent({ providerMessageId: "e_open_1", to: "reader@example.com" });
    await handleResend(resendRequest({
      type: "email.opened", data: { email_id: "e_open_1", to: ["reader@example.com"] },
    }));
    const row = await get("SELECT state FROM contact_consent WHERE contact = ?", "reader@example.com");
    assert.equal(row, undefined, "an open is not a reason to stop sending");
  });

  test("the same event delivered twice changes nothing the second time", async () => {
    await queueSent({ providerMessageId: "e_dup_1" });
    const req = resendRequest(
      { type: "email.delivered", data: { email_id: "e_dup_1", to: ["t@example.com"] } },
      { eventId: "msg_fixed_id" });

    const first = await handleResend(req);
    const second = await handleResend(req);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "a duplicate must return 200 so the provider stops replaying it");
    assert.equal(second.outcome, "duplicate");
    assert.equal((await all("SELECT id FROM delivery_event")).length, 1);
  });

  test("an event for a message we do not know is still stored", async () => {
    const res = await handleResend(resendRequest({
      type: "email.bounced", data: { email_id: "unknown_id", to: ["someone@example.com"] },
    }));
    assert.equal(res.status, 200);
    const ev = await get("SELECT * FROM delivery_event LIMIT 1");
    assert.equal(ev.outbox_id, null);
    assert.equal(ev.company_id, null,
      "an event thrown away is one you cannot explain later");
  });
});

describe("Twilio callbacks", () => {
  test("a terminal failure dead-letters the message", async () => {
    const outboxId = await queueSent({ channel: "sms", to: "+16145550142", providerMessageId: "SM_fail" });
    await handleTwilio(twilioRequest({
      MessageSid: "SM_fail", MessageStatus: "undelivered", To: "+16145550142", ErrorCode: "30006",
    }));
    const row = await get("SELECT status, last_error FROM outbox WHERE id = ?", outboxId);
    assert.equal(row.status, "dead",
      "the carrier has already decided; retrying is not what that means");
    assert.match(row.last_error, /undelivered/);
  });

  test("a delivered status does not dead-letter", async () => {
    const outboxId = await queueSent({ channel: "sms", to: "+16145550143", providerMessageId: "SM_ok" });
    await handleTwilio(twilioRequest({
      MessageSid: "SM_ok", MessageStatus: "delivered", To: "+16145550143",
    }));
    const row = await get("SELECT status FROM outbox WHERE id = ?", outboxId);
    assert.equal(row.status, "sent");
  });

  test("carrier error 21610 revokes consent for every future message", async () => {
    await queueSent({ channel: "sms", to: "+16145550144", providerMessageId: "SM_stop" });
    await handleTwilio(twilioRequest({
      MessageSid: "SM_stop", MessageStatus: "failed", To: "+16145550144", ErrorCode: "21610",
    }));
    const { blockedReason } = await import("../server/lib/delivery/consent.js");
    assert.ok(await blockedReason(companyId, "sms", "+16145550144"));
  });
});

describe("inbound SMS", () => {
  test("STOP revokes consent for the company that last texted them", async () => {
    await queueSent({ channel: "sms", to: "+16145550150", providerMessageId: "SM_prev" });
    const res = await handleTwilio(twilioRequest({
      MessageSid: "SM_in_1", From: "+16145550150", To: "+16145550100", Body: "STOP",
    }));
    assert.equal(res.status, 200);
    assert.equal(res.outcome, "inbound.stop");

    const { blockedReason } = await import("../server/lib/delivery/consent.js");
    assert.match(await blockedReason(companyId, "sms", "+16145550150"), /STOP/);
  });

  test("START restores it", async () => {
    await queueSent({ channel: "sms", to: "+16145550151", providerMessageId: "SM_prev2" });
    await handleTwilio(twilioRequest({
      MessageSid: "SM_in_2", From: "+16145550151", To: "+16145550100", Body: "STOP",
    }));
    await handleTwilio(twilioRequest({
      MessageSid: "SM_in_3", From: "+16145550151", To: "+16145550100", Body: "START",
    }));
    const { blockedReason } = await import("../server/lib/delivery/consent.js");
    assert.equal(await blockedReason(companyId, "sms", "+16145550151"), null);
  });

  test("a sentence containing the word stop is not an opt-out", async () => {
    await queueSent({ channel: "sms", to: "+16145550152", providerMessageId: "SM_prev3" });
    const res = await handleTwilio(twilioRequest({
      MessageSid: "SM_in_4", From: "+16145550152", To: "+16145550100",
      Body: "please stop the leaking tap in the kitchen",
    }));
    assert.equal(res.outcome, "inbound.message");

    const { blockedReason } = await import("../server/lib/delivery/consent.js");
    assert.equal(await blockedReason(companyId, "sms", "+16145550152"), null,
      "treating this as an opt-out would cut a tenant off from their own repair updates");
  });

  test("an ordinary inbound message is kept, not discarded", async () => {
    await queueSent({ channel: "sms", to: "+16145550153", providerMessageId: "SM_prev4" });
    await handleTwilio(twilioRequest({
      MessageSid: "SM_in_5", From: "+16145550153", To: "+16145550100", Body: "the boiler is fixed, thanks",
    }));
    const ev = await get("SELECT kind, detail FROM delivery_event WHERE kind = 'inbound.message'");
    assert.ok(ev);
    assert.match(ev.detail, /boiler/);
  });
});
