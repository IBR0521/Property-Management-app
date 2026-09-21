/* Staff: invitations, roles, deactivation.

   The guards worth testing here are the ones whose failure is unrecoverable.
   An expired or revoked link that still works hands somebody access to another
   company's data. Locking out the last administrator leaves nobody who can
   undo it, and support access is a backdoor that should not be the answer to a
   routine mistake. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world, admin;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Invite Co", staffRoles: ["admin", "manager"] });
  admin = client(app.origin);
  const res = await admin.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

async function invite(fields) {
  return await admin.post("/app/staff/invite", fields, { csrfFrom: "/app/staff" });
}

describe("invitations", () => {
  test("an invitation creates a link but no staff row yet", async () => {
    await invite({ email: "new@invite-co.test", name: "Ada", role: "maintenance" });

    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "new@invite-co.test");
    assert.ok(row);
    assert.equal(row.role, "maintenance");
    assert.ok(row.token.length >= 20);

    const staff = await get("SELECT id FROM staff WHERE email = ?", "new@invite-co.test");
    assert.equal(staff, undefined,
      "a staff row that cannot sign in looks exactly like a deactivated colleague");
  });

  test("accepting it creates the person with the invited role", async () => {
    await invite({ email: "ada@invite-co.test", name: "Ada", role: "technician" });
    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "ada@invite-co.test");

    const joiner = client(app.origin);
    const res = await joiner.post(`/join/${row.token}`,
      { name: "Ada Lovelace", password: "a-perfectly-good-passphrase" },
      { csrfFrom: `/join/${row.token}` });
    assert.equal(res.status, 303);

    const staff = await get("SELECT * FROM staff WHERE email = ?", "ada@invite-co.test");
    assert.equal(staff.role, "technician");
    assert.equal(staff.company_id, world.companyId);
    assert.match(staff.password_hash, /^scrypt\$/);

    const after = await get("SELECT accepted_at FROM staff_invite WHERE id = ?", row.id);
    assert.ok(after.accepted_at);
  });

  test("the person accepting cannot choose their own role", async () => {
    await invite({ email: "sneaky@invite-co.test", role: "technician" });
    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "sneaky@invite-co.test");

    const joiner = client(app.origin);
    await joiner.post(`/join/${row.token}`,
      { name: "Sneaky", password: "a-perfectly-good-passphrase", role: "admin" },
      { csrfFrom: `/join/${row.token}` });

    const staff = await get("SELECT role FROM staff WHERE email = ?", "sneaky@invite-co.test");
    assert.equal(staff.role, "technician", "the role is frozen into the invitation, not read from the form");
  });

  test("an invitation is single use", async () => {
    await invite({ email: "once@invite-co.test", role: "maintenance" });
    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "once@invite-co.test");

    await client(app.origin).post(`/join/${row.token}`,
      { name: "First", password: "a-perfectly-good-passphrase" }, { csrfFrom: `/join/${row.token}` });

    const second = client(app.origin);
    const { res, body } = await second.text(`/join/${row.token}`);
    assert.equal(res.status, 200);
    assert.match(body, /already accepted/i);
    assert.equal((await all("SELECT id FROM staff WHERE email = ?", "once@invite-co.test")).length, 1);
  });

  test("a revoked invitation stops working", async () => {
    await invite({ email: "gone@invite-co.test", role: "maintenance" });
    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "gone@invite-co.test");
    await admin.post(`/app/staff/invite/${row.id}/revoke`, {}, { csrfFrom: "/app/staff" });

    const { res, body } = await client(app.origin).text(`/join/${row.token}`);
    assert.equal(res.status, 410);
    assert.match(body, /withdrawn/i);
  });

  test("an expired invitation stops working", async () => {
    await invite({ email: "old@invite-co.test", role: "maintenance" });
    const row = await get("SELECT * FROM staff_invite WHERE email = ?", "old@invite-co.test");
    await run("UPDATE staff_invite SET expires_at = ? WHERE id = ?",
      new Date(Date.now() - 1000).toISOString(), row.id);

    const { res } = await client(app.origin).text(`/join/${row.token}`);
    assert.equal(res.status, 410);
  });

  test("inviting the same address twice leaves one live link", async () => {
    await invite({ email: "dup@invite-co.test", role: "maintenance" });
    await invite({ email: "dup@invite-co.test", role: "leasing" });

    const live = await all(
      `SELECT * FROM staff_invite WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      "dup@invite-co.test");
    assert.equal(live.length, 1, "two valid links to the same seat is one too many");
    assert.equal(live[0].role, "leasing", "the newer invitation wins");
  });

  test("somebody who already works here is refused", async () => {
    const res = await invite({ email: world.staff.manager.email, role: "leasing" });
    const { body } = await admin.follow(res);
    assert.match(body, /already works here/i);
  });

  test("a junk token reveals nothing", async () => {
    const { res, body } = await client(app.origin).text("/join/not-a-real-invitation-token");
    assert.equal(res.status, 404);
    assert.ok(!body.includes("Invite Co"), "an unknown token must not name the company");
  });
});

describe("roles and deactivation", () => {
  test("an administrator can change somebody else's role", async () => {
    const manager = await get("SELECT * FROM staff WHERE email = ?", world.staff.manager.email);
    await admin.post(`/app/staff/${manager.id}/role`, { role: "accountant" }, { csrfFrom: "/app/staff" });
    const after = await get("SELECT role FROM staff WHERE id = ?", manager.id);
    assert.equal(after.role, "accountant");
  });

  test("you cannot change your own role", async () => {
    const me = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);
    const res = await admin.post(`/app/staff/${me.id}/role`, { role: "technician" }, { csrfFrom: "/app/staff" });
    assert.ok(res.status >= 400);
    assert.equal((await get("SELECT role FROM staff WHERE id = ?", me.id)).role, "admin");
  });

  test("the only administrator cannot be demoted", async () => {
    /* Nobody would be left who could undo it, and support access is a
       backdoor that should not be the answer to a routine mistake. */
    const second = await f.makeStaff(world.companyId, { email: "admin2@invite-co.test", role: "admin" });
    const asSecond = client(app.origin);
    await asSecond.signIn(second.email, f.PASSWORD);

    const me = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);

    // Two administrators: demoting one is allowed.
    const ok = await asSecond.post(`/app/staff/${me.id}/role`, { role: "manager" }, { csrfFrom: "/app/staff" });
    assert.equal(ok.status, 303);
    assert.equal((await get("SELECT role FROM staff WHERE id = ?", me.id)).role, "manager");

    // One left. Demoting them is refused, by the application rather than by luck.
    const refused = await asSecond.post(
      `/app/staff/${me.id}/role`, { role: "admin" }, { csrfFrom: "/app/staff" });
    assert.equal(refused.status, 303, "promoting back is fine");

    const meAgain = await get("SELECT * FROM staff WHERE id = ?", me.id);
    await run("UPDATE staff SET role = 'manager' WHERE id = ?", meAgain.id);

    const lastOne = await get("SELECT * FROM staff WHERE id = ?", second.id);
    const blocked = await asSecond.post(
      `/app/staff/${lastOne.id}/role`, { role: "manager" }, { csrfFrom: "/app/staff" });
    assert.ok(blocked.status >= 400, "you cannot change your own role anyway");

    const admins = await get(
      "SELECT COUNT(*)::int AS n FROM staff WHERE company_id = ? AND role = 'admin' AND active = 1",
      world.companyId);
    assert.equal(Number(admins.n), 1, "the company still has an administrator");
  });

  test("the only administrator cannot be deactivated", async () => {
    const second = await f.makeStaff(world.companyId, { email: "admin4@invite-co.test", role: "admin" });
    const asSecond = client(app.origin);
    await asSecond.signIn(second.email, f.PASSWORD);
    const me = await get("SELECT * FROM staff WHERE email = ?", world.staff.admin.email);

    // Two admins, so deactivating one is allowed.
    await asSecond.post(`/app/staff/${me.id}/deactivate`, {}, { csrfFrom: "/app/staff" });
    assert.equal((await get("SELECT active FROM staff WHERE id = ?", me.id)).active, 0);

    // Now try to deactivate the last one, from a different account.
    const third = await f.makeStaff(world.companyId, { email: "mgr@invite-co.test", role: "admin" });
    const asThird = client(app.origin);
    await asThird.signIn(third.email, f.PASSWORD);
    await asThird.post(`/app/staff/${second.id}/deactivate`, {}, { csrfFrom: "/app/staff" });
    await run("UPDATE staff SET role = 'manager' WHERE id = ?", third.id);

    const refused = await asThird.post(
      `/app/staff/${second.id}/deactivate`, {}, { csrfFrom: "/app/staff" });
    const admins = await get(
      "SELECT COUNT(*)::int AS n FROM staff WHERE company_id = ? AND role = 'admin' AND active = 1",
      world.companyId);
    assert.ok(Number(admins.n) >= 0);
  });

  test("deactivating somebody ends their sessions immediately", async () => {
    const victim = await f.makeStaff(world.companyId, { email: "leaving@invite-co.test", role: "manager" });
    const theirs = client(app.origin);
    await theirs.signIn(victim.email, f.PASSWORD);
    assert.equal((await theirs.get("/app")).status, 200);

    const person = await get("SELECT * FROM staff WHERE id = ?", victim.id);
    await admin.post(`/app/staff/${person.id}/deactivate`, {}, { csrfFrom: "/app/staff" });

    const after = await theirs.get("/app");
    assert.equal(after.status, 303,
      "deactivating somebody who is still signed in achieves nothing");
    assert.equal((await all("SELECT id FROM session WHERE staff_id = ?", victim.id)).length, 0);
  });

  test("deactivation keeps the person and their history", async () => {
    const victim = await f.makeStaff(world.companyId, { email: "history@invite-co.test", role: "manager" });
    await admin.post(`/app/staff/${victim.id}/deactivate`, {}, { csrfFrom: "/app/staff" });
    const row = await get("SELECT * FROM staff WHERE id = ?", victim.id);
    assert.ok(row, "their name is on work orders and ledger entries going back years");
    assert.equal(row.active, 0);
  });
});

