/* Validating an import before any of it is written.

   Two rules shape this file.

   **The dry run and the commit use the same code.** A preview validated with
   one set of rules and a commit that writes with another is a preview nobody
   can trust, and the divergence is invisible until the day the commit rejects
   something the preview approved — halfway through somebody's migration.

   **A partially-correct import is worse than a failed one.** One bad row stops
   everything, because a portfolio somebody cannot tell the state of is worse
   than no portfolio.

   The decision most worth holding is the one about matching. A row is matched
   to something already here by **source id and only source id**. A company
   with "1507 Brice Rd" importing a file containing "1507 Brice Rd" might be
   re-importing the same building or might have two on the same road. Guessing
   wrong merges two real properties and there is no undo. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { readDate, readMoney, readInt, readDecimal, readOneOf, readList } from "../server/lib/import/read.js";
import { validateImport } from "../server/lib/import/validate.js";

let companyId;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  companyId = await f.makeCompany("Import Co");
});

const run_ = (files, sourceSystem = "generic") =>
  validateImport({ companyId, sourceSystem, files });

/* A minimal file set that validates, so a test can break one thing at a
   time. */
const GOOD = {
  owner: "id,name\nO-1,An Owner\n",
  property: "id,owner id,address,city,state,zip\nP-1,O-1,1 Main St,Columbus,OH,43201\n",
  unit: "id,property id,unit,market rent\nU-1,P-1,1,900\n",
  tenant: "id,name\nT-1,A Tenant\n",
  lease: "id,unit id,tenant ids,start date,rent\nL-1,U-1,T-1,2026-01-01,900\n",
};

/* --- reading a cell ---------------------------------------------------------- */

describe("reading values", () => {
  test("dates in the forms exports actually use", async () => {
    assert.equal(readDate("2026-03-14"), "2026-03-14");
    assert.equal(readDate("3/14/2026"), "2026-03-14");
    assert.equal(readDate("03/14/26"), "2026-03-14", "a two-digit year is this century");
    assert.equal(readDate("2026-03-14T09:00:00Z"), "2026-03-14", "exports produce timestamps");
  });

  test("an ambiguous date is refused, not guessed", async () => {
    /* 14/03/2026 is unambiguously not US, and reading it as US would be
       wrong on eleven days a month rather than obviously wrong once. */
    assert.equal(readDate("14/03/2026"), null);
    assert.equal(readDate("2026-02-30"), null, "parses and is not a date");
    assert.equal(readDate("sometime"), null);
  });

  test("money in the forms exports actually use", async () => {
    assert.equal(readMoney("$1,450.00"), 145000);
    assert.equal(readMoney("1450"), 145000);
    assert.equal(readMoney("-250"), -25000);
    assert.equal(readMoney("(250.00)"), -25000, "accounting notation for a negative");
  });

  test("a number it cannot read is null, never zero", async () => {
    /* Zero is a number somebody will believe. */
    assert.equal(readMoney("abc"), null);
    assert.equal(readMoney("€1.234,00"), null, "European notation, refused rather than misread");
    assert.equal(readInt("2.5"), null);
    assert.equal(readDecimal("2.5"), 2.5, "half a bathroom is a real thing");
  });

  test("a fixed set is matched loosely and refused when it does not map", async () => {
    assert.equal(readOneOf("Single Family", ["single", "multi"], { singlefamily: "single" }), "single");
    assert.equal(readOneOf("MULTI", ["single", "multi"]), "multi");
    assert.equal(readOneOf("duplex", ["single", "multi"]), null);
  });

  test("several ids in one cell", async () => {
    assert.deepEqual(readList("T-1; T-2 | T-3"), ["T-1", "T-2", "T-3"]);
    assert.deepEqual(readList(""), []);
  });
});

/* --- a whole import ---------------------------------------------------------- */

describe("a good import", () => {
  test("it validates and would create everything", async () => {
    const r = await run_(GOOD);
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    for (const entity of ["owner", "property", "unit", "tenant", "lease"]) {
      assert.equal(r.summary[entity].create, 1, entity);
      assert.equal(r.summary[entity].error, 0, entity);
    }
  });

  test("a realistic competitor export maps and parses", async () => {
    const r = await run_({
      owner: "Owner ID,Owner Name,Email\nO-1,Okafor Holdings LLC,a@b.test\n",
      property: "Property ID,Owner ID,Address 1,City,State,Zip Code,Property Type\n"
        + "P-1,O-1,1507 Brice Rd,Reynoldsburg,OH,43068,Multi-Family\n",
      unit: "Unit ID,Property ID,Unit,BR,BA,Sq Ft,Market Rent,Status\n"
        + "U-1,P-1,1,1,1,640,\"$925.00\",Occupied\n",
      lease: "Lease Id,Unit Id,Lease From,Rent Amount,Security Deposit,Status\n"
        + "L-1,U-1,01/01/2026,925,925,Current\n",
    }, "appfolio");

    assert.equal(r.ok, true);
    assert.equal(r.entities.property.rows[0].data.kind, "multi", "Multi-Family");
    assert.equal(r.entities.unit.rows[0].data.status, "occupied", "Occupied");
    assert.equal(r.entities.unit.rows[0].data.marketRentCents, 92500);
    assert.equal(r.entities.lease.rows[0].data.status, "active", "Current");
    assert.equal(r.entities.lease.rows[0].data.startDate, "2026-01-01");
  });

  test("columns it does not use are named rather than silently dropped", async () => {
    const r = await run_({
      ...GOOD,
      owner: "id,name,Portfolio,Manager\nO-1,An Owner,East,Dana\n",
    });
    assert.deepEqual(r.summary.owner.ignoredColumns, ["Portfolio", "Manager"]);
    assert.equal(r.ok, true, "an unused column is not an error");
  });
});

