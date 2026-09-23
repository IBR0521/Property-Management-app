/* The technician's view, driven the way a phone would drive it.

   The role already existed and the capability table already said what it
   meant — "the jobs assigned to them and the addresses those jobs are at, and
   nothing else". This is the screen that finally honours it, so most of these
   tests are about the boundary rather than the feature: somebody else's job is
   a 404, somebody else's part cannot be removed, and a technician still
   cannot see the queue, the portfolio or a tenant they are not visiting.

   The other half is what check-in deliberately does not record. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today } from "../server/lib/dates.js";

let app, world, tech;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Van Co", staffRoles: ["admin", "technician"] });
  tech = world.staff.technician;
  await run("UPDATE work_order SET assigned_staff_id = ? WHERE id = ?", tech.id, world.workOrderId);
});

async function asTech() {
  const c = client(app.origin);
  const res = await c.signIn(tech.email, f.PASSWORD);
  assert.equal(res.signedIn, true, "the technician should be able to sign in");
  return c;
}

/* A second job, assigned to nobody — the one that must stay invisible. */
async function somebodyElsesJob() {
  const other = await f.makeWorkOrder(world.companyId, world.unitId, { leaseId: world.leaseId });
  await run("UPDATE work_order SET assigned_staff_id = ? WHERE id = ?", world.staff.admin.id, other);
  return other;
}

/* --- what they can see ---------------------------------------------------- */

describe("the list", () => {
  test("it shows the jobs assigned to them", async () => {
    const c = await asTech();
    const { res, body } = await c.text("/app/jobs");
    assert.equal(res.status, 200);
    const wo = await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);
    assert.ok(body.includes(wo.summary), "their own job should be listed");
  });

  test("and never anybody else's", async () => {
    const other = await somebodyElsesJob();
    await run("UPDATE work_order SET summary = ? WHERE id = ?", "Not this technician's job", other);

    const c = await asTech();
    const { body } = await c.text("/app/jobs");
    assert.ok(!body.includes("Not this technician's job"));
  });

  test("a job booked for a past date is today's problem, not later's", async () => {
    /* Sorting on the date alone files an overdue job under "booked for
       later", which is where it stays until somebody notices. */
    await run("UPDATE work_order SET scheduled_start = ? WHERE id = ?",
      "2020-01-01T09:00", world.workOrderId);

    const c = await asTech();
    const { body } = await c.text("/app/jobs");
    const later = body.indexOf("Booked for later");
    assert.equal(later, -1, "an overdue job must not be filed under later");
    assert.match(body, /job today/);
  });

  test("a job booked for next week is not", async () => {
    const next = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16);
    await run("UPDATE work_order SET scheduled_start = ? WHERE id = ?", next, world.workOrderId);

    const c = await asTech();
    const { body } = await c.text("/app/jobs");
    assert.match(body, /Booked for later/);
    assert.match(body, /Nothing today/);
  });

  test("the sidebar offers nothing that would answer 403", async () => {
    /* The codebase's own rule, in server/views/layout.js: "a nav full of
       links that 403 is worse than a shorter nav". It had drifted — Queue,
       Properties, Inbox and Messages carried no capability annotation, so a
       technician was shown four links that all refuse. The nav now asks the
       same function the gate asks. */
    const c = await asTech();
    const { body } = await c.text("/app/jobs");
    const nav = body.slice(body.indexOf("<nav"), body.indexOf("</nav>"));
    const links = [...nav.matchAll(/href="(\/app[^"]*)"/g)].map((m) => m[1]);

    assert.ok(links.includes("/app/jobs"), "their own screen should be there");
    for (const href of links) {
      const res = await c.get(href);
      assert.ok(res.status < 400, `the sidebar offers ${href}, which answers ${res.status}`);
    }
  });

  test("the technician still cannot reach the rest of the application", async () => {
    /* The capability table said this before the screen existed. It should
       still be true now that it does. */
    const c = await asTech();
    for (const path of [
      "/app", "/app/maintenance", "/app/accounting", "/app/payments",
      /* Both of these were reachable until this phase: the role carried
         `property.view`, which gates exactly these two and nothing else. */
      "/app/portfolio", "/app/compliance",
    ]) {
      const res = await c.get(path);
      assert.ok(res.status === 403 || res.status === 303, `${path} answered ${res.status}`);
    }
  });
});

