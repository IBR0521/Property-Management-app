/* The syndication feed.

   Two properties, and the first one is why this file exists at all.

   **A feed belongs to one company.** The first version of this served every
   company on the platform in one document, labelled with whichever one sorted
   first — so a manager who handed that URL to Zillow would have been
   publishing their competitors' listings under their own management id, and
   the network would have been right to believe them. Found by writing the
   MITS management block, which is the element a feed agreement is matched
   against.

   **Only what was ticked.** Syndication is opt-in per listing and off by
   default, because publishing an address to every aggregator on the internet
   is a decision somebody makes on purpose. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { buildMits, feedsArePerCompany, MITS_VERSION, x } from "../server/lib/listings/mits.js";

let app, world;
const ORIGIN = "https://example.test";

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Feed Co" });
});

async function listing(companyId, unitId, fields = {}) {
  const listingId = id();
  await insert("listing", {
    id: listingId, company_id: companyId, unit_id: unitId,
    status: "active", syndicate: 1,
    headline: "Bright two-bed near the park",
    description: "Quiet street, off-road parking.",
    rent_cents: 145000, deposit_cents: 145000,
    available_date: "2026-08-01", lease_months: 12,
    pets: "cats", laundry: "In unit", parking: "One space",
    created_at: stamp(), updated_at: stamp(),
    ...fields,
  });
  return await get("SELECT * FROM listing WHERE id = ?", listingId);
}

/* A small reader, so the assertions are about the document rather than about
   substrings that happen to appear in it. */
function elements(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>|<${name}\\b[^>]*/>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}
function attr(fragment, name) {
  return new RegExp(`${name}="([^"]*)"`).exec(fragment)?.[1] ?? null;
}
function text(fragment, name) {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(fragment)?.[1] ?? null;
}

/* --- one company's feed is one company's ------------------------------------ */

describe("a feed belongs to one company", () => {
  test("another company's listings are not in it", async () => {
    const other = await f.makeWorld({ name: "Somebody Else Ltd" });
    await listing(world.companyId, world.unitId);
    await listing(other.companyId, other.unitId, {
      headline: "Their flat", rent_cents: 99900 });

    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    assert.match(xml, /Bright two-bed near the park/);
    assert.doesNotMatch(xml, /Their flat/,
      "a shared feed publishes competitors' listings under whoever's name came first");
    assert.doesNotMatch(xml, /Somebody Else Ltd/);
  });

  test("the management block names the company the agreement is with", async () => {
    await listing(world.companyId, world.unitId);
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });

    const management = elements(xml, "Management")[0];
    assert.equal(text(management, "CompanyName"), "Feed Co");
    assert.equal(attr(management, "IDValue"), world.companyId);
    assert.equal(text(management, "MITS_Version"), MITS_VERSION);
    assert.ok(text(management, "GeneratedOn"), "so a network can tell a stale crawl");
  });

  test("the platform-wide URL carries no listings and says where to look", () => {
    const notice = feedsArePerCompany(ORIGIN);
    assert.doesNotMatch(notice, /ILS_Unit/);
    assert.match(notice, /Feeds are per management company/);
    assert.match(notice, /listings\.xml/);
  });
});

/* --- what goes in it -------------------------------------------------------- */

