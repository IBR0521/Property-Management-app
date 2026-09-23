/* The financial statements.

   The roadmap's test for this phase is one sentence: the P&L and the balance
   sheet must tie out to the trial balance. That is the spine of this file, and
   it is asserted against books built here rather than against whatever the
   application happens to produce — a report that agrees with the application
   only proves the two were written by the same person on the same afternoon.

   The other half is the distinction the whole file turns on. A balance sheet
   is **as at a moment** and a profit and loss is **for a period**. Both take
   dates, neither complains when given the wrong ones, and mixing them up
   gives you a balance sheet that does not balance and a P&L that grows for
   ever. So each is tested for the thing it must ignore. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { today } from "../server/lib/dates.js";
import { postJournal, ensureChart, trialBalance } from "../server/features/accounting.js";
import {
  profitAndLoss, profitAndLossByProperty, balanceSheet, cashMovement, generalLedger,
} from "../server/lib/reports/financial.js";

let world, second;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Report Co" });
  await ensureChart(world.companyId);
  /* A second property under the same owner, so "by property" has something to
     divide. */
  second = await f.makeProperty(world.companyId, world.ownerId, { line1: "9 Second Street" });
});

const post = (date, memo, splits) =>
  postJournal({ companyId: world.companyId, date, memo, source: "manual", splits });

/* A small, complete book: rent charged and collected on two properties, a
   management fee, an owner's repair, and a bank charge belonging to neither
   property. Every figure below is derived from these. */
async function book() {
  const a = { ownerId: world.ownerId, propertyId: world.propertyId };
  const b = { ownerId: world.ownerId, propertyId: second };

  await post("2026-03-31", "rent charged, property A", [
    { code: "1300", debit: 100000, ...a }, { code: "2400", credit: 100000, ...a },
  ]);
  await post("2026-04-05", "rent received, property A", [
    { code: "1010", debit: 100000, ...a }, { code: "1300", credit: 100000, ...a },
    { code: "2400", debit: 100000, ...a }, { code: "2200", credit: 100000, ...a },
  ]);
  await post("2026-04-30", "management fee, property A", [
    { code: "2200", debit: 8000, ...a }, { code: "4200", credit: 8000, ...a },
  ]);
  await post("2026-04-30", "rent charged, property B", [
    { code: "1300", debit: 60000, ...b }, { code: "2400", credit: 60000, ...b },
  ]);
  await post("2026-05-06", "rent received, property B", [
    { code: "1010", debit: 60000, ...b }, { code: "1300", credit: 60000, ...b },
    { code: "2400", debit: 60000, ...b }, { code: "2200", credit: 60000, ...b },
  ]);
  await post("2026-05-10", "owner repair, property B", [
    { code: "2200", debit: 15000, ...b }, { code: "1010", credit: 15000, ...b },
  ]);
  await post("2026-05-31", "management fee, property B", [
    { code: "2200", debit: 4800, ...b }, { code: "4200", credit: 4800, ...b },
  ]);
  /* Belongs to no property. The row every dimensional report has to account
     for rather than drop. */
  await post("2026-05-31", "bank charge", [
    { code: "5100", debit: 1200 }, { code: "1010", credit: 1200 },
  ]);
}

/* --- the spine -------------------------------------------------------------- */

describe("tying out to the trial balance", () => {
  test("the balance sheet balances", async () => {
    await book();
    const bs = await balanceSheet(world.companyId, { asOf: today() });
    assert.equal(bs.outOfBalanceCents, 0,
      "assets must equal liabilities plus equity plus earnings not yet closed");
    assert.equal(bs.assets.cents, bs.totalCents);
  });

  test("every balance on it is the trial balance's", async () => {
    /* Not a recomputation that happens to agree — the same numbers. */
    await book();
    const tb = new Map((await trialBalance(world.companyId)).map((r) => [r.code, r.balance]));
    const bs = await balanceSheet(world.companyId, { asOf: today() });

    for (const row of [
      ...bs.assets.restricted, ...bs.assets.unrestricted,
      ...bs.liabilities.restricted, ...bs.liabilities.unrestricted,
      ...bs.equity.rows,
    ]) {
      assert.equal(row.balance, tb.get(row.code), `${row.code} ${row.name}`);
    }
  });

  test("the P&L is the trial balance's income and expense", async () => {
    await book();
    const tb = await trialBalance(world.companyId);
    const income = tb.filter((r) => r.type === "income").reduce((n, r) => n + r.balance, 0);
    const expense = tb.filter((r) => r.type === "expense").reduce((n, r) => n + r.balance, 0);

    const pl = await profitAndLoss(world.companyId, { from: null, to: today() });
    assert.equal(pl.incomeCents, income);
    assert.equal(pl.expenseCents, expense);
    assert.equal(pl.netCents, income - expense);
  });

  test("the figures are the ones the book was built from", async () => {
    /* A tie-out between two things that are both wrong is still a tie-out.
       These are the numbers written into `book()` above. */
    await book();
    const pl = await profitAndLoss(world.companyId, { from: null, to: today() });
    assert.equal(pl.incomeCents, 8000 + 4800, "two management fees");
    assert.equal(pl.expenseCents, 1200, "the bank charge, and nothing else");

    const bs = await balanceSheet(world.companyId, { asOf: today() });
    assert.equal(bs.assets.cents, 100000 + 60000 - 15000 - 1200, "what is left in trust");
  });
});