describe("signing in", () => {
  test("a technician lands somewhere they can actually open", async () => {
    /* Found by signing in as one. Sign-in always redirected to "/app", which
       is the company's queue and needs `queue.view` — so the very first
       screen of the product, on the phone this role exists for, was a 403. */
    const c = client(app.origin);
    const res = await c.signIn(tech.email, f.PASSWORD);

    assert.equal(res.signedIn, true);
    assert.equal(res.location, "/app/jobs");
    assert.equal((await c.get(res.location)).status, 200);
  });

  test("and an administrator still lands on the queue", async () => {
    const c = client(app.origin);
    const res = await c.signIn(world.staff.admin.email, f.PASSWORD);
    assert.equal(res.location, "/app");
  });

  test("a 403 offers a way back that is not another 403", async () => {
    const c = await asTech();
    const { res, body } = await c.text("/app/accounting");
    assert.equal(res.status, 403);
    assert.match(body, /href="\/app\/jobs"/, "the way out must be somewhere they can open");
  });
});

describe("one job", () => {
  test("it opens, with the address and a way to get there", async () => {
    const c = await asTech();
    const { res, body } = await c.text(`/app/jobs/${world.workOrderId}`);
    assert.equal(res.status, 200);
    assert.match(body, /maps\.google\.com/, "a plain maps link, no SDK and no key");

    /* Every action on this page is a form that posts. The only script the
       document loads at all is the service-worker registration from the
       shared shell, which nothing here depends on. */
    const scripts = [...body.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(scripts, ['<script src="/app-assets/js/register-sw.js" defer>'],
      "this page must work with no JavaScript of its own");
    for (const action of ["check-in", "note", "photos", "part", "complete"]) {
      assert.ok(body.includes(`/app/jobs/${world.workOrderId}/${action}"`),
        `${action} should be a plain form`);
    }
  });

  test("somebody else's job is not found, not forbidden", async () => {
    /* A 403 would confirm the job exists. A technician who guesses an id
       should learn nothing either way. */
    const other = await somebodyElsesJob();
    const c = await asTech();
    assert.equal((await c.get(`/app/jobs/${other}`)).status, 404);
    assert.equal((await c.get("/app/jobs/not-a-real-id")).status, 404);
  });
});

/* --- arriving and leaving ------------------------------------------------- */

describe("check in and out", () => {
  test("arriving records a time", async () => {
    const c = await asTech();
    const res = await c.post(`/app/jobs/${world.workOrderId}/check-in`, {},
      { csrfFrom: `/app/jobs/${world.workOrderId}` });
    assert.equal(res.status, 303);

    const wo = await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);
    assert.ok(wo.checked_in_at, "the time should be recorded");
    assert.equal(wo.checked_in_by, tech.id);
  });

  test("and records no place at all", async () => {
    /* The decision this feature was shaped around. There is nowhere for a
       coordinate to be stored, and the page says so rather than leaving
       somebody to wonder. */
    const c = await asTech();
    await c.post(`/app/jobs/${world.workOrderId}/check-in`, {},
      { csrfFrom: `/app/jobs/${world.workOrderId}` });

    const columns = await all(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'work_order' AND table_schema = 'public'`);
    const located = columns.map((c) => c.column_name)
      .filter((n) => /lat|lon|lng|coord|gps|geo/.test(n));
    assert.deepEqual(located, [], "check-in must not have grown a location column");

    const { body } = await c.text(`/app/jobs/${world.workOrderId}`);
    assert.match(body, /does not record where you are/);
  });

  test("the tenant is told the engineer arrived", async () => {
    /* Somebody waiting in for a repair wants to know. It is the cheapest
       honest thing this screen does. */
    const c = await asTech();
    await c.post(`/app/jobs/${world.workOrderId}/check-in`, {},
      { csrfFrom: `/app/jobs/${world.workOrderId}` });

    const wo = await get("SELECT public_token FROM work_order WHERE id = ?", world.workOrderId);
    const { body } = await client(app.origin).text(`/t/${wo.public_token}`);
    assert.match(body, /Arrived on site/);
  });

  test("leaving before arriving is refused", async () => {
    const c = await asTech();
    const res = await c.post(`/app/jobs/${world.workOrderId}/check-out`, {},
      { csrfFrom: `/app/jobs/${world.workOrderId}` });
    assert.equal(res.status, 400);
  });

  test("coming back sets a fresh arrival and clears the old departure", async () => {
    /* A two-visit job is ordinary. Leaving the old checked_out_at in place
       would show somebody as having left before they arrived. */
    const c = await asTech();
    const path = `/app/jobs/${world.workOrderId}`;
    await c.post(`${path}/check-in`, {}, { csrfFrom: path });
    await c.post(`${path}/check-out`, {}, { csrfFrom: path });
    await c.post(`${path}/check-in`, {}, { csrfFrom: path });

    const wo = await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);
    assert.ok(wo.checked_in_at);
    assert.equal(wo.checked_out_at, null);
  });
});

/* --- parts ----------------------------------------------------------------- */

describe("parts", () => {
  const path = () => `/app/jobs/${world.workOrderId}`;

  test("a part is free text and a cost, because a catalogue is a different product", async () => {
    const c = await asTech();
    await c.post(`${path()}/part`,
      { description: "2m of 15mm copper", cost: "14.60" }, { csrfFrom: path() });

    const part = await get("SELECT * FROM work_order_part");
    assert.equal(part.description, "2m of 15mm copper");
    assert.equal(Number(part.cost_cents), 1460);
    assert.equal(part.added_by, tech.id);
  });

  test("a part with no cost is allowed and is not a lie about zero", async () => {
    /* "The tenant's own washer" is a part used and nothing spent. */
    const c = await asTech();
    await c.post(`${path()}/part`, { description: "Tenant's own washer" }, { csrfFrom: path() });
    assert.equal(Number((await get("SELECT * FROM work_order_part")).cost_cents), 0);
  });

  test("a part with no description is refused", async () => {
    const c = await asTech();
    await c.post(`${path()}/part`, { cost: "9.99" }, { csrfFrom: path() });
    assert.equal((await all("SELECT id FROM work_order_part")).length, 0);
  });

  test("the total is shown and prefills the final cost", async () => {
    const c = await asTech();
    await c.post(`${path()}/part`, { description: "Trap", cost: "18.00" }, { csrfFrom: path() });
    await c.post(`${path()}/part`, { description: "Sealant", cost: "6.50" }, { csrfFrom: path() });

    const { body } = await c.text(path());
    assert.match(body, /\$24\.50/);
    assert.match(body, /name="actual"[^>]*value="24\.50"/);
  });

  test("a part on another job cannot be removed from this one", async () => {
    const other = await somebodyElsesJob();
    const partId = id();
    await insert("work_order_part", {
      id: partId, company_id: world.companyId, work_order_id: other,
      description: "Not yours", cost_cents: 100, created_at: stamp(),
    });

    const c = await asTech();
    await c.post(`${path()}/part/remove`, { part_id: partId }, { csrfFrom: path() });
    assert.ok(await get("SELECT id FROM work_order_part WHERE id = ?", partId), "it should still be there");
  });

  test("their own part removes", async () => {
    const c = await asTech();
    await c.post(`${path()}/part`, { description: "Wrong one", cost: "1.00" }, { csrfFrom: path() });
    const part = await get("SELECT * FROM work_order_part");
    await c.post(`${path()}/part/remove`, { part_id: part.id }, { csrfFrom: path() });
    assert.equal((await all("SELECT id FROM work_order_part")).length, 0);
  });
});

/* --- notes ----------------------------------------------------------------- */

describe("notes", () => {
  test("a note reaches the tenant's status page", async () => {
    const c = await asTech();
    const path = `/app/jobs/${world.workOrderId}`;
    await c.post(`${path}/note`, { note: "Isolated the supply, waiting on a part" }, { csrfFrom: path });

    const wo = await get("SELECT public_token FROM work_order WHERE id = ?", world.workOrderId);
    const { body } = await client(app.origin).text(`/t/${wo.public_token}`);
    assert.match(body, /Isolated the supply/);
  });
});

/* --- finishing ------------------------------------------------------------- */

describe("finishing a job", () => {
  const path = () => `/app/jobs/${world.workOrderId}`;

  test("it closes the job and goes back to the list", async () => {
    /* The job is finished; what the person holding the phone wants next is
       the next one. */
    const c = await asTech();
    const res = await c.post(`${path()}/complete`,
      { actual: "212.00", note: "Replaced the trap" }, { csrfFrom: path() });

    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /^\/app\/jobs\?/);

    const wo = await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);
    assert.equal(wo.status, "complete");
    assert.equal(Number(wo.actual_cents), 21200);
    assert.ok(wo.closed_at);
  });

  test("the cost reaches the owner's ledger, the same as from a desk", async () => {
    /* The reason the close-out is one shared function and not two. A job
       finished on a phone that never posts the expense is a repair the owner
       is never billed for, and nobody notices until the year end. */
    const c = await asTech();
    await c.post(`${path()}/complete`, { actual: "212.00" }, { csrfFrom: path() });

    const entry = await get(
      "SELECT * FROM ledger_entry WHERE work_order_id = ?", world.workOrderId);
    assert.ok(entry, "no ledger entry was posted");
    assert.equal(Number(entry.amount_cents), -21200);

    /* And the double-entry side of it, which is the invariant that matters. */
    const journal = await get(
      "SELECT * FROM journal WHERE source_type = 'work_order' AND source_id = ?", world.workOrderId);
    assert.ok(journal, "the journal must know about it too");
  });

  test("finishing with no cost posts nothing and is not an error", async () => {
    /* Somebody at the office is invoicing it. */
    const c = await asTech();
    const res = await c.post(`${path()}/complete`, { note: "Office is invoicing" }, { csrfFrom: path() });
    assert.equal(res.status, 303);

    const wo = await get("SELECT * FROM work_order WHERE id = ?", world.workOrderId);
    assert.equal(wo.status, "complete");
    assert.equal(wo.actual_cents, null);
    assert.equal(await get("SELECT id FROM ledger_entry WHERE work_order_id = ?", world.workOrderId), undefined);
  });

  test("somebody else's job cannot be closed", async () => {
    const other = await somebodyElsesJob();
    const c = await asTech();
    const res = await c.post(`/app/jobs/${other}/complete`, { actual: "500.00" },
      { csrfFrom: `/app/jobs/${world.workOrderId}` });

    assert.equal(res.status, 404);
    const after = await get("SELECT * FROM work_order WHERE id = ?", other);
    assert.notEqual(after.status, "complete", "it must not have been closed");
    assert.equal(after.closed_at, null);
    assert.equal(after.actual_cents, null);
  });

  test("a completed job leaves the list", async () => {
    const c = await asTech();
    await c.post(`${path()}/complete`, { actual: "10.00" }, { csrfFrom: path() });
    const { body } = await c.text("/app/jobs");
    assert.match(body, /Nothing today|Nothing assigned/);
  });
});
