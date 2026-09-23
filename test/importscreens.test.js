/* The three screens a migration goes through.

   The preview is the one that matters. It is not a summary of what the commit
   will do — it is the validation itself, run by the function the commit runs,
   and re-run every time the page is opened. These tests hold that: what the
   screen shows and what gets written come from the same place, the commit
   refuses anything the preview would not have approved, and nothing is
   written without a typed confirmation.

   The rest is about honesty. A column the import did not read is named on the
   screen, because finding out months later that a field went nowhere is worse
   than being told now. Deposits with no trust balance behind them are called
   a shortfall before anybody commits, not after. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { pruneImportFiles } from "../server/lib/import/commit.js";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Migrating Co" });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* A multipart POST, which the ordinary form helper does not do. */
async function upload(files, { sourceSystem = "generic" } = {}) {
  const csrf = await agent.csrf("/app/setup/import");
  const boundary = "----importtest" + id();
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "utf8"));

  push(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="source_system"\r\n\r\n${sourceSystem}\r\n`);
  for (const [entity, text] of Object.entries(files)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${entity}"; filename="${entity}.csv"\r\n`
      + "Content-Type: text/csv\r\n\r\n");
    parts.push(Buffer.from(text, "utf8"));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);

  return await agent.raw("/app/setup/import", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
}

const FILES = {
  owner: "id,name,email,rating\nO-1,Wendy Okafor,wendy@example.test,A+\n",
  property: "id,owner id,address,city,state,zip\nP-1,O-1,1507 Brice Rd,Columbus,OH,43201\n",
  unit: "id,property id,unit,market rent\nU-1,P-1,A,1200\n",
  tenant: "id,name\nT-1,Ravi Bhatt\n",
  lease: "id,unit id,tenant ids,start date,rent,deposit,balance\nL-1,U-1,T-1,2026-01-01,1200,1200,450\n",
};

/* Upload and land on the preview, returning its id and its HTML. */
async function preview(files = FILES) {
  const res = await upload(files);
  assert.equal(res.status, 303, await res.text());
  const location = res.headers.get("location");
  assert.match(location, /\/app\/setup\/import\/[A-Za-z0-9_-]+$/);
  const batchId = location.split("/").pop();
  const { body } = await agent.text(`/app/setup/import/${batchId}`);
  return { batchId, body };
}

/* --- the first screen -------------------------------------------------------- */

describe("before anything is uploaded", () => {
  test("it says what each file may contain", async () => {
    const { body } = await agent.text("/app/setup/import");
    assert.match(body, /Import a portfolio/);
    for (const label of ["Owners", "Properties", "Units", "Tenants", "Leases", "Contractors"]) {
      assert.ok(body.includes(label), `no upload field for ${label}`);
    }
    assert.match(body, /security deposit/, "the column names it accepts are on the page");
  });

  test("it is reachable from setup", async () => {
    const { body } = await agent.text("/app/setup");
    assert.match(body, /\/app\/setup\/import/);
  });

  test("uploading nothing writes nothing and says so", async () => {
    const res = await upload({});
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location")), /No files were uploaded/);
    const batches = await all("SELECT id FROM import_batch");
    assert.equal(batches.length, 0);
  });
});

/* --- the preview ------------------------------------------------------------- */

describe("the preview", () => {
  test("it counts what was read", async () => {
    const { body } = await preview();
    assert.match(body, /Nothing is wrong with these files/);
    assert.match(body, /Check before importing/);
  });

  test("a column it did not read is named, not silently dropped", async () => {
    const { body } = await preview();
    assert.match(body, /rating/,
      "the owner file has a rating column this does not use, and the person has to be told");
  });

  test("the money that will become a journal is shown first", async () => {
    const { body } = await preview();
    /* Matched against the row rather than the figure alone: a bare "$450.00"
       anywhere on the page would pass while saying nothing about whether the
       right number is beside the right label. */
    assert.match(body, /Owed by tenants at conversion<\/td><td class="num">\$450\.00/);
    assert.match(body, /Deposits held<\/td><td class="num">\$1,200\.00/);
    assert.match(body, /Paid ahead by tenants at conversion<\/td><td class="num">\$0\.00/);
  });

  test("a problem stops it, with the row number", async () => {
    const { body } = await preview({
      ...FILES,
      unit: "id,property id,unit,market rent\nU-1,P-NOPE,A,1200\n",
    });
    assert.match(body, /nothing has been written/);
    assert.match(body, /P-NOPE/);
    assert.doesNotMatch(body, /Type <b>import my portfolio/,
      "a file with a problem must not offer the commit form at all");
  });

  test("nothing is in the database yet", async () => {
    await preview();
    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 0, "the preview writes nothing");
  });

  test("it re-reads the files rather than trusting what it said last time",
    async () => {
      const { batchId } = await preview();
      /* The owner this file references now exists under the same source id,
         so the same upload should read as an update rather than a create. */
      await agent.text(`/app/setup/import/${batchId}`);
      const first = JSON.parse((await get("SELECT preview FROM import_batch WHERE id = ?", batchId)).preview);
      assert.equal(first.summary.owner.create, 1);

      const ownerId = id();
      const { insert } = await import("../server/lib/db.js");
      const { stamp } = await import("../server/lib/dates.js");
      await insert("owner", {
        id: ownerId, company_id: world.companyId, name: "Wendy Okafor",
        source_system: "generic", source_id: "O-1", created_at: stamp(),
      });

      const { body } = await agent.text(`/app/setup/import/${batchId}`);
      assert.match(body, /Check before importing/);
      const second = JSON.parse((await get("SELECT preview FROM import_batch WHERE id = ?", batchId)).preview);
      assert.equal(second.summary.owner.create, 0, "it noticed what changed underneath it");
      assert.equal(second.summary.owner.update, 1);
    });
});

