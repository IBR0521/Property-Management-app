/* Sending a notification, with `fetch` replaced.

   The crypto is settled against the specifications elsewhere. What is tested
   here is the behaviour around it, and most of it is about failure: a device
   that is gone, a service that is down, keys that are not configured. Those
   are the ordinary states, and the rule running through all of them is that
   **a failure to notify is never a failure of the thing being notified
   about** — an emergency work order exists whether or not a phone buzzes.

   The other rule with teeth: no notification can carry money, a name or an
   address, because it is read on a lock screen. That is tested in
   vapid.test.js against the payload builder; here it is checked again at the
   point of sending, because that is the last place it could leak. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import {
  subscribe, unsubscribe, subscriptionsFor, sendTo, notify,
  pruneDeadSubscriptions, PUSH_CONFIGURED,
} from "../server/lib/push/index.js";
import { generateVapidKeys, verifyToken } from "../server/lib/push/vapid.js";
import { VAPID_PUBLIC_KEY } from "../server/lib/config.js";
import { encryptPayload, toBase64Url } from "../server/lib/push/encrypt.js";
import { randomBytes, createECDH } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PUSH_MODULE = fileURLToPath(new URL("../server/lib/push/index.js", import.meta.url));

let world;

/* A subscription shaped like the one a browser hands over, with keys a real
   device would produce — so the encryption actually has something to work
   against rather than being skipped. */
function browserSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: toBase64Url(ecdh.getPublicKey()),
      auth: toBase64Url(randomBytes(16)),
    },
  };
}

/* A push service, replaced. Records what it was sent. */
function fakePushService({ status = 201, bodyText = "" } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response(bodyText, { status });
  };
  impl.calls = calls;
  return impl;
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Push Co" });
});

/* --- subscribing ---------------------------------------------------------------- */

describe("a device subscribing", () => {
  test("it is recorded against the person who subscribed", async () => {
    const res = await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(),
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    assert.equal(res.ok, true);

    const row = await get("SELECT * FROM push_subscription WHERE id = ?", res.subscriptionId);
    assert.equal(row.staff_id, world.staff.admin.id);
    assert.equal(row.person_id, null);
    assert.equal(row.label, "iPhone or iPad", "so they can tell their devices apart");
  });

  test("the same browser resubscribing updates rather than doubling", async () => {
    /* Two rows for one device means two buzzes for one event. */
    const subscription = browserSubscription();
    await subscribe({ companyId: world.companyId, staffId: world.staff.admin.id, subscription });
    await subscribe({ companyId: world.companyId, staffId: world.staff.admin.id, subscription });

    assert.equal((await all("SELECT id FROM push_subscription")).length, 1);
  });

  test("a subscription belongs to staff or to a person, never both", async () => {
    const person = await (async () => {
      const pid = id();
      await insert("person", { id: pid, email: "a@example.test", created_at: stamp() });
      return pid;
    })();

    await assert.rejects(() => subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id, personId: person,
      subscription: browserSubscription(),
    }), /not both/);

    await assert.rejects(() => subscribe({
      companyId: world.companyId, subscription: browserSubscription(),
    }), /not both/);
  });

  test("the database refuses one that belongs to neither", async () => {
    await assert.rejects(() => insert("push_subscription", {
      id: id(), company_id: world.companyId, endpoint: "https://x.test/1",
      p256dh: "x", auth: "y", created_at: stamp(),
    }), /subscription_belongs_to_one_actor/);
  });

  test("something that is not a subscription is refused", async () => {
    for (const bad of [
      {}, { endpoint: "not-a-url", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "https://x.test/1" },
      { endpoint: "http://x.test/1", keys: { p256dh: "a", auth: "b" } },
    ]) {
      const res = await subscribe({
        companyId: world.companyId, staffId: world.staff.admin.id, subscription: bad,
      });
      assert.equal(res.ok, false, JSON.stringify(bad));
    }
  });

  test("unsubscribing removes it", async () => {
    const subscription = browserSubscription();
    await subscribe({ companyId: world.companyId, staffId: world.staff.admin.id, subscription });
    await unsubscribe({ endpoint: subscription.endpoint });
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });
});

/* --- sending --------------------------------------------------------------------

   The suite sets a VAPID pair (see .env.test), so these drive the real path —
   encryption, headers, and what each answer from a push service means — with
   `fetch` replaced. Before the pair was set every one of these stopped at
   "push is not configured", which checked nothing. */

