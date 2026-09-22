/* Bringing pre-double-entry history into the books.

   This is the one piece of Phase 3 that touches money which already exists and
   which owners have already been shown. The ledger is append-only, so a
   conversion cannot be undone by deleting it — only by posting a reversal,
   which leaves both halves visible forever. That makes getting it right the
   first time the only option, and makes `plan()` reporting without writing the
   important half of the design.

   The choice the tests pin down: one opening journal per owner, not twelve
   retrospective ones. Back-dating a journal per historical entry would assert
   detail — which account, which side, which date — that is being inferred now
   from a `kind` column rather than recorded then, and an auditor reading it
   back has no way to tell reconstruction from record. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { plan, commit } from "../server/lib/convert.js";
import { parity, unpostedEntries } from "../server/lib/ledger.js";

let world, otherWorld;

before(async () => { await freshDatabase(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Legacy Co" });
  otherWorld = await f.makeWorld({ name: "Second Co" });
});

/* Entries written the way the old code did: ledger only, no journal. */
async function legacyEntry(companyId, ownerId, { kind, cents, date, unitId = null, leaseId = null }) {
  const { insert } = await import("../server/lib/db.js");
  const { id } = await import("../server/lib/ids.js");
  const rowId = id();
  await insert("ledger_entry", {
    id: rowId, company_id: companyId, owner_id: ownerId,
    unit_id: unitId, lease_id: leaseId, date, kind, amount_cents: cents,
    memo: `legacy ${kind}`, source: "manual", created_at: new Date().toISOString(),
  });
  return rowId;
}

describe("plan reports and writes nothing", () => {
  test("it finds the unposted entries", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 145000, date: "2026-03-01" });
    await legacyEntry(world.companyId, world.ownerId, { kind: "management_fee", cents: -14500, date: "2026-03-02" });

    const proposed = await plan();
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].companyName, "Legacy Co");
    assert.equal(proposed[0].entryCount, 2);
    assert.equal(proposed[0].earliest, "2026-03-01", "dated from the oldest entry, not from today");
    assert.equal(proposed[0].owners[0].netCents, 130500, "the net owner position, not the gross");
  });

  test("it writes nothing at all", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });
    await plan();

    assert.equal((await all("SELECT id FROM journal")).length, 0);
    const entry = await get("SELECT journal_id FROM ledger_entry LIMIT 1");
    assert.equal(entry.journal_id, null, "reporting must be safe to run against production");
  });

  test("commit refuses without the confirmation string", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });
    await assert.rejects(() => commit({}), /confirm/);
    await assert.rejects(() => commit({ confirm: "yes" }), /confirm/);
    assert.equal((await all("SELECT id FROM journal")).length, 0,
      "an irreversible operation should not be reachable by a typo");
  });

  test("a company already in parity is not listed", async () => {
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId,
      date: "2026-03-01", kind: "rent_payment", amountCents: 100000, memo: "proper",
    });
    const proposed = await plan();
    assert.equal(proposed.length, 0);
  });
});

