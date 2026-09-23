/* The three-way trust reconciliation.

   Built before the postings it is meant to check were corrected, deliberately,
   so that the correction has something independent that can say whether it
   worked. That ordering shapes this file: the first half proves the report
   *detects* a broken book, and the second proves it does not cry wolf over a
   sound one.

   Both halves build their own journals by hand rather than driving the
   application. That is the point — a detector that is only ever tested against
   whatever the application currently does can only ever confirm that the
   application is consistent with itself, which is exactly the failure it
   exists to catch. The books it is fed here are constructed to be right and
   constructed to be wrong, on purpose. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { postJournal, ensureChart, accountByCode } from "../server/features/accounting.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Trust Co" });
  await ensureChart(world.companyId);
});

const RENT = 137100;

/* An owner-visible entry and the journal behind it, posted the way the
   application posts them today. `postMoney` is deliberately not used: these
   tests describe books, not features. */
async function ledgerEntry({ kind, amountCents, journalId = null, date = today() }) {
  const entryId = id();
  await insert("ledger_entry", {
    id: entryId, company_id: world.companyId, owner_id: world.ownerId,
    property_id: world.propertyId, unit_id: world.unitId, lease_id: world.leaseId,
    date, kind, amount_cents: amountCents, memo: kind, source: "manual",
    journal_id: journalId, created_at: stamp(),
  });
  return entryId;
}

const post = (memo, splits, date = today()) =>
  postJournal({ companyId: world.companyId, date, memo, source: "manual", splits });

/* --- does it see a broken book? ------------------------------------------- */

