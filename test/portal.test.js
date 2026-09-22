/* The portal, driven over HTTP.

   A new authenticated surface on data that was previously staff-only, which
   makes it the largest new attack surface since signup. So the tests are
   weighted towards refusing: a signed-out person reaching nothing, a signed-in
   person reaching only their own, and a person with accounts at two companies
   reaching exactly one of them at a time.

   The rest is the promise the phase was for — that a returning tenant signs
   in once and sees both tenancies, including the one that ended. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, monthKey } from "../server/lib/dates.js";
import { postMoney } from "../server/lib/ledger.js";
import { linkTenant, linkOwner, personByEmail, revokeLink } from "../server/lib/identity.js";
import { requestLink } from "../server/lib/magiclink.js";

const EMAIL = "priya@example.test";

let app, world;

const page = async (agent, path) => {
  const { res, body } = await agent.text(path);
  return { status: res.status, body, res };
};
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

/* Sign in the way a person does: ask for a link, then follow it. */
async function signIn(email = EMAIL) {
  const agent = client(app.origin);
  const link = await requestLink({ email, ip: "1.1.1.1", baseUrl: app.origin });
  assert.equal(link.delivered, true, `no link issued for ${email}`);
  const res = await agent.get(`/portal/enter/${link.secret}`);
  assert.equal(res.status, 303, "the link should let them in");
  return agent;
}

async function tenantOf(world, email = EMAIL) {
  await run("UPDATE tenant SET email = ? WHERE id = ?", email, world.tenantId);
  await linkTenant({ tenantId: world.tenantId });
  return await personByEmail(email);
}

async function ownerOf(world, email = EMAIL) {
  await run("UPDATE owner SET email = ? WHERE id = ?", email, world.ownerId);
  await linkOwner({ ownerId: world.ownerId });
  return await personByEmail(email);
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Portal Co" });
  await run("UPDATE lease SET rent_cents = 145000 WHERE id = ?", world.leaseId);
  /* Verified, so the sign-in email is queued rather than suppressed. */
  await run("UPDATE company SET verified_at = ? WHERE id = ?", stamp(), world.companyId);
});

/* --- the door ---------------------------------------------------------------- */