describe("commit posts one opening journal per owner", () => {
  test("one journal, whatever the number of entries", async () => {
    for (let i = 1; i <= 6; i++) {
      await legacyEntry(world.companyId, world.ownerId, {
        kind: "rent_payment", cents: 100000, date: `2026-0${i}-01`,
      });
    }

    const results = await commit({ confirm: "post-opening-journals" });
    assert.equal(results.length, 1, "one journal, not six");
    assert.equal(results[0].entriesLinked, 6);

    const journals = await all("SELECT * FROM journal WHERE company_id = ?", world.companyId);
    assert.equal(journals.length, 1);
    assert.match(journals[0].memo, /Conversion: pre-double-entry/,
      "the memo says what it is, so nobody reads it as a real transaction");
    assert.equal(journals[0].date, "2026-01-01", "dated where the books begin");
  });

  test("every entry ends up linked", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 145000, date: "2026-03-01" });
    await legacyEntry(world.companyId, world.ownerId, { kind: "expense", cents: -22000, date: "2026-03-05" });
    await legacyEntry(world.companyId, world.ownerId, { kind: "other", cents: 5000, date: "2026-03-10" });

    await commit({ confirm: "post-opening-journals" });

    assert.deepEqual(await unpostedEntries(world.companyId), []);
    const state = await parity(world.companyId);
    assert.equal(state.inParity, true);
  });

  test("owners are kept apart", async () => {
    /* A single company-wide number would lose whose money it was, and make the
       first statement after conversion unexplainable. */
    const secondOwner = await f.makeOwner(world.companyId, { name: "Second Owner" });
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });
    await legacyEntry(world.companyId, secondOwner, { kind: "rent_payment", cents: 250000, date: "2026-03-01" });

    const results = await commit({ confirm: "post-opening-journals" });
    assert.equal(results.length, 2);

    const amounts = results.map((r) => r.netCents).sort((a, b) => a - b);
    assert.deepEqual(amounts, [100000, 250000]);

    const splits = await all(
      `SELECT DISTINCT owner_id FROM journal_split s
         JOIN journal j ON j.id = s.journal_id
        WHERE j.company_id = ? AND j.source_type = 'conversion'`, world.companyId);
    assert.equal(splits.length, 2, "each owner's carried-in position is its own");
  });

  test("companies are kept apart", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });
    await legacyEntry(otherWorld.companyId, otherWorld.ownerId, { kind: "rent_payment", cents: 300000, date: "2026-04-01" });

    await commit({ confirm: "post-opening-journals" });

    const first = await all("SELECT * FROM journal WHERE company_id = ?", world.companyId);
    const second = await all("SELECT * FROM journal WHERE company_id = ?", otherWorld.companyId);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].date, "2026-03-01");
    assert.equal(second[0].date, "2026-04-01", "each company's books begin where its own history does");
  });

  test("a negative position posts the other way round", async () => {
    /* An owner who was owed nothing and had costs against them carried in a
       debit, not a credit. Getting this backwards would show them as holding
       money they do not have. */
    await legacyEntry(world.companyId, world.ownerId, { kind: "expense", cents: -50000, date: "2026-03-01" });

    await commit({ confirm: "post-opening-journals" });

    const splits = await all(
      `SELECT s.*, a.code FROM journal_split s
         JOIN account a ON a.id = s.account_id
         JOIN journal j ON j.id = s.journal_id
        WHERE j.company_id = ? AND j.source_type = 'conversion'`, world.companyId);

    const trust = splits.find((s) => s.code === "1010");
    assert.equal(Number(trust.credit_cents), 50000, "trust cash is credited, not debited");
  });

  test("the book still balances afterwards", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 145000, date: "2026-03-01" });
    await legacyEntry(world.companyId, world.ownerId, { kind: "management_fee", cents: -14500, date: "2026-03-02" });
    await legacyEntry(otherWorld.companyId, otherWorld.ownerId, { kind: "expense", cents: -33000, date: "2026-04-01" });

    await commit({ confirm: "post-opening-journals" });

    const row = await get(
      `SELECT COALESCE(SUM(debit_cents),0)::bigint AS d, COALESCE(SUM(credit_cents),0)::bigint AS c
         FROM journal_split`);
    assert.equal(Number(row.d), Number(row.c));
  });

  test("running it twice changes nothing the second time", async () => {
    /* It is not idempotent by luck: entries already linked are not selected,
       so a second run finds nothing to convert. */
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });

    const first = await commit({ confirm: "post-opening-journals" });
    const second = await commit({ confirm: "post-opening-journals" });

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal((await all("SELECT id FROM journal WHERE company_id = ?", world.companyId)).length, 1);
  });

  test("new entries after conversion post normally, not through conversion", async () => {
    await legacyEntry(world.companyId, world.ownerId, { kind: "rent_payment", cents: 100000, date: "2026-03-01" });
    await commit({ confirm: "post-opening-journals" });

    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId,
      date: "2026-07-01", kind: "rent_payment", amountCents: 145000, memo: "July rent",
    });

    const conversions = await all(
      "SELECT id FROM journal WHERE company_id = ? AND source_type = 'conversion'", world.companyId);
    assert.equal(conversions.length, 1, "the conversion happens once and then is history");

    const state = await parity(world.companyId);
    assert.equal(state.inParity, true);
  });
});
