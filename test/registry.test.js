/* The report registry.

   Eleven reports written as separate functions, each returning its own shape.
   That is fine until something has to run one by name — a URL, an export, a
   schedule firing at six in the morning — at which point every caller needs to
   know all eleven shapes.

   Most of this file is written as a loop over every registered report rather
   than as a test per report, on purpose. The failure this guards against is
   not one report being wrong; it is the twelfth being added next month with a
   capability nobody checks, a column with no label, or a totals row keyed to
   columns that no longer exist. A loop catches that on the day it lands. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today } from "../server/lib/dates.js";
import { CAPABILITIES, capabilitiesFor } from "../server/lib/auth.js";
import { ensureChart } from "../server/features/accounting.js";
import { chargeRent } from "../server/lib/rentcharge.js";
import { postMoney } from "../server/lib/ledger.js";
import { toCsv } from "../server/lib/csv.js";
import { buildReportPdf } from "../server/lib/pdf/report.js";
import {
  REPORTS, PARAMS, reportKeys, reportsFor, reportDefinition,
  paramsFor, runReport, tableFor, subtitleFor,
} from "../server/lib/reports/index.js";

let world, company;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Registry Co" });
  await ensureChart(world.companyId);
  await run("UPDATE lease SET rent_cents = ?, deposit_cents = ?, start_date = ? WHERE id = ?",
    100000, 150000, "2026-01-01", world.leaseId);
  /* Enough movement that the reports have something to say. A registry tested
     only against an empty company proves the loops terminate. */
  await chargeRent(world.companyId, { period: "2026-08" });
  await postMoney({
    companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
    unitId: world.unitId, leaseId: world.leaseId, date: "2026-08-03",
    kind: "rent_payment", amountCents: 100000, memo: "rent", source: "manual", postedBy: "t",
  });
  await postMoney({
    companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
    date: "2026-08-31", kind: "management_fee", amountCents: -8000,
    memo: "fee", source: "manual", postedBy: "t",
  });
  company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
});

const ALL_PARAMS = { from: "2026-01-01", to: today(), asOf: today(), withinDays: 365, year: 2026 };

/* --- every report, every time --------------------------------------------- */

describe("every registered report", () => {
  test("there are some, and the loop is not running over nothing", async () => {
    /* A guard on the guards below: a registry that came back empty would
       make every one of them pass while asserting nothing. */
    assert.ok(reportKeys().length >= 12, `only ${reportKeys().length} reports`);
  });

  test("each one runs and answers", async () => {
    for (const key of reportKeys()) {
      const out = await runReport(key, world.companyId, ALL_PARAMS);
      assert.ok(out.result, `${key} returned nothing`);
      assert.equal(out.key, key);
    }
  });

  test("each one lays out as a table", async () => {
    for (const key of reportKeys()) {
      const { result } = await runReport(key, world.companyId, ALL_PARAMS);
      const table = tableFor(key, result);

      assert.ok(Array.isArray(table.columns) && table.columns.length, `${key} has no columns`);
      assert.ok(Array.isArray(table.rows), `${key} rows is not an array`);
      for (const column of table.columns) {
        assert.ok(column.key, `${key} has a column with no key`);
        assert.ok(typeof column.label === "string", `${key}: ${column.key} has no label`);
      }
    }
  });

  test("a totals row is keyed to columns that exist", async () => {
    /* A totals row carrying a key no column reads renders as a blank line
       under the data, which looks like a rendering bug and is a silent one. */
    for (const key of reportKeys()) {
      const { result } = await runReport(key, world.companyId, ALL_PARAMS);
      const table = tableFor(key, result);
      if (!table.totals) continue;

      const columnKeys = new Set(table.columns.map((c) => c.key));
      for (const field of Object.keys(table.totals)) {
        assert.ok(columnKeys.has(field), `${key}: totals has "${field}" and no column does`);
      }
    }
  });

  test("each one exports to CSV and to PDF", async () => {
    /* The registry's whole reason for existing: one shape that both
       exporters consume, so they cannot drift from the screen or from each
       other. */
    for (const key of reportKeys()) {
      const { result, title, params } = await runReport(key, world.companyId, ALL_PARAMS);
      const table = tableFor(key, result);

      const csv = toCsv(table);
      assert.ok(csv.includes(table.columns[0].label), `${key}: CSV has no header`);

      const pdf = await buildReportPdf({
        company, title, subtitle: subtitleFor(key, params), ...table,
      });
      assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-", `${key}: not a PDF`);
    }
  });

  test("each one has a title, a group and a description", async () => {
    /* These are what a person picks from. A report with no description is
       one nobody runs. */
    for (const key of reportKeys()) {
      const r = reportDefinition(key);
      assert.ok(r.title, `${key} has no title`);
      assert.ok(r.group, `${key} has no group`);
      assert.ok(r.description, `${key} has no description`);
    }
  });
});