describe("sending", () => {
  async function subscribed(endpoint) {
    const res = await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(endpoint),
    });
    return await get("SELECT * FROM push_subscription WHERE id = ?", res.subscriptionId);
  }

  test("the keys are configured, which is what makes the rest of this real", async () => {
    assert.equal(PUSH_CONFIGURED, true);
  });

  test("the body on the wire is encrypted", async () => {
    /* The payload for this kind says "Emergency job". If that string is
       readable in what we post, the encryption is not running. */
    const row = await subscribed();
    const service = fakePushService();
    const sent = await sendTo({ subscription: row, kind: "emergency", fetchImpl: service });

    assert.equal(sent.ok, true);
    const { body } = service.calls[0];
    assert.ok(Buffer.isBuffer(body));
    assert.ok(!body.includes(Buffer.from("Emergency")), "the payload is in the clear");
    assert.equal(body.readUInt32BE(16), 4096, "record size");
    assert.equal(body.readUInt8(20), 65, "the sender's key follows");
  });

  test("the headers are the ones a push service reads", async () => {
    const row = await subscribed();
    const service = fakePushService();
    await sendTo({ subscription: row, kind: "emergency", fetchImpl: service });

    const { headers } = service.calls[0];
    assert.equal(headers["content-encoding"], "aes128gcm");
    assert.equal(headers["content-type"], "application/octet-stream");
    assert.ok(Number(headers.ttl) > 0, "without a TTL the service may hold it forever");
    assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  });

  test("the token in the header verifies, and is addressed to the right origin", async () => {
    /* A signature that is well-formed and wrong is reported by a push service
       as an unhelpful "invalid JWT" long after the code looked fine. */
    const row = await subscribed("https://updates.push.services.mozilla.com/wpush/v2/abc");
    const service = fakePushService();
    await sendTo({ subscription: row, kind: "emergency", fetchImpl: service });

    const token = /t=([^,]+)/.exec(service.calls[0].headers.authorization)[1];
    const check = verifyToken({ token, publicKey: VAPID_PUBLIC_KEY });
    assert.equal(check.ok, true);
    assert.equal(check.claims.aud, "https://updates.push.services.mozilla.com",
      "the audience is the origin, never the endpoint");
  });

  test("an emergency is sent urgent and a message is not", async () => {
    /* Urgency is what decides whether a phone wakes for it. */
    const row = await subscribed();
    const service = fakePushService();
    await sendTo({ subscription: row, kind: "emergency", fetchImpl: service });
    await sendTo({ subscription: row, kind: "message_received", fetchImpl: service });

    assert.equal(service.calls[0].headers.urgency, "high");
    assert.equal(service.calls[1].headers.urgency, "normal");
  });

  test("a success clears the failure count and records when", async () => {
    const row = await subscribed();
    await run("UPDATE push_subscription SET failures = 4, last_error = 'x' WHERE id = ?", row.id);
    await sendTo({ subscription: row, kind: "emergency", fetchImpl: fakePushService() });

    const after = await get("SELECT * FROM push_subscription WHERE id = ?", row.id);
    assert.equal(after.failures, 0);
    assert.equal(after.last_error, null);
    assert.ok(after.last_used_at, "so a dormant device can be told from a broken one");
  });

  test("a kind nobody wrote down is refused before anything is sent", async () => {
    /* The guard that stops a notification being assembled at a call site
       with a tenant's name in it. */
    const row = await subscribed();
    const service = fakePushService();
    await assert.rejects(
      () => sendTo({ subscription: row, kind: "rent_overdue_for_priya", fetchImpl: service }),
      /is not a notification/);
    assert.equal(service.calls.length, 0, "and nothing left the machine");
  });
});

describe("what a push service's answer means", () => {
  async function subscribed(endpoint) {
    const res = await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(endpoint),
    });
    return await get("SELECT * FROM push_subscription WHERE id = ?", res.subscriptionId);
  }

  for (const status of [404, 410]) {
    test(`${status} means the device is gone, so the row goes too`, async () => {
      /* Keeping it means failing forever against an endpoint that will never
         answer again. */
      const row = await subscribed();
      const sent = await sendTo({
        subscription: row, kind: "emergency",
        fetchImpl: fakePushService({ status }),
      });

      assert.equal(sent.gone, true);
      assert.equal(await get("SELECT id FROM push_subscription WHERE id = ?", row.id), undefined);
    });
  }

  test("500 is counted, not acted on — a service can be having a bad day", async () => {
    const row = await subscribed();
    await sendTo({
      subscription: row, kind: "emergency",
      fetchImpl: fakePushService({ status: 500, bodyText: "upstream unavailable" }),
    });

    const after = await get("SELECT * FROM push_subscription WHERE id = ?", row.id);
    assert.equal(after.failures, 1);
    assert.match(after.last_error, /500/);
  });

  test("a network error is counted the same way and never thrown at the caller", async () => {
    const row = await subscribed();
    const res = await sendTo({
      subscription: row, kind: "emergency",
      fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    });

    assert.equal(res.ok, false);
    const after = await get("SELECT * FROM push_subscription WHERE id = ?", row.id);
    assert.equal(after.failures, 1);
  });
});

