/* Webhook signature verification.

   Verified by signing with the documented algorithm and checking the verifier
   accepts it, then breaking each input in turn and checking it does not. A
   test that only asserts against a hard-coded vector from documentation proves
   the string was copied correctly; it does not prove the thing round-trips or
   that tampering is caught.

   What this cannot prove is that my reading of each provider's documentation
   matches what their servers actually send. That needs a live webhook, and it
   is recorded as unverified in the phase report rather than assumed. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  verifySvix, verifyTwilio, signSvix, signTwilio, TOLERANCE_SECONDS,
} from "../server/lib/delivery/signatures.js";

const SECRET = "whsec_" + Buffer.from("a-thirty-two-byte-test-secret-ok").toString("base64");
const NOW = 1780000000000;                   // fixed clock, seconds below
const TS = String(Math.floor(NOW / 1000));

function svixRequest(body, { id = "msg_2abc", timestamp = TS, secret = SECRET } = {}) {
  return {
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signSvix({ id, timestamp, body, secret }),
    },
    rawBody: body,
    secret: SECRET,
    now: NOW,
  };
}

describe("Resend / Svix signatures", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });

  test("a correctly signed request is accepted", () => {
    const r = verifySvix(svixRequest(body));
    assert.equal(r.ok, true);
    assert.equal(r.eventId, "msg_2abc");
  });

  test("a tampered body is rejected", () => {
    const req = svixRequest(body);
    req.rawBody = body.replace("delivered", "bounced");
    assert.equal(verifySvix(req).ok, false);
  });

  test("a signature from a different secret is rejected", () => {
    const wrong = "whsec_" + Buffer.from("a-completely-different-secret!!!").toString("base64");
    const req = svixRequest(body, { secret: wrong });
    const r = verifySvix(req);
    assert.equal(r.ok, false);
    assert.match(r.reason, /mismatch/);
  });

  test("a replayed request outside the window is rejected", () => {
    const old = String(Math.floor(NOW / 1000) - TOLERANCE_SECONDS - 1);
    const r = verifySvix(svixRequest(body, { timestamp: old }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /tolerance/,
      "a captured request replayed later must not be indistinguishable from a real one");
  });

  test("a request from the future outside the window is rejected", () => {
    const future = String(Math.floor(NOW / 1000) + TOLERANCE_SECONDS + 1);
    assert.equal(verifySvix(svixRequest(body, { timestamp: future })).ok, false);
  });

  test("a request just inside the window is accepted", () => {
    const edge = String(Math.floor(NOW / 1000) - TOLERANCE_SECONDS + 1);
    assert.equal(verifySvix(svixRequest(body, { timestamp: edge })).ok, true);
  });

  test("missing headers are rejected rather than treated as unsigned", () => {
    for (const drop of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const req = svixRequest(body);
      delete req.headers[drop];
      const r = verifySvix(req);
      assert.equal(r.ok, false, `${drop} missing must fail`);
      assert.match(r.reason, /missing/);
    }
  });

  test("no configured secret fails closed", () => {
    const req = svixRequest(body);
    req.secret = null;
    const r = verifySvix(req);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no signing secret/);
  });

  test("several signatures are accepted if any matches, for key rotation", () => {
    const req = svixRequest(body);
    const good = req.headers["svix-signature"];
    req.headers["svix-signature"] = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good}`;
    assert.equal(verifySvix(req).ok, true);
  });

  test("an unknown signature version alone is not enough", () => {
    const req = svixRequest(body);
    req.headers["svix-signature"] = req.headers["svix-signature"].replace("v1,", "v2,");
    assert.equal(verifySvix(req).ok, false);
  });

  test("header casing does not matter", () => {
    const req = svixRequest(body);
    req.headers = {
      "Svix-Id": req.headers["svix-id"],
      "SVIX-TIMESTAMP": req.headers["svix-timestamp"],
      "Svix-Signature": req.headers["svix-signature"],
    };
    assert.equal(verifySvix(req).ok, true);
  });
});

describe("Twilio signatures", () => {
  const AUTH = "test_auth_token_0123456789abcdef";
  const URL_ = "https://app.example.com/api/webhooks/twilio";
  const params = { MessageSid: "SM1", MessageStatus: "delivered", To: "+16145550142" };

  const signed = (overrides = {}) => ({
    url: URL_, params, authToken: AUTH,
    signature: signTwilio({ url: URL_, params, authToken: AUTH }),
    ...overrides,
  });

  test("a correctly signed request is accepted", () => {
    assert.equal(verifyTwilio(signed()).ok, true);
  });

  test("parameter order does not change the signature", () => {
    const reordered = { To: params.To, MessageSid: params.MessageSid, MessageStatus: params.MessageStatus };
    assert.equal(verifyTwilio(signed({ params: reordered })).ok, true);
  });

  test("a changed parameter is rejected", () => {
    const tampered = { ...params, MessageStatus: "failed" };
    assert.equal(verifyTwilio(signed({ params: tampered })).ok, false);
  });

  test("an added parameter is rejected", () => {
    assert.equal(verifyTwilio(signed({ params: { ...params, Extra: "1" } })).ok, false);
  });

  test("a different URL is rejected", () => {
    /* The usual production failure: behind a proxy the app sees http and an
       internal host while Twilio signed https and the public one. */
    assert.equal(verifyTwilio(signed({ url: "http://app.example.com/api/webhooks/twilio" })).ok, false);
    assert.equal(verifyTwilio(signed({ url: URL_ + "?x=1" })).ok, false);
  });

  test("a wrong auth token is rejected", () => {
    assert.equal(verifyTwilio(signed({ authToken: "another_token_entirely_0000000" })).ok, false);
  });

  test("a missing signature fails closed", () => {
    const r = verifyTwilio(signed({ signature: null }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing/);
  });

  test("no auth token fails closed", () => {
    const r = verifyTwilio(signed({ authToken: null }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /no auth token/);
  });
});
