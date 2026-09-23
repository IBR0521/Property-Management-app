/* The owner's statement as a PDF.

   One rule shapes the whole thing: **it renders the snapshot, never a fresh
   query.** `owner_statement.totals` holds the figures as they stood when the
   statement was generated, so an owner sent a link in April sees April's
   numbers in April's statement whatever has been posted since. A paper copy
   disagreeing with the link it came from is worse than either being stale,
   because only one of them can be checked.

   The other half is that it must render at all. pdf-lib's standard fonts are
   WinAnsi and throw on anything outside them, and an owner called Đurađ took
   this down during development — not at the draw call, where it would have
   been obvious, but during truncation, because the text was measured before
   it was sanitised. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today } from "../server/lib/dates.js";
import { ensureChart } from "../server/features/accounting.js";
import { postMoney } from "../server/lib/ledger.js";
import { computeStatement } from "../server/features/owners.js";
import { buildStatementPdf, statementFileName } from "../server/lib/pdf/statement.js";

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Statement Co" });
  await ensureChart(world.companyId);
});

const move = (date, kind, cents, memo) => postMoney({
  companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
  unitId: world.unitId, leaseId: world.leaseId,
  date, kind, amountCents: cents, memo, source: "manual", postedBy: "test",
});

async function aMonth() {
  await move("2026-08-03", "rent_payment", 145000, "August rent");
  await move("2026-08-11", "expense", -27350, "Tap washer and labour");
  await move("2026-08-31", "management_fee", -14500, "Management fee");
  return await computeStatement(world.ownerId, "2026-08-01", "2026-08-31");
}

/* Stored the way the application stores it, so the tests exercise the real
   path from snapshot to page. */
async function generate(totals, token = "tok-" + id()) {
  const sid = id();
  await insert("owner_statement", {
    id: sid, company_id: world.companyId, owner_id: world.ownerId,
    period_start: "2026-08-01", period_end: "2026-08-31",
    totals: JSON.stringify(totals), token, generated_at: stamp(),
  });
  return { id: sid, token };
}

const staffClient = async () => {
  const c = client(app.origin);
  await c.signIn(world.staff.admin.email, f.PASSWORD);
  return c;
};

/* --- it renders ------------------------------------------------------------- */