describe("signing in", () => {
  test("the form never says whether an address is known", async () => {
    /* Otherwise it is a way to ask "does this person rent from you", which is
       somebody's home address. */
    await tenantOf(world);
    const anon = client(app.origin);

    const known = await anon.post("/portal/sign-in", { email: EMAIL }, { csrfFrom: "/portal/sign-in" });
    const unknown = await anon.post("/portal/sign-in", { email: "nobody@example.test" },
      { csrfFrom: "/portal/sign-in" });

    assert.equal(loc(known), loc(unknown), "identical answers");
    assert.match(loc(known), /If that address is on an account/);
  });

  test("a known address is actually sent something", async () => {
    await tenantOf(world);
    const anon = client(app.origin);
    await anon.post("/portal/sign-in", { email: EMAIL }, { csrfFrom: "/portal/sign-in" });

    const queued = await get("SELECT * FROM outbox WHERE kind = 'transactional' ORDER BY queued_at DESC");
    assert.ok(queued, "a message exists");
    assert.equal(queued.to_contact, EMAIL);
    assert.match(queued.body, /\/portal\/enter\//);
  });

  test("an unknown address is sent nothing", async () => {
    const anon = client(app.origin);
    await anon.post("/portal/sign-in", { email: "nobody@example.test" }, { csrfFrom: "/portal/sign-in" });
    assert.equal((await all("SELECT id FROM outbox")).length, 0);
  });

  test("the email carries a link that works once", async () => {
    await tenantOf(world);
    const link = await requestLink({ email: EMAIL, ip: "1.1.1.1", baseUrl: app.origin });

    const first = client(app.origin);
    assert.equal((await first.get(`/portal/enter/${link.secret}`)).status, 303);

    const second = client(app.origin);
    const res = await second.get(`/portal/enter/${link.secret}`);
    assert.match(loc(res), /already been used/i);
  });

  test("a bad token lands on the form with a reason, not an error page", async () => {
    const anon = client(app.origin);
    const res = await anon.get("/portal/enter/not-a-real-token");
    assert.equal(res.status, 303);
    assert.match(loc(res), /\/portal\/sign-in/);
    assert.match(loc(res), /not valid/i);
  });

  test("the sign-in page says the old links still work", async () => {
    /* They do, and a tenant with a bookmarked pay link should not think the
       product has changed under them. */
    const anon = client(app.origin);
    const res = await page(anon, "/portal/sign-in");
    assert.match(res.body, /It still works/i);
  });
});

/* --- the gate ---------------------------------------------------------------- */

describe("what a signed-out person can reach", () => {
  test("nothing, and they are sent to the form", async () => {
    const anon = client(app.origin);
    for (const path of ["/portal/home", "/portal/home/renting", "/portal/home/owning", "/portal/choose"]) {
      const res = await anon.get(path);
      assert.equal(res.status, 303, path);
      assert.match(res.headers.get("location"), /\/portal\/sign-in/, path);
    }
  });

  test("a tenancy page by id is not reachable by guessing", async () => {
    const anon = client(app.origin);
    const res = await anon.get(`/portal/renting/${world.leaseId}`);
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /sign-in/);
  });

  test("the staff app is not reachable with a portal session", async () => {
    /* The reason the sessions are separate tables: a tenant must never be
       able to become a member of staff by holding the wrong cookie. */
    await tenantOf(world);
    const agent = await signIn();

    const res = await agent.get("/app");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/app\/sign-in/);
  });

  test("and a staff session is not a portal session", async () => {
    const staff = client(app.origin);
    await staff.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await staff.get("/portal/home");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/portal\/sign-in/);
  });
});

/* --- a tenant ---------------------------------------------------------------- */

describe("a tenant", () => {
  test("lands on their home without choosing anything", async () => {
    await tenantOf(world);
    const agent = await signIn();
    const res = await page(agent, "/portal/home");
    assert.equal(res.status, 303);
    assert.match(res.res.headers.get("location"), /renting/);
  });

  test("sees what they owe, from the same figures as the pay page", async () => {
    await tenantOf(world);
    const agent = await signIn();
    const res = await page(agent, "/portal/home/renting");
    assert.match(res.body, /\$1,450\.00/);
    assert.match(res.body, /Still owing/);
  });

  test("never sees an owner tab, because they hold nothing to own", async () => {
    await tenantOf(world);
    const agent = await signIn();
    const res = await page(agent, "/portal/home/renting");
    assert.ok(!res.body.includes("/portal/home/owning"));
  });

  test("is bounced from the owner pages they do not hold", async () => {
    await tenantOf(world);
    const agent = await signIn();
    const res = await agent.get("/portal/home/owning");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/portal\/home/);
  });

  test("opens their own tenancy and sees ledger, repairs and notices", async () => {
    await tenantOf(world);
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId,
      date: today(), kind: "rent_payment", amountCents: 145000,
      memo: "Rent September", source: "manual", postedBy: "test",
    });

    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Rent September/);
    assert.match(res.body, /Your account/);
    assert.match(res.body, /Repairs/);
  });

  test("cannot open a tenancy that is not theirs", async () => {
    /* The URL carries an id; the id proves nothing. */
    await tenantOf(world);
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "9" });
    const { leaseId: strangerLease } = await f.makeLease(world.companyId, second);

    const agent = await signIn();
    const res = await agent.get(`/portal/renting/${strangerLease}`);
    assert.equal(res.status, 404);
  });

  test("the pay link on the portal is their own lease's", async () => {
    await tenantOf(world);
    const lease = await get("SELECT pay_token FROM lease WHERE id = ?", world.leaseId);
    const agent = await signIn();
    const res = await page(agent, "/portal/home/renting");
    assert.match(res.body, new RegExp(`/pay/${lease.pay_token}`));
  });

  test("a blocked home shows the reason instead of a pay button", async () => {
    await tenantOf(world);
    await run(
      "UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ? WHERE id = ?",
      "We have filed for possession. Please call the office.", world.leaseId);

    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}`);
    assert.match(res.body, /filed for possession/);
    assert.ok(!res.body.includes("Pay rent</a>"));
  });
});

/* --- the promise of the phase ------------------------------------------------- */

describe("a returning tenant", () => {
  test("signs in once and sees both tenancies, including the one that ended", async () => {
    /* The sentence the schema could not express before this phase. */
    await tenantOf(world);
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "3" });
    const { leaseId: newer, tenantId: newerTenant } = await f.makeLease(
      world.companyId, second, { tenantName: "Priya Anand" });
    await run("UPDATE tenant SET email = ? WHERE id = ?", "PRIYA@example.test", newerTenant);
    await linkTenant({ tenantId: newerTenant });
    await run("UPDATE lease SET status = 'ended', end_date = '2024-06-30' WHERE id = ?", world.leaseId);

    const agent = await signIn();
    const res = await page(agent, "/portal/home/renting");

    assert.match(res.body, /Before that/, "the ended one is listed");
    assert.match(res.body, new RegExp(`/portal/renting/${world.leaseId}`));
    assert.match(res.body, new RegExp(`/portal/renting/${newer}`));
  });

  test("an ended tenancy says so rather than showing a stale balance", async () => {
    await tenantOf(world);
    await run("UPDATE lease SET status = 'ended', end_date = '2024-06-30' WHERE id = ?", world.leaseId);

    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}`);
    assert.match(res.body, /This tenancy has ended/);
    assert.ok(!res.body.includes("Still owing"));
  });
});

