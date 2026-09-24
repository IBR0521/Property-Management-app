/* Saved reports, and sending them on a schedule.

   The decision this file exists to hold: **a schedule stores a period rule,
   never dates.** One holding `from 2026-01-01, to 2026-01-31` would email
   January's figures every month for ever, and the third time it arrived
   nobody would notice it had stopped being useful — the numbers would simply
   have stopped changing.

   And it sends a link rather than the file. An emailed PDF of somebody's
   finances sits in an inbox for ever and gets forwarded; a link goes through
   the capability gate every time it is opened and stops working when their
   account does. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today, addDays } from "../server/lib/dates.js";
import {
  PERIODS, resolvePeriod, saveReport, savedReports, savedReport, deleteSavedReport,
  scheduleReport, schedulesFor, isDue, runReportSchedules, deleteSchedule,
} from "../server/lib/reports/saved.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Schedule Co",
    staffRoles: ["admin", "accountant", "leasing", "technician"],
  });
  await run("UPDATE company SET timezone = ? WHERE id = ?", "UTC", world.companyId);
});

const saveOne = (key = "profit_and_loss", name = "Monthly P&L", params = {}) =>
  saveReport({ companyId: world.companyId, reportKey: key, name, params, by: "test" });

const emails = () => all(
  "SELECT * FROM outbox WHERE about_type = 'report_schedule' ORDER BY queued_at");

/* --- the period rule -------------------------------------------------------- */

describe("working out the period", () => {
  test("last month is the month that has just finished", async () => {
    const r = resolvePeriod("last_month", "2026-03-14");
    assert.equal(r.from, "2026-02-01");
    assert.equal(r.to, "2026-02-28");
  });

  test("it crosses a year end", async () => {
    const r = resolvePeriod("last_month", "2026-01-09");
    assert.equal(r.from, "2025-12-01");
    assert.equal(r.to, "2025-12-31");
  });

  test("the quarter just gone is the one that finished, not the one running", async () => {
    /* A run on 1 April must report January to March. Taking the quarter
       containing today would report an April with one day in it. */
    const q1 = resolvePeriod("last_quarter", "2026-04-01");
    assert.equal(q1.from, "2026-01-01");
    assert.equal(q1.to, "2026-03-31");

    const q4 = resolvePeriod("last_quarter", "2026-01-05");
    assert.equal(q4.from, "2025-10-01");
    assert.equal(q4.to, "2025-12-31");
  });

  test("the middle of a quarter still reports the last complete one", async () => {
    const r = resolvePeriod("last_quarter", "2026-05-20");
    assert.equal(r.from, "2026-04-01");
    assert.equal(r.to, "2026-06-30");
  });

  test("year to date starts in January", async () => {
    const r = resolvePeriod("year_to_date", "2026-09-23");
    assert.equal(r.from, "2026-01-01");
    assert.equal(r.to, "2026-09-23");
  });

  test("a position has no from", async () => {
    /* A balance sheet is as at a moment. Giving it a period start would be
       asking a different question. */
    const r = resolvePeriod("as_at_today", "2026-09-23");
    assert.equal(r.from, null);
    assert.equal(r.asOf, "2026-09-23");
  });

  test("a rule nobody wrote down is refused", async () => {
    assert.throws(() => resolvePeriod("whenever"), /is not a period/);
  });
});

/* --- saving ------------------------------------------------------------------ */

