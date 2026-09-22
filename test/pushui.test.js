/* Turning notifications on and off, over HTTP.

   Two things are being checked here and they pull in opposite directions.

   **Subscribing needs a script**, because `pushManager.subscribe()` has no
   HTML equivalent. That is a concession, and it is bounded: the list of
   devices and the button that stops each one are plain forms. Being able to
   turn something off must never depend on a script loading, and there is a
   test for exactly that.

   **A subscription is a capability to put text on somebody's lock screen.**
   So the tests lean on who may create and destroy one: not without a session,
   not without a CSRF token, and never somebody else's. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { stamp } from "../server/lib/dates.js";
import { linkTenant, personByEmail } from "../server/lib/identity.js";
import { requestLink } from "../server/lib/magiclink.js";
import { toBase64Url } from "../server/lib/push/encrypt.js";
import { notificationsPanel } from "../server/features/push.js";
import { randomBytes, createECDH } from "node:crypto";

const EMAIL = "priya@example.test";
let app, world;

function browserSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
  };
}

/* The subscribe endpoints take JSON, because that is what a browser posts
   from `fetch`. The CSRF token travels in the body like it does in a form. */
async function postJson(agent, path, payload, csrf) {
  return await agent.raw(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _csrf: csrf, ...payload }),
  });
}

async function staffAgent() {
  const c = client(app.origin);
  await c.signIn(world.staff.admin.email, f.PASSWORD);
  return c;
}

async function personAgent(email = EMAIL) {
  const c = client(app.origin);
  const link = await requestLink({ email, ip: "1.1.1.1", baseUrl: app.origin });
  assert.equal(link.delivered, true);
  await c.get(`/portal/enter/${link.secret}`);
  return c;
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Notify Co", staffRoles: ["admin", "manager"] });
  await run("UPDATE company SET verified_at = ? WHERE id = ?", stamp(), world.companyId);
});

/* --- the key -------------------------------------------------------------- */

describe("the public key", () => {
  test("anybody may read it, because every browser that subscribes is given it", async () => {
    const res = await client(app.origin).get("/push/key");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true, "the suite sets a pair");
    assert.ok(body.key.length > 80, "an uncompressed P-256 point, base64url");
  });

  test("it is the public half and never the private one", async () => {
    /* Serving the private key here would let anybody send notifications as
       this deployment. */
    const { body } = await client(app.origin).text("/push/key");
    const { VAPID_PRIVATE_KEY } = await import("../server/lib/config.js");
    assert.ok(!body.includes(VAPID_PRIVATE_KEY));
  });
});

/* --- subscribing ---------------------------------------------------------- */

describe("a staff member subscribing", () => {
  test("it is recorded against them", async () => {
    const c = await staffAgent();
    const csrf = await c.csrf("/app/account");
    const res = await postJson(c, "/app/push/subscribe",
      { subscription: browserSubscription() }, csrf);

    assert.equal(res.status, 200);
    const row = await get("SELECT * FROM push_subscription");
    assert.equal(row.staff_id, world.staff.admin.id);
    assert.equal(row.person_id, null);
    assert.equal(row.company_id, world.companyId);
  });

  test("not without a session", async () => {
    const res = await postJson(client(app.origin), "/app/push/subscribe",
      { subscription: browserSubscription() }, "anything");
    assert.ok(res.status === 303 || res.status === 403, `got ${res.status}`);
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });

  test("not without a CSRF token", async () => {
    /* Otherwise any site could subscribe its own endpoint against a signed-in
       staff member and receive their notifications. */
    const c = await staffAgent();
    const res = await postJson(c, "/app/push/subscribe",
      { subscription: browserSubscription() }, "not-the-token");
    assert.equal(res.status, 403);
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });

  test("something that is not a subscription is refused with a reason", async () => {
    const c = await staffAgent();
    const csrf = await c.csrf("/app/account");
    const res = await postJson(c, "/app/push/subscribe",
      { subscription: { endpoint: "http://not-https.test/x" } }, csrf);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });
});

describe("a tenant subscribing", () => {
  beforeEach(async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", EMAIL, world.tenantId);
    await linkTenant({ tenantId: world.tenantId });
  });

  test("it is recorded against the person, never a staff id", async () => {
    const person = await personByEmail(EMAIL);
    const c = await personAgent();
    const csrf = await c.csrf("/portal/details");
    const res = await postJson(c, "/portal/push/subscribe",
      { subscription: browserSubscription() }, csrf);

    assert.equal(res.status, 200);
    const row = await get("SELECT * FROM push_subscription");
    assert.equal(row.person_id, person.id);
    assert.equal(row.staff_id, null, "a tenant on a staff id would get staff notifications");
  });

  test("not without a portal session", async () => {
    const res = await postJson(client(app.origin), "/portal/push/subscribe",
      { subscription: browserSubscription() }, "anything");
    assert.ok(res.status === 303 || res.status === 403, `got ${res.status}`);
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });
});