/* --- an owner ----------------------------------------------------------------- */

describe("an owner", () => {
  test("sees their portfolio and what is held for them", async () => {
    await ownerOf(world);
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      date: today(), kind: "rent_payment", amountCents: 486775,
      memo: "Rent", source: "manual", postedBy: "test",
    });

    const agent = await signIn();
    const res = await page(agent, "/portal/home/owning");
    assert.equal(res.status, 200);
    assert.match(res.body, /Your buildings/);
    assert.match(res.body, /\$4,867\.75/);
  });

  test("an approval waiting on them is at the top", async () => {
    /* The only thing on the page that is waiting on the person reading it. */
    await ownerOf(world);
    await insert("owner_approval", {
      id: id(), company_id: world.companyId, owner_id: world.ownerId,
      work_order_id: world.workOrderId, amount_cents: 85000,
      status: "pending", token: "approval-token-1", requested_at: stamp(),
    });

    const agent = await signIn();
    const res = await page(agent, "/portal/home/owning");
    assert.match(res.body, /Waiting for you/);
    assert.match(res.body, /\$850\.00/);
    assert.match(res.body, /\/o\/a\/approval-token-1/, "the existing decision link, unchanged");
  });

  test("reports are named as missing rather than shown empty", async () => {
    /* An owner who finds an empty Reports tab concludes the product is
       broken. Phase 6 builds them. */
    await ownerOf(world);
    const agent = await signIn();
    const res = await page(agent, "/portal/home/owning");
    assert.match(res.body, /Not here yet/);
    assert.match(res.body, /being built/i);
  });

  test("opens one of their buildings", async () => {
    await ownerOf(world);
    const agent = await signIn();
    const res = await page(agent, `/portal/owning/${world.propertyId}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Units/);
    assert.match(res.body, /Rent due this month/);
  });

  test("cannot open a building that is not theirs", async () => {
    await ownerOf(world);
    const strangerOwner = await f.makeOwner(world.companyId, { name: "Someone Else" });
    const strangerProperty = await f.makeProperty(world.companyId, strangerOwner, { line1: "9 Nowhere" });

    const agent = await signIn();
    const res = await agent.get(`/portal/owning/${strangerProperty}`);
    assert.equal(res.status, 404);
  });

  test("is bounced from the tenant pages they do not hold", async () => {
    await ownerOf(world);
    const agent = await signIn();
    const res = await agent.get("/portal/home/renting");
    assert.equal(res.status, 303);
  });
});

/* --- both roles ---------------------------------------------------------------- */

describe("somebody who rents and also owns", () => {
  test("is offered both, and neither is guessed at", async () => {
    await tenantOf(world);
    await ownerOf(world);

    const agent = await signIn();
    const res = await page(agent, "/portal/home");
    assert.equal(res.status, 200);
    assert.match(res.body, /Where you rent/);
    assert.match(res.body, /What you own/);
  });
});

/* --- two companies -------------------------------------------------------------- */

describe("one login, two companies", () => {
  let other;

  beforeEach(async () => {
    other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE company SET verified_at = ? WHERE id = ?", stamp(), other.companyId);
    await tenantOf(world);
    await ownerOf(other);
  });

  test("they must choose before anything is readable", async () => {
    const agent = await signIn();
    const res = await agent.get("/portal/home");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/portal\/choose/);
  });

  test("the picker names both and merges neither", async () => {
    const agent = await signIn();
    const res = await page(agent, "/portal/choose");
    assert.match(res.body, /Portal Co/);
    assert.match(res.body, /Other Co/);
    assert.match(res.body, /kept separate/i);
  });

  test("choosing one shows only that one", async () => {
    const agent = await signIn();
    await agent.post("/portal/choose", { company_id: world.companyId }, { csrfFrom: "/portal/choose" });

    const res = await page(agent, "/portal/home/renting");
    assert.match(res.body, /Portal Co/);
    assert.ok(!res.body.includes("Other Co"), "the other company never appears");
  });

  test("a record from the company they did not choose is not reachable", async () => {
    const agent = await signIn();
    await agent.post("/portal/choose", { company_id: world.companyId }, { csrfFrom: "/portal/choose" });

    const res = await agent.get(`/portal/owning/${other.propertyId}`);
    assert.equal(res.status, 404, "held, but not here");
  });

  test("choosing a company they hold nothing in is refused", async () => {
    const third = await f.makeWorld({ name: "Third Co" });
    const agent = await signIn();

    const res = await agent.post("/portal/choose", { company_id: third.companyId },
      { csrfFrom: "/portal/choose" });
    assert.match(loc(res), /do not have an account/i);
  });
});

/* --- losing access ------------------------------------------------------------- */

describe("when access is taken away", () => {
  test("a revoked link ends what they can see, mid-session", async () => {
    const person = await tenantOf(world);
    const agent = await signIn();
    assert.equal((await page(agent, "/portal/home/renting")).status, 200);

    const link = await get("SELECT id FROM person_link WHERE person_id = ?", person.id);
    await revokeLink({ linkId: link.id, by: "staff-1" });

    const res = await agent.get("/portal/home/renting");
    assert.equal(res.status, 303, "no longer a tenant here");
  });

  test("and they are told, rather than shown an empty chooser", async () => {
    /* Losing the last link also clears the company on the session, so they
       land on the picker — which is therefore where it has to be explained.
       An empty "Which account?" page is the worst possible answer. */
    const person = await tenantOf(world);
    const agent = await signIn();
    const link = await get("SELECT id FROM person_link WHERE person_id = ?", person.id);
    await revokeLink({ linkId: link.id, by: "staff-1" });

    const res = await page(agent, "/portal/choose");
    assert.equal(res.status, 200);
    assert.match(res.body, /no records/i);
    assert.match(res.body, /moved out recently/i, "and the likely innocent reason first");
    assert.ok(!res.body.includes("Which account?"));
  });

  test("signing out ends the session", async () => {
    await tenantOf(world);
    const agent = await signIn();
    await agent.get("/portal/sign-out");

    const res = await agent.get("/portal/home/renting");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /sign-in/);
    assert.equal((await all("SELECT id FROM portal_session")).length, 0);
  });
});
