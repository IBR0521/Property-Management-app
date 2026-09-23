/* Taking everything and leaving.

   The test that matters most in this file is the dullest one: every table in
   the database is named in the export policy. An export that silently stops
   being complete is worse than one that never existed, because the customer
   believes they have taken everything — and the way it stops being complete
   is a migration adding a table that nobody thinks about again.

   The rest is the two halves of honesty. Nothing that is a record of
   something that happened is withheld; nothing that is a credential is
   included. Both directions are asserted, because getting either one wrong
   is a different kind of failure and only one of them is loud. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { readZip } from "./helpers/unzip.js";
import { TABLES, FILE_COLUMNS, undecided, stale, exported, skipped } from "../server/lib/export/tables.js";
import { exportArchive } from "../server/lib/export/archive.js";
import { UPLOAD_DIR } from "../server/lib/files.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => {
  await app.close();
  await closeDb();
  rmSync(join(UPLOAD_DIR, "exporttest"), { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Leaving Co", staffRoles: ["admin", "leasing"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

async function archive(companyId = world.companyId) {
  const parts = [];
  for await (const chunk of exportArchive({ companyId, requestedBy: "a test" })) parts.push(chunk);
  return readZip(Buffer.concat(parts));
}

const text = (entries, name) => {
  const entry = entries.get(name);
  assert.ok(entry, `${name} is not in the archive`);
  return entry.data.toString("utf8").replace(/^﻿/, "");
};

/* --- the policy, against the database it describes --------------------------- */