/* --- the things that drift ------------------------------------------------- */

describe("what would drift", () => {
  test("every capability named is a real one", async () => {
    /* A typo here does not fail — `can()` returns false for an unknown
       capability, so the report simply disappears from everybody's list and
       nobody reports a bug about a report they never knew existed. */
    for (const key of reportKeys()) {
      const need = reportDefinition(key).need;
      if (!need) continue;
      assert.ok(CAPABILITIES.includes(need), `${key} needs "${need}", which is not a capability`);
    }
  });

  test("every parameter named is one a screen knows how to render", async () => {
    /* A report asking for a filter the filter bar cannot draw is a report
       that can only ever run with defaults. */
    for (const key of reportKeys()) {
      for (const name of reportDefinition(key).params) {
        assert.ok(PARAMS[name], `${key} takes "${name}", which is not a known parameter`);
      }
    }
  });

  test("an unknown report says so by name", async () => {
    assert.throws(() => reportDefinition("nonsense"), /There is no report called nonsense/);
  });
});

/* --- who may run what ------------------------------------------------------- */

describe("permission", () => {
  test("a technician is offered nothing", async () => {
    /* They hold maintenance.own and nothing else, and none of these are
       theirs. */
    const tech = { role: "technician", active: 1 };
    assert.deepEqual(reportsFor(tech), []);
  });

  test("an accountant is offered the money, and not the portfolio", async () => {
    const accountant = { role: "accountant", active: 1 };
    const offered = reportsFor(accountant).map((r) => r.key);

    assert.ok(offered.includes("balance_sheet"));
    assert.ok(offered.includes("trust_reconciliation"));
    assert.ok(capabilitiesFor("accountant").has("property.view"), "they do hold this");
    assert.ok(offered.includes("rent_roll"), "so the rent roll is theirs too");
  });

  test("a leasing agent gets the portfolio and none of the money", async () => {
    const leasing = { role: "leasing", active: 1 };
    const offered = reportsFor(leasing).map((r) => r.key);

    assert.ok(offered.includes("rent_roll"));
    assert.ok(offered.includes("vacancy"));
    assert.ok(!offered.includes("balance_sheet"), "no money at all");
    assert.ok(!offered.includes("trust_reconciliation"));
  });

  test("an administrator is offered every one", async () => {
    const admin = { role: "admin", active: 1 };
    assert.equal(reportsFor(admin).length, reportKeys().length);
  });
});

/* --- parameters -------------------------------------------------------------- */

describe("parameters", () => {
  test("a report run with none still answers", async () => {
    /* An empty page reads as "there is nothing", which is a different and
       much worse answer than "here is this month". */
    const params = paramsFor("profit_and_loss", {});
    assert.ok(params.from, "a period was filled in");
    assert.ok(params.to);
  });

  test("what is given wins over the default", async () => {
    const params = paramsFor("balance_sheet", { asOf: "2026-03-31" });
    assert.equal(params.asOf, "2026-03-31");
  });

  test("an empty string counts as not given", async () => {
    /* Which is what an untouched date input posts. */
    const params = paramsFor("balance_sheet", { asOf: "" });
    assert.equal(params.asOf, today());
  });

  test("a parameter the report does not take is dropped", async () => {
    /* Rather than reaching the query, where it would either be ignored
       quietly or do something nobody intended. */
    const params = paramsFor("balance_sheet", { asOf: today(), propertyId: "sneaky" });
    assert.equal(params.propertyId, undefined);
  });

  test("the subtitle says what period it covers", async () => {
    assert.match(subtitleFor("balance_sheet", { asOf: "2026-09-30" }), /As at 30 Sep/);
    assert.match(subtitleFor("profit_and_loss", { from: "2026-01-01", to: "2026-12-31" }), / to /);
    assert.match(subtitleFor("tax_1099", { year: 2025 }), /Tax year 2025/);
  });
});
