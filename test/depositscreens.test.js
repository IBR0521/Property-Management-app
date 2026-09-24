/* The deposit screens.

   Two things they have to do that the library cannot.

   **Show the statement before it is sent.** Somebody is about to tell a person
   why they are not getting their money back; a screen that settles and then
   reveals what went out is a screen that produces disputes.

   **Lead with the deadline.** A deposit return is the one obligation here that
   carries a statutory penalty for being late in most states, so the list is
   ordered by when it is due rather than by when it opened. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { takeDeposit, openReturn } from "../server/lib/deposits.js";

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
    name: "Deposit Screens Co", staffRoles: ["admin", "leasing"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

async function rule(windowDays = 30) {
  await insert("compliance_rule", {
    id: id(), company_id: world.companyId, kind: "deposit_return",
    label: "Security deposit return", window_days: windowDays,
    authority_note: "per ORC 5321.16, confirmed by counsel",
    active: 1, created_at: stamp(),
  });
}

async function openOne({ moveout = "2026-06-30", cents = 120000 } = {}) {
  await takeDeposit({
    companyId: world.companyId, leaseId: world.leaseId,
    amountCents: cents, date: "2026-01-01", by: "test" });
  await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", cents, world.leaseId);
  return await openReturn({
    companyId: world.companyId, leaseId: world.leaseId, moveoutDate: moveout, by: "test" });
}

describe("the list", () => {
  test("it shows what is held and how long is left", async () => {
    await rule(30);
    await openOne({ moveout: addDays(today(), -5) });

    const { body } = await agent.text("/app/deposits");
    assert.match(body, /\$1,200\.00/, "what is held");
    assert.match(body, /days left/);
    assert.match(body, /held in trust/, "and the company total, so the two add up");
  });

  test("an overdue one is called out at the top, with what it costs", async () => {
    await rule(30);
    await openOne({ moveout: addDays(today(), -60) });

    const { body } = await agent.text("/app/deposits");
    assert.match(body, /past its deadline/i);
    assert.match(body, /carries a penalty well beyond/);
    assert.match(body, /days late/);
  });

  test("with no rule it says so rather than inventing a deadline", async () => {
    await openOne();
    const { body } = await agent.text("/app/deposits");
    assert.match(body, /no rule set/);
    assert.doesNotMatch(body, /days left/);
  });

  test("nothing open is an empty state that explains itself", async () => {
    const { body } = await agent.text("/app/deposits");
    assert.match(body, /Nothing open/);
    assert.match(body, /opens by itself when a move-out is recorded/);
  });
});

describe("one return", () => {
  test("the statement is shown before anything is settled", async () => {
    await rule(30);
    const ret = await openOne();

    const { body } = await agent.text(`/app/deposits/${ret.id}`);
    assert.match(body, /What will be sent/);
    assert.match(body, /Read it before you settle/);
    assert.match(body, /Deposit held/);
    assert.match(body, /No deductions have been made/);
  });

  test("a deduction goes on through the screen and changes the statement", async () => {
    await rule(30);
    const ret = await openOne();

    const res = await agent.post(`/app/deposits/${ret.id}/deduction`,
      { reason: "Carpet in the second bedroom, beyond fair wear", amount: "450.00" },
      { csrfFrom: `/app/deposits/${ret.id}` });
    assert.equal(res.status, 303);

    const { body } = await agent.text(`/app/deposits/${ret.id}`);
    assert.match(body, /Carpet in the second bedroom/);
    assert.match(body, /\$750\.00/, "what would go back now");
  });

  test("an overdrawn deposit is refused with the arithmetic in the message", async () => {
    await rule(30);
    const ret = await openOne();
    const res = await agent.post(`/app/deposits/${ret.id}/deduction`,
      { reason: "Everything", amount: "2000.00" },
      { csrfFrom: `/app/deposits/${ret.id}` });
    const message = decodeURIComponent(res.headers.get("location"));
    assert.match(message, /cannot be overdrawn/);
    assert.match(message, /\$1,200\.00 held/);
    assert.equal((await all("SELECT id FROM deposit_deduction")).length, 0);
  });

  test("an amount that is not an amount is refused", async () => {
    await rule(30);
    const ret = await openOne();
    const res = await agent.post(`/app/deposits/${ret.id}/deduction`,
      { reason: "Carpet", amount: "four hundred" },
      { csrfFrom: `/app/deposits/${ret.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /not an amount/);
  });

  test("settling posts, queues the statement, and says which", async () => {
    await rule(30);
    await run("UPDATE tenant SET email = ? WHERE id = ?", "ravi@example.test", world.tenantId);
    const ret = await openOne();
    await agent.post(`/app/deposits/${ret.id}/deduction`,
      { reason: "Cleaning beyond fair wear", amount: "120.00" },
      { csrfFrom: `/app/deposits/${ret.id}` });

    const res = await agent.post(`/app/deposits/${ret.id}/settle`,
      { date: "2026-07-05" }, { csrfFrom: `/app/deposits/${ret.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /statement is queued/);

    const settled = await get("SELECT * FROM deposit_return WHERE id = ?", ret.id);
    assert.equal(settled.status, "settled");
    assert.ok(settled.journal_id);
    assert.ok(settled.itemisation_outbox_id);

    const { body } = await agent.text(`/app/deposits/${ret.id}`);
    assert.match(body, /What was sent/);
    assert.match(body, /Exactly as it went out/);
    assert.doesNotMatch(body, /Settle and send/, "and there is nothing left to press");
  });

  test("it is recorded, because it moved somebody else's money", async () => {
    await rule(30);
    const ret = await openOne();
    await agent.post(`/app/deposits/${ret.id}/settle`, { date: "2026-07-05" },
      { csrfFrom: `/app/deposits/${ret.id}` });

    const row = await get(
      "SELECT * FROM audit_log WHERE company_id = ? AND action = 'deposit_returned'",
      world.companyId);
    assert.ok(row);
    assert.match(row.detail, /\$1,200\.00 returned/);
  });

  test("a return with nothing posted against it says so rather than offering to pay out",
    async () => {
      /* The lease may carry a deposit that was never posted. Until it is,
         there is nothing to return, and a screen that offered to pay it
         anyway would be paying out money the books do not know about. */
      await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);
      const ret = await openReturn({
        companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-06-30" });

      const { body } = await agent.text(`/app/deposits/${ret.id}`);
      assert.match(body, /books say nothing is held/);
      assert.match(body, /no posting was ever made/);
    });
});

