/* The webhook screens.

   The delivery log is the feature: "did you send it" is the first question
   every integration asks, and the only answer worth having is a record a
   customer can read themselves. So most of this is about what the screen
   admits to. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { EVENT_NAMES } from "../server/lib/webhooks/events.js";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Hook Screens Co", staffRoles: ["admin", "technician"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

const add = (fields = {}) => agent.post("/app/setup/webhooks",
  { url: "https://hooks.example.com/in", ...fields }, { csrfFrom: "/app/setup/webhooks" });

describe("adding one", () => {
  test("the secret is shown once, on the page that made it", async () => {
    const res = await add();
    const body = await res.text();
    const secret = /(whsec_[A-Za-z0-9+/=]+)/.exec(body)?.[1];
    assert.ok(secret, "the secret has to be on the page that created it");
    assert.match(body, /only time it is shown/);

    const { body: later } = await agent.text("/app/setup/webhooks");
    assert.equal(later.includes(secret), false);

    const row = await get("SELECT * FROM webhook_endpoint LIMIT 1");
    assert.equal(row.secret, secret, "we keep it because we have to sign with it");
  });

  test("http is refused, and says why", async () => {
    const res = await add({ url: "http://hooks.example.com/in" });
    assert.match(await res.text(), /has to be https/);
    assert.equal((await all("SELECT id FROM webhook_endpoint")).length, 0);
  });

  test("a private address is refused before it is ever stored", async () => {
    for (const url of ["https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/in", "https://10.0.0.1/in", "https://[::1]/in"]) {
      const res = await add({ url });
      assert.match(await res.text(), /will not send to/, `${url} was accepted`);
    }
    assert.equal((await all("SELECT id FROM webhook_endpoint")).length, 0);
  });

  test("no events ticked means all of them, and the page says so", async () => {
    await add();
    const row = await get("SELECT * FROM webhook_endpoint LIMIT 1");
    assert.equal(row.events, "[]");
    const { body } = await agent.text("/app/setup/webhooks");
    assert.match(body, /all of them/);
  });

  test("every declared event is offered, with what it carries", async () => {
    const { body } = await agent.text("/app/setup/webhooks");
    for (const name of EVENT_NAMES) {
      assert.ok(body.includes(name), `${name} is not on the form`);
    }
  });

  test("the page explains how to check a signature, because the receiver has to", async () => {
    const { body } = await agent.text("/app/setup/webhooks");
    assert.match(body, /webhook-signature/);
    assert.match(body, /id\.timestamp\.body/);
    assert.match(body, /HMAC-SHA256/);
  });
});

describe("living with them", () => {
  async function endpointWithDelivery(fields = {}, delivery = {}) {
    await add();
    const e = await get("SELECT * FROM webhook_endpoint LIMIT 1");
    if (Object.keys(fields).length) {
      await run(`UPDATE webhook_endpoint SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
        ...Object.values(fields), e.id);
    }
    const d = {
      id: id(), company_id: world.companyId, endpoint_id: e.id,
      event: "work_order.raised", payload: '{"type":"work_order.raised"}',
      status: "pending", attempts: 0, created_at: stamp(), next_attempt_at: stamp(),
      ...delivery,
    };
    await insert("webhook_delivery", d);
    return { endpoint: e, delivery: d };
  }

  test("the log says what came back and why it stopped", async () => {
    await endpointWithDelivery({}, {
      status: "failed", attempts: 2, response_status: 404,
      error: "the endpoint answered 404, which is a refusal rather than a wobble",
    });
    const { body } = await agent.text("/app/setup/webhooks");
    assert.match(body, /work_order\.raised/);
    assert.match(body, /answered 404/);
    assert.match(body, /refusal rather than a wobble/);
  });

  test("a queued one says when it will be tried again", async () => {
    await endpointWithDelivery({}, { status: "pending", attempts: 1,
      next_attempt_at: "2026-12-01T09:00:00.000Z" });
    const { body } = await agent.text("/app/setup/webhooks");
    assert.match(body, /next try/);
  });

  test("an endpoint that turned itself off says so, and can be turned back on", async () => {
    const { endpoint } = await endpointWithDelivery({
      active: 0, disabled_at: stamp(), disabled_why: "40 deliveries in a row failed.",
      consecutive_failures: 40,
    });
    let { body } = await agent.text("/app/setup/webhooks");
    assert.match(body, /40 deliveries in a row failed/);

    const res = await agent.post(`/app/setup/webhooks/${endpoint.id}/enable`, {},
      { csrfFrom: "/app/setup/webhooks" });
    assert.equal(res.status, 303);

    const after = await get("SELECT * FROM webhook_endpoint WHERE id = ?", endpoint.id);
    assert.equal(Number(after.active), 1);
    assert.equal(after.disabled_at, null);
    assert.equal(Number(after.consecutive_failures), 0,
      "turning it back on starts the count again, or it would switch off immediately");
  });

  test("removing an endpoint takes what was queued for it", async () => {
    const { endpoint } = await endpointWithDelivery();
    await agent.post(`/app/setup/webhooks/${endpoint.id}/delete`, {},
      { csrfFrom: "/app/setup/webhooks" });
    assert.equal((await all("SELECT id FROM webhook_endpoint")).length, 0);
    assert.equal((await all("SELECT id FROM webhook_delivery")).length, 0);
  });

  test("another company's endpoint cannot be removed through this", async () => {
    const other = await f.makeWorld({ name: "Not Yours Ltd" });
    const theirs = {
      id: id(), company_id: other.companyId, url: "https://theirs.example.com/in",
      secret: "whsec_x", events: "[]", active: 1, created_at: stamp(),
    };
    await insert("webhook_endpoint", theirs);

    const res = await agent.post(`/app/setup/webhooks/${theirs.id}/delete`, {},
      { csrfFrom: "/app/setup/webhooks" });
    assert.equal(res.status, 404);
    assert.ok(await get("SELECT id FROM webhook_endpoint WHERE id = ?", theirs.id));
  });
});

describe("who may reach it", () => {
  test("a technician cannot, because /app/setup needs settings.manage", async () => {
    const tech = client(app.origin);
    const signedIn = await tech.signIn(world.staff.technician.email, f.PASSWORD);
    assert.equal(signedIn.signedIn, true);
    assert.equal((await tech.get("/app/setup/webhooks")).status, 403);

    const post = await tech.post("/app/setup/webhooks",
      { url: "https://evil.example.com/in" }, { csrf: null });
    assert.ok(post.status >= 400);
    assert.equal((await all("SELECT id FROM webhook_endpoint")).length, 0);
  });

  test("it is linked from setup", async () => {
    const { body } = await agent.text("/app/setup");
    assert.match(body, /\/app\/setup\/webhooks/);
  });
});