describe("a book with the defect this application has today", () => {
  /* Rent received but never charged, and an owner's repair booked as the
     manager's expense. Written out explicitly so this test keeps meaning the
     same thing after the application stops doing it. */
  async function brokenBook() {
    const rentJournal = await post("rent received", [
      { code: "1010", debit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "1300", credit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
    ]);
    await ledgerEntry({ kind: "rent_payment", amountCents: RENT, journalId: rentJournal });

    const repairJournal = await post("owner repair", [
      { code: "5000", debit: 27350, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "1010", credit: 27350, ownerId: world.ownerId, propertyId: world.propertyId },
    ]);
    await ledgerEntry({ kind: "expense", amountCents: -27350, journalId: repairJournal });

    const feeJournal = await post("management fee", [
      { code: "2200", debit: 7591, ownerId: world.ownerId },
      { code: "4200", credit: 7591, ownerId: world.ownerId },
    ]);
    await ledgerEntry({ kind: "management_fee", amountCents: -7591, journalId: feeJournal });
  }

  test("it does not report a broken book as balanced", async () => {
    /* The whole reason this exists. The trial balance balances — the database
       will not accept a journal that does not — and the book is still wrong. */
    await brokenBook();
    const r = await trustReconciliation(world.companyId);
    assert.equal(r.balanced, false);
  });

  test("it names the negative trust liability", async () => {
    await brokenBook();
    const r = await trustReconciliation(world.companyId);

    const negative = r.findings.find((x) => x.title.includes("2200"));
    assert.ok(negative, "a liability below zero should be named");
    assert.equal(negative.severity, "error");

    const owed = r.legs.clients.rows.find((x) => x.code === "2200");
    assert.equal(owed.balance, -7591, "fees taken against an obligation never recorded");
  });

  test("it catches the control account disagreeing with the individual ledgers", async () => {
    /* The check that only a third leg can make. The control account says one
       thing and the records the owner is actually shown say another. */
    await brokenBook();
    const r = await trustReconciliation(world.companyId);

    assert.equal(r.legs.clients.cents, -7591, "what the journal says is owed");
    assert.equal(r.legs.subledger.cents, RENT - 27350 - 7591, "what the owner is shown");

    const v = r.variances.find((x) => x.key === "clients_vs_subledger");
    assert.notEqual(v.cents, 0);
    assert.ok(r.findings.some((x) => x.title.includes("individual ledgers")));
  });

  test("it refuses the reassuring explanation for the surplus", async () => {
    /* A trust account holding more than it owes is normally unswept fees, and
       saying that here would be the most misleading thing this report could
       do: the total it is being measured against is not a real obligation. */
    await brokenBook();
    const r = await trustReconciliation(world.companyId);

    const surplus = r.findings.find((x) => x.title.includes("more than is owed"));
    assert.ok(surplus);
    assert.equal(surplus.severity, "error");
    assert.match(surplus.detail, /not available/);
  });
});

/* --- does it stay quiet about a sound one? -------------------------------- */

describe("a book posted the way the plan proposes", () => {
  /* Rent charged against a non-trust liability, moved into trust only on
     receipt. The four-split receipt is the shape that keeps the two halves
     from coming apart. */
  async function soundBook() {
    /* 2400 comes from the chart now rather than being made here. It was
       hand-inserted when this test was written, before the account existed —
       which is exactly the drift the chart test guards against, caught the
       other way round. */
    await post("rent charged", [
      { code: "1300", debit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "2400", credit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
    ]);

    const received = await post("rent received", [
      { code: "1010", debit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "1300", credit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "2400", debit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "2200", credit: RENT, ownerId: world.ownerId, propertyId: world.propertyId },
    ]);
    await ledgerEntry({ kind: "rent_payment", amountCents: RENT, journalId: received });

    const repair = await post("owner repair", [
      { code: "2200", debit: 27350, ownerId: world.ownerId, propertyId: world.propertyId },
      { code: "1010", credit: 27350, ownerId: world.ownerId, propertyId: world.propertyId },
    ]);
    await ledgerEntry({ kind: "expense", amountCents: -27350, journalId: repair });

    const fee = await post("management fee", [
      { code: "2200", debit: 7591, ownerId: world.ownerId },
      { code: "4200", credit: 7591, ownerId: world.ownerId },
    ]);
    await ledgerEntry({ kind: "management_fee", amountCents: -7591, journalId: fee });
  }

  test("the control account and the individual ledgers agree to the cent", async () => {
    await soundBook();
    const r = await trustReconciliation(world.companyId);

    const expected = RENT - 27350 - 7591;
    assert.equal(r.legs.clients.cents, expected);
    assert.equal(r.legs.subledger.cents, expected);
    assert.equal(r.variances.find((v) => v.key === "clients_vs_subledger").cents, 0);
  });

  test("the surplus is the fee, and is described as the fee", async () => {
    /* Trust cash still holds the management fee: it has been earned and taken
       from the owner's funds, and not yet moved to the operating account. That
       is a real and explainable variance rather than an error. */
    await soundBook();
    const r = await trustReconciliation(world.companyId);

    assert.equal(r.legs.book.cents, RENT - 27350);
    assert.equal(r.variances.find((v) => v.key === "book_vs_clients").cents, 7591);

    const surplus = r.findings.find((x) => x.title.includes("more than is owed"));
    assert.equal(surplus.severity, "warn");
    assert.match(surplus.detail, /not yet moved to your operating account/);
  });

  test("no trust account is negative", async () => {
    await soundBook();
    const r = await trustReconciliation(world.companyId);
    const negative = [...r.legs.book.rows, ...r.legs.clients.rows].filter((x) => x.balance < 0);
    assert.deepEqual(negative.map((x) => x.code), []);
  });
});

/* --- the bank leg ---------------------------------------------------------- */

describe("the bank leg", () => {
  /* A manually reconciled account — the shape a company has before anybody
     connects an aggregator, and the one most of them will stay in. */
  async function trustAccount(balanceCents) {
    const itemId = id();
    await insert("bank_item", {
      id: itemId, company_id: world.companyId, provider: "manual",
      institution_name: "Test Bank", status: "active", created_at: stamp(),
    });
    const accountId = id();
    await insert("bank_account", {
      id: accountId, company_id: world.companyId, item_id: itemId,
      external_id: `ext-${accountId}`,
      name: "Trust checking", mask: "4417", type: "depository",
      balance_cents: balanceCents, is_trust: 1, active: 1, created_at: stamp(),
    });
    return accountId;
  }

  test("no connected account is unavailable, not zero", async () => {
    /* The distinction this report turns on. "Nobody has told us" and "the
       account is empty" are different answers, and reporting the second when
       the first is true invents a variance out of nothing. */
    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.cents, null);
    assert.match(r.legs.bank.unavailable, /no trust bank account/);
    assert.equal(r.variances.find((v) => v.key === "bank_vs_book").cents, null);
    assert.ok(r.unchecked.includes("bank_vs_book"));
  });

  test("a connected account reporting nothing is also unavailable", async () => {
    /* An aggregator that has never returned a balance leaves zero in the
       column, and treating that as a real figure would report the entire
       trust balance as missing. */
    await trustAccount(0);
    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.cents, null);
    assert.match(r.legs.bank.unavailable, /no balance has been reported/);
  });

  test("it never reports a reconciliation as balanced when a leg was not checked", async () => {
    /* A report that says "balanced" because it could not look is worse than
       one that says nothing. */
    await post("rent received", [
      { code: "1010", debit: RENT, ownerId: world.ownerId },
      { code: "2200", credit: RENT, ownerId: world.ownerId },
    ]);
    await ledgerEntry({ kind: "rent_payment", amountCents: RENT });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.book.cents, r.legs.clients.cents, "those two do agree");
    assert.equal(r.balanced, false, "and the bank leg was never checked");
    assert.ok(r.findings.some((x) => x.title.includes("bank leg could not be checked")));
  });

  test("payments issued and not yet cleared are taken off the bank's figure", async () => {
    /* A cheque hits the book the day it is written and the statement a
       fortnight later. That gap is not an error; failing to allow for it
       would make every reconciliation fail for two weeks a month. */
    await trustAccount(100000);

    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: world.companyId, kind: "owner", method: "check",
      effective_date: today(), status: "issued", total_cents: 25000, item_count: 1,
      created_by: "test", created_at: stamp(),
    });
    await insert("payout_item", {
      id: id(), company_id: world.companyId, batch_id: batchId,
      owner_id: world.ownerId, payee_name: "Test Owner", amount_cents: 25000,
      created_at: stamp(),
    });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.reported, 100000);
    assert.equal(r.legs.bank.outstandingPayments.cents, 25000);
    assert.equal(r.legs.bank.cents, 75000, "the bank's figure, brought onto the book's footing");
  });

  test("a voided payment is not outstanding", async () => {
    await trustAccount(100000);
    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: world.companyId, kind: "owner", method: "check",
      effective_date: today(), status: "issued", total_cents: 25000, item_count: 1,
      created_by: "test", created_at: stamp(),
    });
    await insert("payout_item", {
      id: id(), company_id: world.companyId, batch_id: batchId,
      owner_id: world.ownerId, payee_name: "Test Owner", amount_cents: 25000,
      voided_at: stamp(), void_reason: "reissued", created_at: stamp(),
    });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.outstandingPayments.cents, 0);
    assert.equal(r.legs.bank.cents, 100000);
  });

  test("a draft run is a proposal, not a payment", async () => {
    await trustAccount(100000);
    const batchId = id();
    await insert("payout_batch", {
      id: batchId, company_id: world.companyId, kind: "owner", method: "check",
      effective_date: today(), status: "draft", total_cents: 25000, item_count: 1,
      created_by: "test", created_at: stamp(),
    });
    await insert("payout_item", {
      id: id(), company_id: world.companyId, batch_id: batchId,
      owner_id: world.ownerId, payee_name: "Test Owner", amount_cents: 25000,
      created_at: stamp(),
    });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.outstandingPayments.cents, 0,
      "nothing has left the account on the strength of a draft");
  });

  test("all three legs agreeing is reported as balanced", async () => {
    /* The only construction in this file where the report is allowed to say
       yes. */
    await trustAccount(RENT);
    await post("rent received", [
      { code: "1010", debit: RENT, ownerId: world.ownerId },
      { code: "2200", credit: RENT, ownerId: world.ownerId },
    ]);
    await ledgerEntry({ kind: "rent_payment", amountCents: RENT });

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.bank.cents, RENT);
    assert.equal(r.legs.book.cents, RENT);
    assert.equal(r.legs.clients.cents, RENT);
    assert.equal(r.legs.subledger.cents, RENT);
    assert.equal(r.balanced, true);
    assert.deepEqual(r.unchecked, []);
  });
});

