/* Signing in without a password.

   This is the one piece of Phase 4 where a mistake is a breach rather than a
   bug, so the tests are mostly about refusing rather than about working.

   Four properties, each of which exists because breaking it causes real harm:
   the stored token is a hash and not a credential; the reply never reveals
   whether an address is known; the endpoint is bounded per address and per
   network; and a link works exactly once. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { sha256 } from "../server/lib/crypto.js";
import { ensurePerson, linkTenant, linkOwner, revokeLink, personByEmail } from "../server/lib/identity.js";
import {
  requestLink, redeem, sessionFor, chooseCompany, signOut,
  touchSession, prunePortalSessions,
  LINK_TTL_MINUTES, MAX_PER_EMAIL, MAX_PER_IP,
} from "../server/lib/magiclink.js";

let world;

/* A tenant who can actually sign in. */
async function tenantPerson(email = "priya@example.test") {
  await run("UPDATE tenant SET email = ? WHERE id = ?", email, world.tenantId);
  await linkTenant({ tenantId: world.tenantId });
  return await personByEmail(email);
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Portal Co" });
});

/* --- asking for a link -------------------------------------------------------- */

describe("what the sign-in form gives away", () => {
  test("an unknown address gets the same answer as a known one", async () => {
    /* Otherwise the form is a membership oracle: type an address, learn
       whether that person rents from this company. */
    await tenantPerson("priya@example.test");

    const known = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });
    const unknown = await requestLink({ email: "nobody@example.test", ip: "1.1.1.1" });

    assert.equal(known.ok, true);
    assert.equal(unknown.ok, true, "the same outward answer");
    assert.equal(unknown.delivered, false, "and nothing was sent");
  });

  test("a malformed address is refused the same way", async () => {
    for (const bad of ["", "   ", "not-an-address", "a@b", "@example.test"]) {
      const res = await requestLink({ email: bad, ip: "1.1.1.1" });
      assert.equal(res.ok, true, `${bad} should not be distinguishable`);
      assert.equal(res.delivered, false);
    }
    assert.equal((await all("SELECT id FROM portal_login_token")).length, 0);
  });

  test("somebody whose access was revoked is not sent a login", async () => {
    const person = await tenantPerson();
    const link = await get("SELECT id FROM person_link WHERE person_id = ?", person.id);
    await revokeLink({ linkId: link.id, by: "staff-1" });

    const res = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });
    assert.equal(res.delivered, false);
    assert.equal(res.reason, "no live links");
  });
});

describe("the token itself", () => {
  test("only a hash is stored", async () => {
    /* A read of this table should not hand somebody a login. */
    await tenantPerson();
    const res = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });

    const row = await get("SELECT * FROM portal_login_token");
    assert.ok(res.secret && res.secret.length >= 20);
    assert.ok(!row.token_hash.includes(res.secret), "the plaintext is not in the column");
    assert.equal(row.token_hash, sha256(res.secret));
    assert.equal(row.token_hash.length, 64);
  });

  test("the whole row holds nothing that would let somebody in", async () => {
    await tenantPerson();
    const res = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });
    const row = await get("SELECT * FROM portal_login_token");
    for (const [column, value] of Object.entries(row)) {
      assert.ok(!String(value ?? "").includes(res.secret), `${column} holds the token`);
    }
  });

  test("the link points where the person can use it", async () => {
    await tenantPerson();
    const res = await requestLink({
      email: "priya@example.test", ip: "1.1.1.1", baseUrl: "https://example.test",
    });
    assert.equal(res.url, `https://example.test/portal/enter/${res.secret}`);
  });

  test("an SMS code is six digits and short-lived", async () => {
    await tenantPerson();
    const res = await requestLink({ email: "priya@example.test", ip: "1.1.1.1", channel: "sms" });
    assert.match(res.secret, /^\d{6}$/);
    assert.equal(res.url, null, "a code is typed, not clicked");
    assert.ok(res.expiresInMinutes < LINK_TTL_MINUTES, "shorter than a link");
  });

  test("codes are not a sequence", async () => {
    /* Math.random is seeded predictably enough that a stream of codes is
       guessable. This is a smoke test, not a statistical one. */
    await tenantPerson();
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      const res = await requestLink({ email: "priya@example.test", channel: "sms" });
      seen.add(res.secret);
    }
    assert.equal(seen.size, 4, "four requests, four different codes");
  });
});

describe("asking again", () => {
  test("a newer link retires the older one", async () => {
    /* Somebody who clicks "send it again" should not leave two working links
       in two emails, one of which gets forwarded. */
    await tenantPerson();
    const first = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });
    const second = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });

    const stale = await redeem({ token: first.secret });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /newer link/i);

    const fresh = await redeem({ token: second.secret });
    assert.equal(fresh.ok, true);
  });

  test("it is bounded per address", async () => {
    /* An unauthenticated endpoint that sends email is a way to fill somebody
       else's inbox. */
    await tenantPerson();
    for (let i = 0; i < MAX_PER_EMAIL; i++) {
      await requestLink({ email: "priya@example.test", ip: `10.0.0.${i}` });
    }
    const over = await requestLink({ email: "priya@example.test", ip: "10.0.0.99" });
    assert.equal(over.delivered, false);
    assert.equal(over.reason, "too many for that address");
    assert.equal(over.ok, true, "and the person is told the same thing as always");
  });

  test("it is bounded per network", async () => {
    for (let i = 0; i < MAX_PER_IP; i++) {
      const email = `p${i}@example.test`;
      await ensurePerson({ email });
      await insert("portal_login_token", {
        id: id(), person_id: (await personByEmail(email)).id,
        token_hash: sha256(`t${i}`), channel: "email",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        requested_ip: "9.9.9.9", created_at: stamp(),
      });
    }
    await tenantPerson();
    const over = await requestLink({ email: "priya@example.test", ip: "9.9.9.9" });
    assert.equal(over.reason, "too many from that network");
  });

  test("the limit is an hour, not forever", async () => {
    const person = await tenantPerson();
    for (let i = 0; i < MAX_PER_EMAIL; i++) {
      await insert("portal_login_token", {
        id: id(), person_id: person.id, token_hash: sha256(`old${i}`), channel: "email",
        expires_at: stamp(), requested_ip: "1.1.1.1",
        created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      });
    }
    const res = await requestLink({ email: "priya@example.test", ip: "1.1.1.1" });
    assert.equal(res.delivered, true, "yesterday's attempts do not lock somebody out today");
  });
});