describe("what the document says", () => {
  test("only what was ticked for syndication", async () => {
    await listing(world.companyId, world.unitId, { syndicate: 0 });
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    assert.equal(elements(xml, "ILS_Unit").length, 0,
      "off by default: publishing an address is a decision somebody makes on purpose");
  });

  test("and only what is live", async () => {
    await listing(world.companyId, world.unitId, { status: "leased" });
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    assert.equal(elements(xml, "ILS_Unit").length, 0);
  });

  test("a real address, which both networks require", async () => {
    await listing(world.companyId, world.unitId);
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    const address = elements(xml, "Address")[0];
    assert.ok(text(address, "AddressLine1"));
    assert.ok(text(address, "City"));
    assert.ok(text(address, "State"));
    assert.ok(text(address, "PostalCode"));
    assert.equal(text(address, "Country"), "US");
  });

  test("the price is decimal currency, not cents", async () => {
    await listing(world.companyId, world.unitId, { rent_cents: 145000 });
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    const unit = elements(xml, "ILS_Unit")[0];
    const rent = elements(unit, "MarketRent")[0];
    assert.equal(attr(rent, "Min"), "1450.00",
      "a network reading 145000 would list this at a hundred and forty-five thousand dollars");
  });

  test("every URL in it is absolute, because a crawler has no origin", async () => {
    const l = await listing(world.companyId, world.unitId);
    await insert("listing_photo", {
      id: id(), listing_id: l.id, path: "2026-03/front.jpg", rank: 1,
      caption: "The front", created_at: stamp() });

    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    for (const src of [...xml.matchAll(/<Src>([^<]*)<\/Src>/g)].map((m) => m[1])) {
      assert.match(src, /^https:\/\//, `${src} means nothing to a crawler`);
    }
    assert.match(xml, /<ILS_UnitURL>https:\/\/example\.test\/c\//,
      "and the page about the listing is one a person can open");
  });

  test("a building with several vacancies is one Property with several units", async () => {
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "2" });
    await listing(world.companyId, world.unitId);
    await listing(world.companyId, second, { headline: "The other one" });

    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    assert.equal(elements(xml, "Property").length, 1,
      "the same address eight times is what a search result should not look like");
    assert.equal(elements(xml, "ILS_Unit").length, 2);
    assert.match(xml, /<UnitCount>2<\/UnitCount>/);
  });

  test("two companies on the same road are not merged", async () => {
    /* Keyed on the property's own id rather than on its address. */
    const other = await f.makeWorld({ name: "Same Road Ltd" });
    await run("UPDATE property SET line1 = ?, zip = ? WHERE company_id = ?",
      "1 Shared Road", "43201", other.companyId);
    await run("UPDATE property SET line1 = ?, zip = ? WHERE company_id = ?",
      "1 Shared Road", "43201", world.companyId);

    await listing(world.companyId, world.unitId);
    await listing(other.companyId, other.unitId, { headline: "Theirs" });

    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    assert.equal(elements(xml, "Property").length, 1);
    assert.doesNotMatch(xml, /Theirs/);
  });

  test("what somebody typed cannot break the document", async () => {
    await listing(world.companyId, world.unitId, {
      headline: 'Bright & airy <b>"two-bed"</b>',
      description: "Rent < market. Landlord & agent both reachable.",
    });
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });

    assert.doesNotMatch(xml, /<b>/, "raw markup from a description would end the element early");
    assert.match(xml, /Bright &amp; airy &lt;b&gt;&quot;two-bed&quot;&lt;\/b&gt;/);
    assert.match(xml, /Rent &lt; market/);
  });

  test("the five characters that must never appear raw", () => {
    assert.equal(x(`& < > " '`), "&amp; &lt; &gt; &quot; &apos;");
    assert.equal(x(null), "");
  });

  test("only the amenities that were filled in", async () => {
    await listing(world.companyId, world.unitId, {
      laundry: "In unit", parking: null, utilities_note: null, smoking: 0 });
    const xml = await buildMits({ companyId: world.companyId, origin: ORIGIN });
    const amenities = elements(xml, "Amenity");
    assert.equal(amenities.length, 1, "an empty element is noise a network has to filter");
    assert.match(amenities[0], /In unit/);
  });
});

/* --- serving it ------------------------------------------------------------- */

describe("the routes", () => {
  test("a company's feed is at its own address", async () => {
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    await listing(world.companyId, world.unitId);

    const res = await fetch(`${app.origin}/feeds/${company.slug}/listings.xml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/xml/);
    const xml = await res.text();
    assert.match(xml, /Bright two-bed near the park/);
    assert.match(xml, /Feed Co/);
  });

  test("the platform-wide one answers and publishes nothing", async () => {
    await listing(world.companyId, world.unitId);
    const res = await fetch(`${app.origin}/feeds/listings.xml`);
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.doesNotMatch(xml, /Bright two-bed/,
      "somebody will hand a network the obvious URL, and it must not publish everybody");
    assert.match(xml, /per management company/);
  });

  test("an address that matches no company is a 404, in XML", async () => {
    const res = await fetch(`${app.origin}/feeds/nobody/listings.xml`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /application\/xml/,
      "a crawler that gets HTML here logs a parse error instead of a status");
  });

  test("a feed needs no account, because an aggregator does not hold one", async () => {
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    const res = await fetch(`${app.origin}/feeds/${company.slug}/listings.xml`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-robots-tag"), "noindex",
      "a feed is for machines that were pointed at it, not for search engines");
  });
});
