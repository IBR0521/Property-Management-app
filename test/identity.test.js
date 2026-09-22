/* Who a person is, and what they are allowed to see.

   Two halves, and the second matters more.

   **Identity** is the inference this phase rests on: that two rows carrying
   one email address are one human. It is the right inference — an address is
   a login — but it is an inference, so the cases it has to survive are the
   messy ones: a stray capital, a pasted trailing space, somebody who is both
   a landlord and a tenant, somebody who moved out and came back.

   **Access** is the part where a mistake is a breach. Every question in
   identity.js takes a company, and the tests below try to get an answer
   without one. A person with links in two companies must never see a merged
   view, and a person with links in one must never reach the other. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import {
  normaliseEmail, ensurePerson, personByEmail, linkTenant, linkOwner,
  revokeLink, companiesFor, rolesIn, leasesFor, propertiesFor,
  leaseIfHeld, propertyIfHeld, ownerIfHeld, syncPeopleFor,
} from "../server/lib/identity.js";

let world;

async function makeTenant({ companyId, name, email, phone = null }) {
  const tid = id();
  await insert("tenant", {
    id: tid, company_id: companyId, name, email, phone, created_at: stamp(),
  });
  return tid;
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Identity Co" });
});

/* --- one address is one human ----------------------------------------------- */

describe("normalising an address", () => {
  test("case and whitespace do not make a second person", () => {
    /* Addresses arrive pasted from spreadsheets. */
    for (const raw of ["  Priya@Example.TEST ", "PRIYA@EXAMPLE.TEST", "priya@example.test"]) {
      assert.equal(normaliseEmail(raw), "priya@example.test");
    }
  });

  test("nothing at all is nothing, not an empty person", () => {
    for (const raw of ["", "   ", null, undefined]) {
      assert.equal(normaliseEmail(raw), "");
    }
  });
});

describe("a person", () => {
  test("the same address returns the same person", async () => {
    const first = await ensurePerson({ email: "priya@example.test", name: "Priya Anand" });
    const second = await ensurePerson({ email: " PRIYA@Example.test ", name: "P. Anand" });
    assert.equal(first.id, second.id);
    assert.equal((await all("SELECT id FROM person")).length, 1);
  });

  test("what we did not know gets filled in; what we knew is kept", async () => {
    /* A name somebody set themselves outranks one a member of staff typed on
       a lease afterwards. */
    await ensurePerson({ email: "a@example.test", name: "Ada Lovelace" });
    await ensurePerson({ email: "a@example.test", name: "A. LOVELACE", phone: "6145550100" });

    const person = await personByEmail("a@example.test");
    assert.equal(person.name, "Ada Lovelace", "not overwritten");
    assert.equal(person.phone, "6145550100", "but the gap was filled");
  });

  test("no address is no person, and that is not an error", async () => {
    assert.equal(await ensurePerson({ email: "", name: "Nobody" }), null);
    assert.equal(await ensurePerson({ email: null }), null);
  });

  test("the database refuses a second person for one address", async () => {
    await ensurePerson({ email: "a@example.test" });
    await assert.rejects(() => insert("person", {
      id: id(), email: "a@example.test", created_at: stamp(),
    }), /duplicate key/);
  });
});

/* --- what a person holds ----------------------------------------------------- */