describe("saving a report", () => {
  test("only the filters that report actually takes are kept", async () => {
    /* So a report that later loses a filter does not carry a stale one
       around for ever. */
    await saveOne("balance_sheet", "Position", { asOf: "2026-06-30", propertyId: "sneaky" });
    const [saved] = await savedReports(world.companyId);

    assert.equal(saved.params.asOf, "2026-06-30");
    assert.equal(saved.params.propertyId, undefined);
  });

  test("saving the same name again replaces it", async () => {
    await saveOne("profit_and_loss", "Mine", { from: "2026-01-01" });
    const second = await saveOne("profit_and_loss", "Mine", { from: "2026-06-01" });

    assert.equal(second.replaced, true);
    const list = await savedReports(world.companyId);
    assert.equal(list.length, 1);
    assert.equal(list[0].params.from, "2026-06-01");
  });

  test("it needs a name somebody will recognise", async () => {
    await assert.rejects(() => saveOne("profit_and_loss", "   "), /a name you will recognise/);
  });

  test("a saved report pointing at one the code no longer has is shown, not thrown", async () => {
    /* Deleting somebody's saved filters on a deploy would be worse than
       showing them a row that says it no longer works. */
    await saveOne();
    await run("UPDATE saved_report SET report_key = ?", "retired_report");

    const [saved] = await savedReports(world.companyId);
    assert.equal(saved.known, false);
    assert.equal(saved.title, "retired_report");
  });

  test("it can be deleted", async () => {
    const { id } = await saveOne();
    assert.equal(await deleteSavedReport(world.companyId, id), 1);
    assert.deepEqual(await savedReports(world.companyId), []);
  });
});

/* --- who it may be sent to ---------------------------------------------------- */

describe("recipients", () => {
  test("somebody who cannot open the report is refused", async () => {
    /* A schedule that emails a link somebody cannot open is worse than no
       schedule: it looks like it is working. */
    const { id } = await saveOne("balance_sheet", "Position");

    await assert.rejects(() => scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 1, period: "as_at_today",
      recipients: [world.staff.leasing.id],
    }), /cannot open the balance sheet/);
  });

  test("somebody who can is accepted", async () => {
    const { id } = await saveOne("balance_sheet", "Position");
    const res = await scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 1, period: "as_at_today",
      recipients: [world.staff.accountant.id],
    });
    assert.ok(res.id);
  });

  test("a deactivated account is refused", async () => {
    await run("UPDATE staff SET active = 0 WHERE id = ?", world.staff.accountant.id);
    const { id } = await saveOne("balance_sheet", "Position");

    await assert.rejects(() => scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 1, period: "as_at_today",
      recipients: [world.staff.accountant.id],
    }), /not active/);
  });

  test("somebody from another company is refused", async () => {
    const other = await f.makeWorld({ name: "Elsewhere Co" });
    const { id } = await saveOne("balance_sheet", "Position");

    await assert.rejects(() => scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 1, period: "as_at_today",
      recipients: [other.staff.admin.id],
    }), /not on this company's staff/);
  });

  test("nobody at all is refused", async () => {
    const { id } = await saveOne();
    await assert.rejects(() => scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 1, period: "last_month", recipients: [],
    }), /at least one person/);
  });
});

/* --- the cadence --------------------------------------------------------------- */

describe("when it fires", () => {
  const monthly = (day, extra = {}) =>
    ({ active: 1, cadence: "monthly", day_of: day, last_sent_on: null, ...extra });
  const weekly = (day, extra = {}) =>
    ({ active: 1, cadence: "weekly", day_of: day, last_sent_on: null, ...extra });

  test("monthly fires on its day and no other", async () => {
    assert.equal(isDue(monthly(5), "2026-03-05"), true);
    assert.equal(isDue(monthly(5), "2026-03-04"), false);
    assert.equal(isDue(monthly(5), "2026-03-06"), false);
  });

  test("weekly fires on its weekday", async () => {
    /* 2026-03-02 is a Monday. */
    assert.equal(isDue(weekly(1), "2026-03-02"), true);
    assert.equal(isDue(weekly(1), "2026-03-03"), false);
  });

  test("a day that is not a day of the month is refused when the schedule is made", async () => {
    /* 29 to 31 are accepted now: `isDue` clamps them to the length of the
       month, so the 31st means the last day rather than a run that silently
       skips February. What is still refused is a number that is not a day. */
    const { id } = await saveOne();
    for (const day of [0, 32, 40, -1]) {
      await assert.rejects(() => scheduleReport({
        companyId: world.companyId, savedReportId: id,
        cadence: "monthly", dayOf: day, period: "last_month",
        recipients: [world.staff.admin.id],
      }), /1 to 31/, String(day));
    }
  });

  test("the last day of the month can be chosen", async () => {
    const { id } = await saveOne();
    for (const day of [29, 30, 31]) {
      const sched = await scheduleReport({
        companyId: world.companyId, savedReportId: id,
        cadence: "monthly", dayOf: day, period: "last_month",
        recipients: [world.staff.admin.id],
      });
      const stored = await get("SELECT day_of FROM report_schedule WHERE id = ?", sched.id);
      assert.equal(Number(stored.day_of), day, `day ${day} should be storable`);
      await deleteSchedule(world.companyId, sched.id);
    }
  });

  test("a tick running all day sends once", async () => {
    /* The tick runs every ten minutes. `last_sent_on` is a date rather than
       a timestamp precisely so the answer does not change during the day. */
    assert.equal(isDue(monthly(5, { last_sent_on: "2026-03-05" }), "2026-03-05"), false);
    assert.equal(isDue(monthly(5, { last_sent_on: "2026-02-05" }), "2026-03-05"), true);
  });

  test("a schedule that is off does not fire", async () => {
    assert.equal(isDue(monthly(5, { active: 0 }), "2026-03-05"), false);
  });
});

