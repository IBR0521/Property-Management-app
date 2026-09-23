/* The reports section, over HTTP.

   The thing worth testing hard here is the authorisation, because it is the
   one place in this application where the gate cannot do it.

   Everywhere else, a path maps to a capability and the app-level gate
   enforces it once. Reports cannot work that way: the capability depends on
   which report, so a single entry over `/app/reports` would have to be either
   the loosest of them — handing a leasing agent the balance sheet — or the
   strictest, hiding the rent roll from the person whose job it is.

   So the check moved into the handler, and that is exactly the shape of thing
   that rots. These tests hold it: the index offers only what a person may
   run, the URL refuses the rest, and the refusal is asserted by typing the
   URL rather than by reading the menu. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { today } from "../server/lib/dates.js";
import { ensureChart } from "../server/features/accounting.js";
import { chargeRent } from "../server/lib/rentcharge.js";
import { reportKeys, reportDefinition } from "../server/lib/reports/index.js";

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Screens Co",
    staffRoles: ["admin", "leasing", "technician", "accountant"],
  });
  await ensureChart(world.companyId);
  await run("UPDATE lease SET rent_cents = ?, start_date = ? WHERE id = ?",
    100000, "2026-01-01", world.leaseId);
  await chargeRent(world.companyId, { period: "2026-08" });
});

async function as(role) {
  const c = client(app.origin);
  const res = await c.signIn(world.staff[role].email, f.PASSWORD);
  assert.equal(res.signedIn, true, `${role} should be able to sign in`);
  return c;
}

/* --- the index --------------------------------------------------------------- */

describe("the index", () => {
  test("an administrator is offered every report, grouped", async () => {
    const c = await as("admin");
    const { res, body } = await c.text("/app/reports");

    assert.equal(res.status, 200);
    for (const key of reportKeys()) {
      assert.ok(body.includes(reportDefinition(key).title), `${key} is missing from the index`);
    }
    for (const group of ["Financial", "Rent", "Portfolio", "Tax"]) {
      assert.ok(body.includes(group), `the ${group} group is missing`);
    }
  });

  test("a leasing agent is offered the portfolio and none of the money", async () => {
    const c = await as("leasing");
    const { body } = await c.text("/app/reports");

    assert.ok(body.includes("Rent roll"));
    assert.ok(body.includes("Vacancy"));
    assert.ok(!body.includes("Balance sheet"), "no money at all");
    assert.ok(!body.includes("Trust reconciliation"));
  });

  test("a technician is told plainly there is nothing for them", async () => {
    /* An empty page reads as broken. */
    const c = await as("technician");
    const { res, body } = await c.text("/app/reports");

    assert.equal(res.status, 200, "the section itself is not forbidden");
    assert.match(body, /Nothing here for your account/);
  });

  test("and is not offered it in the sidebar", async () => {
    /* The application's own rule: a nav full of links that answer nothing is
       worse than a shorter nav. Reports are gated per report, so "may they
       reach the section" is "is there anything in it for them". */
    const c = await as("technician");
    const { body } = await c.text("/app/jobs");
    const nav = body.slice(body.indexOf("<nav"), body.indexOf("</nav>"));
    assert.ok(!nav.includes("/app/reports"));
  });

  test("but a leasing agent is", async () => {
    const c = await as("leasing");
    const { body } = await c.text("/app/listings");
    const nav = body.slice(body.indexOf("<nav"), body.indexOf("</nav>"));
    assert.ok(nav.includes("/app/reports"));
  });
});

/* --- the refusal ------------------------------------------------------------- */

