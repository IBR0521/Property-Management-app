/* Getting back in after forgetting a password.

   There was no way. A person could change their password from inside their
   account and had no route in from outside it, so the first time anybody
   forgot one the only remedy was somebody editing the database by hand.

   Three decisions this holds:

   **The answer is the same either way.** A form that said "no account with
   that email" would be a way of asking which addresses work at a company, and
   the people most likely to ask are not the ones who forgot a password.

   **The token is never stored.** Only its hash — a reset table that leaked
   would otherwise be a list of live keys to accounts.

   **Completing a reset signs out everywhere else.** Somebody resetting a
   password is often somebody who thinks another person has been in their
   account, and leaving those sessions alive would defeat the exercise. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { stamp } from "../server/lib/dates.js";
import { sha256 } from "../server/lib/crypto.js";
import { request, check, complete, ResetRefused } from "../server/lib/passwordreset.js";

let app, world;
const NEW = "a-far-better-password";

before(async () => { await freshDatabase(); await truncateAll(); app = await startApp(); });
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Reset Co", staffRoles: ["admin"] });
});

const ask = () => request({
  email: world.staff.admin.email, ip: "1.1.1.1", baseUrl: "http://x.test",
});

describe("asking for a link", () => {
  test("an address with an account gets one", async () => {
    const r = await ask();
    assert.equal(r.sent, true);
    assert.match(r.link, /\/app\/reset\/[A-Za-z0-9_-]+$/);
  });

  test("an address without one is answered exactly the same way", async () => {
    const r = await request({ email: "nobody@example.test", ip: "1.1.1.1" });
    assert.equal(r.ok, true);
    assert.equal(r.sent, false);
    assert.equal(r.link, null,
      "a form that said 'no such account' would be a way of asking who works here");
  });

  test("so is something that is not an address at all", async () => {
    for (const bad of ["", "   ", "not-an-address", null]) {
      const r = await request({ email: bad });
      assert.equal(r.ok, true);
      assert.equal(r.sent, false);
    }
  });

  test("the token is stored as a hash, never in the clear", async () => {
    const r = await ask();
    const secret = r.link.split("/").pop();
    const rows = await all("SELECT * FROM password_reset");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, sha256(secret));
    assert.ok(!JSON.stringify(rows[0]).includes(secret),
      "a table that leaked must not be a list of live keys");
  });

  test("asking again retires the first link", async () => {
    const first = await ask();
    await ask();
    const still = await check(first.link.split("/").pop());
    assert.equal(still.ok, false, "two live links to one account is one more than anybody needs");
  });

  test("a deactivated account is not offered one", async () => {
    await run("UPDATE staff SET active = 0 WHERE id = ?", world.staff.admin.id);
    const r = await ask();
    assert.equal(r.sent, false);
  });
});

describe("using it", () => {
  test("it sets the password and the new one works", async () => {
    const r = await ask();
    await complete({ secret: r.link.split("/").pop(), password: NEW, confirm: NEW });

    const c = client(app.origin);
    assert.equal((await c.signIn(world.staff.admin.email, NEW)).signedIn, true);
  });

  test("and the old one stops working", async () => {
    const r = await ask();
    await complete({ secret: r.link.split("/").pop(), password: NEW, confirm: NEW });
    const c = client(app.origin);
    assert.equal((await c.signIn(world.staff.admin.email, f.PASSWORD)).signedIn, false);
  });

  test("it works once", async () => {
    const r = await ask();
    const secret = r.link.split("/").pop();
    await complete({ secret, password: NEW, confirm: NEW });
    await assert.rejects(
      () => complete({ secret, password: "another-one-entirely", confirm: "another-one-entirely" }),
      /already been used/);
  });

  test("an expired link is refused", async () => {
    const r = await ask();
    await run("UPDATE password_reset SET expires_at = ?", "2020-01-01T00:00:00.000Z");
    await assert.rejects(
      () => complete({ secret: r.link.split("/").pop(), password: NEW, confirm: NEW }),
      /expired/);
  });

  test("a link nobody issued is refused", async () => {
    await assert.rejects(
      () => complete({ secret: "not-a-real-token", password: NEW, confirm: NEW }),
      /not one of ours/);
  });

  test("two passwords that differ are refused", async () => {
    const r = await ask();
    await assert.rejects(
      () => complete({ secret: r.link.split("/").pop(), password: NEW, confirm: "something-else-here" }),
      /do not match/);
  });

  test("a short password is refused, and says why", async () => {
    const r = await ask();
    await assert.rejects(
      () => complete({ secret: r.link.split("/").pop(), password: "short", confirm: "short" }),
      /twelve characters/);
  });

  test("it signs out every other session", async () => {
    /* The reason this matters: somebody resetting a password often believes
       another person has been in their account. */
    const other = client(app.origin);
    assert.equal((await other.signIn(world.staff.admin.email, f.PASSWORD)).signedIn, true);
    assert.equal((await other.get("/app")).status, 200);

    const r = await ask();
    await complete({ secret: r.link.split("/").pop(), password: NEW, confirm: NEW });

    const after = await other.get("/app");
    assert.notEqual(after.status, 200, "the session that was open must not survive");
    assert.equal((await all("SELECT id FROM session WHERE staff_id = ?", world.staff.admin.id)).length, 0);
  });
});

describe("the screens", () => {
  test("sign-in offers both routes that used to be unreachable", async () => {
    const { body } = await client(app.origin).text("/app/sign-in");
    assert.match(body, /href="\/app\/forgot"/, "forgetting a password had no route at all");
    assert.match(body, /href="\/signup"/, "signup was built, tested, and linked from nowhere");
  });

  test("the form answers the same way for an unknown address", async () => {
    const c = client(app.origin);
    const res = await c.post("/app/forgot", { email: "nobody@example.test" },
      { csrfFrom: "/app/forgot" });
    assert.equal(res.status, 303);
    const { body } = await c.text("/app/forgot?sent=1");
    assert.match(body, /Check your email/);
    assert.match(body, /If that address belongs to an account/);
  });

  test("a real request queues an email with the link in it", async () => {
    const c = client(app.origin);
    await c.post("/app/forgot", { email: world.staff.admin.email }, { csrfFrom: "/app/forgot" });
    const msg = await get("SELECT * FROM outbox WHERE about_type = 'password_reset'");
    assert.ok(msg, "the link has to actually go somewhere");
    assert.match(msg.body, /\/app\/reset\//);
    assert.match(msg.body, /works once/);
  });

  test("the reset page refuses a bad link in words, with a way forward", async () => {
    const { res, body } = await client(app.origin).text("/app/reset/not-a-real-token");
    assert.equal(res.status, 410);
    assert.match(body, /will not work/);
    assert.match(body, /href="\/app\/forgot"/, "and a way to get a good one");
  });

  test("the whole thing works from the browser's side", async () => {
    const c = client(app.origin);
    await c.post("/app/forgot", { email: world.staff.admin.email }, { csrfFrom: "/app/forgot" });
    const msg = await get("SELECT body FROM outbox WHERE about_type = 'password_reset'");
    const link = msg.body.match(/\/app\/reset\/([A-Za-z0-9_-]+)/)[0];

    const page = await c.text(link);
    assert.equal(page.res.status, 200);
    assert.match(page.body, /New password/);

    const res = await c.post(link, { password: NEW, confirm: NEW }, { csrfFrom: link });
    assert.equal(res.status, 303);

    const fresh = client(app.origin);
    assert.equal((await fresh.signIn(world.staff.admin.email, NEW)).signedIn, true);
  });
});