describe("linking a tenancy", () => {
  test("a returning tenant keeps one login and gains a second tenancy", async () => {
    /* The sentence the whole phase exists for. The move-in path makes a fresh
       tenant row every time, so this person is two rows and one human. */
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "2" });
    const { leaseId: secondLease, tenantId: secondTenant } =
      await f.makeLease(world.companyId, second, { tenantName: "Priya Anand" });

    await run("UPDATE tenant SET email = ? WHERE id = ?", "priya@example.test", world.tenantId);
    await run("UPDATE tenant SET email = ? WHERE id = ?", "Priya@Example.test", secondTenant);

    await linkTenant({ tenantId: world.tenantId });
    await linkTenant({ tenantId: secondTenant });

    assert.equal((await all("SELECT id FROM person")).length, 1, "one human");
    const person = await personByEmail("priya@example.test");
    const leases = await leasesFor(person.id, world.companyId);
    assert.equal(leases.length, 2, "both tenancies");
    assert.ok(leases.map((l) => l.id).includes(secondLease));
  });

  test("the live tenancy comes first, and the old one is still there", async () => {
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "2" });
    const { tenantId: secondTenant } = await f.makeLease(
      world.companyId, second, { status: "ended", startDate: "2023-01-01" });

    await run("UPDATE tenant SET email = ? WHERE id IN (?, ?)",
      "priya@example.test", world.tenantId, secondTenant);
    await linkTenant({ tenantId: world.tenantId });
    await linkTenant({ tenantId: secondTenant });

    const person = await personByEmail("priya@example.test");
    const leases = await leasesFor(person.id, world.companyId);
    assert.equal(leases[0].status, "active", "this month's balance first");
    assert.equal(leases.length, 2, "and the history is not thrown away");
  });

  test("a landlord who also rents is one person with both roles", async () => {
    await run("UPDATE owner SET email = ? WHERE id = ?", "ruth@example.test", world.ownerId);
    await run("UPDATE tenant SET email = ? WHERE id = ?", "RUTH@example.test", world.tenantId);

    await linkOwner({ ownerId: world.ownerId });
    await linkTenant({ tenantId: world.tenantId });

    const person = await personByEmail("ruth@example.test");
    const roles = await rolesIn(person.id, world.companyId);
    assert.equal(roles.isTenant, true);
    assert.equal(roles.isOwner, true);
    assert.equal((await all("SELECT id FROM person")).length, 1);
  });

  test("linking twice is the same link, not two portal entries", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", world.tenantId);
    const first = await linkTenant({ tenantId: world.tenantId });
    const second = await linkTenant({ tenantId: world.tenantId });
    assert.equal(first, second);
    assert.equal((await all("SELECT id FROM person_link")).length, 1);
  });

  test("the database refuses a second link to one tenancy", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", world.tenantId);
    await linkTenant({ tenantId: world.tenantId });
    const other = await ensurePerson({ email: "b@example.test" });

    await assert.rejects(() => insert("person_link", {
      id: id(), person_id: other.id, company_id: world.companyId,
      role: "tenant", tenant_id: world.tenantId, created_at: stamp(),
    }), /duplicate key/);
  });

  test("correcting the email to somebody else moves the tenancy, not duplicates it", async () => {
    /* A typo fixed a week later. The old person must stop seeing it. */
    await run("UPDATE tenant SET email = ? WHERE id = ?", "typo@example.test", world.tenantId);
    await linkTenant({ tenantId: world.tenantId });
    const wrong = await personByEmail("typo@example.test");

    await run("UPDATE tenant SET email = ? WHERE id = ?", "right@example.test", world.tenantId);
    await linkTenant({ tenantId: world.tenantId });

    const right = await personByEmail("right@example.test");
    assert.equal((await leasesFor(wrong.id, world.companyId)).length, 0, "the typo sees nothing");
    assert.equal((await leasesFor(right.id, world.companyId)).length, 1);
  });

  test("a tenancy with no email gets no person, and still exists", async () => {
    await run("UPDATE tenant SET email = NULL WHERE id = ?", world.tenantId);
    assert.equal(await linkTenant({ tenantId: world.tenantId }), null);
    assert.equal((await all("SELECT id FROM person")).length, 0);
    assert.ok(await get("SELECT id FROM tenant WHERE id = ?", world.tenantId),
      "the tenancy is untouched and still reachable by token");
  });

  test("the database refuses a link that contradicts its own role", async () => {
    const person = await ensurePerson({ email: "a@example.test" });
    await assert.rejects(() => insert("person_link", {
      id: id(), person_id: person.id, company_id: world.companyId,
      role: "tenant", owner_id: world.ownerId, created_at: stamp(),
    }), /link_matches_its_role/);
  });
});

/* --- taking access away ------------------------------------------------------ */

describe("revoking", () => {
  test("a revoked link stops granting access and keeps the record", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", world.tenantId);
    const linkId = await linkTenant({ tenantId: world.tenantId });
    const person = await personByEmail("a@example.test");

    await revokeLink({ linkId, by: "staff-1" });

    assert.equal((await leasesFor(person.id, world.companyId)).length, 0);
    assert.equal((await companiesFor(person.id)).length, 0);
    const row = await get("SELECT * FROM person_link WHERE id = ?", linkId);
    assert.ok(row, "the row is still there to answer 'did they have access in March'");
    assert.equal(row.revoked_by, "staff-1");
  });

  test("relinking restores it rather than making a second", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", world.tenantId);
    const linkId = await linkTenant({ tenantId: world.tenantId });
    await revokeLink({ linkId, by: "staff-1" });
    await linkTenant({ tenantId: world.tenantId });

    assert.equal((await all("SELECT id FROM person_link")).length, 1);
    const row = await get("SELECT * FROM person_link WHERE id = ?", linkId);
    assert.equal(row.revoked_at, null);
  });
});

