/* Fees a tenant owes the manager, and what happens when they pay one.

   Nothing credited `1200 Rent receivable` until now. Late fees have been
   charged to it since Phase 1 and no path ever cleared one, so two things
   were wrong at once and both were silent:

     the fee stayed outstanding for ever, and
     the money that paid it fell through to `2300 Prepaid rent` — recorded as
     rent held **for the owner**.

   The second is the serious one. `2300` is inside the `2200 + 2300` total the
   trust reconciliation measures the owners' ledgers against, so the manager's
   own income inflated what the owner appeared to be owed.

   ## Rent first, and it is not a matter of taste

   Applying a payment to fees before rent turns a tenant who paid their rent in
   full into a tenant in arrears *on rent*, and arrears on rent is the ground
   for eviction. Several states prohibit it outright. That is what the order
   below is protecting, and it is the case the third test here is about. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { postMoney, outstandingReceivable, outstandingFees } from "../server/lib/ledger.js";
import { chargeRent } from "../server/lib/rentcharge.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Fee Settlement Co" });
  await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", world.companyId);
});

const bal = async (code) => Number((await get(
  `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
     FROM journal_split s JOIN account a ON a.id = s.account_id
    WHERE a.company_id = ? AND a.code = ?`, world.companyId, code)).c);

const post = (kind, amountCents) => postMoney({
  companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
  unitId: world.unitId, leaseId: world.leaseId, date: "2026-03-05",
  kind, amountCents, memo: kind, source: "manual", postedBy: "test",
});

describe("a fee the tenant pays", () => {
  test("clears the receivable instead of sitting on it for ever", async () => {
    await post("other", 5000);
    assert.equal(await bal("1200"), 5000);
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 5000);

    await post("rent_payment", 5000);
    assert.equal(await bal("1200"), 0, "the fee is paid");
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 0);
  });

  test("and is not recorded as rent held for the owner", async () => {
    await post("other", 5000);
    await post("rent_payment", 5000);

    assert.equal(await bal("2300"), 0,
      "prepaid rent is the owner's; a fee the manager earned is not");
    assert.equal(await bal("2200"), 0, "and it is not owner funds either");
  });

  test("the money is in the trust account, and the report says whose it is", async () => {
    await post("other", 5000);
    await post("rent_payment", 5000);

    assert.equal(await bal("1010"), 5000, "the tenant sent it to the trust account");
    const r = await trustReconciliation(world.companyId);
    const v = r.variances.find((x) => x.key === "book_vs_clients");
    assert.equal(v.cents, 5000,
      "a surplus, which this report already reads as fees earned and not swept — "
      + "the same thing a management fee has always produced");
  });
});

describe("rent first", () => {
  test("a tenant who pays their rent is not put in arrears on rent by a fee", async () => {
    /* The case the rule exists for. Rent 1,000; a 50 fee; the tenant pays
       exactly their rent. Fees-first would leave 50 of *rent* outstanding,
       which is the ground for an eviction the tenant did nothing to earn. */
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("other", 5000);
    assert.equal(await outstandingReceivable(world.companyId, world.leaseId), 100000);

    await post("rent_payment", 100000);

    assert.equal(await outstandingReceivable(world.companyId, world.leaseId), 0,
      "the rent is paid in full");
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 5000,
      "and the fee is what is still owed");
  });

  test("what is left over after the rent goes against the fee", async () => {
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("other", 5000);

    await post("rent_payment", 105000);
    assert.equal(await outstandingReceivable(world.companyId, world.leaseId), 0);
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 0);
    assert.equal(await bal("2300"), 0, "nothing was left to be prepaid");
  });

  test("and anything beyond both is prepaid rent, as it always was", async () => {
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("other", 5000);

    await post("rent_payment", 125000);
    assert.equal(await outstandingReceivable(world.companyId, world.leaseId), 0);
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 0);
    assert.equal(await bal("2300"), -20000, "the extra 200 is held as prepaid rent");
  });

  test("a partial payment settles rent as far as it goes and touches no fee", async () => {
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("other", 5000);

    await post("rent_payment", 40000);
    assert.equal(await outstandingReceivable(world.companyId, world.leaseId), 60000);
    assert.equal(await outstandingFees(world.companyId, world.leaseId), 5000,
      "the fee is untouched while rent is still owed");
  });
});

describe("nothing else moved", () => {
  test("a payment with no fee outstanding behaves exactly as before", async () => {
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("rent_payment", 100000);

    assert.equal(await bal("1300"), 0);
    assert.equal(await bal("2200"), -100000, "held for the owner");
    assert.equal(await bal("2300"), 0);
    assert.equal(await bal("1200"), 0);
  });

  test("paying ahead with no charge at all is still prepaid rent", async () => {
    await post("rent_payment", 100000);
    assert.equal(await bal("2300"), -100000);
    assert.equal(await bal("1200"), 0);
  });

  test("the journal balances however the payment is split", async () => {
    await chargeRent(world.companyId, { period: "2026-03" });
    await post("other", 5000);
    await post("rent_payment", 125000);

    const net = await get(
      `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint c
         FROM journal_split s JOIN journal j ON j.id = s.journal_id
        WHERE j.company_id = ?`, world.companyId);
    assert.equal(Number(net.c), 0);
  });
});

describe("a real late fee, end to end", () => {
  test("is charged by the sweep and settled by a payment", async () => {
    const { sweepLateFees } = await import("../server/lib/latefees.js");
    await run(
      "UPDATE lease SET rent_due_day = 1, grace_days = 0, late_fee_cents = 5000 WHERE id = ?",
      world.leaseId);
    await chargeRent(world.companyId, { period: "2026-03" });

    await sweepLateFees({ asOf: "2026-03-10", postedBy: "test" });
    const fee = await get("SELECT amount_cents FROM late_fee WHERE lease_id = ?", world.leaseId);
    assert.ok(fee, "a fee was charged");
    assert.equal(await bal("1200"), 5000);

    await post("rent_payment", 105000);
    assert.equal(await bal("1200"), 0, "and the tenant has now paid it");
    assert.equal(await bal("2300"), 0, "without any of it becoming the owner's");
  });
});