/* --- sending -------------------------------------------------------------------- */

describe("what goes out", () => {
  async function scheduled({ period = "last_month", key = "profit_and_loss", params = {} } = {}) {
    const { id } = await saveOne(key, "Monthly numbers", params);
    await scheduleReport({
      companyId: world.companyId, savedReportId: id,
      cadence: "monthly", dayOf: 5, period,
      recipients: [world.staff.admin.id, world.staff.accountant.id],
    });
    return id;
  }

  test("one email each, to people who can open it", async () => {
    await scheduled();
    const out = await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });

    assert.equal(out.reportsScheduled, 1, "one schedule fired");
    const queued = await emails();
    assert.equal(queued.length, 2, "two recipients, two emails");
  });

  test("it carries a link, never the file", async () => {
    /* An emailed PDF of somebody's finances sits in an inbox for ever and
       gets forwarded. */
    await scheduled();
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });

    const [mail] = await emails();
    assert.match(mail.body, /https:\/\/example\.test\/app\/reports\/profit_and_loss\?/);
    assert.match(mail.body, /link rather than an attachment/);
    assert.ok(!/%PDF/.test(mail.body));
  });

  test("the link carries the period worked out for the day it ran", async () => {
    /* The whole point. A schedule that sent the same January every month
       would look like it was working. */
    await scheduled();
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    const [march] = await emails();
    assert.match(march.body, /from=2026-02-01/);
    assert.match(march.body, /to=2026-02-28/);

    await run("DELETE FROM outbox");
    await run("UPDATE report_schedule SET last_sent_on = NULL");
    await runReportSchedules({ on: "2026-04-05", baseUrl: "https://example.test" });
    const [april] = await emails();
    assert.match(april.body, /from=2026-03-01/, "a different month, a different report");
  });

  test("the saved filters that are not dates carry over", async () => {
    await scheduled({ params: { propertyId: world.propertyId } });
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    const [mail] = await emails();
    assert.match(mail.body, new RegExp(`propertyId=${world.propertyId}`));
  });

  test("the subject says which report and which period", async () => {
    await scheduled();
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    const [mail] = await emails();
    assert.match(mail.subject, /Monthly numbers/);
    assert.match(mail.subject, /Feb 2026/);
  });

  test("a week of downtime sends once on the way back, not seven times", async () => {
    /* Every job in this scheduler works from current state rather than from
       "what happened since", and this is that rule for reports. */
    await scheduled();
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    for (const day of ["2026-03-06", "2026-03-07", "2026-03-08"]) {
      await runReportSchedules({ on: day, baseUrl: "https://example.test" });
    }
    assert.equal((await emails()).length, 2, "the two recipients, once");
  });

  test("a broken schedule is recorded and does not stop the others", async () => {
    const good = await scheduled();
    const { id: badSaved } = await saveOne("balance_sheet", "Broken");
    await scheduleReport({
      companyId: world.companyId, savedReportId: badSaved,
      cadence: "monthly", dayOf: 5, period: "as_at_today",
      recipients: [world.staff.admin.id],
    });
    /* A period the resolver cannot work out, forced past the check. */
    await run("UPDATE report_schedule SET period = ? WHERE saved_report_id = ?",
      "year_to_date", badSaved);
    await run("UPDATE saved_report SET report_key = ? WHERE id = ?", "retired", badSaved);

    const out = await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    assert.equal(out.reportsScheduled, 1, "the good one still went");

    const broken = await get(
      "SELECT last_error FROM report_schedule WHERE saved_report_id = ?", badSaved);
    assert.match(broken.last_error, /retired/);
  });

  test("a schedule that is switched off sends nothing", async () => {
    await scheduled();
    await run("UPDATE report_schedule SET active = 0");
    await runReportSchedules({ on: "2026-03-05", baseUrl: "https://example.test" });
    assert.deepEqual(await emails(), []);
  });

  test("it can be listed and deleted", async () => {
    await scheduled();
    const list = await schedulesFor(world.companyId);
    assert.equal(list.length, 1);
    assert.equal(list[0].periodLabel, PERIODS.last_month.label);
    assert.equal(list[0].recipients.length, 2);

    assert.equal(await deleteSchedule(world.companyId, list[0].id), 1);
    assert.deepEqual(await schedulesFor(world.companyId), []);
  });
});