describe("who may reach it", () => {
  test("a leasing agent cannot, because it is money", async () => {
    const leasing = client(app.origin);
    const signedIn = await leasing.signIn(world.staff.leasing.email, f.PASSWORD);
    assert.equal(signedIn.signedIn, true);

    assert.equal((await leasing.get("/app/deposits")).status, 403);
    const post = await leasing.post("/app/deposits/anything/settle", {}, { csrf: null });
    assert.ok(post.status >= 400);
  });

  test("another company's return is not reachable by id", async () => {
    const other = await f.makeWorld({ name: "Not Yours Ltd" });
    await takeDeposit({
      companyId: other.companyId, leaseId: other.leaseId,
      amountCents: 50000, date: "2026-01-01", by: "test" });
    const theirs = await openReturn({
      companyId: other.companyId, leaseId: other.leaseId, moveoutDate: "2026-06-30" });

    assert.equal((await agent.get(`/app/deposits/${theirs.id}`)).status, 404);
    const settle = await agent.post(`/app/deposits/${theirs.id}/settle`, { date: today() },
      { csrfFrom: "/app/deposits" });
    assert.equal(settle.status, 404);

    const still = await get("SELECT status FROM deposit_return WHERE id = ?", theirs.id);
    assert.equal(still.status, "open");
  });
});
