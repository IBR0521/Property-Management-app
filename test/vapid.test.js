/* VAPID, and what a notification is allowed to say.

   Two halves, and the second is the one that matters most.

   **VAPID** says who is sending. The tests verify tokens we signed rather
   than checking that signing did not throw — the failure this guards against
   is a signature that is well-formed and wrong, which a push service reports
   as an unhelpful "invalid JWT" long after the code looked fine.

   **The payload rule** is that a notification is read on a lock screen, by
   whoever is holding the phone. So no payload carries money, a balance, a
   name or an address. That is enforced by a check on the finished text, not
   by discipline, because the thing being guarded against is somebody later
   adding a tenant's name to a title *because it would be more useful* — which
   it would, and which is exactly the problem. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateVapidKeys, signToken, verifyToken, audienceFor,
  authorizationHeader, TOKEN_TTL_SECONDS,
} from "../server/lib/push/vapid.js";
import { build, safePath, urgencyOf, KINDS } from "../server/lib/push/payload.js";
import { fromBase64Url } from "../server/lib/push/encrypt.js";

const SUBJECT = "mailto:ops@example.test";
const keys = generateVapidKeys();

describe("the key pair", () => {
  test("the public half is an uncompressed P-256 point", () => {
    const raw = fromBase64Url(keys.publicKey);
    assert.equal(raw.length, 65);
    assert.equal(raw[0], 0x04, "uncompressed");
  });

  test("the private half is a 32-byte scalar", () => {
    assert.equal(fromBase64Url(keys.privateKey).length, 32);
  });

  test("two calls give two different pairs", () => {
    const other = generateVapidKeys();
    assert.notEqual(other.publicKey, keys.publicKey);
  });
});

describe("a token", () => {
  test("it verifies against its own key", () => {
    /* The real check. A signature in the wrong format is well-formed and
       fails here, which is what a push service would tell us much later. */
    const token = signToken({ audience: "https://fcm.googleapis.com", subject: SUBJECT, ...keys });
    const res = verifyToken({ token, publicKey: keys.publicKey });
    assert.equal(res.ok, true);
  });

  test("it does not verify against somebody else's key", () => {
    const token = signToken({ audience: "https://fcm.googleapis.com", subject: SUBJECT, ...keys });
    const other = generateVapidKeys();
    assert.equal(verifyToken({ token, publicKey: other.publicKey }).ok, false);
  });

  test("a tampered claim breaks it", () => {
    const token = signToken({ audience: "https://fcm.googleapis.com", subject: SUBJECT, ...keys });
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({
      aud: "https://evil.example", exp: 9999999999, sub: SUBJECT,
    })).toString("base64url");
    assert.equal(verifyToken({ token: `${header}.${forged}.${signature}`, publicKey: keys.publicKey }).ok, false);
  });

  test("the signature is the 64 bytes JOSE wants, not DER", () => {
    /* DER is what ECDSA signing produces by default and what every push
       service rejects. */
    const token = signToken({ audience: "https://fcm.googleapis.com", subject: SUBJECT, ...keys });
    const signature = fromBase64Url(token.split(".")[2]);
    assert.equal(signature.length, 64);
    assert.notEqual(signature[0], 0x30, "0x30 would be a DER sequence");
  });

  test("it carries the claims a push service checks", () => {
    const now = Date.UTC(2026, 8, 23);
    const token = signToken({
      audience: "https://updates.push.services.mozilla.com", subject: SUBJECT, ...keys, now,
    });
    const { claims } = verifyToken({ token, publicKey: keys.publicKey });

    assert.equal(claims.aud, "https://updates.push.services.mozilla.com");
    assert.equal(claims.sub, SUBJECT);
    assert.equal(claims.exp, Math.floor(now / 1000) + TOKEN_TTL_SECONDS);
  });

  test("the audience is the origin, never the endpoint", () => {
    /* A JWT carrying the full path is refused, and the error says "invalid
       audience" without saying why. */
    assert.equal(
      audienceFor("https://fcm.googleapis.com/fcm/send/abc123?x=1"),
      "https://fcm.googleapis.com");
    assert.equal(
      audienceFor("https://web.push.apple.com/QAB…/long/path"),
      "https://web.push.apple.com");
  });

  test("a subject that nobody can be reached at is refused", () => {
    /* Push services mean it: it is who they contact if our messages become a
       problem. */
    for (const bad of ["", "ops@example.test", "Leafridge", "tel:6145550100"]) {
      assert.throws(
        () => signToken({ audience: "https://fcm.googleapis.com", subject: bad, ...keys }),
        /mailto: or https:/, String(bad));
    }
  });

  test("an audience that is not an origin is refused", () => {
    assert.throws(
      () => signToken({ audience: "fcm.googleapis.com", subject: SUBJECT, ...keys }),
      /is not an origin/);
  });

  test("the header is the shape a push service parses", () => {
    const header = authorizationHeader({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc", subject: SUBJECT, ...keys,
    });
    assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.ok(header.endsWith(`k=${keys.publicKey}`));
  });
});

