/* Company-local dates.

   `company.timezone` has been on the table since migration 001 and nothing
   ever read it, so every date in the app was computed in whatever zone the
   server happened to run in. On a laptop in the same city as the buildings
   that is invisible. On a platform whose function region is Oregon and whose
   customers are in Columbus and London it is a bug with money attached: rent
   is due on a calendar date where the building is.

   The test that matters is the last one. It puts two companies in different
   zones, picks an instant where it is a different date in each, and checks
   they are judged on their own calendars rather than on the server's. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import {
  todayIn, minutesIn, isValidZone, withinBusinessHours, offsetMinutes, COMMON_ZONES,
} from "../server/lib/timezone.js";

describe("the calendar in a zone", () => {
  test("a single instant is two different dates", () => {
    /* 03:30 UTC on the 1st of June is still the 31st of May in Columbus. This
       is the whole bug in one line. */
    const instant = new Date("2026-06-01T03:30:00Z");
    assert.equal(todayIn("UTC", instant), "2026-06-01");
    assert.equal(todayIn("America/New_York", instant), "2026-05-31");
    assert.equal(todayIn("America/Los_Angeles", instant), "2026-05-31");
    assert.equal(todayIn("Australia/Sydney", instant), "2026-06-01");
  });

  test("daylight saving is handled, because nobody gets it right by hand", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    const summer = new Date("2026-07-15T12:00:00Z");
    assert.equal(offsetMinutes("America/New_York", winter), -300, "EST");
    assert.equal(offsetMinutes("America/New_York", summer), -240, "EDT");
    assert.equal(offsetMinutes("Europe/London", winter), 0, "GMT");
    assert.equal(offsetMinutes("Europe/London", summer), 60, "BST");
  });

  test("an invalid zone falls back rather than throwing", () => {
    /* A bad value in one company's settings must not take down a sweep that
       runs for every company. */
    assert.equal(isValidZone("America/New_York"), true);
    assert.equal(isValidZone("Mars/Olympus"), false);
    assert.equal(isValidZone(""), false);
    assert.equal(todayIn("Mars/Olympus", new Date("2026-06-01T12:00:00Z")), "2026-06-01");
  });

  test("every zone offered in the dropdown is real", () => {
    for (const zone of COMMON_ZONES) {
      assert.ok(isValidZone(zone), `${zone} is not a zone Node knows`);
    }
  });

  test("local clock time, for business hours", () => {
    const instant = new Date("2026-06-01T20:00:00Z");
    assert.equal(minutesIn("UTC", instant), 20 * 60);
    assert.equal(minutesIn("America/New_York", instant), 16 * 60, "16:00 EDT");
  });

  test("the office is open or it is not, where the office is", () => {
    const company = { timezone: "America/New_York", business_open_minute: 540, business_close_minute: 1020 };
    // 14:00 UTC is 10:00 in New York — open.
    assert.equal(withinBusinessHours(company, new Date("2026-06-01T14:00:00Z")), true);
    // 02:00 UTC is 22:00 the previous evening — shut.
    assert.equal(withinBusinessHours(company, new Date("2026-06-01T02:00:00Z")), false);
  });
});

describe("the late fee sweep judges each company on its own calendar", () => {
  before(async () => { await freshDatabase(); });
  after(async () => { await closeDb(); });
  beforeEach(async () => { await truncateAll(); });

  /* An instant where it is the 7th in Sydney and still the 6th in Los
     Angeles. A lease due on the 1st with five days of grace is one day past
     grace in Sydney and exactly on the grace boundary in Los Angeles — late in
     one and not yet late in the other, at the very same moment. */
  const INSTANT = new Date("2026-06-06T20:00:00Z");

  async function leaseIn(zone, name) {
    const companyId = await f.makeCompany(name, { timezone: zone });
    const ownerId = await f.makeOwner(companyId);
    const propertyId = await f.makeProperty(companyId, ownerId);
    const unitId = await f.makeUnit(companyId, propertyId);
    const { leaseId } = await f.makeLease(companyId, unitId, {
      rentCents: 100000, dueDay: 1, graceDays: 5, startDate: "2026-01-01",
    });
    await run("UPDATE lease SET late_fee_cents = ? WHERE id = ?", 5000, leaseId);
    return { companyId, leaseId };
  }

  test("the same instant is late in one zone and not the other", async () => {
    assert.equal(todayIn("Australia/Sydney", INSTANT), "2026-06-07");
    assert.equal(todayIn("America/Los_Angeles", INSTANT), "2026-06-06");

    const sydney = await leaseIn("Australia/Sydney", "Sydney Lettings");
    const la = await leaseIn("America/Los_Angeles", "Pacific Property");

    const { sweepLateFees } = await import("../server/lib/latefees.js");
    const result = await sweepLateFees({ postedBy: "test", now: INSTANT });

    assert.equal(result.charged, 1,
      "one lease is past its grace locally and the other is not, at the same instant");

    const charged = await all("SELECT lease_id, period, assessed_date FROM late_fee");
    assert.equal(charged.length, 1);
    assert.equal(charged[0].lease_id, sydney.leaseId, "Sydney is a day ahead");
    assert.equal(charged[0].assessed_date, "2026-06-07",
      "and the fee is dated in the company's own calendar, not the server's");

    const laFee = await get("SELECT id FROM late_fee WHERE lease_id = ?", la.leaseId);
    assert.equal(laFee, undefined, "charging a day early is charging wrongly");
  });

  test("a day later the second company is charged too", async () => {
    const sydney = await leaseIn("Australia/Sydney", "Sydney Lettings");
    const la = await leaseIn("America/Los_Angeles", "Pacific Property");

    const { sweepLateFees } = await import("../server/lib/latefees.js");
    await sweepLateFees({ postedBy: "test", now: INSTANT });
    const second = await sweepLateFees({
      postedBy: "test", now: new Date("2026-06-07T20:00:00Z"),
    });

    assert.equal(second.charged, 1, "the other company's date has now passed too");
    assert.equal((await all("SELECT id FROM late_fee")).length, 2);
    assert.equal(second.skipped >= 1, true, "and the first is not charged twice");
  });

  test("a company with a nonsense timezone is still swept", async () => {
    /* One bad settings value must not stop every other company's fees. */
    const bad = await leaseIn("Mars/Olympus", "Broken Settings Co");
    const { sweepLateFees } = await import("../server/lib/latefees.js");
    const result = await sweepLateFees({ postedBy: "test", now: new Date("2026-06-20T12:00:00Z") });
    assert.equal(result.charged, 1, "it falls back to UTC rather than throwing");
  });
});
