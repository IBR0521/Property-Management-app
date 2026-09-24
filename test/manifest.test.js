/* The installed app's name.

   OPEN-ITEMS P4. An installed icon said "Operations" or "Your home" — never
   the company's own name — and the reason was real rather than an oversight:
   **a manifest is fetched without credentials**, so the request carries no
   session and the server cannot tell who is installing.

   The way round it is to put the identity in the URL. The page already knows
   the company when it renders the `<link rel="manifest">`, so it points at
   `/m/<slug>/app.webmanifest`. Nothing secret is exposed: a company's name
   and slug are already public on the listing page at `/c/<slug>`, and a
   manifest carries no more than a name, an icon and a start URL. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { manifestUrl, buildManifest } from "../server/lib/manifest.js";

let app, world, agent;

before(async () => { await freshDatabase(); await truncateAll(); app = await startApp(); });
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Leafridge Property Management", staffRoles: ["admin"] });
  agent = client(app.origin);
  assert.equal((await agent.signIn(world.staff.admin.email, f.PASSWORD)).signedIn, true);
});

const company = () => get("SELECT name, slug FROM company WHERE id = ?", world.companyId);

describe("the name an installed icon carries", () => {
  test("is the company's, not the product's", async () => {
    const c = await company();
    const m = await buildManifest("app", c.slug);
    assert.equal(m.name, "Leafridge Property Management");
    assert.notEqual(m.name, "Property operations");
  });

  test("and the short name survives being put under an icon", async () => {
    const c = await company();
    const m = await buildManifest("app", c.slug);
    assert.ok(m.short_name.length <= 12,
      `"${m.short_name}" is too long for a home screen to show`);
    assert.equal(m.short_name, "Leafridge", "the first word, not a truncation mid-word");
  });

  test("a short company name is left alone", async () => {
    await run("UPDATE company SET name = 'Acme' WHERE id = ?", world.companyId);
    const c = await company();
    assert.equal((await buildManifest("app", c.slug)).short_name, "Acme");
  });

  test("a single very long word is truncated rather than left to overflow", async () => {
    await run("UPDATE company SET name = 'Northamptonshireproperties' WHERE id = ?",
      world.companyId);
    const c = await company();
    const m = await buildManifest("app", c.slug);
    assert.ok(m.short_name.length <= 12);
    assert.match(m.short_name, /…$/, "and says it was cut");
  });

  test("the tenant's portal says whose home it is", async () => {
    const c = await company();
    const m = await buildManifest("portal", c.slug);
    assert.match(m.name, /Leafridge/);
    assert.match(m.name, /your home/i,
      "a tenant is installing the place they pay rent, not a back office");
  });
});

describe("when the company cannot be told", () => {
  test("an unknown slug falls back to the generic wording", async () => {
    const m = await buildManifest("app", "no-such-company");
    assert.equal(m.name, "Property operations",
      "an install is not the moment to argue with somebody about a URL");
  });

  test("no slug at all does too", async () => {
    assert.equal((await buildManifest("app", null)).name, "Property operations");
  });

  test("a kind that is not one returns nothing", async () => {
    assert.equal(await buildManifest("nonsense", "x"), null);
  });

  test("and the URL falls back when a company has no slug", () => {
    assert.equal(manifestUrl("app", null), "/app-assets/manifest.webmanifest");
    assert.equal(manifestUrl("portal", {}), "/app-assets/portal.webmanifest");
  });
});

describe("serving it", () => {
  test("the route answers with the right content type", async () => {
    const c = await company();
    const res = await agent.get(`/m/${c.slug}/app.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
  });

  test("it is valid JSON with what a home screen needs", async () => {
    const c = await company();
    const { body } = await agent.text(`/m/${c.slug}/app.webmanifest`);
    const m = JSON.parse(body);
    assert.equal(m.name, "Leafridge Property Management");
    assert.equal(m.start_url, "/app");
    assert.equal(m.display, "standalone");
    assert.ok(m.icons.length >= 4, "including the maskable pair");
  });

  test("it is served without a session, which is the whole point", async () => {
    const c = await company();
    const anon = client(app.origin);
    const res = await anon.get(`/m/${c.slug}/app.webmanifest`);
    assert.equal(res.status, 200,
      "a manifest is fetched without credentials; requiring one would serve nobody");
  });

  test("an unknown slug still serves a manifest rather than a 404", async () => {
    const res = await agent.get("/m/not-a-company/app.webmanifest");
    assert.equal(res.status, 200);
  });

  test("a kind that is not one is a 404", async () => {
    const c = await company();
    const res = await agent.get(`/m/${c.slug}/nonsense.webmanifest`);
    assert.equal(res.status, 404);
  });
});

describe("the pages point at it", () => {
  test("a staff page links its own company's manifest", async () => {
    const c = await company();
    const { body } = await agent.text("/app");
    assert.match(body, new RegExp(`rel="manifest" href="/m/${c.slug}/app\\.webmanifest"`),
      "the page knows the company, so the link can carry it");
  });
});