/* --- what it is allowed to say --------------------------------------------- */

describe("a notification payload", () => {
  test("it says that something happened, not what", () => {
    const payload = build("emergency");
    assert.equal(payload.title, "Emergency job");
    assert.match(payload.body, /Open the app/);
    assert.equal(payload.url, "/app");
  });

  test("a kind nobody wrote down is refused", () => {
    /* So a new notification gets its wording read by a person rather than
       assembled at a call site. */
    assert.throws(() => build("rent_overdue_for_priya"), /is not a notification/);
  });

  test("every kind we ship is free of money, names and addresses", () => {
    /* The rule applied to the shipped wording rather than only to new
       additions. */
    for (const kind of Object.keys(KINDS)) {
      const payload = build(kind);
      const text = `${payload.title} ${payload.body}`;
      assert.ok(!/[$£€]\s*\d|\d+\.\d{2}\b/.test(text), `${kind} mentions money`);
      assert.ok(!/[^@\s]+@[^@\s]+\.[^@\s]+/.test(text), `${kind} has an address in it`);
    }
  });

  test("the guard catches money, addresses, emails and phone numbers", () => {
    /* Proving the net works, by pushing things through it that must not
       pass. The shipped kinds cannot express these, which is the point —
       this is what stops the next one. */
    const cases = [
      ["Priya owes $1,450", /money/],
      ["Rent for 412 Maple Grove Dr", /address/],
      ["Reply to priya@example.test", /email/],
      ["Call (614) 555-0200", /phone/],
    ];
    for (const [body, expected] of cases) {
      const kind = `__test_${body.length}`;
      KINDS[kind] = { title: "Test", body, url: "/app", urgency: "normal" };
      assert.throws(() => build(kind), expected, body);
      delete KINDS[kind];
    }
  });

  test("the url stays inside this application", () => {
    /* A notification that can send somebody to another origin is a
       phishing primitive that arrives with our name on it. */
    assert.equal(safePath("https://evil.example/steal"), null);
    assert.equal(safePath("//evil.example/steal"), null);
    assert.equal(safePath("/app/inbox/abc"), "/app/inbox/abc");

    const payload = build("message_received", { url: "https://evil.example" });
    assert.equal(payload.url, "/app/inbox", "it falls back to the kind's own path");
  });

  test("a tag collapses repeats on the device", () => {
    /* Five new messages should be one badge, not five buzzes. */
    assert.equal(build("message_received").tag, "message_received");
    assert.equal(build("message_received", { tag: "thread-abc" }).tag, "thread-abc");
  });

  test("an emergency is urgent and nothing else is", () => {
    assert.equal(urgencyOf("emergency"), "high");
    assert.equal(urgencyOf("message_received"), "normal");
    assert.equal(urgencyOf("nonsense"), "normal");
  });
});
