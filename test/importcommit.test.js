/* Writing an import.

   The validator's tests cover what is refused. This file covers what happens
   to the rows that were not refused, and there are three things it has to get
   right that nothing else can check for it.

   **One transaction.** A portfolio arrives whole or not at all. Half a
   portfolio is worse than none, because nobody can tell which half.

   **Matching is by source id.** A second upload of the same file updates the
   rows it created the first time rather than making a second copy of the
   building.

   **The books balance afterwards.** An import that leaves the trust
   reconciliation reporting a variance has handed the customer a migration
   they cannot sign off, on day one. This is the test that found the real bug:
   a tenant in credit was posted to prepaid rent and to no owner's ledger, so
   every migrated company read as having a control account that disagreed with
   its subsidiary ledger by exactly the credit. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { validateImport } from "../server/lib/import/validate.js";
import { commitImport } from "../server/lib/import/commit.js";
import { trustReconciliation } from "../server/lib/reports/trust.js";

let companyId;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  companyId = await f.makeCompany("Migrating Co");
});

/* A small portfolio: one owner, one building, two units, two tenancies. */
const FILES = {
  owner: "id,name,email\nO-1,Wendy Okafor,wendy@example.test\n",
  property: "id,owner id,address,city,state,zip\nP-1,O-1,1507 Brice Rd,Columbus,OH,43201\n",
  unit: "id,property id,unit,beds,market rent\n"
    + "U-1,P-1,A,2,1200\n"
    + "U-2,P-1,B,1,950\n",
  tenant: "id,name,email\nT-1,Ravi Bhatt,ravi@example.test\nT-2,Mona Silvers,mona@example.test\n",
  lease: "id,unit id,tenant ids,start date,rent,deposit,balance\n"
    + "L-1,U-1,T-1,2026-01-01,1200,1200,0\n"
    + "L-2,U-2,T-2,2026-02-01,950,950,0\n",
};

async function commit(files = FILES, opts = {}) {
  const validated = await validateImport({ companyId, sourceSystem: "generic", files });
  assert.equal(validated.ok, true,
    `validation failed: ${JSON.stringify(validated.entities?.lease?.rows?.map((r) => r.errors))}`);
  return await commitImport({
    companyId, validated, sourceSystem: "generic",
    conversionDate: "2026-03-01", ...opts,
  });
}

/* --- what lands ------------------------------------------------------------- */

describe("a portfolio arrives whole", () => {
  test("every table, and the references between them", async () => {
    const res = await commit();

    assert.equal(res.created.owner, 1);
    assert.equal(res.created.property, 1);
    assert.equal(res.created.unit, 2);
    assert.equal(res.created.tenant, 2);
    assert.equal(res.created.lease, 2);
    assert.equal(res.tenancies, 2);

    const lease = await get(
      `SELECT l.rent_cents, u.label, p.line1, o.name AS owner
         FROM lease l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN owner o ON o.id = p.owner_id
        WHERE l.source_id = 'L-1'`);
    assert.equal(lease.rent_cents, 120000);
    assert.equal(lease.label, "A");
    assert.equal(lease.line1, "1507 Brice Rd");
    assert.equal(lease.owner, "Wendy Okafor", "the lease reaches its owner through the chain");

    const tenancy = await get(
      `SELECT t.name FROM lease_tenant lt
         JOIN lease l ON l.id = lt.lease_id
         JOIN tenant t ON t.id = lt.tenant_id
        WHERE l.source_id = 'L-1'`);
    assert.equal(tenancy.name, "Ravi Bhatt");
  });

  test("a unit gets the sticker token a QR code needs", async () => {
    await commit();
    const units = await all("SELECT report_token FROM unit WHERE company_id = ?", companyId);
    assert.equal(units.length, 2);
    for (const u of units) assert.ok(u.report_token, "a unit with no token cannot be scanned");
  });

  test("the same file twice updates rather than duplicates", async () => {
    await commit();
    const changed = {
      ...FILES,
      owner: "id,name,email\nO-1,Wendy Okafor-Reid,wendy@example.test\n",
    };
    const second = await commit(changed);

    assert.equal(second.created.owner, 0);
    assert.equal(second.updated.owner, 1);
    assert.equal(second.tenancies, 0, "the tenancies were already there");

    const owners = await all("SELECT name FROM owner WHERE company_id = ?", companyId);
    assert.equal(owners.length, 1, "one owner, not two");
    assert.equal(owners[0].name, "Wendy Okafor-Reid", "and the new name won");
  });

  test("a failed validation writes nothing", async () => {
    const bad = { ...FILES, lease: "id,unit id,start date,rent\nL-9,U-NOPE,2026-01-01,900\n" };
    const validated = await validateImport({ companyId, sourceSystem: "generic", files: bad });
    assert.equal(validated.ok, false);
    await assert.rejects(
      () => commitImport({ companyId, validated, sourceSystem: "generic" }),
      /problems that have to be fixed/);
    const owners = await all("SELECT id FROM owner WHERE company_id = ?", companyId);
    assert.equal(owners.length, 0, "not one row of it");
  });
});

/* --- the opening journal ---------------------------------------------------- */