/* --- as at, against for ------------------------------------------------------ */

describe("as at a moment, and for a period", () => {
  test("the balance sheet ignores everything after its date", async () => {
    await book();
    const april = await balanceSheet(world.companyId, { asOf: "2026-04-30" });
    const trust = april.assets.restricted.find((r) => r.code === "1010");
    const owed = april.assets.unrestricted.find((r) => r.code === "1300");

    assert.equal(trust.balance, 100000, "property B's rent had not arrived yet");
    assert.equal(owed.balance, 60000, "but it had been charged on the 30th, so it is owed");
    assert.equal(april.outOfBalanceCents, 0, "and it still balances");
  });

  test("the balance sheet includes everything before it", async () => {
    /* It is cumulative, not a period. A balance sheet that only counted one
       month would be a statement of nothing in particular. */
    await book();
    const may = await balanceSheet(world.companyId, { asOf: "2026-05-31" });
    assert.equal(may.assets.cents, 100000 + 60000 - 15000 - 1200);
  });

  test("the P&L counts only its own period", async () => {
    await book();
    const april = await profitAndLoss(world.companyId, { from: "2026-04-01", to: "2026-04-30" });
    assert.equal(april.incomeCents, 8000, "only property A's fee");
    assert.equal(april.expenseCents, 0, "the bank charge is in May");

    const may = await profitAndLoss(world.companyId, { from: "2026-05-01", to: "2026-05-31" });
    assert.equal(may.incomeCents, 4800);
    assert.equal(may.expenseCents, 1200);
  });

  test("the periods add up to the whole", async () => {
    await book();
    const whole = await profitAndLoss(world.companyId, { from: null, to: today() });
    let sum = 0;
    for (const [from, to] of [["2026-03-01", "2026-03-31"], ["2026-04-01", "2026-04-30"],
                              ["2026-05-01", "2026-05-31"], ["2026-06-01", today()]]) {
      sum += (await profitAndLoss(world.companyId, { from, to })).netCents;
    }
    assert.equal(sum, whole.netCents);
  });
});

/* --- by property -------------------------------------------------------------- */

describe("split by property", () => {
  test("the columns explain the total exactly", async () => {
    /* The arithmetic that makes a dimensional report trustworthy. Anything
       but zero here and the parts do not add up to the whole. */
    await book();
    const r = await profitAndLossByProperty(world.companyId, { from: null, to: today() });
    assert.equal(r.unexplainedCents, 0);
    assert.equal(r.columns.reduce((n, c) => n + c.netCents, 0), r.totalCents);
  });

  test("unallocated carries what belongs to no property", async () => {
    /* The bank charge. A report that silently dropped it would stop agreeing
       with the trial balance and nobody could tell why. */
    await book();
    const r = await profitAndLossByProperty(world.companyId, { from: null, to: today() });
    const loose = r.columns.find((c) => c.propertyId === null);

    assert.ok(loose, "the row must exist");
    assert.equal(loose.expenseCents, 1200);
    assert.equal(loose.netCents, -1200);
  });

  test("unallocated is shown even when it is zero", async () => {
    /* Absent and zero read the same to somebody scanning a report, and they
       mean very different things. */
    const a = { ownerId: world.ownerId, propertyId: world.propertyId };
    await post("2026-04-30", "fee", [
      { code: "2200", debit: 5000, ...a }, { code: "4200", credit: 5000, ...a },
    ]);

    const r = await profitAndLossByProperty(world.companyId, { from: null, to: today() });
    const loose = r.columns.find((c) => c.propertyId === null);
    assert.ok(loose);
    assert.equal(loose.netCents, 0);
  });

  test("each property gets only its own", async () => {
    await book();
    const r = await profitAndLossByProperty(world.companyId, { from: null, to: today() });
    const a = r.columns.find((c) => c.propertyId === world.propertyId);
    const b = r.columns.find((c) => c.propertyId === second);

    assert.equal(a.incomeCents, 8000);
    assert.equal(b.incomeCents, 4800);
  });
});