/* --- one bad row stops everything -------------------------------------------- */

describe("what stops it", () => {
  test("a single bad row makes the whole import not ok", async () => {
    /* A portfolio somebody cannot tell the state of is worse than no
       portfolio. */
    const r = await run_({
      ...GOOD,
      owner: "id,name\nO-1,An Owner\nO-2,\n",
    });
    assert.equal(r.ok, false);
    assert.equal(r.summary.owner.create, 1);
    assert.equal(r.summary.owner.error, 1);
  });

  test("every problem carries the line number in the file", async () => {
    /* So somebody can open the file and go to it. */
    const r = await run_({ owner: "id,name\nO-1,Fine\nO-2,\nO-3,Also fine\n" });
    assert.equal(r.problems[0].row, 3);
  });

  test("a required column missing stops it before any row is read", async () => {
    const r = await run_({ property: "id,city,state,zip\nP-1,Columbus,OH,43201\n" });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].message, /No column for line1/);
    assert.equal(r.summary.property.usable, false);
    assert.equal(r.summary.property.total, 0, "nothing is validated against a mapping that cannot work");
  });

  test("a value outside a CHECK constraint is refused here, not at the insert", async () => {
    /* Otherwise the transaction aborts with a constraint name instead of a
       row number. */
    const r = await run_({
      ...GOOD,
      property: "id,owner id,address,city,state,zip,type\nP-1,O-1,1 Main St,Columbus,OH,43201,Warehouse\n",
    });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].message, /not a property type/);
    assert.match(r.problems[0].message, /single, multi, condo/);
  });

  test("a rent day past the 28th is refused", async () => {
    /* The same rule the rent charge and the report schedules follow. */
    const r = await run_({
      ...GOOD,
      lease: "id,unit id,start date,rent,due day\nL-1,U-1,2026-01-01,900,31\n",
    });
    assert.match(r.problems[0].message, /do not exist in every month/);
  });

  test("a lease that ends before it starts", async () => {
    const r = await run_({
      ...GOOD,
      lease: "id,unit id,start date,end date,rent\nL-1,U-1,2026-06-01,2026-01-01,900\n",
    });
    assert.match(r.problems[0].message, /ends before it starts/);
  });

  test("two rows claiming the same id", async () => {
    /* Not a merge. Two rows saying they are the same thing. */
    const r = await run_({ owner: "id,name\nO-1,One\nO-1,Another\n" });
    assert.match(r.problems[0].message, /already uses the id "O-1"/);
  });
});

/* --- references --------------------------------------------------------------- */

describe("resolving a reference", () => {
  test("by source id, within the file", async () => {
    const r = await run_(GOOD);
    assert.equal(r.entities.property.rows[0].data.ownerRef.kind, "file");
    assert.equal(r.entities.lease.rows[0].data.unitRef.sourceId, "U-1");
  });

  test("a reference to nothing is an error, not a skipped row", async () => {
    /* Silently dropping it is how somebody discovers in March that eleven
       tenancies were never created. */
    const r = await run_({
      ...GOOD,
      property: "id,owner id,address,city,state,zip\nP-1,O-9,1 Main St,Columbus,OH,43201\n",
    });
    assert.match(r.problems[0].message, /No owner with the id "O-9"/);
    assert.match(r.problems[0].message, /not already here/);
  });

  test("by name when the file carries no ids", async () => {
    const r = await run_({
      owner: "name\nAn Owner\n",
      property: "owner,address,city,state,zip\nAn Owner,1 Main St,Columbus,OH,43201\n",
    });
    assert.equal(r.ok, true);
    assert.equal(r.entities.property.rows[0].data.ownerRef.kind, "file");
  });

  test("a name matching two rows is an error, not a coin toss", async () => {
    /* Picking one puts a property on somebody else's books. */
    const r = await run_({
      owner: "name\nSmith Holdings\nSmith Holdings\n",
      property: "owner,address,city,state,zip\nSmith Holdings,1 Main St,Columbus,OH,43201\n",
    });
    assert.ok(r.problems.some((p) => /matches 2 owners/.test(p.message)));
    assert.ok(r.problems.some((p) => /Give them ids/.test(p.message)));
  });

  test("a row that does not say what it belongs to", async () => {
    const r = await run_({
      owner: "id,name\nO-1,An Owner\n",
      property: "id,address,city,state,zip\nP-1,1 Main St,Columbus,OH,43201\n",
    });
    assert.match(r.problems[0].message, /does not say which owner/);
  });

  test("a lease can have no tenant, but not a tenant that is not there", async () => {
    /* A signed lease before anybody has moved in is ordinary. A named
       tenant resolving to nothing is not. */
    const none = await run_({
      ...GOOD,
      lease: "id,unit id,start date,rent\nL-1,U-1,2026-01-01,900\n",
    });
    assert.equal(none.ok, true);

    const dangling = await run_({
      ...GOOD,
      lease: "id,unit id,tenant ids,start date,rent\nL-1,U-1,T-9,2026-01-01,900\n",
    });
    assert.match(dangling.problems[0].message, /No tenant with the id "T-9"/);
  });

  test("two tenants on one lease", async () => {
    const r = await run_({
      ...GOOD,
      tenant: "id,name\nT-1,One\nT-2,Two\n",
      lease: "id,unit id,tenant ids,start date,rent\nL-1,U-1,T-1;T-2,2026-01-01,900\n",
    });
    assert.equal(r.ok, true);
    assert.equal(r.entities.lease.rows[0].data.tenantRefs.length, 2);
  });
});