describe("notifying a person", () => {
  test("every device they have, and nobody else's", async () => {
    const pid = id();
    await insert("person", { id: pid, email: "other@example.test", created_at: stamp() });
    for (const e of ["https://fcm.googleapis.com/fcm/send/one", "https://fcm.googleapis.com/fcm/send/two"]) {
      await subscribe({
        companyId: world.companyId, staffId: world.staff.admin.id,
        subscription: browserSubscription(e),
      });
    }
    await subscribe({
      companyId: world.companyId, personId: pid,
      subscription: browserSubscription("https://fcm.googleapis.com/fcm/send/three"),
    });

    const service = fakePushService();
    const out = await notify({ staffId: world.staff.admin.id, kind: "emergency", fetchImpl: service });

    assert.equal(out.sent, 2);
    assert.equal(service.calls.length, 2);
    assert.ok(!service.calls.some((c) => c.url.endsWith("three")), "that is somebody else's device");
  });

  test("a device that fails does not stop the others being told", async () => {
    /* The rule with teeth: a failure to notify is never a failure of the
       thing being notified about, and it is not a failure of the next device
       either. */
    for (const e of ["https://fcm.googleapis.com/fcm/send/bad", "https://fcm.googleapis.com/fcm/send/good"]) {
      await subscribe({
        companyId: world.companyId, staffId: world.staff.admin.id,
        subscription: browserSubscription(e),
      });
    }

    let first = true;
    const out = await notify({
      staffId: world.staff.admin.id, kind: "emergency",
      fetchImpl: async (url) => {
        if (first) { first = false; throw new Error("connection reset"); }
        return new Response("", { status: 201 });
      },
    });

    assert.equal(out.devices, 2);
    assert.equal(out.sent, 1);
  });

  test("notifying somebody with no devices is a no-op, not an error", async () => {
    const out = await notify({ staffId: world.staff.admin.id, kind: "emergency", fetchImpl: fakePushService() });
    assert.equal(out.sent, 0);
    assert.equal(out.configured, true);
  });
});

/* --- when a device goes away ------------------------------------------------------ */

describe("a device that is gone", () => {
  async function subscribed() {
    const res = await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(),
    });
    return await get("SELECT * FROM push_subscription WHERE id = ?", res.subscriptionId);
  }

  test("a repeatedly failing subscription is eventually swept", async () => {
    /* A push service answering 500 for a fortnight is not coming back. */
    const row = await subscribed();
    await run("UPDATE push_subscription SET failures = 25 WHERE id = ?", row.id);

    const swept = await pruneDeadSubscriptions();
    assert.equal(swept.pushSubscriptionsPruned, 1);
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });

  test("one that is merely unlucky is kept", async () => {
    const row = await subscribed();
    await run("UPDATE push_subscription SET failures = 3 WHERE id = ?", row.id);
    await pruneDeadSubscriptions();
    assert.equal((await all("SELECT id FROM push_subscription")).length, 1);
  });

  test("subscriptions are found per actor, never mixed", async () => {
    const pid = id();
    await insert("person", { id: pid, email: "a@example.test", created_at: stamp() });
    await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription("https://fcm.googleapis.com/fcm/send/staff"),
    });
    await subscribe({
      companyId: world.companyId, personId: pid,
      subscription: browserSubscription("https://fcm.googleapis.com/fcm/send/person"),
    });

    const staffDevices = await subscriptionsFor({ staffId: world.staff.admin.id });
    const personDevices = await subscriptionsFor({ personId: pid });
    assert.equal(staffDevices.length, 1);
    assert.equal(personDevices.length, 1);
    assert.notEqual(staffDevices[0].endpoint, personDevices[0].endpoint);
  });

  test("asking for nobody's subscriptions returns none rather than everybody's", async () => {
    /* The query that would otherwise notify the whole company. */
    await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(),
    });
    assert.deepEqual(await subscriptionsFor({}), []);
  });
});

/* --- with no keys at all ---------------------------------------------------- */

describe("when VAPID is not configured", () => {
  /* The suite sets a pair, which is what makes everything above real — so
     this one case runs in its own process with the keys stripped out. It is
     the state every deployment starts in, and the rule is that the
     application says so rather than offering a button that silently does
     nothing. */
  function withoutVapid(script) {
    const env = { ...process.env };
    delete env.VAPID_PUBLIC_KEY;
    delete env.VAPID_PRIVATE_KEY;
    delete env.VAPID_SUBJECT;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script],
      { env, encoding: "utf8" }).trim();
  }

  test("sending refuses, and says why, rather than reporting a success", () => {
    const out = withoutVapid(`
      const p = await import(${JSON.stringify(PUSH_MODULE)});
      const res = await p.sendTo({
        subscription: { id: "x", endpoint: "https://x.test/1", p256dh: "a", auth: "b" },
        kind: "emergency",
        fetchImpl: async () => { throw new Error("nothing should have been sent"); },
      });
      console.log(JSON.stringify({ configured: p.PUSH_CONFIGURED, ok: res.ok, reason: res.reason }));
    `);
    const res = JSON.parse(out);
    assert.equal(res.configured, false);
    assert.equal(res.ok, false);
    assert.match(res.reason, /not configured/);
  });

  test("notifying reports nothing sent rather than throwing", () => {
    const out = withoutVapid(`
      const p = await import(${JSON.stringify(PUSH_MODULE)});
      console.log(JSON.stringify(await p.notify({ staffId: "whoever", kind: "emergency" })));
    `);
    assert.deepEqual(JSON.parse(out), { sent: 0, configured: false });
  });

});
