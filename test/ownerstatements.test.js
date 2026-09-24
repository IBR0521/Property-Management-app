/* Owner statements, generated on the day the owner was promised one.

   `owner.statement_day` was on the form from Phase 2, stored, shown in the
   owner directory — and read by nothing. A manager setting "Statement day:
   15" was setting a preference that changed nothing at all. A field that
   describes a behaviour the software does not have is worse than a missing
   feature, because the missing feature is at least visible.

   Two things this has to get right, and one it has to refuse to do.

   **The day.** 31 means the last day of the month, not a day that exists in
   five of them. The form used to stop at 28 to avoid the question.

   **Once.** The unique constraint on (owner_id, period_start, period_end) is
   the guarantee, not a check in the job.

   **And it does not send.** Generating can be done again; a statement of
   somebody's finances landing in their inbox cannot be taken back, and a job
   that quietly starts emailing every owner every month the day it ships is
   not a thing to switch on unasked. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import {
  statementDayIn, isStatementDay, dueToday, generateForCompany, runOwnerStatements,
} from "../server/lib/ownerstatements.js";

let world, company;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Statement Co" });
  await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", world.companyId);
  company = await get("SELECT id, timezone FROM company WHERE id = ?", world.companyId);
});

const setDay = (day) => run(
  "UPDATE owner SET statement_day = ? WHERE id = ?", day, world.ownerId);
const statements = () => all(
  "SELECT * FROM owner_statement WHERE owner_id = ? ORDER BY period_start", world.ownerId);

describe("which day it lands on", () => {
  test("31 is the last day, whatever the month's length", () => {
    assert.equal(statementDayIn("2026-01-15", 31), 31);
    assert.equal(statementDayIn("2026-02-15", 31), 28);
    assert.equal(statementDayIn("2028-02-15", 31), 29);
    assert.equal(statementDayIn("2026-04-15", 31), 30);
  });

  test("a day inside every month is itself", () => {
    assert.equal(statementDayIn("2026-02-15", 5), 5);
    assert.equal(statementDayIn("2026-02-15", 28), 28);
  });

  test("it fires on exactly one day a month", () => {
    for (const [month, last] of Object.entries({ "2026-02": 28, "2026-04": 30, "2026-01": 31 })) {
      let fired = 0;
      for (let d = 1; d <= last; d += 1) {
        if (isStatementDay(`${month}-${String(d).padStart(2, "0")}`, 31)) fired += 1;
      }
      assert.equal(fired, 1, `${month} fired ${fired} times`);
    }
  });
});

describe("what it generates", () => {
  test("the month that has just finished, not the one running", async () => {
    await setDay(5);
    const res = await generateForCompany(company, { on: "2026-03-05" });
    assert.equal(res.statementsGenerated, 1);

    const [s] = await statements();
    assert.equal(s.period_start, "2026-02-01");
    assert.equal(s.period_end, "2026-02-28", "February, complete — not a March with five days in it");
  });

  test("nothing on any other day", async () => {
    await setDay(5);
    const res = await generateForCompany(company, { on: "2026-03-06" });
    assert.equal(res.statementsGenerated, 0);
    assert.deepEqual(await statements(), []);
  });

  test("an owner set to the last day is served in February", async () => {
    await setDay(31);
    const res = await generateForCompany(company, { on: "2026-02-28" });
    assert.equal(res.statementsGenerated, 1,
      "the 31st of February does not exist, and the statement is still owed");
  });

  test("the snapshot carries the figures the screen would show", async () => {
    await setDay(5);
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId, date: "2026-02-10",
      kind: "rent_payment", amountCents: 120000, memo: "rent",
      source: "manual", postedBy: "test",
    });
    await generateForCompany(company, { on: "2026-03-05" });

    const [s] = await statements();
    const totals = JSON.parse(s.totals);
    assert.equal(totals.rent, 120000);
  });
});

describe("never twice", () => {
  test("a second run the same day files nothing new", async () => {
    await setDay(5);
    await generateForCompany(company, { on: "2026-03-05" });
    const second = await generateForCompany(company, { on: "2026-03-05" });

    assert.equal(second.statementsGenerated, 0);
    assert.equal(second.statementsSkipped, 1);
    assert.equal((await statements()).length, 1);
  });

  test("a statement already filed by hand is left alone", async () => {
    await setDay(5);
    const { insert } = await import("../server/lib/db.js");
    const { id, token } = await import("../server/lib/ids.js");
    await insert("owner_statement", {
      id: id(), company_id: world.companyId, owner_id: world.ownerId,
      period_start: "2026-02-01", period_end: "2026-02-28",
      totals: JSON.stringify({ net: 999, byHand: true }), token: token(),
      generated_at: "2026-03-01T00:00:00.000Z",
    });

    await generateForCompany(company, { on: "2026-03-05" });
    const [s] = await statements();
    assert.equal(JSON.parse(s.totals).byHand, true,
      "a scheduled run must not silently rewrite a figure an owner has already been shown");
  });

  test("the guarantee is the database, not the check", async () => {
    /* Both runs pass the `already` check before either inserts, which is the
       window a check-then-insert leaves open. The constraint closes it. */
    await setDay(5);
    const [a, b] = await Promise.allSettled([
      generateForCompany(company, { on: "2026-03-05" }),
      generateForCompany(company, { on: "2026-03-05" }),
    ]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "fulfilled");
    assert.equal((await statements()).length, 1, "one statement, however many ticks overlap");
  });
});

describe("what it refuses to do", () => {
  test("it sends nothing", async () => {
    await setDay(5);
    await run("UPDATE owner SET email = 'owner@example.test' WHERE id = ?", world.ownerId);
    await generateForCompany(company, { on: "2026-03-05" });

    const queued = await all(
      "SELECT id FROM outbox WHERE about_type = 'owner_statement'");
    assert.deepEqual(queued, [],
      "generating is reversible; emailing somebody's finances is not");

    const [s] = await statements();
    assert.equal(s.sent_at, null, "and the screen goes on saying 'not sent'");
  });
});

describe("the run across every company", () => {
  test("one company's broken owner does not cost another its statement", async () => {
    const other = await f.makeWorld({ name: "Other Statement Co" });
    await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", other.companyId);
    await run("UPDATE owner SET statement_day = 5 WHERE id IN (?, ?)",
      world.ownerId, other.ownerId);

    const res = await runOwnerStatements({ on: "2026-03-05" });
    assert.equal(res.statementsGenerated, 2);
  });

  test("dueToday says what is coming without filing it", async () => {
    await setDay(5);
    const due = await dueToday(world.companyId, "2026-03-05");
    assert.equal(due.length, 1);
    assert.equal(due[0].from, "2026-02-01");
    assert.equal(due[0].already, false);
    assert.deepEqual(await statements(), [], "asking is not doing");
  });
});