/* --- using one ----------------------------------------------------------------- */

describe("redeeming", () => {
  test("it works once and not twice", async () => {
    await tenantPerson();
    const { secret } = await requestLink({ email: "priya@example.test" });

    const first = await redeem({ token: secret });
    assert.equal(first.ok, true);
    assert.ok(first.sessionId);

    const second = await redeem({ token: secret });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been used/i);
    assert.equal((await all("SELECT id FROM portal_session")).length, 1, "one session, not two");
  });

  test("an expired link is refused and says so", async () => {
    const person = await tenantPerson();
    await insert("portal_login_token", {
      id: id(), person_id: person.id, token_hash: sha256("stale-token"), channel: "email",
      expires_at: new Date(Date.now() - 60_000).toISOString(), created_at: stamp(),
    });
    const res = await redeem({ token: "stale-token" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /expired/i);
  });

  test("a token nobody issued is refused", async () => {
    await tenantPerson();
    const res = await redeem({ token: "a-token-that-was-never-issued" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not valid/i);
  });

  test("a missing token is refused rather than throwing", async () => {
    for (const bad of ["", null, undefined]) {
      const res = await redeem({ token: bad });
      assert.equal(res.ok, false);
    }
  });

  test("access revoked between sending and clicking is refused", async () => {
    /* The window that matters: a link sent on Friday, clicked on Monday,
       after the tenancy ended. */
    const person = await tenantPerson();
    const { secret } = await requestLink({ email: "priya@example.test" });

    const link = await get("SELECT id FROM person_link WHERE person_id = ?", person.id);
    await revokeLink({ linkId: link.id, by: "staff-1" });

    const res = await redeem({ token: secret });
    assert.equal(res.ok, false);
    assert.match(res.reason, /no longer has access/i);
    assert.equal((await all("SELECT id FROM portal_session")).length, 0);
  });

  test("one company is chosen for them; two are offered", async () => {
    const person = await tenantPerson();
    const one = await redeem({ token: (await requestLink({ email: "priya@example.test" })).secret });
    let session = await sessionFor(one.sessionId);
    assert.equal(session.company_id, world.companyId, "no needless click");

    const other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE owner SET email = ? WHERE id = ?", "priya@example.test", other.ownerId);
    await linkOwner({ ownerId: other.ownerId });

    const two = await redeem({ token: (await requestLink({ email: "priya@example.test" })).secret });
    session = await sessionFor(two.sessionId);
    assert.equal(session.company_id, null, "they must choose");
    assert.equal(two.companies.length, 2);
  });
});

/* --- the session --------------------------------------------------------------- */

describe("a portal session", () => {
  test("it is not a staff session", async () => {
    /* Different table, so a missing WHERE cannot make a tenant staff. */
    await tenantPerson();
    const { sessionId } = await redeem({ token: (await requestLink({ email: "priya@example.test" })).secret });

    assert.equal((await all("SELECT id FROM session")).length, 0, "nothing in the staff table");
    const portal = await get("SELECT * FROM portal_session WHERE id = ?", sessionId);
    assert.ok(portal.person_id);
    assert.ok(!("staff_id" in portal), "and no staff column to fill in by accident");
  });

  test("an expired one resolves to nothing", async () => {
    const person = await tenantPerson();
    const sessionId = id();
    await insert("portal_session", {
      id: sessionId, person_id: person.id, company_id: world.companyId,
      created_at: stamp(), expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await sessionFor(sessionId), null);
  });

  test("choosing a company is checked, not trusted", async () => {
    /* The company comes from a form. A person must not be able to point their
       session at one they hold nothing in. */
    const person = await tenantPerson();
    const other = await f.makeWorld({ name: "Other Co" });
    const { sessionId } = await redeem({ token: (await requestLink({ email: "priya@example.test" })).secret });

    const bad = await chooseCompany({ sessionId, personId: person.id, companyId: other.companyId });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /do not have an account/i);

    const session = await sessionFor(sessionId);
    assert.equal(session.company_id, world.companyId, "unchanged");
  });

  test("signing out ends it", async () => {
    await tenantPerson();
    const { sessionId } = await redeem({ token: (await requestLink({ email: "priya@example.test" })).secret });
    await signOut(sessionId);
    assert.equal(await sessionFor(sessionId), null);
  });

  test("expired sessions and old tokens are swept", async () => {
    const person = await tenantPerson();
    await insert("portal_session", {
      id: id(), person_id: person.id, created_at: stamp(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await insert("portal_login_token", {
      id: id(), person_id: person.id, token_hash: sha256("ancient"), channel: "email",
      expires_at: stamp(),
      created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });

    const swept = await prunePortalSessions();
    assert.equal(swept.portalSessionsPruned, 1);
    assert.equal(swept.loginTokensPruned, 1, "a spent token still names somebody");
  });
});