describe("typing the URL", () => {
  test("a report they may not run is refused, not merely hidden", async () => {
    /* "It is not in your menu" is not a permission check. A URL is typed,
       guessed and bookmarked. */
    const c = await as("leasing");
    for (const key of ["balance_sheet", "trust_reconciliation", "general_ledger"]) {
      const res = await c.get(`/app/reports/${key}`);
      assert.equal(res.status, 403, key);
    }
  });

  test("the refusal says what to do about it", async () => {
    const c = await as("leasing");
    const { body } = await c.text("/app/reports/balance_sheet");
    assert.match(body, /administrator can change your role/);
  });

  test("the export routes are refused too, not only the page", async () => {
    /* The obvious way round a check on a page is the download beside it. */
    const c = await as("leasing");
    assert.equal((await c.get("/app/reports/balance_sheet/csv")).status, 403);
    assert.equal((await c.get("/app/reports/balance_sheet/pdf")).status, 403);
  });

  test("a report that does not exist is a bad request, not a crash", async () => {
    const c = await as("admin");
    const res = await c.get("/app/reports/nonsense");
    assert.equal(res.status, 400);
  });

  test("one they may run, they may run", async () => {
    const c = await as("leasing");
    assert.equal((await c.get("/app/reports/rent_roll")).status, 200);
    assert.equal((await c.get("/app/reports/rent_roll/csv")).status, 200);
  });
});

/* --- the page ---------------------------------------------------------------- */

describe("a report page", () => {
  test("every one of them renders for an administrator", async () => {
    /* A loop, because the failure being guarded against is the fifteenth
       report rendering a column its table function does not produce. */
    const c = await as("admin");
    for (const key of reportKeys()) {
      const { res, body } = await c.text(`/app/reports/${key}`);
      assert.equal(res.status, 200, key);
      assert.ok(body.includes(reportDefinition(key).title), key);
    }
  });

  test("it carries a filter bar built from what the report takes", async () => {
    const c = await as("admin");
    const { body } = await c.text("/app/reports/profit_and_loss");
    assert.match(body, /name="from"/);
    assert.match(body, /name="to"/);
    assert.match(body, /name="propertyId"/);
  });

  test("the filter is applied rather than decorative", async () => {
    /* The trial balance filter shipped for two phases doing nothing at all,
       so this one gets asserted. */
    const c = await as("admin");
    const wide = await c.text("/app/reports/general_ledger?from=2020-01-01&to=2030-12-31");
    const narrow = await c.text("/app/reports/general_ledger?from=1990-01-01&to=1990-12-31");

    assert.ok(wide.body.includes("Rent 2026-08") || wide.body.includes("rent"), "the wide range has postings");
    assert.match(narrow.body, /Nothing to show/, "and the narrow one has none");
  });

  test("an empty result says so rather than showing a bare table", async () => {
    const c = await as("admin");
    const { body } = await c.text("/app/reports/aged_receivables?asOf=1990-01-01");
    assert.match(body, /Nothing to show/);
  });

  test("a report carrying a warning shows it", async () => {
    /* The deposits report knows money is recorded on a lease and posted
       nowhere, and saying so on the screen is the entire point of it. */
    await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", 150000, world.leaseId);
    const c = await as("admin");
    const { body } = await c.text("/app/reports/deposits_held");
    assert.match(body, /posted to no account/);
  });
});

/* --- downloads ---------------------------------------------------------------- */

describe("downloading", () => {
  test("a CSV arrives as a file, named, and is never cached", async () => {
    /* A report is a snapshot of somebody's finances. It does not belong in a
       shared cache and it does not belong in the browser's either. */
    const c = await as("admin");
    const res = await c.get("/app/reports/rent_roll/csv");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="screens-co-rent-roll/);
    assert.match(res.headers.get("cache-control"), /no-store/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    const text = await res.text();
    assert.ok(text.includes("Property"), "the header row");
  });

  test("a PDF is a PDF", async () => {
    const c = await as("admin");
    const res = await c.get("/app/reports/rent_roll/pdf");
    const bytes = Buffer.from(await res.arrayBuffer());

    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  });

  test("every report downloads in both formats", async () => {
    const c = await as("admin");
    for (const key of reportKeys()) {
      for (const format of ["csv", "pdf"]) {
        const res = await c.get(`/app/reports/${key}/${format}`);
        assert.equal(res.status, 200, `${key}.${format}`);
      }
    }
  });

  test("the download carries the filter it was asked for", async () => {
    /* Otherwise somebody exports what is on screen and gets something else
       entirely, which is the worst kind of export bug because the file looks
       fine. */
    const c = await as("admin");
    const res = await c.get("/app/reports/profit_and_loss/csv?from=2026-01-01&to=2026-03-31");
    assert.match(res.headers.get("content-disposition"), /2026-01-01-to-2026-03-31/);
  });
});
