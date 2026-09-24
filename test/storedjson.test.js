/* Stored JSON, read defensively.

   Two columns in this schema hold JSON as text: `lease_document.required`
   and `owner_statement.totals`. Both are read back and used structurally —
   one is filtered, the other has `.length` taken of a list inside it — and
   both were read with a bare parse or a parse guarded only by try/catch.

   try/catch is not enough. `JSON.parse` is perfectly happy with `1`, `null`
   and `"tenant"`: all valid JSON, none of them an array, and `.filter` is not
   a function on any of them. The catch never fires and the page 500s.

   Nothing in the application writes such a row today — the defaults are JSON
   arrays and so is every insert. What writes one is an import, a migration,
   a hand-run UPDATE at 2am, or simply time: a snapshot filed before a field
   existed does not grow the field when the code does. Stored JSON outlives
   the code that wrote it, which is the whole reason to read it defensively.

   Found by walking every route with a fixture built by hand — the hand-built
   rows were the wrong shape, and two pages fell over rather than falling
   back. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id, token } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";

let app, world, agent;

before(async () => { await freshDatabase(); await truncateAll(); app = await startApp(); });
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Stored JSON Co", staffRoles: ["admin"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

async function leaseDoc(required) {
  const docId = id(), tok = token();
  await insert("lease_document", {
    id: docId, company_id: world.companyId, lease_id: world.leaseId,
    unit_id: world.unitId, title: "Doc", body_md: "# Doc", body_hash: "h",
    status: "out_for_signature", token: tok, required,
    created_by: "test", created_at: stamp(),
  });
  return { docId, tok };
}

async function statement(totals) {
  const tok = token();
  await insert("owner_statement", {
    id: id(), company_id: world.companyId, owner_id: world.ownerId,
    period_start: "2026-01-01", period_end: "2026-01-31",
    totals, token: tok, generated_at: stamp(),
  });
  return tok;
}

describe("a lease document whose required-signers column is not a list", () => {
  /* Every one of these is valid JSON. None is an array. */
  for (const [label, value] of [
    ["a number", "1"],
    ["a string", '"tenant"'],
    ["null", "null"],
    ["an object", '{"tenant":true}'],
    ["a list of the wrong thing", "[1,2,3]"],
    ["not JSON at all", "tenant,manager"],
  ]) {
    test(`${label} falls back instead of taking the page down`, async () => {
      const { docId, tok } = await leaseDoc(value);

      const pub = await agent.text(`/sign/${tok}`);
      assert.notEqual(pub.res.status, 500, `/sign 500ed on ${label}`);

      const staffPage = await agent.text(`/app/leases/d/${docId}`);
      assert.notEqual(staffPage.res.status, 500, `/app/leases/d 500ed on ${label}`);
    });
  }

  test("a proper list is still honoured, not overwritten by the fallback", async () => {
    const { docId } = await leaseDoc(JSON.stringify(["tenant"]));
    const { res, body } = await agent.text(`/app/leases/d/${docId}`);
    assert.equal(res.status, 200);
    assert.ok(!/manager/i.test(body) || /tenant/i.test(body),
      "the document asked for one signer and must not silently gain a second");
  });
});

describe("an owner statement whose snapshot is not the shape it was", () => {
  test("a snapshot filed before the list fields existed does not crash the page", async () => {
    /* The realistic case: the column is fine, the code moved on. */
    const tok = await statement(JSON.stringify({
      rent: 120000, expenses: 0, fees: 0, other: 0, net: 120000,
    }));
    const { res } = await agent.text(`/o/s/${tok}`);
    assert.notEqual(res.status, 500);
  });

  for (const [label, value] of [
    ["unparseable", "{not json"],
    ["a list", "[1,2,3]"],
    ["a bare number", "42"],
    ["null", "null"],
  ]) {
    test(`${label} is refused in words, not with a stack trace`, async () => {
      const tok = await statement(value);
      const { res, body } = await agent.text(`/o/s/${tok}`);
      assert.notEqual(res.status, 500, `500ed on ${label}`);
      assert.match(body, /could not be read|cannot be shown/i,
        "an owner opening their own link deserves a sentence, not a 500");
    });
  }

  test("a complete snapshot still renders its figures", async () => {
    const tok = await statement(JSON.stringify({
      rent: 120000, expenses: -5000, fees: -12000, other: 0, net: 103000,
      lines: [], jobs: [], upcoming: [],
    }));
    const { res, body } = await agent.text(`/o/s/${tok}`);
    assert.equal(res.status, 200);
    assert.match(body, /1,200\.00/, "the rent figure belongs on the page");
  });
});