/* --- committing -------------------------------------------------------------- */

describe("writing it", () => {
  async function commit(batchId, fields = {}) {
    return await agent.post(`/app/setup/import/${batchId}/commit`, {
      confirm: "import my portfolio",
      conversion_date: "2026-03-01",
      ...fields,
    }, { csrfFrom: `/app/setup/import/${batchId}` });
  }

  test("without the typed confirmation, nothing happens", async () => {
    const { batchId } = await preview();
    const res = await commit(batchId, { confirm: "" });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location")), /type "import my portfolio"/);
    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 0);
  });

  test("a confirmation that is nearly right is not right", async () => {
    const { batchId } = await preview();
    await commit(batchId, { confirm: "import" });
    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 0);
  });

  test("with it, the portfolio lands", async () => {
    const { batchId } = await preview();
    const res = await commit(batchId, { trust_cash: "16.50" });
    assert.equal(res.status, 303);

    const owner = await get(
      "SELECT name FROM owner WHERE company_id = ? AND source_id = 'O-1'", world.companyId);
    assert.equal(owner.name, "Wendy Okafor");
    const lease = await get(
      "SELECT rent_cents FROM lease WHERE company_id = ? AND source_id = 'L-1'", world.companyId);
    assert.equal(lease.rent_cents, 120000);

    const batch = await get("SELECT * FROM import_batch WHERE id = ?", batchId);
    assert.equal(batch.status, "done");
    assert.equal(batch.files, null, "the uploaded portfolio is not kept after it is written");
  });

  test("the result page says what it did", async () => {
    const { batchId } = await preview();
    await commit(batchId, { trust_cash: "16.50" });
    const { body } = await agent.text(`/app/setup/import/${batchId}`);
    assert.match(body, /Written in one transaction/);
    assert.match(body, /What it created/);
    assert.match(body, /The opening journal/);
  });

  test("committing twice writes once", async () => {
    const { batchId } = await preview();
    await commit(batchId, { trust_cash: "16.50" });
    const again = await commit(batchId);
    assert.match(decodeURIComponent(again.headers.get("location")), /already been committed/);

    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 1, "one imported owner, not two");
  });

  test("a trust balance that is not an amount is refused rather than guessed", async () => {
    const { batchId } = await preview();
    const res = await commit(batchId, { trust_cash: "about sixteen" });
    assert.match(decodeURIComponent(res.headers.get("location")), /not an amount/);
    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 0);
  });

  test("it refuses to write what it can no longer validate", async () => {
    const { batchId } = await preview();
    /* The property row references owner O-1 by id. Deleting nothing and
       changing nothing would commit; instead the files are replaced with a
       version that no longer validates, which is the state a portfolio that
       moved underneath the preview would be in. */
    const broken = JSON.stringify({
      ...FILES,
      property: "id,owner id,address,city,state,zip\nP-1,O-GONE,1507 Brice Rd,Columbus,OH,43201\n",
    });
    const { update } = await import("../server/lib/db.js");
    await update("import_batch", batchId, { files: broken });

    const res = await commit(batchId);
    assert.match(decodeURIComponent(res.headers.get("location")), /no longer validates/);
    const owners = await all("SELECT id FROM owner WHERE company_id = ? AND source_id IS NOT NULL", world.companyId);
    assert.equal(owners.length, 0, "not one row of it");
    const batch = await get("SELECT status FROM import_batch WHERE id = ?", batchId);
    assert.equal(batch.status, "failed");
  });

  test("a draft can be discarded and a committed one cannot", async () => {
    const { batchId } = await preview();
    const res = await agent.post(`/app/setup/import/${batchId}/discard`, {},
      { csrfFrom: `/app/setup/import/${batchId}` });
    assert.equal(res.status, 303);
    assert.equal((await all("SELECT id FROM import_batch")).length, 0);

    const second = await preview();
    await commit(second.batchId, { trust_cash: "16.50" });
    const refused = await agent.post(`/app/setup/import/${second.batchId}/discard`, {},
      { csrfFrom: `/app/setup/import/${second.batchId}` });
    assert.equal(refused.status, 400);
    assert.equal((await all("SELECT id FROM import_batch")).length, 1, "the record of it stays");
  });
});

/* --- the upload does not live there for ever --------------------------------- */

describe("what happens to the file", () => {
  test("an abandoned upload stops holding the portfolio after a week", async () => {
    const { batchId } = await preview();
    assert.ok((await get("SELECT files FROM import_batch WHERE id = ?", batchId)).files);

    const { update } = await import("../server/lib/db.js");
    await update("import_batch", batchId, { created_at: "2020-01-01T00:00:00.000Z" });

    const pruned = await pruneImportFiles();
    assert.equal(pruned, 1);

    const batch = await get("SELECT files, status FROM import_batch WHERE id = ?", batchId);
    assert.equal(batch.files, null, "the names and addresses are gone");
    assert.equal(batch.status, "draft", "the record that it happened stays");
  });

  test("a recent one is left alone", async () => {
    const { batchId } = await preview();
    assert.equal(await pruneImportFiles(), 0);
    assert.ok((await get("SELECT files FROM import_batch WHERE id = ?", batchId)).files);
  });
});
