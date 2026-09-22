/* The two books agree.

   `ledger_entry` drives owner statements. `journal` is the company's
   double-entry book. They were being written independently, so recording rent
   told an owner what they were owed and told the company's accounts nothing —
   twelve payments and $13,710 had accumulated on one side only.

   The invariant this file defends: **no owner-visible money exists outside the
   company's books.** Every ledger entry has a journal behind it, and the
   journal balances, which the database already enforces.

   The last test is the one that will catch the next regression. It drives the
   real HTTP paths a person actually uses — record a payment, log a cost, add
   an owner entry — and then asserts parity across everything, rather than
   trusting that a call site was converted. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { postMoney, postingFor, parity, unpostedEntries } from "../server/lib/ledger.js";

let app, world, staffClient;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Parity Co" });
  staffClient = client(app.origin);
  const res = await staffClient.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

describe("the mapping from one book to the other", () => {
  test("every ledger kind has a double-entry posting", async () => {
    /* A kind with no posting is money that would enter the owner's statement
       and never reach the company's accounts — which is exactly the bug. */
    /* The CHECK constraint is the source of truth for which kinds exist, so a
       kind added later without a posting fails here rather than in production. */
    const def = await get(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'ledger_entry'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%rent_charge%'`);
    const declared = [...String(def.d).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    assert.ok(declared.length >= 6, `found ${declared.length} kinds`);
    for (const kind of declared) {
      assert.ok(postingFor(kind, 10000), `${kind} has no posting — it would bypass the books`);
    }
  });

  test("every posting balances", () => {
    const def = ["rent_charge", "rent_payment", "expense", "management_fee",
                 "deposit_held", "deposit_returned", "other"];
    for (const kind of def) {
      const splits = postingFor(kind, 123456);
      const debits = splits.reduce((n, s) => n + (s.debit || 0), 0);
      const credits = splits.reduce((n, s) => n + (s.credit || 0), 0);
      assert.equal(debits, credits, `${kind} does not balance`);
      assert.equal(splits.length, 2, `${kind} should be a simple pair`);
    }
  });

  test("a deposit is a liability, not income", () => {
    /* The classic trust-accounting failure: treating somebody else's money as
       revenue because it arrived in your bank. */
    const splits = postingFor("deposit_held", 100000);
    const credited = splits.find((s) => s.credit);
    assert.equal(credited.code, "2100", "deposits are owed back to the tenant");
  });

  test("rent received goes into trust cash, not the company's own", () => {
    const splits = postingFor("rent_payment", 145000);
    const debited = splits.find((s) => s.debit);
    assert.equal(debited.code, "1010", "client money is distinguishable from the company's");
  });

  test("a zero amount posts nothing", () => {
    assert.equal(postingFor("rent_payment", 0), null);
  });
});

describe("postMoney writes both books or neither", () => {
  test("an entry and a journal, linked", async () => {
    const { entryId, journalId } = await postMoney({
      companyId: world.companyId, ownerId: world.ownerId,
      unitId: world.unitId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "rent_payment", amountCents: 145000,
      memo: "June rent",
    });

    const entry = await get("SELECT * FROM ledger_entry WHERE id = ?", entryId);
    assert.equal(entry.journal_id, journalId, "the entry points at its journal");

    const splits = await all("SELECT * FROM journal_split WHERE journal_id = ?", journalId);
    assert.equal(splits.length, 2);
    const total = splits.reduce((n, s) => n + Number(s.debit_cents), 0);
    assert.equal(total, 145000);
  });

  test("a failed entry leaves no journal behind", async () => {
    /* The enclosing transaction is what makes this true. A journal with no
       entry is money in the company's books that no owner can see; an entry
       with no journal is the bug this whole file exists about. Neither may
       survive alone.

       Forced with an owner id that does not exist, so the journal posts and
       then the entry's foreign key fails. */
    await assert.rejects(
      () => postMoney({
        companyId: world.companyId, ownerId: "no-such-owner-id",
        date: "2026-06-01", kind: "rent_payment", amountCents: 100000, memo: "bad",
      }));

    const entries = await all("SELECT id FROM ledger_entry WHERE company_id = ?", world.companyId);
    const journals = await all("SELECT id FROM journal WHERE company_id = ?", world.companyId);
    assert.equal(entries.length, 0, "no entry");
    assert.equal(journals.length, 0, "and no orphaned journal either");
  });

  test("the journal carries the owner and unit, so a report can group by them", async () => {
    const { journalId } = await postMoney({
      companyId: world.companyId, ownerId: world.ownerId,
      propertyId: world.propertyId, unitId: world.unitId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "rent_payment", amountCents: 100000, memo: "rent",
    });
    const splits = await all("SELECT * FROM journal_split WHERE journal_id = ?", journalId);
    for (const s of splits) {
      assert.equal(s.owner_id, world.ownerId);
      assert.equal(s.unit_id, world.unitId);
    }
  });
});

