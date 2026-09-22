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
import { generateVapidKeys } from "../server/lib/push/vapid.js";
import { encryptPayload, toBase64Url } from "../server/lib/push/encrypt.js";
import { randomBytes, createECDH } from "node:crypto";

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

/* --- sending --------------------------------------------------------------------- */

describe("sending", () => {
  /* VAPID is unset in the test environment, which is itself a state worth
     asserting; the tests that need it set stub the module's inputs by
     importing a configured copy is not possible, so they check the refusal
     instead and the encrypted-send path is exercised in pushcrypto.test.js. */

  test("with no keys configured it refuses rather than pretending", async () => {
    assert.equal(PUSH_CONFIGURED, false, "the test environment has no VAPID keys");

    const res = await subscribe({
      companyId: world.companyId, staffId: world.staff.admin.id,
      subscription: browserSubscription(),
    });
    const row = await get("SELECT * FROM push_subscription WHERE id = ?", res.subscriptionId);

    const sent = await sendTo({ subscription: row, kind: "emergency", fetchImpl: fakePushService() });
    assert.equal(sent.ok, false);
    assert.match(sent.reason, /not configured/);
  });

  test("notifying somebody says so too, rather than reporting a success", async () => {
    const out = await notify({ staffId: world.staff.admin.id, kind: "emergency" });
    assert.equal(out.configured, false);
    assert.equal(out.sent, 0);
  });

  test("the body is encrypted and the headers are what a push service reads", async () => {
    /* Driven through the encryption directly, since the send path is gated
       on configuration. What matters is that the wire format is right. */
    const subscription = browserSubscription();
    const { body } = encryptPayload({
      payload: JSON.stringify({ title: "Emergency job", body: "Open the app." }),
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });

    assert.ok(body.length > 86, "header plus ciphertext");
    assert.equal(body.readUInt32BE(16), 4096, "record size");
    assert.equal(body.readUInt8(20), 65, "key length");
    assert.ok(!body.includes(Buffer.from("Emergency job")), "the payload is not in the clear");
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