/* --- the boundary ------------------------------------------------------------ */

describe("one person, two companies", () => {
  let person, other;

  beforeEach(async () => {
    other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE owner SET email = ? WHERE id = ?", "ruth@example.test", world.ownerId);
    await run("UPDATE owner SET email = ? WHERE id = ?", "ruth@example.test", other.ownerId);
    await linkOwner({ ownerId: world.ownerId });
    await linkOwner({ ownerId: other.ownerId });
    person = await personByEmail("ruth@example.test");
  });

  test("one login, two companies listed, chosen one at a time", async () => {
    const companies = await companiesFor(person.id);
    assert.equal(companies.length, 2);
    assert.deepEqual(companies.map((c) => c.name).sort(), ["Identity Co", "Other Co"]);
  });

  test("there is no merged view", async () => {
    /* Every query takes a company, and each answers only about that one. */
    const mine = await propertiesFor(person.id, world.companyId);
    const theirs = await propertiesFor(person.id, other.companyId);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 1);
    assert.notEqual(mine[0].id, theirs[0].id);
  });

  test("a record from the other company is not held here", async () => {
    /* The check the portal makes before reading anything a URL named. */
    assert.equal(
      await propertyIfHeld({ personId: person.id, companyId: world.companyId, propertyId: other.propertyId }),
      null);
    assert.equal(
      await ownerIfHeld({ personId: person.id, companyId: world.companyId, ownerId: other.ownerId }),
      null);
  });

  test("a stranger's record is not held either", async () => {
    const stranger = await ensurePerson({ email: "stranger@example.test" });
    assert.equal(
      await propertyIfHeld({ personId: stranger.id, companyId: world.companyId, propertyId: world.propertyId }),
      null);
    assert.equal(
      await leaseIfHeld({ personId: stranger.id, companyId: world.companyId, leaseId: world.leaseId }),
      null);
  });

  test("a tenancy in one company is not visible through the other", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "ruth@example.test", other.tenantId);
    await linkTenant({ tenantId: other.tenantId });

    assert.equal(
      await leaseIfHeld({ personId: person.id, companyId: world.companyId, leaseId: other.leaseId }),
      null, "held in Other Co, asked about in Identity Co");
    assert.ok(
      await leaseIfHeld({ personId: person.id, companyId: other.companyId, leaseId: other.leaseId }),
      "and held when asked about correctly");
  });

  test("roles are answered per company", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "ruth@example.test", other.tenantId);
    await linkTenant({ tenantId: other.tenantId });

    const here = await rolesIn(person.id, world.companyId);
    const there = await rolesIn(person.id, other.companyId);
    assert.equal(here.isTenant, false, "a landlord here");
    assert.equal(there.isTenant, true, "and a tenant there");
  });
});

/* --- keeping up ------------------------------------------------------------- */

describe("syncing", () => {
  test("it links whoever was added since, and nobody twice", async () => {
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", world.tenantId);
    await run("UPDATE owner SET email = ? WHERE id = ?", "b@example.test", world.ownerId);
    await makeTenant({ companyId: world.companyId, name: "New", email: "c@example.test" });

    const first = await syncPeopleFor(world.companyId);
    assert.equal(first.tenants, 2);
    assert.equal(first.owners, 1);

    const second = await syncPeopleFor(world.companyId);
    assert.deepEqual(second, { tenants: 0, owners: 0 }, "idempotent");
    assert.equal((await all("SELECT id FROM person_link")).length, 3);
  });

  test("it does not reach into another company", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE tenant SET email = ? WHERE id = ?", "a@example.test", other.tenantId);

    const res = await syncPeopleFor(world.companyId);
    assert.equal(res.tenants, 1, "only this company's, and only the one with an address");
    const links = await all("SELECT company_id FROM person_link");
    assert.ok(links.every((l) => l.company_id === world.companyId));
  });
});
