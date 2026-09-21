/* Signing up, verifying, and what a company may do in between.

   The interesting case is the one in the middle. A company exists and can be
   used the moment somebody signs up, but it has not proved it owns the email
   address it typed — and anyone can type somebody else's. What it may not do
   until it proves that is send mail to owners and tenants under our sending
   domain.

   Which creates a deadlock if it is enforced naively: the message that lifts
   the block is itself a message. That exception is the thing most worth
   testing here. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { queueMessage, senderFor, sendingBlockedReason } from "../server/lib/outbox.js";

let app;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });
beforeEach(async () => { await truncateAll(); });

const GOOD = {
  company_name: "Northgate Residential",
  name: "Dana Whitfield",
  email: "dana@northgate.test",
  phone: "6145550100",
  password: "a-long-enough-passphrase",
};

async function signUp(c, overrides = {}) {
  const csrf = await c.csrf("/signup");
  return await c.post("/signup", { ...GOOD, ...overrides }, { csrf });
}

describe("signup", () => {
  test("creates the company and its first admin together", async () => {
    const c = client(app.origin);
    const res = await signUp(c);
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/app/);

    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);
    assert.ok(company, "the company exists");
    assert.equal(company.slug, "northgate-residential");
    assert.equal(company.verified_at, null, "and is not verified yet");

    const staff = await get("SELECT * FROM staff WHERE email = ?", GOOD.email);
    assert.equal(staff.company_id, company.id);
    assert.equal(staff.role, "admin", "the first person in is an administrator");
    assert.match(staff.password_hash, /^scrypt\$/);
  });

  test("the new admin is signed in immediately", async () => {
    const c = client(app.origin);
    await signUp(c);
    const { res, body } = await c.text("/app");
    assert.equal(res.status, 200, "no second sign-in step");
    assert.match(body, /Northgate Residential/);
  });

  test("neither half exists if the other fails", async () => {
    /* A company nobody can sign in to is an orphan; a staff row with no
       company cannot be scoped by any query in this codebase. */
    const c = client(app.origin);
    await signUp(c, { email: "not-an-email" });
    assert.equal((await all("SELECT id FROM company")).length, 0);
    assert.equal((await all("SELECT id FROM staff")).length, 0);
  });

  test("a short password is refused, and says why", async () => {
    const c = client(app.origin);
    const res = await signUp(c, { password: "short" });
    const { body } = await c.follow(res);
    assert.match(body, /at least 12 characters/i);
    assert.equal((await all("SELECT id FROM company")).length, 0);
  });

  test("two companies with the same name get different handles", async () => {
    await signUp(client(app.origin));
    await signUp(client(app.origin), { email: "other@northgate.test" });
    const slugs = (await all("SELECT slug FROM company ORDER BY created_at")).map((r) => r.slug);
    assert.deepEqual(slugs, ["northgate-residential", "northgate-residential-2"]);
  });

  test("signup is rate limited, because it creates rows in our database", async () => {
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const res = await signUp(client(app.origin), { email: `x${i}@northgate.test` });
      if (res.status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, "an open signup form is an open door");
    await run("DELETE FROM rate_hit");
  });
});

