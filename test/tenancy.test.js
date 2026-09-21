/* The public surface, with more than one company.

   Phase 0's isolation test drives every route as company A's staff. A public
   page has no "acting as", so the entire public surface fell outside it — and
   that is exactly where the single-company assumption lived. Five handlers
   resolved their company with `SELECT * FROM company LIMIT 1`, four of them
   public.

   The failure was not a leak. The unit lookup was correctly scoped, so a
   sticker belonging to the second company found nothing and its tenant was
   told their own address was not one we manage, under the first company's
   name. A feature that works for exactly one customer, on a platform meant for
   many. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { slugify, slugProblem, uniqueSlug } from "../server/lib/slug.js";

let app, A, B;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  A = await f.makeWorld({ name: "Alpha Management" });
  B = await f.makeWorld({ name: "Bravo Property Group" });
  A.company = await get("SELECT * FROM company WHERE id = ?", A.companyId);
  B.company = await get("SELECT * FROM company WHERE id = ?", B.companyId);
});

after(async () => { await app.close(); await closeDb(); });

describe("a QR sticker works for the company that printed it", () => {
  test("each company's sticker resolves to its own units and branding", async () => {
    for (const world of [A, B]) {
      const c = client(app.origin);
      const res = await c.get(`/r/${world.reportToken}`);
      assert.equal(res.status, 303);

      const page = await c.text(res.headers.get("location").replace(app.origin, ""));
      assert.equal(page.res.status, 200);

      const company = world.company;
      const other = world === A ? B.company : A.company;

      assert.ok(page.body.includes(company.name),
        `${company.name}'s sticker must show ${company.name}`);
      assert.ok(!page.body.includes(other.name),
        `${company.name}'s sticker must not show ${other.name} — this was the bug`);
      assert.match(page.body, /What kind of problem is it\?/,
        "the address must be resolved, not asked for again");
    }
  });

  test("a report filed from a sticker belongs to that sticker's company", async () => {
    const c = client(app.origin);
    const csrf = await c.csrf(`/report?u=${B.reportToken}&category=plumbing`);
    const res = await c.post("/report", {
      unit_token: B.reportToken, category: "plumbing", closest: "one_fixture",
      summary: "Tap drips", phone: "6145550142",
    }, { csrf });
    assert.equal(res.status, 303);

    const wo = await get(
      "SELECT company_id, unit_id FROM work_order ORDER BY created_at DESC LIMIT 1");
    assert.equal(wo.company_id, B.companyId,
      "filed against the sticker's company, not whichever row came back first");
    assert.equal(wo.unit_id, B.unitId);
  });
});

describe("the application form belongs to one company", () => {
  test("each slug serves only its own vacancies", async () => {
    // Give each company a vacant unit so there is something to list.
    for (const world of [A, B]) {
      const p = await f.makeProperty(world.companyId, world.ownerId, { line1: `${world.company.name} Vacancy Road` });
      await f.makeUnit(world.companyId, p, { label: "9", status: "vacant" });
    }

    for (const world of [A, B]) {
      const c = client(app.origin);
      const { res, body } = await c.text(`/c/${world.company.slug}/apply`);
      assert.equal(res.status, 200);
      const other = world === A ? B.company : A.company;
      assert.ok(body.includes(`${world.company.name} Vacancy Road`),
        `${world.company.slug} must list its own vacancies`);
      assert.ok(!body.includes(`${other.name} Vacancy Road`),
        `${world.company.slug} must not list ${other.name}'s`);
    }
  });

  test("an unknown slug is a 404, not somebody else's form", async () => {
    const c = client(app.origin);
    const res = await c.get("/c/not-a-real-company/apply");
    assert.equal(res.status, 404);
  });
});

describe("with several companies, nothing guesses", () => {
  test("bare /report asks for the missing company instead of picking one", async () => {
    const c = client(app.origin);
    const { res, body } = await c.text("/report");
    assert.equal(res.status, 404);
    assert.match(body, /missing the company/i);
    /* And it names none of them: listing every company so a visitor can choose
       is the portfolio-enumeration mistake one level up. */
    assert.ok(!body.includes(A.company.name) && !body.includes(B.company.name),
      "the fallback page must not enumerate the platform's customers");
  });

  test("bare /apply does the same", async () => {
    const c = client(app.origin);
    const { res, body } = await c.text("/apply");
    assert.equal(res.status, 404);
    assert.ok(!body.includes(A.company.name) && !body.includes(B.company.name));
  });

  test("the sign-in page shows no customer's name", async () => {
    const c = client(app.origin);
    const { body } = await c.text("/app/sign-in");
    assert.ok(!body.includes(A.company.name) && !body.includes(B.company.name),
      "there is no way to know whose sign-in page this is until credentials arrive");
  });
});

describe("with exactly one company, the bare paths still work", () => {
  test("a single company needs no slug", async () => {
    /* The development setup and the first customer. Breaking these would be
       gratuitous, and there is no ambiguity to resolve. */
    await truncateAll();
    const only = await f.makeWorld({ name: "Only Company" });
    const c = client(app.origin);

    const report = await c.text("/report");
    assert.equal(report.res.status, 200);
    assert.ok(report.body.includes("Only Company"));

    const apply = await c.text("/apply");
    assert.equal(apply.res.status, 200);

    // Put the two-company world back for any test that runs after this one.
    await truncateAll();
    A = await f.makeWorld({ name: "Alpha Management" });
    B = await f.makeWorld({ name: "Bravo Property Group" });
    A.company = await get("SELECT * FROM company WHERE id = ?", A.companyId);
    B.company = await get("SELECT * FROM company WHERE id = ?", B.companyId);
  });
});

describe("slugs", () => {
  test("a name becomes a readable handle", () => {
    assert.equal(slugify("Leafridge Property Management"), "leafridge-property-management");
    assert.equal(slugify("Bravo & Co."), "bravo-co");
    assert.equal(slugify("Ünïcode Realty"), "unicode-realty", "accents fold rather than drop the word");
    assert.equal(slugify("   --- "), "");
  });

  test("collisions get a suffix, because Smith Properties is not a rare name", async () => {
    const first = await uniqueSlug("Smith Properties");
    await f.makeCompany("Smith Properties", { slug: first });
    const second = await uniqueSlug("Smith Properties");
    assert.notEqual(first, second);
    assert.match(second, /-2$/);
  });

  test("a company cannot claim a route the application owns", async () => {
    for (const reserved of ["app", "api", "signup", "health", "assets"]) {
      assert.ok(slugProblem(reserved), `${reserved} must be refused`);
      const issued = await uniqueSlug(reserved);
      assert.notEqual(issued, reserved, `uniqueSlug must not hand out ${reserved}`);
    }
  });

  test("hand-typed handles are validated", () => {
    assert.equal(slugProblem("ok-name"), null);
    assert.ok(slugProblem("Has Spaces"));
    assert.ok(slugProblem("-leading"));
    assert.ok(slugProblem("double--hyphen"));
    assert.ok(slugProblem("a"));
    assert.ok(slugProblem(""));
  });

  test("every company has one, and no two share", async () => {
    const rows = await all("SELECT slug FROM company");
    assert.ok(rows.every((r) => r.slug && r.slug.length >= 2));
    assert.equal(new Set(rows.map((r) => r.slug)).size, rows.length);
  });
});