/* A monthly schedule set to the last day of the month.

   `isDue` compared the day exactly — `getUTCDate() === day_of` — so a
   schedule on the 31st would never match in February, April, June, September
   or November, and would silently not run in five months of the year. The
   validator capped the day at 28 to prevent that, which worked but cost the
   arrangement outright.

   It clamps now, the same way rent due dates always have. */
describe("a schedule on the last day of the month", () => {
  const monthlyOn = (day) => ({ active: 1, cadence: "monthly", day_of: day, last_sent_on: null });

  test("31 runs on the last day, whatever the month's length", () => {
    assert.equal(isDue(monthlyOn(31), "2026-01-31"), true, "January has a 31st");
    assert.equal(isDue(monthlyOn(31), "2026-02-28"), true, "February's last day is the 28th");
    assert.equal(isDue(monthlyOn(31), "2028-02-29"), true, "and the 29th in a leap year");
    assert.equal(isDue(monthlyOn(31), "2026-04-30"), true, "April's is the 30th");
  });

  test("and not on any other day of those months", () => {
    assert.equal(isDue(monthlyOn(31), "2026-02-27"), false);
    assert.equal(isDue(monthlyOn(31), "2026-04-29"), false);
    assert.equal(isDue(monthlyOn(31), "2026-01-30"), false);
  });

  test("February is no longer skipped — the bug the cap was guarding", () => {
    /* Every month gets exactly one run. Before the clamp, five of these
       would have produced none at all. */
    const days = {
      "2026-01": 31, "2026-02": 28, "2026-03": 31, "2026-04": 30,
      "2026-05": 31, "2026-06": 30, "2026-09": 30, "2026-11": 30,
    };
    for (const [month, last] of Object.entries(days)) {
      let fired = 0;
      for (let d = 1; d <= last; d += 1) {
        if (isDue(monthlyOn(31), `${month}-${String(d).padStart(2, "0")}`)) fired += 1;
      }
      assert.equal(fired, 1, `${month} should fire exactly once, fired ${fired}`);
    }
  });

  test("a day inside every month is unaffected", () => {
    /* The existing behaviour, which must not move. */
    assert.equal(isDue(monthlyOn(5), "2026-02-05"), true);
    assert.equal(isDue(monthlyOn(5), "2026-02-28"), false);
    assert.equal(isDue(monthlyOn(1), "2026-02-01"), true);
  });

  test("30 lands on the 28th in February but stays the 30th elsewhere", () => {
    assert.equal(isDue(monthlyOn(30), "2026-02-28"), true);
    assert.equal(isDue(monthlyOn(30), "2026-01-30"), true);
    assert.equal(isDue(monthlyOn(30), "2026-01-31"), false);
  });
});