describe("parity across the real paths", () => {
  test("recording a rent payment posts both books", async () => {
    const res = await staffClient.post("/app/rent/record",
      { lease_id: world.leaseId, amount: "1450.00", date: "2026-06-03", memo: "June rent" },
      { csrfFrom: "/app/rent" });
    assert.ok(res.status < 400, `recording failed: ${res.status}`);

    const entry = await get(
      "SELECT * FROM ledger_entry WHERE company_id = ? AND kind = 'rent_payment'", world.companyId);
    assert.ok(entry, "the owner sees it");
    assert.ok(entry.journal_id, "and so do the company's accounts — this was the bug");

    const state = await parity(world.companyId);
    assert.equal(state.inParity, true);
  });

  test("an owner ledger entry posts both books", async () => {
    const res = await staffClient.post(`/app/owners/${world.ownerId}/ledger`,
      { kind: "management_fee", amount: "145.00", date: "2026-06-03", memo: "June fee" },
      { csrfFrom: `/app/owners/${world.ownerId}` });
    assert.ok(res.status < 400);

    const state = await parity(world.companyId);
    assert.equal(state.unposted, 0, "an owner entry with no journal is money outside the books");
  });

  test("a late fee posts both books and links them", async () => {
    await run("UPDATE lease SET late_fee_cents = ?, rent_due_day = 1, grace_days = 5 WHERE id = ?",
      5000, world.leaseId);
    const { sweepLateFees } = await import("../server/lib/latefees.js");
    const result = await sweepLateFees({ asOf: "2026-06-20", postedBy: "test" });
    assert.equal(result.charged, 1);

    const state = await parity(world.companyId);
    assert.equal(state.inParity, true, "the sweep wrote both books but did not link them");
  });

  test("nothing anywhere is left unposted", async () => {
    /* The regression catcher. Drives the paths a person uses and then asks the
       database, rather than trusting that each call site was converted. */
    await staffClient.post("/app/rent/record",
      { lease_id: world.leaseId, amount: "1450.00", date: "2026-06-03", memo: "rent" },
      { csrfFrom: "/app/rent" });
    await staffClient.post(`/app/owners/${world.ownerId}/ledger`,
      { kind: "expense", amount: "220.00", date: "2026-06-04", memo: "gutter" },
      { csrfFrom: `/app/owners/${world.ownerId}` });

    const orphans = await unpostedEntries();
    assert.deepEqual(orphans.map((o) => `${o.kind} ${o.amount_cents} on ${o.date}`), [],
      "owner-visible money exists that the company's books do not know about");
  });

  test("the whole journal still balances", async () => {
    await staffClient.post("/app/rent/record",
      { lease_id: world.leaseId, amount: "1450.00", date: "2026-06-03", memo: "rent" },
      { csrfFrom: "/app/rent" });

    const row = await get(
      `SELECT COALESCE(SUM(debit_cents),0)::bigint AS d, COALESCE(SUM(credit_cents),0)::bigint AS c
         FROM journal_split`);
    assert.equal(Number(row.d), Number(row.c));
  });
});

describe("the accounts the payment paths need", () => {
  /* A chart is created on first posting rather than at signup, so it has to be
     asked for before it can be inspected. That laziness is deliberate — a
     company that never records money never needs a chart — and it is also how
     the drift happened: migration 020 added these accounts for companies that
     already existed, and ensureChart did not know about them, so a company
     created afterwards failed to post a rent payment at all. */
  beforeEach(async () => {
    const { ensureChart } = await import("../server/features/accounting.js");
    await ensureChart(world.companyId);
  });

  test("payments in transit exists and is trust money", async () => {
    /* A tenant's payment is authorised days before it settles. During that
       window it is real, owed to the owner, and not yet spendable — so it
       cannot be counted as cash the company has, nor left uncounted. */
    const acct = await get(
      "SELECT * FROM account WHERE company_id = ? AND code = '1020'", world.companyId);
    assert.ok(acct, "an in-transit account is needed before ACH exists");
    assert.equal(acct.is_trust, 1);
    assert.equal(acct.type, "asset");
  });

  test("every account the code names actually exists", async () => {
    /* The test that catches the next drift. ACCT is the set of codes the
       application posts against; if one of them is missing from the chart a
       posting fails at runtime with a lookup error, which is what happened
       here. */
    const { ACCT } = await import("../server/features/accounting.js");
    const rows = await all("SELECT code FROM account WHERE company_id = ?", world.companyId);
    const have = new Set(rows.map((r) => r.code));
    const missing = Object.entries(ACCT).filter(([, code]) => !have.has(code));
    assert.deepEqual(missing, [],
      `these codes are used in code and absent from a new company's chart: ${missing.map(([k]) => k).join(", ")}`);
  });

  test("fees recovered and fees paid are separate accounts", async () => {
    /* A processing fee passed to a tenant is income; the fee the processor
       charges is an expense. Netting them hides both. */
    const recovered = await get("SELECT * FROM account WHERE company_id = ? AND code = '4300'", world.companyId);
    const paid = await get("SELECT * FROM account WHERE company_id = ? AND code = '5200'", world.companyId);
    assert.equal(recovered.type, "income");
    assert.equal(paid.type, "expense");
  });
});
