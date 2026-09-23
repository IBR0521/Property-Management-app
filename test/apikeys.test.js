/* The screens that issue keys.

   The security property this file holds is the absence of a field. There is
   no "who should hold this key": if a manager could issue a key held by an
   administrator, the manager would be holding an administrator's credential —
   a privilege escalation with a form in front of it. Tying the holder to the
   issuer removes the question rather than answering it carefully, and a test
   is what stops somebody adding the convenience back. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { authenticate } from "../server/lib/api/keys.js";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Keys Co", staffRoles: ["admin", "manager", "leasing", "technician"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* The POST renders the key rather than redirecting, so the body is the page. */
async function makeKey(as = agent, fields = {}) {
  const res = await as.post("/app/setup/api",
    { name: "Zapier", scopes: ["portfolio:read"], ...fields },
    { csrfFrom: "/app/setup/api" });
  const body = await res.text();
  const m = /(pmk_[A-Za-z0-9_-]+)/.exec(body);
  return { res, body, key: m ? m[1] : null };
}

describe("issuing", () => {
  test("the key is shown once, and only in the response that made it", async () => {
    const { res, body, key } = await makeKey();
    assert.equal(res.status, 200);
    assert.ok(key, "the key has to be on the page that created it");
    assert.match(body, /only time it is shown/);

    /* And never again. */
    const { body: later } = await agent.text("/app/setup/api");
    assert.equal(later.includes(key), false, "a key on a page that can be reloaded is a key "
      + "in the browser's history and in our access log");
  });

  test("it works", async () => {
    const { key } = await makeKey();
    const auth = await authenticate(`Bearer ${key}`);
    assert.equal(auth.ok, true);
    assert.deepEqual(auth.key.scopes, ["portfolio:read"]);
    assert.equal(auth.staff.id, world.staff.admin.id);
  });

  test("it is held by whoever made it, and there is no way to say otherwise", async () => {
    const managerAgent = client(app.origin);
    await managerAgent.signIn(world.staff.manager.email, f.PASSWORD);

    const { body } = await managerAgent.text("/app/setup/api");
    assert.doesNotMatch(body, /name="staff_id"/,
      "a form field choosing the holder is a way to borrow somebody's account");

    /* And sending one anyway changes nothing. */
    const res = await managerAgent.post("/app/setup/api",
      { name: "sneaky", scopes: ["portfolio:read"], staff_id: world.staff.admin.id },
      { csrfFrom: "/app/setup/api" });
    const key = /(pmk_[A-Za-z0-9_-]+)/.exec(await res.text())?.[1];
    const auth = await authenticate(`Bearer ${key}`);
    assert.equal(auth.staff.id, world.staff.manager.id,
      "the holder is the issuer, whatever the form said");
  });

  test("a key with no name or no scopes is refused, and nothing is written", async () => {
    const noName = await agent.post("/app/setup/api",
      { name: "", scopes: ["portfolio:read"] }, { csrfFrom: "/app/setup/api" });
    assert.match(await noName.text(), /needs a name/);

    const noScopes = await agent.post("/app/setup/api",
      { name: "x" }, { csrfFrom: "/app/setup/api" });
    assert.match(await noScopes.text(), /at least one/);

    assert.equal((await all("SELECT id FROM api_key")).length, 0);
  });

  test("every scope is offered to everybody who can reach this page — today", async () => {
    /* The form greys out a scope the issuer's own role cannot back, and that
       branch does not render for anybody, because the two roles that hold
       `settings.manage` also hold every capability a scope is capped by.

       Asserted rather than left implicit, and asserted this way round: the
       day somebody adds a role that can reach Setup and cannot, say, write
       money, this fails and points at the screen that has to handle it. */
    const { capabilitiesFor } = await import("../server/lib/auth.js");
    const { SCOPES } = await import("../server/lib/api/scopes.js");

    const canReachSetup = ["admin", "manager", "accountant", "leasing", "maintenance", "technician"]
      .filter((role) => capabilitiesFor(role).has("settings.manage"));
    assert.deepEqual(canReachSetup, ["admin", "manager"]);

    for (const role of canReachSetup) {
      for (const [name, scope] of Object.entries(SCOPES)) {
        assert.ok(capabilitiesFor(role).has(scope.capability),
          `a ${role} cannot back ${name}, so the greyed-out branch now renders and needs a test`);
      }
    }

    const { body } = await agent.text("/app/setup/api");
    for (const name of Object.keys(SCOPES)) {
      assert.ok(body.includes(name), `${name} is not on the form`);
    }
    assert.doesNotMatch(body, /does not have this/);
  });
});