/* --- the second upload --------------------------------------------------------- */

describe("importing the same file twice", () => {
  async function alreadyHere() {
    const ownerId = id();
    await insert("owner", {
      id: ownerId, company_id: companyId, name: "An Owner",
      source_system: "generic", source_id: "O-1", created_at: stamp(),
    });
    return ownerId;
  }

  test("a row already here by source id is an update, not a second one", async () => {
    await alreadyHere();
    const r = await run_({ owner: "id,name\nO-1,An Owner Renamed\n" });

    assert.equal(r.summary.owner.update, 1);
    assert.equal(r.summary.owner.create, 0);
  });

  test("a reference can point at something already here", async () => {
    /* Importing properties a month after the owners were imported has to
       work, or the second file is useless. */
    await alreadyHere();
    const r = await run_({
      property: "id,owner id,address,city,state,zip\nP-1,O-1,1 Main St,Columbus,OH,43201\n",
    });

    assert.equal(r.ok, true);
    assert.equal(r.entities.property.rows[0].data.ownerRef.kind, "existing");
  });

  test("a different source system is a different namespace", async () => {
    /* AppFolio's O-1 and Buildium's O-1 are not the same owner. */
    await alreadyHere();
    const r = await run_({ owner: "id,name\nO-1,Somebody Else\n" }, "buildium");
    assert.equal(r.summary.owner.create, 1, "not an update");
  });

  test("a row with no id is always a creation, never a natural-key merge", async () => {
    /* The decision this whole design turns on. A company with "1 Main St"
       importing a file with "1 Main St" might be re-importing the same
       building or might have two on the same road. Guessing wrong merges two
       real properties and there is no undo. */
    const ownerId = await alreadyHere();
    const propertyId = id();
    await insert("property", {
      id: propertyId, company_id: companyId, owner_id: ownerId,
      line1: "1 Main St", city: "Columbus", state: "OH", zip: "43201",
      created_at: stamp(),
    });

    const r = await run_({
      owner: "id,name\nO-1,An Owner\n",
      property: "owner id,address,city,state,zip\nO-1,1 Main St,Columbus,OH,43201\n",
    });

    assert.equal(r.ok, true);
    assert.equal(r.summary.property.create, 1, "created, not merged into the one already here");
    assert.equal(r.summary.property.update, 0);
  });
});

/* --- money that comes in as a position ------------------------------------------ */

describe("opening balances", () => {
  test("what tenants owe, what they are in credit, and what is held", async () => {
    /* Totalled before anybody agrees to post a journal, because an opening
       journal is the one part of an import that touches the books. */
    const r = await run_({
      ...GOOD,
      unit: "id,property id,unit\nU-1,P-1,1\nU-2,P-1,2\nU-3,P-1,3\n",
      lease: "id,unit id,start date,rent,deposit,balance\n"
        + "L-1,U-1,2026-01-01,900,900,250\n"
        + "L-2,U-2,2026-01-01,900,900,(100.00)\n"
        + "L-3,U-3,2026-01-01,900,0,0\n",
    });

    assert.equal(r.ok, true);
    assert.equal(r.opening.arrearsCents, 25000);
    assert.equal(r.opening.creditCents, 10000);
    assert.equal(r.opening.depositsCents, 180000);
    assert.equal(r.opening.leases, 3);
  });

  test("a row with errors is not counted into the opening position", async () => {
    /* It is not going to be imported, so counting its money would preview a
       journal that will never post. */
    const r = await run_({
      ...GOOD,
      lease: "id,unit id,start date,rent,deposit\nL-1,U-1,not a date,900,900\n",
    });
    assert.equal(r.opening.depositsCents, 0);
  });
});