describe("rendering", () => {
  test("it is a PDF with the figures on it", async () => {
    const totals = await aMonth();
    const owner = await get("SELECT * FROM owner WHERE id = ?", world.ownerId);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);

    const bytes = await buildStatementPdf({
      company, owner, totals,
      statement: { period_start: "2026-08-01", period_end: "2026-08-31", generated_at: stamp() },
    });

    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
    assert.equal(totals.net, 145000 - 27350 - 14500, "the figure it is rendering");
  });

  test("an owner outside WinAnsi does not take it down", async () => {
    /* The bug that shipped for an afternoon. It failed during truncation,
       not at the draw call, because the text was measured before it was
       sanitised — one stack frame further from the cause and the same
       unhelpful message. */
    await run("UPDATE owner SET name = ? WHERE id = ?", "Đurađ Ćosić", world.ownerId);
    const totals = await aMonth();
    const owner = await get("SELECT * FROM owner WHERE id = ?", world.ownerId);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);

    const bytes = await buildStatementPdf({
      company, owner, totals,
      statement: { period_start: "2026-08-01", period_end: "2026-08-31", generated_at: stamp() },
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("nor does a memo, a company name or an address outside it", async () => {
    /* Every string on the page comes from somewhere a person typed. */
    await move("2026-08-03", "rent_payment", 145000, "Ремонт крыши — 田中さん");
    const totals = await computeStatement(world.ownerId, "2026-08-01", "2026-08-31");
    const owner = await get("SELECT * FROM owner WHERE id = ?", world.ownerId);

    const bytes = await buildStatementPdf({
      company: { name: "Ø Property", legal_name: "Łukasz Ø LLC", address: "Ståhl Street 1" },
      owner, totals,
      statement: { period_start: "2026-08-01", period_end: "2026-08-31", generated_at: stamp() },
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("a long month runs onto more pages rather than off the first", async () => {
    for (let i = 1; i <= 90; i++) {
      await move(`2026-08-${String((i % 28) + 1).padStart(2, "0")}`, "expense", -1000, `Item ${i}`);
    }
    const totals = await computeStatement(world.ownerId, "2026-08-01", "2026-08-31");
    const owner = await get("SELECT * FROM owner WHERE id = ?", world.ownerId);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);

    const bytes = await buildStatementPdf({
      company, owner, totals,
      statement: { period_start: "2026-08-01", period_end: "2026-08-31", generated_at: stamp() },
    });
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() > 1, "ninety lines do not fit on one page");
  });

  test("a period with nothing in it is still a statement", async () => {
    /* "Nothing happened" is an answer an owner is entitled to, and a
       zero-byte file is not it. */
    const totals = await computeStatement(world.ownerId, "2026-08-01", "2026-08-31");
    const owner = await get("SELECT * FROM owner WHERE id = ?", world.ownerId);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);

    const bytes = await buildStatementPdf({
      company, owner, totals,
      statement: { period_start: "2026-08-01", period_end: "2026-08-31", generated_at: stamp() },
    });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
  });

  test("the filename says whose and when", async () => {
    assert.equal(
      statementFileName({
        companyName: "Leafridge Property Management", ownerName: "Okafor Holdings LLC",
        from: "2026-08-01", to: "2026-08-31",
      }),
      "leafridge-property-manag-statement-okafor-holdings-llc-2026-08-01-to-2026-08-31.pdf");
  });
});

/* --- the snapshot ------------------------------------------------------------ */

describe("it renders the snapshot", () => {
  test("the builder cannot go and look", async () => {
    /* Asserted on the source, because it is a property of the design rather
       than of any one call: the builder takes the parsed snapshot and has no
       way to reach the database at all. */
    const source = readFileSync(
      new URL("../server/lib/pdf/statement.js", import.meta.url), "utf8");
    assert.ok(!/from "\.\.\/db\.js"/.test(source), "it must not import the database");
    assert.ok(!/computeStatement/.test(source), "nor recompute the figures");
  });

  test("posting more money afterwards does not change it", async () => {
    /* The rule the whole thing exists for. */
    const totals = await aMonth();
    const { token } = await generate(totals);
    const anon = client(app.origin);

    const before = Buffer.from(await (await anon.get(`/o/s/${token}/pdf`)).arrayBuffer());

    await move("2026-08-15", "expense", -99999, "A cost recorded later");

    const after = Buffer.from(await (await anon.get(`/o/s/${token}/pdf`)).arrayBuffer());
    assert.equal(after.length, before.length,
      "the statement is a record of what was checked, not a live query");
  });

  test("a snapshot that will not parse says so rather than throwing a stack", async () => {
    const { token } = await generate(await aMonth());
    await run("UPDATE owner_statement SET totals = ? WHERE token = ?", "{not json", token);

    const res = await client(app.origin).get(`/o/s/${token}/pdf`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /could not be read/);
  });
});

/* --- who can fetch it --------------------------------------------------------- */

describe("the two ways to it", () => {
  test("the owner's token is enough, with no account", async () => {
    /* Owners do not have passwords. The token is the whole credential and
       always has been. */
    const { token } = await generate(await aMonth());
    const res = await client(app.origin).get(`/o/s/${token}/pdf`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /attachment; filename="statement-co-statement-/);
    assert.match(res.headers.get("cache-control"), /no-store/);
  });

  test("a token nobody issued is not found", async () => {
    assert.equal((await client(app.origin).get("/o/s/not-a-real-token/pdf")).status, 404);
  });

  test("a member of staff gets it through their session", async () => {
    const { id: sid } = await generate(await aMonth());
    const c = await staffClient();
    const res = await c.get(`/app/owners/${world.ownerId}/statements/${sid}/pdf`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
  });

  test("another company's statement is not found, not forbidden", async () => {
    /* Scoped in the query that finds it. A 403 would confirm it exists. */
    const other = await f.makeWorld({ name: "Somebody Else Co" });
    const sid = id();
    await insert("owner_statement", {
      id: sid, company_id: other.companyId, owner_id: other.ownerId,
      period_start: "2026-08-01", period_end: "2026-08-31",
      totals: "{}", token: "other-token", generated_at: stamp(),
    });

    const c = await staffClient();
    const res = await c.get(`/app/owners/${other.ownerId}/statements/${sid}/pdf`);
    assert.equal(res.status, 404);
  });

  test("the owner's page offers the download", async () => {
    const { token } = await generate(await aMonth());
    const { body } = await client(app.origin).text(`/o/s/${token}`);
    assert.match(body, new RegExp(`/o/s/${token}/pdf`));
  });

  test("and so does the staff page", async () => {
    const { id: sid } = await generate(await aMonth());
    const c = await staffClient();
    const { body } = await c.text(`/app/owners/${world.ownerId}`);
    assert.match(body, new RegExp(`/statements/${sid}/pdf`));
  });
});