describe("living with them", () => {
  test("the list says what a key can do today, not what it was given", async () => {
    await makeKey(agent, { name: "broad", scopes: ["portfolio:read", "money:read"] });

    let body = (await agent.text("/app/setup/api")).body;
    assert.match(body, /money:read/);

    /* The holder is narrowed. The key still names money:read and can no
       longer use it, and the screen has to say so — otherwise it is found
       out at three in the morning. */
    await run("UPDATE staff SET role = 'leasing' WHERE id = ?", world.staff.admin.id);
    const stillIn = client(app.origin);
    await stillIn.signIn(world.staff.manager.email, f.PASSWORD);
    body = (await stillIn.text("/app/setup/api")).body;
    assert.match(body, /role no longer\s+carries it/,
      "a key narrowed by a role change should say so on the page, not in a 403");
  });

  test("revoking takes effect on the next request", async () => {
    const { key } = await makeKey();
    const row = await get("SELECT id FROM api_key LIMIT 1");

    const before = await fetch(`${app.origin}/api/v1/properties`,
      { headers: { authorization: `Bearer ${key}` } });
    assert.equal(before.status, 200);

    const res = await agent.post(`/app/setup/api/${row.id}/revoke`, {},
      { csrfFrom: "/app/setup/api" });
    assert.equal(res.status, 303);

    const after = await fetch(`${app.origin}/api/v1/properties`,
      { headers: { authorization: `Bearer ${key}` } });
    assert.equal(after.status, 401);
  });

  test("a revoked key stays on the list, because it was used", async () => {
    const { key } = await makeKey();
    await fetch(`${app.origin}/api/v1/properties`,
      { headers: { authorization: `Bearer ${key}` } });
    const row = await get("SELECT id FROM api_key LIMIT 1");
    await agent.post(`/app/setup/api/${row.id}/revoke`, {}, { csrfFrom: "/app/setup/api" });

    const { body } = await agent.text("/app/setup/api");
    assert.match(body, /revoked/);
    assert.match(body, /Zapier/, "what it was and what it did is still worth knowing");
  });
});

describe("who may reach this page at all", () => {
  test("a technician cannot, because /app/setup needs settings.manage", async () => {
    const tech = client(app.origin);
    const signedIn = await tech.signIn(world.staff.technician.email, f.PASSWORD);
    assert.equal(signedIn.signedIn, true);

    assert.equal((await tech.get("/app/setup/api")).status, 403);
    const post = await tech.post("/app/setup/api",
      { name: "x", scopes: ["portfolio:read"] }, { csrf: null });
    assert.ok(post.status >= 400);
    assert.equal((await all("SELECT id FROM api_key")).length, 0);
  });

  test("the specification is readable with a session, not only with a key", async () => {
    /* An integrator reading the shape before anybody has given them a key is
       the ordinary case, and a link on this page that answers 401 in a
       browser is a link that does not work. */
    const res = await agent.get("/app/setup/api/openapi.json");
    assert.equal(res.status, 200);
    const spec = JSON.parse(await res.text());
    assert.equal(spec.openapi, "3.1.0");
    assert.ok(spec.paths["/units"]);

    const { body } = await agent.text("/app/setup/api");
    assert.match(body, /\/app\/setup\/api\/openapi\.json/);
  });

  test("and a signed-out visitor gets neither", async () => {
    const stranger = client(app.origin);
    const viaApp = await stranger.get("/app/setup/api/openapi.json");
    assert.equal(viaApp.status, 303, "the app sends them to sign in");

    const viaApi = await fetch(`${app.origin}/api/v1/openapi.json`);
    assert.equal(viaApi.status, 401);
  });

  test("it is linked from setup", async () => {
    const { body } = await agent.text("/app/setup");
    assert.match(body, /\/app\/setup\/api/);
  });
});