describe("the unverified window", () => {
  test("the verification email is queued despite the block it lifts", async () => {
    /* The deadlock: an unverified company may not send, and the message that
       verifies it is a message. Without an explicit exception a new company
       could never escape. */
    const c = client(app.origin);
    await signUp(c);

    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);
    const queued = await all(
      "SELECT * FROM outbox WHERE company_id = ? AND status = 'queued'", company.id);

    assert.equal(queued.length, 1);
    assert.equal(queued[0].to_contact, GOOD.email);
    assert.match(queued[0].body, /\/verify\//, "and it carries the link");
  });

  test("anything else is refused, and recorded rather than dropped", async () => {
    const c = client(app.origin);
    await signUp(c);
    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);

    const rowId = await queueMessage({
      companyId: company.id, channel: "email", to: "owner@example.com",
      subject: "Approval needed", body: "Please approve",
      aboutType: "owner_approval", aboutId: "x",
    });

    assert.equal(rowId, null, "it does not go");
    const suppressed = await get(
      "SELECT * FROM outbox WHERE company_id = ? AND status = 'suppressed'", company.id);
    assert.ok(suppressed, "but it is recorded — a message that never existed cannot be explained later");
    assert.match(suppressed.last_error, /not been confirmed/);
  });

  test("clicking the link lifts the block", async () => {
    const c = client(app.origin);
    await signUp(c);
    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);
    const verification = await get("SELECT * FROM email_verification WHERE company_id = ?", company.id);

    assert.ok(await sendingBlockedReason(company.id));
    const res = await c.get(`/verify/${verification.token}`);
    assert.equal(res.status, 200);
    assert.equal(await sendingBlockedReason(company.id), null);

    const after = await get("SELECT verified_at FROM company WHERE id = ?", company.id);
    assert.ok(after.verified_at);
  });

  test("the link is single use, and says so kindly the second time", async () => {
    /* Mail clients prefetch links. The second visit is a person or a robot
       checking, not an error to shout about. */
    const c = client(app.origin);
    await signUp(c);
    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);
    const v = await get("SELECT * FROM email_verification WHERE company_id = ?", company.id);

    await c.get(`/verify/${v.token}`);
    const second = await c.text(`/verify/${v.token}`);
    assert.equal(second.res.status, 200);
    assert.match(second.body, /already confirmed/i);
  });

  test("an expired link is refused", async () => {
    const c = client(app.origin);
    await signUp(c);
    const company = await get("SELECT * FROM company WHERE name = ?", GOOD.company_name);
    const v = await get("SELECT * FROM email_verification WHERE company_id = ?", company.id);
    await run("UPDATE email_verification SET expires_at = ? WHERE id = ?",
      new Date(Date.now() - 1000).toISOString(), v.id);

    const res = await c.get(`/verify/${v.token}`);
    assert.equal(res.status, 410);
    assert.equal((await get("SELECT verified_at FROM company WHERE id = ?", company.id)).verified_at, null);
  });

  test("a junk token verifies nothing", async () => {
    const c = client(app.origin);
    await signUp(c);
    const res = await c.get("/verify/not-a-real-token-at-all-no");
    assert.equal(res.status, 404);
    const company = await get("SELECT verified_at FROM company WHERE name = ?", GOOD.company_name);
    assert.equal(company.verified_at, null);
  });
});

describe("mail goes out as the company, not the platform", () => {
  test("the from address is the company's own, with its name on it", async () => {
    const cid = await f.makeCompany("Leafridge Property Management");
    await run(
      "UPDATE company SET from_email = ?, from_name = ?, reply_to = ? WHERE id = ?",
      "notices@leafridge.test", "Leafridge Lettings", "office@leafridge.test", cid);

    const sender = await senderFor(cid, "email");
    assert.equal(sender.from, "Leafridge Lettings <notices@leafridge.test>",
      "a display name is the difference between mail that is opened and mail that is reported");
    assert.equal(sender.replyTo, "office@leafridge.test");
  });

  test("the company name is used when no sender name is set", async () => {
    const cid = await f.makeCompany("Fallback Realty");
    await run("UPDATE company SET from_email = ? WHERE id = ?", "hello@fallback.test", cid);
    const sender = await senderFor(cid, "email");
    assert.equal(sender.from, "Fallback Realty <hello@fallback.test>");
  });

  test("two companies do not share a sender", async () => {
    const one = await f.makeCompany("One Co");
    const two = await f.makeCompany("Two Co");
    await run("UPDATE company SET from_email = ? WHERE id = ?", "a@one.test", one);
    await run("UPDATE company SET from_email = ? WHERE id = ?", "b@two.test", two);

    assert.notEqual((await senderFor(one, "email")).from, (await senderFor(two, "email")).from,
      "one platform address for every customer is ruinous the first time one is marked as spam");
  });

  test("SMS uses the company's own number when it has one", async () => {
    const cid = await f.makeCompany("Texting Co");
    await run("UPDATE company SET sms_from = ? WHERE id = ?", "+16145550199", cid);
    assert.equal((await senderFor(cid, "sms")).from, "+16145550199");
  });
});