/* --- deposits -------------------------------------------------------------- */

describe("deposits recorded on a lease and posted nowhere", () => {
  test("it is a finding in its own right, not folded into a total", async () => {
    /* Tenant deposits are somebody else's money held in trust. A deposit that
       exists on a lease and in no account is money the books do not know
       about, and hiding it inside a subtotal is how it stays unnoticed. */
    await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", 120000, world.leaseId);

    const r = await trustReconciliation(world.companyId);
    assert.equal(r.legs.subledger.depositsOnLeases.cents, 120000);
    assert.equal(r.legs.subledger.depositsOnLeases.count, 1);

    const finding = r.findings.find((x) => x.title.includes("Deposits"));
    assert.ok(finding, "it should be named");
    assert.equal(finding.severity, "error");
  });

  test("once the deposit is posted, it stops being a finding", async () => {
    await run("UPDATE lease SET deposit_cents = ? WHERE id = ?", 120000, world.leaseId);
    await post("deposit received", [
      { code: "1010", debit: 120000, leaseId: world.leaseId },
      { code: "2100", credit: 120000, leaseId: world.leaseId },
    ]);

    const r = await trustReconciliation(world.companyId);
    assert.ok(!r.findings.some((x) => x.title.includes("Deposits")),
      "the books now know the money exists");
    assert.equal(r.legs.clients.rows.find((x) => x.code === "2100").balance, 120000);
  });
});

/* --- as at a date ---------------------------------------------------------- */

describe("as at a date", () => {
  test("a journal after the date is not counted", async () => {
    /* A reconciliation is always as at a moment. One that silently includes
       tomorrow's postings cannot be compared against a statement. */
    await post("rent received", [
      { code: "1010", debit: RENT, ownerId: world.ownerId },
      { code: "2200", credit: RENT, ownerId: world.ownerId },
    ], addDays(today(), 5));

    const now = await trustReconciliation(world.companyId, { asOf: today() });
    const later = await trustReconciliation(world.companyId, { asOf: addDays(today(), 10) });

    assert.equal(now.legs.book.cents, 0);
    assert.equal(later.legs.book.cents, RENT);
  });
});
