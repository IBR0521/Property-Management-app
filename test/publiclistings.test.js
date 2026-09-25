/* The public listing pages.

   This is the first page this application serves to strangers at scale.
   Everything public before it — the repair form, the application, an owner's
   statement — was behind a token somebody was given; a listing page is meant
   to be found, which makes it the first thing worth pointing a scraper at.

   So the things asserted here are: it shows only what the company published,
   one company at a time, it cannot be walked to enumerate a portfolio, the
   enquiry form is rate limited like every other public form, and it never
   tells anybody a viewing is booked. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { LIMITS } from "../server/lib/ratelimit.js";

let app, world, company, visitor;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Public Co" });
  company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
  visitor = client(app.origin);
});

async function listing(fields = {}) {
  const listingId = id();
  await insert("listing", {
    id: listingId, company_id: world.companyId, unit_id: world.unitId,
    status: "active", syndicate: 0,
    headline: "Bright two-bed near the park",
    description: "Quiet street, off-road parking.",
    rent_cents: 145000, deposit_cents: 145000,
    available_date: "2026-08-01", lease_months: 12, pets: "cats",
    parking: "One space", laundry: "In unit",
    created_at: stamp(), updated_at: stamp(),
    ...fields,
  });
  return await get("SELECT * FROM listing WHERE id = ?", listingId);
}

const at = (path) => `/c/${company.slug}${path}`;

describe("the index", () => {
  test("a live listing can be found, and the staff app cannot", async () => {
    const l = await listing();
    const { body } = await visitor.text(at("/listings"));
    assert.match(body, /name="robots" content="index, follow"/);
    assert.match(body, new RegExp(`rel="canonical" href="[^"]+/c/${company.slug}/listings"`));
    const one = await visitor.text(at(`/listings/${l.id}`));
    assert.match(one.body, /application\/ld\+json/);
    assert.match(one.body, /Bright two-bed near the park/);
    const map = await visitor.get(at("/sitemap.xml"));
    assert.equal(map.status, 200);
    assert.match(await map.text(), new RegExp(`/listings/${l.id}`));
    const robots = await (await visitor.get("/robots.txt")).text();
    assert.match(robots, /Disallow: \/app/);
    assert.match(robots, /Allow: \/c\//);
  });

  test("it shows what is live, with the rent", async () => {
    await listing();
    const { body } = await visitor.text(at("/listings"));
    assert.match(body, /Bright two-bed near the park/);
    assert.match(body, /\$1,450\.00/);
    assert.match(body, /Available from Public Co/);
  });

  test("a draft is not on it, because it was not published", async () => {
    await listing({ status: "draft" });
    const { body } = await visitor.text(at("/listings"));
    assert.doesNotMatch(body, /Bright two-bed/);
    assert.match(body, /Nothing right now/);
  });

  test("a listing does not need syndication to be on the company's own page", async () => {
    /* Syndication is about giving an address to every aggregator on the
       internet. Putting it on your own page is not the same decision. */
    await listing({ syndicate: 0 });
    const { body } = await visitor.text(at("/listings"));
    assert.match(body, /Bright two-bed/);
  });

  test("another company's listings are not on it", async () => {
    const other = await f.makeWorld({ name: "Somebody Else Ltd" });
    await insert("listing", {
      id: id(), company_id: other.companyId, unit_id: other.unitId,
      status: "active", syndicate: 0, headline: "Their flat", rent_cents: 99900,
      created_at: stamp(), updated_at: stamp() });

    const { body } = await visitor.text(at("/listings"));
    assert.doesNotMatch(body, /Their flat/);
  });

  test("an address that matches no company names none of them", async () => {
    const res = await visitor.get("/c/nobody/listings");
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.doesNotMatch(body, /Public Co/,
      "listing every company so a visitor can pick is portfolio enumeration one level up");
  });
});

describe("one listing", () => {
  test("it says what somebody needs to decide whether to ask", async () => {
    const l = await listing();
    const { body } = await visitor.text(at(`/listings/${l.id}`));

    assert.match(body, /Bright two-bed near the park/);
    assert.match(body, /Quiet street, off-road parking/);
    assert.match(body, /\$1,450\.00/);
    assert.match(body, /Cats considered/);
    assert.match(body, /One space/);
    assert.match(body, /Not permitted/, "smoking, said either way rather than left out");
  });

  test("one that has gone says so rather than looking broken", async () => {
    const l = await listing({ status: "leased" });
    const res = await visitor.get(at(`/listings/${l.id}`));
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /That one has gone/);
    assert.match(body, /See what else is/);
  });

  test("another company's listing is not reachable by id", async () => {
    const other = await f.makeWorld({ name: "Somebody Else Ltd" });
    const theirId = id();
    await insert("listing", {
      id: theirId, company_id: other.companyId, unit_id: other.unitId,
      status: "active", syndicate: 0, headline: "Their flat", rent_cents: 99900,
      created_at: stamp(), updated_at: stamp() });

    const res = await visitor.get(at(`/listings/${theirId}`));
    assert.equal(res.status, 404);
  });

  test("it does not promise a viewing it cannot arrange", async () => {
    const l = await listing();
    const { body } = await visitor.text(at(`/listings/${l.id}`));
    assert.match(body, /A viewing request is a request/);
    assert.match(body, /Nobody is booked in by this form/);
    assert.doesNotMatch(body, /Book a viewing/);
  });
});

