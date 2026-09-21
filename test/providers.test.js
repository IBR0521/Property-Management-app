/* The Resend and Twilio adapters.

   No credentials and no network. `fetch` is replaced, so what is under test is
   the part that is actually ours: the request we build, and the judgement
   about which failures are worth retrying. Getting that judgement wrong in one
   direction retries a malformed address five times; in the other it drops a
   rent notice because the provider hiccupped once.

   Environment is set before the dynamic imports, because config.js reads it at
   module load — which is the point of config.js. node:test gives each file its
   own process, so this does not leak into any other test. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
process.env.RESEND_API_KEY = "re_test_key";
process.env.EMAIL_FROM = "Leafridge <notices@leafridge.test>";
process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
process.env.TWILIO_FROM_NUMBER = "+16145550100";
process.env.APP_BASE_URL = "https://app.example.com";

const resend = await import("../server/lib/delivery/resend.js");
const twilio = await import("../server/lib/delivery/twilio.js");

let calls;
const realFetch = globalThis.fetch;

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(responder) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const { status = 200, json = {} } = responder({ url: String(url), opts }) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

describe("Resend", () => {
  test("a successful send returns the provider's id", async () => {
    stubFetch(() => ({ status: 200, json: { id: "e_abc123" } }));
    const r = await resend.send({ to: "t@example.com", subject: "Rent due", body: "Hello" });
    assert.equal(r.ok, true);
    assert.equal(r.providerMessageId, "e_abc123");
  });

  test("the request carries auth, the sender and plain text", async () => {
    stubFetch(() => ({ status: 200, json: { id: "e1" } }));
    await resend.send({ to: "t@example.com", subject: "Subject", body: "Line one" });

    const [call] = calls;
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.opts.headers.authorization, "Bearer re_test_key");
    const sent = JSON.parse(call.opts.body);
    assert.equal(sent.from, "Leafridge <notices@leafridge.test>");
    assert.deepEqual(sent.to, ["t@example.com"]);
    assert.equal(sent.text, "Line one");
    assert.ok(!("html" in sent),
      "every message here is plain text; sending HTML would mean escaping tenant text into markup for nothing");
  });

  test("a validation error is permanent", async () => {
    stubFetch(() => ({ status: 422, json: { name: "validation_error", message: "Invalid `to`" } }));
    const r = await resend.send({ to: "not-an-address", subject: "x", body: "y" });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false, "retrying a malformed address buries the errors worth reading");
  });

  test("rate limiting and server errors are retryable", async () => {
    for (const status of [429, 500, 502, 503]) {
      stubFetch(() => ({ status, json: { message: "later" } }));
      const r = await resend.send({ to: "t@example.com", subject: "x", body: "y" });
      assert.equal(r.retryable, true, `${status} means slow down or not our fault, not stop`);
    }
  });

  test("an unreachable provider is retryable, not a rejection", async () => {
    globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    const r = await resend.send({ to: "t@example.com", subject: "x", body: "y" });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.error, /unreachable/);
  });

  test("an unknown error name defaults to retryable", async () => {
    stubFetch(() => ({ status: 400, json: { name: "something_new", message: "?" } }));
    const r = await resend.send({ to: "t@example.com", subject: "x", body: "y" });
    assert.equal(r.retryable, true,
      "an unseen code is more likely transient than permanent, and the attempt limit bounds the cost");
  });
});

describe("Twilio", () => {
  test("a successful send returns the message sid", async () => {
    stubFetch(() => ({ status: 201, json: { sid: "SM123", status: "queued" } }));
    const r = await twilio.send({ to: "+16145550142", body: "Emergency at 1 Test St" });
    assert.equal(r.ok, true);
    assert.equal(r.providerMessageId, "SM123");
  });

  test("the request is form-encoded with basic auth and a status callback", async () => {
    stubFetch(() => ({ status: 201, json: { sid: "SM1" } }));
    await twilio.send({ to: "+16145550142", body: "Hello" });

    const [call] = calls;
    assert.match(call.url, /Accounts\/ACtest0+\/Messages\.json$/);
    assert.equal(call.opts.headers["content-type"], "application/x-www-form-urlencoded");
    const expectedAuth = "Basic " + Buffer.from("ACtest0000000000000000000000000000:test_auth_token").toString("base64");
    assert.equal(call.opts.headers.authorization, expectedAuth);

    const form = new URLSearchParams(call.opts.body);
    assert.equal(form.get("To"), "+16145550142");
    assert.equal(form.get("From"), "+16145550100");
    assert.equal(form.get("Body"), "Hello");
    assert.equal(form.get("StatusCallback"), "https://app.example.com/api/webhooks/twilio",
      "without a callback, 'accepted' is the last thing we ever learn — and accepted is not delivered");
  });

  test("a landline or invalid number is permanent", async () => {
    for (const code of [21211, 21214, 21614]) {
      stubFetch(() => ({ status: 400, json: { code, message: "bad number" } }));
      const r = await twilio.send({ to: "+16145550142", body: "x" });
      assert.equal(r.retryable, false, `${code} will never succeed`);
    }
  });

  test("a STOP opt-out is permanent and surfaces as a carrier opt-out", async () => {
    stubFetch(() => ({ status: 400, json: { code: 21610, message: "unsubscribed recipient" } }));
    const r = await twilio.send({ to: "+16145550142", body: "x" });
    assert.equal(r.retryable, false);
    assert.equal(r.carrierOptOut, true,
      "the number should stop being tried across every future message, not just this one");
  });

  test("server errors and rate limits are retryable", async () => {
    for (const status of [429, 500, 503]) {
      stubFetch(() => ({ status, json: { code: 20429, message: "slow down" } }));
      const r = await twilio.send({ to: "+16145550142", body: "x" });
      assert.equal(r.retryable, true);
    }
  });

  test("an unreachable provider is retryable", async () => {
    globalThis.fetch = async () => { throw new Error("socket hang up"); };
    const r = await twilio.send({ to: "+16145550142", body: "x" });
    assert.equal(r.retryable, true);
    assert.match(r.error, /unreachable/);
  });
});