/* --- stopping ------------------------------------------------------------- */

describe("stopping a device", () => {
  async function subscribedStaff() {
    const c = await staffAgent();
    const csrf = await c.csrf("/app/account");
    await postJson(c, "/app/push/subscribe", { subscription: browserSubscription() }, csrf);
    return { c, row: await get("SELECT * FROM push_subscription") };
  }

  test("it is a plain form, so it works with no script at all", async () => {
    /* The point of the whole split. Turning something on may need
       JavaScript; turning it off may not. */
    const { c, row } = await subscribedStaff();
    const { body } = await c.text("/app/account");

    assert.match(body, /action="\/app\/push\/remove"/);
    assert.match(body, new RegExp(`name="id" value="${row.id}"`));

    const res = await c.post("/app/push/remove", { id: row.id }, { csrfFrom: "/app/account" });
    assert.equal(res.status, 303);
    assert.equal((await all("SELECT id FROM push_subscription")).length, 0);
  });

  test("a colleague's device is not theirs to stop", async () => {
    /* Scoped in the DELETE itself rather than fetched, checked and then
       deleted — the two-step version is one forgotten `if` from letting
       anybody in the company silence anybody else. */
    const { row } = await subscribedStaff();

    const colleague = client(app.origin);
    const signedIn = await colleague.signIn(world.staff.manager.email, f.PASSWORD);
    assert.equal(signedIn.signedIn, true);

    const res = await colleague.post("/app/push/remove", { id: row.id },
      { csrfFrom: "/app/account" });

    assert.equal(res.status, 303, "it redirects either way, and says nothing about what exists");
    assert.equal((await all("SELECT id FROM push_subscription")).length, 1, "and removes nothing");

    /* And the owner can still stop their own. */
    const mine = await subscribedStaff();
    await mine.c.post("/app/push/remove", { id: mine.row.id }, { csrfFrom: "/app/account" });
    assert.equal((await all("SELECT id FROM push_subscription WHERE id = ?", mine.row.id)).length, 0);
  });

  test("a tenant cannot stop a staff device", async () => {
    const { row } = await subscribedStaff();
    await run("UPDATE tenant SET email = ? WHERE id = ?", EMAIL, world.tenantId);
    await linkTenant({ tenantId: world.tenantId });

    const c = await personAgent();
    await c.post("/portal/push/remove", { id: row.id }, { csrfFrom: "/portal/details" });
    assert.equal((await all("SELECT id FROM push_subscription")).length, 1);
  });
});

/* --- what the panel says -------------------------------------------------- */

describe("the panel", () => {
  test("it lists the device by a name somebody can recognise", async () => {
    const c = await staffAgent();
    const csrf = await c.csrf("/app/account");
    await c.raw("/app/push/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      },
      body: JSON.stringify({ _csrf: csrf, subscription: browserSubscription() }),
    });

    const { body } = await c.text("/app/account");
    assert.match(body, /iPhone or iPad/, "so they can tell their devices apart");
  });

  test("it never promises anything a notification will not contain", async () => {
    const c = await staffAgent();
    const { body } = await c.text("/app/account");
    assert.match(body, /never what/, "the lock-screen rule should be said, not assumed");
  });

  test("with no keys set it says so rather than offering a dead button", async () => {
    /* The delivery-honesty rule applied to a feature: a button that
       subscribes a device nothing can ever send to is worse than no button. */
    const off = await notificationsPanel({
      csrf: "x", staffId: world.staff.admin.id, base: "/app/push", configured: false,
    });
    const text = String(off);
    assert.match(text, /Not switched on yet/);
    assert.ok(!/data-push-enable/.test(text), "there must be nothing to click");
  });

  test("the button is hidden by a style, because `hidden` does not work here", async () => {
    /* Found by looking at the page rather than by reasoning about it. `.pill`
       sets `display:inline-flex`, which beats the browser's own
       `[hidden] { display: none }` — so the attribute is inert on every pill
       in this application, and the result was "notifications are blocked for
       this site" printed directly above a button offering to turn them on.

       The stylesheet has no `[hidden]` rule to lean on, so the markup has to
       carry the display itself. */
    const c = await staffAgent();
    const { body } = await c.text("/app/account");
    const button = /<button[^>]*data-push-enable[^>]*>/.exec(body)[0];

    assert.match(button, /style="[^"]*display:none/);
    assert.ok(!/\shidden(\s|>|=)/.test(button), "the hidden attribute would do nothing");
  });

  test("the script is external, so the policy is untouched", async () => {
    const c = await staffAgent();
    const { res, body } = await c.text("/app/account");
    assert.match(body, /<script src="\/app-assets\/js\/push\.js"/);
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(body), "an inline script would need unsafe-inline");
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  });
});