describe("the enquiry", () => {
  test("it lands in the inbox, attached to the listing", async () => {
    const l = await listing();
    const res = await visitor.post(at(`/listings/${l.id}/enquire`), {
      name: "Ravi Bhatt", email: "ravi@example.test", phone: "614-555-0110",
      move_in: "2026-09-01", viewing: "Weekday evenings",
      message: "Is the parking off-street?",
    }, { csrfFrom: at(`/listings/${l.id}`) });

    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location")), /Nothing is booked yet/);

    const thread = await get("SELECT * FROM thread WHERE company_id = ?", world.companyId);
    assert.ok(thread, "an enquiry a manager never sees is an enquiry that did not happen");
    assert.equal(thread.about_type, "listing");
    assert.equal(thread.about_id, l.id,
      "a conversation that started from a vacancy stays attached to it");
    assert.match(thread.subject, /Enquiry/);

    const message = await get("SELECT * FROM message WHERE thread_id = ?", thread.id);
    assert.match(message.body, /Ravi Bhatt asked about/);
    assert.match(message.body, /614-555-0110/);
    assert.match(message.body, /Could view: Weekday evenings/);
    assert.match(message.body, /Is the parking off-street\?/);
  });

  test("without a name and a usable email it goes nowhere", async () => {
    const l = await listing();
    for (const fields of [
      { name: "", email: "ravi@example.test" },
      { name: "Ravi", email: "not-an-email" },
      { name: "Ravi", email: "" },
    ]) {
      const res = await visitor.post(at(`/listings/${l.id}/enquire`), fields,
        { csrfFrom: at(`/listings/${l.id}`) });
      assert.match(decodeURIComponent(res.headers.get("location")), /name and an email/);
    }
    assert.equal((await all("SELECT id FROM thread")).length, 0);
  });

  test("a listing that has gone takes no more enquiries", async () => {
    const l = await listing();
    const path = at(`/listings/${l.id}`);
    const token = await visitor.csrf(path);
    await run("UPDATE listing SET status = 'leased' WHERE id = ?", l.id);

    const res = await visitor.post(`${path}/enquire`,
      { name: "Ravi Bhatt", email: "ravi@example.test" }, { csrf: token });
    assert.match(decodeURIComponent(res.headers.get("location")), /no longer available/);
    assert.equal((await all("SELECT id FROM thread")).length, 0);
  });

  test("it is rate limited, like every other public form", async () => {
    const l = await listing();
    const path = at(`/listings/${l.id}`);
    const max = LIMITS.enquiry.max;

    for (let i = 0; i <= max; i++) {
      await visitor.post(`${path}/enquire`,
        { name: `Person ${i}`, email: `p${i}@example.test` }, { csrfFrom: path });
    }

    const res = await visitor.post(`${path}/enquire`,
      { name: "One more", email: "more@example.test" }, { csrfFrom: path });
    assert.match(decodeURIComponent(res.headers.get("location")), /a lot of enquiries/);

    const threads = await all("SELECT id FROM thread");
    assert.ok(threads.length <= max,
      "the form must not be a way to post into somebody's inbox all afternoon");
  });

  test("a forged post without the token is refused", async () => {
    const l = await listing();
    const res = await visitor.post(at(`/listings/${l.id}/enquire`),
      { name: "Ravi", email: "ravi@example.test" }, { csrf: null });
    assert.equal(res.status, 403);
    assert.equal((await all("SELECT id FROM thread")).length, 0);
  });
});

describe("what the company sees", () => {
  test("its own page and its own feed address are on the vacancies screen", async () => {
    const agent = client(app.origin);
    await agent.signIn(world.staff.admin.email, f.PASSWORD);
    const { body } = await agent.text("/app/listings");

    assert.match(body, new RegExp(`/c/${company.slug}/listings`));
    assert.match(body, new RegExp(`/feeds/${company.slug}/listings\\.xml`));
    assert.match(body, /carries no\s+listings on purpose/,
      "so nobody hands a network the address that would publish everybody");
    assert.match(body, /four to six weeks/,
      "and knows a feed does nothing until somebody approves it");
  });
});
