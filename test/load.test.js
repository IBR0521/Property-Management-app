/* What every screen costs at size.

   ## The number this asserts is queries, not milliseconds

   Wall time here is my machine against local Postgres. It is not Vercel
   against Supabase's transaction pooler, and a number that cannot be compared
   is a number nobody acts on. **An N+1 is an N+1 on any machine**, and a page
   that issues four hundred queries is broken whatever the clock says — so the
   budget is a query count, and the timings are printed beside it as context.

   ## Why a smaller seed here than the one the phase measured

   `scripts/loadseed.js` builds 2,000 units and five years — 230,000 journals
   and 676,000 splits — and takes about seventy seconds. That is the run the
   phase report quotes. This file builds a fraction of it, because a query
   budget does not care how many rows there are: a screen that issues a query
   per row fails at six hundred units exactly as it fails at two thousand, and
   a screen that issues eleven issues eleven either way.

   Run the real thing by hand when a plan is in question:

       node --env-file=.env.test scripts/loadseed.js

   ## What this caught

   At 2,000 units the balance sheet took ten and a half seconds. Not an N+1 —
   the query count was thirteen — but every financial report joined
   `journal_split` to `journal` for the one column it filtered on, which is
   676,000 primary-key lookups. Migration 046 put the date on the split and
   the sheet went to 474ms. The rent screen was four correlated subqueries per
   tenancy, which is one query by the counter and an N+1 by every other
   measure; it went from 716ms to 60ms. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as counting from "../server/lib/dev/querycount.js";
import { loadSeed, checkSeed } from "../scripts/loadseed.js";

const UNITS = Number(process.env.LOAD_TEST_UNITS || 600);
const YEARS = Number(process.env.LOAD_TEST_YEARS || 3);

let app, agent, seeded, ids;

before(async () => {
  await freshDatabase();
  await truncateAll();
  seeded = await loadSeed({ units: UNITS, years: YEARS, log: () => {} });

  app = await startApp();
  agent = client(app.origin);
  const signed = await agent.signIn(seeded.email, seeded.password);
  assert.equal(signed.signedIn, true);

  ids = {
    company: await get("SELECT * FROM company LIMIT 1"),
    owner: await get("SELECT id FROM owner LIMIT 1"),
    unit: await get("SELECT id FROM unit LIMIT 1"),
    workOrder: await get("SELECT id FROM work_order LIMIT 1"),
  };
  counting.enable();
});

after(async () => {
  counting.disable();
  await app.close();
  await truncateAll();
  await closeDb();
});

/* The budget per screen: the most queries it may issue, whatever the size of
   the portfolio. Set a little above what each one costs today, so an ordinary
   change does not fail the build and a query-per-row does. */
const BUDGETS = [
  ["the queue", () => "/app", 35],
  ["the portfolio", () => "/app/portfolio", 20],
  ["one unit", () => `/app/portfolio/u/${ids.unit.id}`, 25],
  ["the repair queue", () => "/app/maintenance", 20],
  ["one repair", () => `/app/maintenance/${ids.workOrder.id}`, 22],
  ["rent", () => "/app/rent", 20],
  ["accounting", () => "/app/accounting", 20],
  ["owners", () => "/app/owners", 20],
  ["one owner", () => `/app/owners/${ids.owner.id}`, 22],
  ["deposits", () => "/app/deposits", 20],
  ["inspections", () => "/app/inspections", 20],
  ["vacancies", () => "/app/listings", 20],
  ["applications", () => "/app/applications", 20],
  ["deadlines", () => "/app/compliance", 20],
  ["turns", () => "/app/turns", 20],
  ["contractors", () => "/app/vendors", 20],
  ["the reports index", () => "/app/reports", 18],
  ["the rent roll", () => "/app/reports/rent_roll", 20],
  ["the trial balance", () => "/app/reports/trial_balance", 18],
  ["the balance sheet", () => "/app/reports/balance_sheet", 20],
  ["the trust reconciliation", () => "/app/reports/trust_reconciliation", 24],
  ["aged receivables", () => "/app/reports/aged_receivables", 20],
  ["deposits held", () => "/app/reports/deposits_held", 20],
  ["repair spend", () => "/app/reports/repair_spend", 20],
  ["messages", () => "/app/messages", 20],
  ["the inbox", () => "/app/inbox", 20],
  ["setup", () => "/app/setup", 24],
  ["the public vacancies page", () => `/c/${ids.company.slug}/listings`, 10],
  ["the syndication feed", () => `/feeds/${ids.company.slug}/listings.xml`, 10],
];

async function cost(path) {
  const res = await agent.raw(path);
  await res.text();
  const log = counting.lastCounted()?.queries || [];
  return { status: res.status, queries: log, n: log.length };
}

describe(`every screen, at ${UNITS} units and ${YEARS} years`, () => {
  test("the seed produced books this application would have produced", async () => {
    const problems = await checkSeed(seeded.companyId);
    assert.deepEqual(problems, [],
      "a seed that produced books the application would refuse is a seed that tests nothing");
    assert.ok(seeded.counts.splits > 50_000,
      `only ${seeded.counts.splits} splits — not enough for a plan to be interesting`);
  });

  for (const [name, path, budget] of BUDGETS) {
    test(`${name} stays inside ${budget} queries`, async () => {
      const { status, n, queries } = await cost(path());
      assert.ok(status < 400, `${path()} answered ${status}`);

      const worst = counting.repeats(queries, { atLeast: 5 })[0];
      assert.ok(n <= budget,
        `${name} issued ${n} queries against a budget of ${budget}`
        + (worst ? `. The worst repeat was ${worst.n}x: ${worst.sql}` : ""));
    });
  }

  test("and nothing issues the same query per row", async () => {
    /* The budgets above would catch it. This says what it is, so a failure
       reads as "this is an N+1" rather than as "this number went up". */
    const offenders = [];
    for (const [name, path] of BUDGETS) {
      const { queries } = await cost(path());
      for (const r of counting.repeats(queries, { atLeast: 8 })) {
        offenders.push(`${name}: ${r.n}x ${r.sql}`);
      }
    }
    assert.deepEqual(offenders, [],
      "a query repeated eight times in one request is a query per row:\n  "
      + offenders.join("\n  "));
  });
});

describe("the counter itself", () => {
  test("it is off unless a test turns it on", async () => {
    counting.disable();
    try {
      await cost("/app/owners");
      assert.equal(counting.counted(), null, "nothing is recorded while it is off");
    } finally {
      counting.enable();
    }
  });

  test("it groups by shape, so a thousand ids are one query", () => {
    assert.equal(
      counting.shape("SELECT * FROM lease WHERE id = 'abc'   AND x = $1"),
      "SELECT * FROM lease WHERE id = '?' AND x = $?");
  });

  test("and it finds a repeat rather than a total", () => {
    const queries = [
      { sql: "A" }, { sql: "A" }, { sql: "A" }, { sql: "A" }, { sql: "A" },
      { sql: "B" }, { sql: "C" },
    ];
    assert.deepEqual(counting.repeats(queries, { atLeast: 5 }), [{ sql: "A", n: 5 }]);
    assert.deepEqual(counting.repeats(queries, { atLeast: 6 }), []);
  });
});