describe("the position each lease arrives in", () => {
  const withBalances = {
    ...FILES,
    /* One tenant owes, one has paid ahead. Both hold a deposit. */
    lease: "id,unit id,tenant ids,start date,rent,deposit,balance\n"
      + "L-1,U-1,T-1,2026-01-01,1200,1200,450\n"
      + "L-2,U-2,T-2,2026-02-01,950,950,-100\n",
  };

  async function splitsByCode() {
    const rows = await all(
      `SELECT a.code, SUM(s.debit_cents)::bigint AS dr, SUM(s.credit_cents)::bigint AS cr
         FROM journal_split s
         JOIN account a ON a.id = s.account_id
         JOIN journal j ON j.id = s.journal_id
        WHERE j.source_type = 'import_opening'
        GROUP BY a.code`);
    const out = {};
    for (const r of rows) out[r.code] = { dr: Number(r.dr), cr: Number(r.cr) };
    return out;
  }

  test("arrears, credits and deposits, each to its own account", async () => {
    const res = await commit(withBalances, { trustCashCents: 255000 });
    assert.equal(res.opening.posted, true);
    assert.equal(res.opening.arrears, 45000);
    assert.equal(res.opening.credits, 10000);
    assert.equal(res.opening.deposits, 215000);

    const by = await splitsByCode();
    assert.equal(by["1300"].dr, 45000, "owed at conversion");
    assert.equal(by["2300"].cr, 10000, "paid ahead at conversion");
    assert.equal(by["2100"].cr, 215000, "deposits held");
    assert.equal(by["1010"].dr, 255000, "what the bank actually holds");
    assert.ok(by["3100"], "and a balancing figure, which is equity on purpose");
  });

  test("the splits carry the owner, so a report can attribute them", async () => {
    await commit(withBalances, { trustCashCents: 255000 });
    const rows = await all(
      `SELECT a.code, s.owner_id, s.lease_id
         FROM journal_split s
         JOIN account a ON a.id = s.account_id
         JOIN journal j ON j.id = s.journal_id
        WHERE j.source_type = 'import_opening' AND a.code IN ('1300','2300','2100')`);
    assert.ok(rows.length >= 4);
    for (const r of rows) {
      assert.ok(r.owner_id, `${r.code} with no owner is a lump nobody can attribute`);
      assert.ok(r.lease_id, `${r.code} with no lease is the same problem`);
    }
  });

  test("nothing to carry means no journal at all", async () => {
    const res = await commit({
      owner: "id,name\nO-1,Wendy Okafor\n",
      property: "id,owner id,address,city,state,zip\nP-1,O-1,1507 Brice Rd,Columbus,OH,43201\n",
      unit: "id,property id,unit,market rent\nU-1,P-1,A,1200\n",
    });
    assert.equal(res.opening.posted, false);
    const journals = await all("SELECT id FROM journal WHERE company_id = ?", companyId);
    assert.equal(journals.length, 0, "an empty journal is noise in the book");
  });

  test("deposits with no trust balance behind them is said, not discovered", async () => {
    const res = await commit(withBalances);
    assert.ok(res.opening.unbacked, "the preview has to say this");
    assert.match(res.opening.unbacked, /\$2,150\.00/);
    assert.match(res.opening.unbacked, /shortfall/);
  });

  test("a trust balance was supplied, so nothing is claimed about it", async () => {
    const res = await commit(withBalances, { trustCashCents: 255000 });
    assert.equal(res.opening.unbacked, null);
  });
});

/* --- the books afterwards --------------------------------------------------- */

describe("the reconciliation on the first day", () => {
  /* Arrears, a credit, and deposits, with a trust balance that matches what
     is held: 2,150 of deposits + 100 paid ahead = 2,250. */
  const files = {
    ...FILES,
    lease: "id,unit id,tenant ids,start date,rent,deposit,balance\n"
      + "L-1,U-1,T-1,2026-01-01,1200,1200,450\n"
      + "L-2,U-2,T-2,2026-02-01,950,950,-100\n",
  };

  test("the owners' control account agrees with the owners' own ledgers", async () => {
    await commit(files, { trustCashCents: 225000 });

    const rec = await trustReconciliation(companyId, { asOf: "2026-03-01" });
    const control = rec.variances.find((v) => v.key === "clients_vs_subledger");
    assert.equal(control.cents, 0,
      "a credit posted to prepaid rent and to no owner's ledger is this variance");
  });

  test("the credit reaches the owner's statement, because the money is theirs", async () => {
    await commit(files, { trustCashCents: 225000 });
    const entry = await get(
      `SELECT e.amount_cents, e.kind, o.name
         FROM ledger_entry e JOIN owner o ON o.id = e.owner_id
        WHERE e.company_id = ?`, companyId);
    assert.ok(entry, "the owner holds 100 of someone's rent and should see it");
    assert.equal(entry.amount_cents, 10000);
    assert.equal(entry.name, "Wendy Okafor");
  });

  test("every owner entry has a journal behind it", async () => {
    await commit(files, { trustCashCents: 225000 });
    const orphans = await all(
      "SELECT id FROM ledger_entry WHERE company_id = ? AND journal_id IS NULL", companyId);
    assert.equal(orphans.length, 0);
  });

  test("the deposits in the books are the deposits on the leases", async () => {
    await commit(files, { trustCashCents: 225000 });
    const rec = await trustReconciliation(companyId, { asOf: "2026-03-01" });
    const dep = rec.variances.find((v) => v.key === "deposits_vs_leases");
    assert.equal(dep.cents, 0);
  });

  test("with the bank told what it holds, it reconciles", async () => {
    await commit(files, { trustCashCents: 225000 });
    const rec = await trustReconciliation(companyId, { asOf: "2026-03-01" });
    const book = rec.variances.find((v) => v.key === "book_vs_clients");
    assert.equal(book.cents, 0, "every dollar held is somebody's money");
  });
});