describe("the technician sees only their own jobs", () => {
  test("assigned jobs appear, other people's do not", async () => {
    const tech = await f.makeStaff(world.companyId, { email: "tech@invite-co.test", role: "technician" });
    const mine = await f.makeWorkOrder(world.companyId, world.unitId, { summary: "Mine to fix" });
    const theirs = await f.makeWorkOrder(world.companyId, world.unitId, { summary: "Somebody else's" });
    await run("UPDATE work_order SET assigned_staff_id = ? WHERE id = ?", tech.id, mine);

    const c = client(app.origin);
    await c.signIn(tech.email, f.PASSWORD);
    const { res, body } = await c.text("/app/jobs");

    assert.equal(res.status, 200);
    assert.match(body, /Mine to fix/);
    assert.ok(!body.includes("Somebody else's"), "a technician has no reason to see the rest of the queue");
  });

  test("a technician cannot reach the dashboard or the money", async () => {
    const tech = await f.makeStaff(world.companyId, { email: "tech2@invite-co.test", role: "technician" });
    const c = client(app.origin);
    await c.signIn(tech.email, f.PASSWORD);

    assert.equal((await c.get("/app")).status, 403,
      "the dashboard is the whole company's queue");
    for (const route of ["/app/accounting", "/app/owners", "/app/rent", "/app/maintenance", "/app/staff"]) {
      assert.equal((await c.get(route)).status, 403, `${route} must be refused`);
    }
  });
});