describe("every table is accounted for", () => {
  async function tableNames() {
    const rows = await all(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`);
    return rows.map((r) => r.table_name);
  }

  test("a migration cannot add a table the export does not know about", async () => {
    const missing = undecided(await tableNames());
    assert.deepEqual(missing, [],
      `these tables have no decision in server/lib/export/tables.js: ${missing.join(", ")}`);
  });

  test("and a decision about a table that no longer exists is found too", async () => {
    const gone = stale(await tableNames());
    assert.deepEqual(gone, [],
      `these are decided about but are not in the database: ${gone.join(", ")}`);
  });

  test("the file columns point at columns that exist", async () => {
    for (const { table, column } of FILE_COLUMNS) {
      const row = await get(
        `SELECT 1 AS ok FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`, table, column);
      assert.ok(row, `${table}.${column} does not exist`);
    }
  });

  test("every redacted column exists, or the redaction quietly does nothing", async () => {
    for (const [table, spec] of Object.entries(TABLES)) {
      for (const column of spec.redact || []) {
        const row = await get(
          `SELECT 1 AS ok FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`, table, column);
        assert.ok(row, `${table}.${column} is redacted but does not exist — a rename would `
          + "have turned this redaction into a no-op and nobody would have noticed");
      }
    }
  });

  test("nothing is both exported and skipped", () => {
    const both = exported().filter((name) => skipped().some((s) => s.name === name));
    assert.deepEqual(both, []);
  });
});

/* --- what is in the archive --------------------------------------------------- */

describe("the archive", () => {
  test("one CSV per exported table, and a README", async () => {
    const entries = await archive();
    for (const table of exported()) {
      assert.ok(entries.has(`data/${table}.csv`), `data/${table}.csv is missing`);
    }
    assert.ok(entries.has("README.txt"));
    assert.ok(entries.has("files/index.csv"));
  });

  test("a table that was skipped has no file", async () => {
    const entries = await archive();
    for (const s of skipped()) {
      assert.equal(entries.has(`data/${s.name}.csv`), false, `${s.name} should not be here`);
    }
  });

  test("the portfolio is in it", async () => {
    const entries = await archive();
    assert.match(text(entries, "data/owner.csv"), /Leaving Co Owner/);
    assert.match(text(entries, "data/property.csv"), /leaving-co Road/);
    assert.match(text(entries, "data/company.csv"), /Leaving Co/);
    assert.match(text(entries, "data/work_order.csv"), new RegExp(world.workOrderId));
  });

  test("an empty table still carries its headings", async () => {
    const entries = await archive();
    const csv = text(entries, "data/listing.csv");
    assert.match(csv, /^id,company_id/, "a reader needs the shape even when there are no rows");
    assert.equal(csv.trim().split("\r\n").length, 1);
  });

  test("another company's rows are not in it", async () => {
    const other = await f.makeWorld({ name: "Someone Else Ltd" });
    const entries = await archive();
    assert.doesNotMatch(text(entries, "data/owner.csv"), /Someone Else/);
    assert.doesNotMatch(text(entries, "data/company.csv"), /Someone Else/);
    assert.ok(other.companyId);
  });

  test("a child table comes through its parent", async () => {
    const entries = await archive();
    const csv = text(entries, "data/lease_tenant.csv");
    assert.match(csv, new RegExp(world.leaseId), "a tenancy carries no company_id of its own");
  });

  test("the double-entry splits come through their journal", async () => {
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "deposit_held", amountCents: 90000, memo: "deposit",
    });
    const entries = await archive();
    assert.match(text(entries, "data/journal_split.csv"), /90000/);
  });
});

/* --- what is not in it --------------------------------------------------------- */

describe("credentials are not records", () => {
  test("no password hash, no TOTP secret", async () => {
    const entries = await archive();
    const csv = text(entries, "data/staff.csv");
    assert.match(csv, new RegExp(world.staff.admin.email), "the person is here");
    assert.doesNotMatch(csv, /password_hash/, "and their password is not");
    assert.doesNotMatch(csv, /totp_secret/);

    const hash = (await get("SELECT password_hash FROM staff WHERE id = ?", world.staff.admin.id))
      .password_hash;
    assert.ok(hash, "there is one to leak");
    assert.equal(csv.includes(hash), false, "and it is not in the file");
  });

  test("a session is not in the archive at all", async () => {
    const entries = await archive();
    assert.equal(entries.has("data/session.csv"), false);
    assert.equal(entries.has("data/portal_session.csv"), false);
    assert.equal(entries.has("data/staff_recovery_code.csv"), false);
  });

  test("the last four digits of an account stay, the number does not", async () => {
    await insert("payee_account", {
      id: id(), company_id: world.companyId, owner_id: world.ownerId,
      method: "ach", routing_number: "021000021", account_enc: "encrypted-blob-here",
      account_last4: "6789", account_type: "checking", account_name: "An Owner",
      created_at: stamp(), updated_at: stamp(),
    });
    const csv = text(await archive(), "data/payee_account.csv");
    assert.match(csv, /6789/, "which is what a person uses to recognise it");
    assert.doesNotMatch(csv, /021000021/);
    assert.doesNotMatch(csv, /encrypted-blob-here/);
  });
});

/* --- the uploaded files --------------------------------------------------------- */

describe("the files themselves", () => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c489".repeat(4), "hex");

  async function attachPhoto(stored, bytes = PNG) {
    if (bytes) {
      mkdirSync(join(UPLOAD_DIR, "exporttest"), { recursive: true });
      writeFileSync(join(UPLOAD_DIR, stored), bytes);
    }
    const photoId = id();
    await insert("work_order_photo", {
      id: photoId, work_order_id: world.workOrderId, path: stored,
      phase: "report", mime: "image/png", bytes: bytes ? bytes.length : 0,
      created_at: stamp(),
    });
    return photoId;
  }

  test("a photograph is carried, not merely named", async () => {
    const photoId = await attachPhoto("exporttest/one.png");
    const entries = await archive();

    const entry = entries.get(`files/work-orders/${photoId}.png`);
    assert.ok(entry, "a row saying 'one.png' is not a copy of a photograph");
    assert.deepEqual([...entry.data], [...PNG]);

    const index = text(entries, "files/index.csv");
    assert.match(index, new RegExp(`files/work-orders/${photoId}\\.png`));
    assert.match(index, /work_order_photo/);
  });

  test("a file that cannot be read becomes a note, and the README says so", async () => {
    const photoId = await attachPhoto("exporttest/missing.png", null);
    const entries = await archive();

    const entry = entries.get(`files/work-orders/${photoId}.png`);
    assert.ok(entry, "an archive must not simply omit it");
    assert.match(entry.data.toString(), /could not be read/);

    const readme = text(entries, "README.txt");
    assert.match(readme, /FILES THAT COULD NOT BE READ/);
    assert.match(readme, /exporttest\/missing\.png/);
  });

  test("a path that tries to climb out of the upload directory is refused", async () => {
    const photoId = await attachPhoto("../../../etc/passwd", null);
    const entries = await archive();
    const entry = entries.get(`files/work-orders/${photoId}`);
    assert.ok(entry);
    assert.match(entry.data.toString(), /not a path this application wrote/);
  });

  test("an address that is not the file store is not fetched", async () => {
    /* This column can only hold what storeUpload wrote, today. The check
       exists because the function turns a database column into an outbound
       request, and that is worth being narrow about before something else
       ever writes to it. */
    const photoId = await attachPhoto("https://example.invalid/whatever.png", null);
    const entry = (await archive()).get(`files/work-orders/${photoId}.png`);
    assert.ok(entry);
    assert.match(entry.data.toString(), /not an address this application stores files at/);
  });

  test("with everything readable the README says that instead", async () => {
    await attachPhoto("exporttest/two.png");
    const readme = text(await archive(), "README.txt");
    assert.match(readme, /Every uploaded file was read/);
    assert.doesNotMatch(readme, /FILES THAT COULD NOT BE READ/);
  });
});

/* --- the README ----------------------------------------------------------------- */

describe("the README", () => {
  test("it lists what is in the archive and what is not", async () => {
    const readme = text(await archive(), "README.txt");
    assert.match(readme, /Leaving Co/);
    assert.match(readme, /WHAT IS IN IT/);
    assert.match(readme, /data\/owner\.csv/);
    assert.match(readme, /WHAT IS NOT, AND WHY/);
    for (const s of skipped()) assert.match(readme, new RegExp(`  ${s.name}\\b`));
  });

  test("it names the redacted columns rather than leaving a gap to discover", async () => {
    const readme = text(await archive(), "README.txt");
    assert.match(readme, /staff: password_hash/);
    assert.match(readme, /payee_account: account_enc, routing_number/);
  });

  test("it says amounts are in cents, because they are", async () => {
    assert.match(text(await archive(), "README.txt"), /Amounts are in cents/);
  });
});

/* --- there and back again ---------------------------------------------------------

   "No lock-in" is the kind of claim that is easy to make and rarely checked.
   This checks it: export a company, import the archive into an empty one, and
   compare what arrives.

   It is also what the two shapes in the archive are for. `data/` is the record
   as held — database column names, amounts in cents — which is what somebody
   mapping into another system needs and is not importable by anything,
   including this. `import/` is the same portfolio spelled the way this
   application's own importer spells it, read by exactly the code that reads a
   customer's export from somewhere else. */
describe("an export can be imported", () => {
  async function seedPositions() {
    /* A tenant in arrears, a tenant in credit, and a deposit held — the three
       figures the opening journal carries. Posted through the ledger rather
       than written, so what the export reads is what the books say. */
    const { chargeRent } = await import("../server/lib/rentcharge.js");
    const { postMoney } = await import("../server/lib/ledger.js");

    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      unitId: world.unitId, propertyId: world.propertyId,
      date: "2026-05-01", kind: "deposit_held", amountCents: 90000, memo: "deposit",
    });
    await run("UPDATE lease SET deposit_cents = 90000 WHERE id = ?", world.leaseId);

    /* Charged and unpaid: arrears. Through the charge run rather than by
       posting a journal by hand, so the figure the export reads is the one
       the application would really have produced. */
    await chargeRent(world.companyId, { period: "2026-06", postedBy: "test" });
  }

  async function importInto(entries) {
    const other = await f.makeWorld({ name: "Arriving Co" });
    const files = {};
    for (const entity of ["owner", "property", "unit", "tenant", "lease", "vendor"]) {
      const entry = entries.get(`import/${entity}.csv`);
      assert.ok(entry, `import/${entity}.csv is not in the archive`);
      files[entity] = entry.data.toString("utf8");
    }

    const { validateImport } = await import("../server/lib/import/validate.js");
    const { commitImport } = await import("../server/lib/import/commit.js");
    const validated = await validateImport({
      companyId: other.companyId, sourceSystem: "generic", files });

    assert.equal(validated.ok, true,
      `an export of this application did not validate: `
      + JSON.stringify(validated.problems.slice(0, 5)));

    const result = await commitImport({
      companyId: other.companyId, validated, sourceSystem: "generic",
      conversionDate: "2026-07-01", trustCashCents: null,
    });
    return { other, validated, result };
  }

  test("the portfolio arrives, and the positions arrive with it", async () => {
    await seedPositions();
    const entries = await archive();
    const { other, result } = await importInto(entries);

    /* Every owner, property, unit, tenant, lease and contractor of the source,
       plus the ones the receiving fixture already had. */
    const counted = async (table) => (await all(
      `SELECT id FROM ${table} WHERE company_id = ? AND source_id IS NOT NULL`,
      other.companyId)).length;

    assert.equal(await counted("owner"), 1);
    assert.equal(await counted("property"), 1);
    assert.equal(await counted("unit"), 1);
    assert.equal(await counted("tenant"), 1);
    assert.equal(await counted("lease"), 1);
    assert.equal(result.tenancies, 1, "the tenancy came too");

    const arrived = await get(
      `SELECT l.rent_cents, l.deposit_cents, u.label, p.line1, o.name AS owner
         FROM lease l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN owner o ON o.id = p.owner_id
        WHERE l.company_id = ? AND l.source_id IS NOT NULL`, other.companyId);
    const source = await get(
      `SELECT l.rent_cents, l.deposit_cents, u.label, p.line1, o.name AS owner
         FROM lease l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN owner o ON o.id = p.owner_id
        WHERE l.id = ?`, world.leaseId);

    assert.equal(arrived.rent_cents, source.rent_cents, "the rent survived the round trip");
    assert.equal(arrived.deposit_cents, source.deposit_cents);
    assert.equal(arrived.label, source.label);
    assert.equal(arrived.line1, source.line1);
    assert.equal(arrived.owner, source.owner);
  });

  test("what the tenant owed is what the opening journal carries", async () => {
    await seedPositions();
    const owed = await get(
      `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS cents
         FROM journal_split s JOIN account a ON a.id = s.account_id
        WHERE a.company_id = ? AND a.code = '1300'`, world.companyId);
    assert.ok(Number(owed.cents) > 0, "the fixture has to owe something for this to mean anything");

    const { result } = await importInto(await archive());
    assert.equal(result.opening.arrears, Number(owed.cents));
    assert.equal(result.opening.deposits, 90000);
    assert.equal(result.opening.credits, 0);
  });

  test("a tenant in credit arrives in credit, not in arrears", async () => {
    /* The sign is the whole risk in carrying a position as one figure, and
       getting it backwards would turn somebody's credit into a demand. */
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      unitId: world.unitId, propertyId: world.propertyId,
      date: "2026-05-20", kind: "rent_payment", amountCents: 25000,
      memo: "paid ahead",
    });

    const { result } = await importInto(await archive());
    assert.equal(result.opening.credits, 25000);
    assert.equal(result.opening.arrears, 0);
  });

  test("the README says what the import folder is not", async () => {
    const readme = text(await archive(), "README.txt");
    assert.match(readme, /import\//);
    assert.match(readme, /It is NOT everything/);
    assert.match(readme, /Work orders, journals, messages and/);
  });
});

/* --- one snapshot ---------------------------------------------------------------

   Sixty-odd sequential reads at the default isolation see sixty-odd different
   moments. A portfolio in use during an export would produce an archive whose
   files do not agree — a lease naming a journal that is not in journal.csv
   because it was posted between two queries — and nobody would find out until
   they tried to load it somewhere. */
describe("the archive is one moment, not sixty", () => {
  test("the transaction really is repeatable read, and read only", async () => {
    const { tx, get: getOne } = await import("../server/lib/db.js");
    const inside = await tx(
      () => getOne(`SELECT current_setting('transaction_isolation') AS iso,
                           current_setting('transaction_read_only') AS ro`),
      { isolation: "isolation level repeatable read read only" });
    assert.equal(inside.iso, "repeatable read");
    assert.equal(inside.ro, "on");

    /* And that it is not simply what every transaction gets, which would make
       the assertion above true and meaningless. */
    const plain = await tx(
      () => getOne("SELECT current_setting('transaction_isolation') AS iso"));
    assert.equal(plain.iso, "read committed");
  });

  test("changing it from inside an open transaction is refused, not ignored", async () => {
    const { tx } = await import("../server/lib/db.js");
    await assert.rejects(
      () => tx(() => tx(async () => {}, { isolation: "isolation level serializable" })),
      /cannot be changed from inside/);
  });

  test("and the export asks for it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../server/lib/export/archive.js", import.meta.url), "utf8");
    assert.match(src, /isolation level repeatable read read only/,
      "the archive's table reads must run in one snapshot");
  });
});

/* --- the screens ---------------------------------------------------------------- */

describe("the route", () => {
  test("the page says what it will and will not include", async () => {
    const { body } = await agent.text("/app/setup/export");
    assert.match(body, /Export everything/);
    assert.match(body, /Sign-in sessions/, "what is left out is on the page, not only in the zip");
    assert.match(body, /data\//);
    assert.match(body, /import\//, "both shapes are described before the download, not after");
    assert.match(body, /not everything/, "and what import\/ does not carry");
  });

  test("it is linked from setup", async () => {
    const { body } = await agent.text("/app/setup");
    assert.match(body, /\/app\/setup\/export/);
  });

  test("a download is a real archive", async () => {
    const res = await agent.post("/app/setup/export", {}, { csrfFrom: "/app/setup/export" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /attachment; filename="leaving-co-export-/);

    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(entries.has("README.txt"));
    assert.match(entries.get("data/owner.csv").data.toString(), /Leaving Co Owner/);
  });

  test("a cancelled download does not leave the handler waiting", async () => {
    /* `once("drain")` on its own is a promise that never settles when the
       person closes the tab: the socket will not drain because there is
       nothing at the other end. The symptom is not an error — it is a
       handler that never returns, which is why it needs a test rather than a
       stack trace. */
    const controller = new AbortController();
    const token = await agent.csrf("/app/setup/export");
    const body = new URLSearchParams({ _csrf: token }).toString();

    await assert.rejects(async () => {
      const res = await agent.raw("/app/setup/export", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      controller.abort();
      await res.arrayBuffer();
    });

    /* The process is still answering, which is the whole assertion. */
    const after = await agent.get("/app/setup/export");
    assert.equal(after.status, 200);
  });

  test("it is recorded, because somebody read the whole portfolio", async () => {
    await agent.post("/app/setup/export", {}, { csrfFrom: "/app/setup/export" });
    const row = await get(
      "SELECT * FROM audit_log WHERE company_id = ? AND action = 'export'", world.companyId);
    assert.ok(row, "an export leaves a trace");
    assert.equal(row.entity, "company");
  });

  test("a leasing agent cannot take the company's data", async () => {
    const other = client(app.origin);
    const signedIn = await other.signIn(world.staff.leasing.email, f.PASSWORD);
    assert.equal(signedIn.signedIn, true);

    const page = await other.get("/app/setup/export");
    assert.equal(page.status, 403, "the gate on /app/setup answers this");

    const post = await other.post("/app/setup/export", {}, { csrf: null });
    assert.ok(post.status >= 400, `a direct POST must not work either: ${post.status}`);
  });
});