/* --- the restricted split ------------------------------------------------------ */

describe("client money on the balance sheet", () => {
  test("it is segregated rather than split into a second statement", async () => {
    /* One reporting entity, one balance sheet. The company is the account
       holder at the bank, so trust cash is its asset with an offsetting
       liability — it belongs on the sheet, marked. */
    await book();
    const bs = await balanceSheet(world.companyId, { asOf: today() });

    assert.ok(bs.assets.restricted.some((r) => r.code === "1010"), "trust cash is restricted");
    assert.ok(bs.liabilities.restricted.some((r) => r.code === "2200"), "owner funds are");
    assert.ok(!bs.liabilities.restricted.some((r) => r.code === "2400"),
      "rent not yet collected is not client money — it has not arrived");
  });

  test("the restricted lines net to the fee not yet swept", async () => {
    /* The number the segregation exists to make visible: money that is the
       manager's, still sitting in the trust account. */
    await book();
    const bs = await balanceSheet(world.companyId, { asOf: today() });
    assert.equal(bs.assets.restrictedCents - bs.liabilities.restrictedCents, 8000 + 4800 - 1200);
  });
});

/* --- cash ---------------------------------------------------------------------- */

describe("cash movement", () => {
  test("opening plus in less out is closing", async () => {
    await book();
    const r = await cashMovement(world.companyId, { from: "2026-05-01", to: "2026-05-31" });
    const trust = r.accounts.find((a) => a.code === "1010");

    assert.equal(trust.openingCents, 100000, "April's rent was already in");
    assert.equal(trust.inCents, 60000);
    assert.equal(trust.outCents, 15000 + 1200);
    assert.equal(trust.closingCents, trust.openingCents + trust.inCents - trust.outCents);
  });

  test("it says what each movement was against", async () => {
    /* The only part of a cash report that tells anybody anything. */
    await book();
    const r = await cashMovement(world.companyId, { from: "2026-05-01", to: "2026-05-31" });
    const trust = r.accounts.find((a) => a.code === "1010");

    assert.ok(trust.against.some((x) => x.code === "5100" && x.outCents === 1200),
      "the bank charge");
    assert.ok(trust.against.some((x) => x.code === "2200" && x.outCents === 15000),
      "the owner's repair");
  });
});

/* --- the general ledger --------------------------------------------------------- */

describe("general ledger detail", () => {
  test("it balances overall", async () => {
    await book();
    const gl = await generalLedger(world.companyId, { from: null, to: today() });
    assert.equal(gl.debitCents, gl.creditCents);
  });

  test("the running balance restarts for each account", async () => {
    /* A running total carried across different accounts is a number with no
       meaning. */
    await book();
    const gl = await generalLedger(world.companyId, { from: null, to: today() });

    const seen = new Set();
    for (const line of gl.lines) {
      if (seen.has(line.code)) continue;
      seen.add(line.code);
      /* The first line of an account carries only its own posting, signed the
         way that account reads. Anything else means a balance was carried in
         from the account above it. */
      const own = line.debitCents - line.creditCents;
      assert.equal(Math.abs(line.runningCents), Math.abs(own),
        `${line.code} carried a balance in from another account`);
    }
    assert.ok(seen.size > 3, "several accounts were actually checked");
  });

  test("the last running balance of an account is its balance", async () => {
    await book();
    const gl = await generalLedger(world.companyId, { from: null, to: today(), code: "1010" });
    const tb = await trialBalance(world.companyId);
    const expected = tb.find((r) => r.code === "1010").balance;
    assert.equal(gl.lines.at(-1).runningCents, expected);
  });

  test("it can be narrowed to one property", async () => {
    await book();
    const gl = await generalLedger(world.companyId, { from: null, to: today(), propertyId: second });
    assert.ok(gl.lines.length > 0);
    for (const line of gl.lines) assert.equal(line.propertyId, second);
  });

  test("it says when it has been truncated", async () => {
    /* A report silently showing the first N rows is how somebody concludes a
       number is wrong. */
    await book();
    const gl = await generalLedger(world.companyId, { from: null, to: today(), limit: 3 });
    assert.equal(gl.lines.length, 3);
    assert.equal(gl.truncated, true);
  });
});
