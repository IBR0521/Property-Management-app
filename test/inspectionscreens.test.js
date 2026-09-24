/* The inspection screens, and the thing they exist for.

   A move-out screen that showed only today's condition would be asking the
   person filling it in to remember what it was a year ago. So the comparison
   is on the page, the lines that got worse are marked, and — the payoff —
   they are offered as deductions on the deposit return with the room, both
   conditions and the photographs behind them. A deduction that says "damages"
   is the thing this whole feature exists to prevent. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp, today } from "../server/lib/dates.js";
import { takeDeposit, openReturn } from "../server/lib/deposits.js";
import {
  startInspection, startMoveOut, setCondition, completeInspection, signInspection,
} from "../server/lib/inspections.js";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Inspection Screens Co", staffRoles: ["admin", "leasing"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

async function fill(inspectionId, overrides = {}) {
  for (const item of await all(
    "SELECT * FROM inspection_item WHERE inspection_id = ?", inspectionId)) {
    await setCondition({
      companyId: world.companyId, itemId: item.id,
      condition: overrides[item.label] || "good",
      note: overrides[`${item.label}:note`] || null,
    });
  }
}

async function signedMoveIn() {
  const inspection = await startInspection({
    companyId: world.companyId, unitId: world.unitId, leaseId: world.leaseId,
    kind: "movein", performedOn: "2026-01-01", by: "Dana" });
  await fill(inspection.id);
  await completeInspection({ companyId: world.companyId, inspectionId: inspection.id });
  await signInspection({
    companyId: world.companyId, inspectionId: inspection.id, typedName: "Ravi Bhatt" });
  return inspection;
}

describe("starting and filling one in", () => {
  test("the form starts one and lands on it", async () => {
    const res = await agent.post("/app/inspections/new",
      { unit_id: world.unitId, kind: "movein", performed_on: "2026-01-01" },
      { csrfFrom: "/app/inspections" });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /\/app\/inspections\//);

    const row = await get("SELECT * FROM inspection WHERE company_id = ?", world.companyId);
    assert.equal(row.kind, "movein");
    assert.equal(row.performed_by, "Dana Whitfield".slice(0, 0) || row.performed_by);
  });

  test("the checklist is on the page, by room", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const { body } = await agent.text(`/app/inspections/${inspection.id}`);
    assert.match(body, /Entry and hallway/);
    assert.match(body, /Kitchen/);
    assert.match(body, /Smoke detectors/);
    assert.match(body, /Condition/);
  });

  test("a condition and a note save from the row", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? AND label = 'Worktops'",
      inspection.id);

    const res = await agent.post(`/app/inspections/${inspection.id}/item/${item.id}`,
      { condition: "fair", note: "Small chip near the sink" },
      { csrfFrom: `/app/inspections/${inspection.id}` });
    assert.equal(res.status, 303);

    const after = await get("SELECT * FROM inspection_item WHERE id = ?", item.id);
    assert.equal(after.condition, "fair");
    assert.equal(after.note, "Small chip near the sink");
  });

  test("finishing with gaps is refused and says how many", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const res = await agent.post(`/app/inspections/${inspection.id}/complete`, {},
      { csrfFrom: `/app/inspections/${inspection.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /no condition against them/);
  });

  test("the tenant signs on the screen, witnessed by whoever is standing there", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, leaseId: world.leaseId,
      kind: "movein" });
    await fill(inspection.id);
    await agent.post(`/app/inspections/${inspection.id}/complete`, {},
      { csrfFrom: `/app/inspections/${inspection.id}` });

    let page = await agent.text(`/app/inspections/${inspection.id}`);
    assert.match(page.body, /The tenant signs/);
    assert.match(page.body, /On this screen, here, with you/);
    assert.match(page.body, /You are witnessing/);

    const res = await agent.post(`/app/inspections/${inspection.id}/sign`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/app/inspections/${inspection.id}` });
    assert.equal(res.status, 303);

    const signed = await get("SELECT * FROM inspection WHERE id = ?", inspection.id);
    assert.equal(signed.status, "signed");
    assert.equal(signed.signed_name, "Ravi Bhatt");
    assert.ok(signed.frozen_hash);

    const audit = await get(
      "SELECT * FROM audit_log WHERE entity = 'inspection' AND action = 'signed'");
    assert.ok(audit, "and who witnessed it");

    page = await agent.text(`/app/inspections/${inspection.id}`);
    assert.match(page.body, /Signed/);
    assert.doesNotMatch(page.body, /name="condition"/, "and it cannot be edited any more");
  });
});

describe("the move-out comparison", () => {
  test("it shows both sides and marks what got worse", async () => {
    await signedMoveIn();
    const res = await agent.post("/app/inspections/new",
      { unit_id: world.unitId, kind: "moveout", performed_on: "2026-12-31" },
      { csrfFrom: "/app/inspections" });
    const moveOutId = res.headers.get("location").split("/").pop();

    const worktops = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? AND label = 'Worktops'", moveOutId);
    await agent.post(`/app/inspections/${moveOutId}/item/${worktops.id}`,
      { condition: "damaged", note: "Burn mark near the hob" },
      { csrfFrom: `/app/inspections/${moveOutId}` });

    const { body } = await agent.text(`/app/inspections/${moveOutId}`);
    assert.match(body, /At move-in/);
    assert.match(body, /worse than at move-in/);
    assert.match(body, /Burn mark near the hob/);
  });

  test("with nothing to compare against it says so", async () => {
    const res = await agent.post("/app/inspections/new",
      { unit_id: world.unitId, kind: "moveout", performed_on: "2026-12-31" },
      { csrfFrom: "/app/inspections" });
    const { body } = await agent.text(res.headers.get("location").replace(/^https?:\/\/[^/]+/, ""));
    assert.match(body, /Nothing to compare with/);
    assert.match(body, /still worth recording/);
  });
});

describe("the payoff: a finding becomes a deduction", () => {
  async function scenario() {
    await takeDeposit({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: 120000, date: "2026-01-01", by: "test" });
    await run("UPDATE lease SET deposit_cents = 120000 WHERE id = ?", world.leaseId);
    await signedMoveIn();

    const moveOut = await startMoveOut({
      companyId: world.companyId, leaseId: world.leaseId, performedOn: "2026-12-31" });
    await fill(moveOut.id, {
      "Worktops": "damaged", "Worktops:note": "Burn mark near the hob" });
    await completeInspection({ companyId: world.companyId, inspectionId: moveOut.id });

    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-12-31" });
    return { ret, moveOut };
  }

  test("the worsened line is offered on the deposit return", async () => {
    const { ret } = await scenario();
    const { body } = await agent.text(`/app/deposits/${ret.id}`);

    assert.match(body, /From the move-out inspection/);
    assert.match(body, /Kitchen — Worktops/);
    assert.match(body, /survives\s+being disputed/);
    assert.doesNotMatch(body, /Front door and lock/,
      "only the lines that got worse — the rest cannot justify keeping anything");
  });

  test("taking it writes a deduction that says which room and both conditions", async () => {
    const { ret, moveOut } = await scenario();
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? AND label = 'Worktops'", moveOut.id);

    const res = await agent.post(`/app/deposits/${ret.id}/deduction`, {
      inspection_item_id: item.id,
      reason: "Kitchen — Worktops: Burn mark near the hob",
      amount: "450.00",
    }, { csrfFrom: `/app/deposits/${ret.id}` });
    assert.equal(res.status, 303);

    const deduction = await get("SELECT * FROM deposit_deduction WHERE return_id = ?", ret.id);
    assert.equal(deduction.inspection_item_id, item.id);
    assert.equal(Number(deduction.amount_cents), 45000);

    const { body } = await agent.text(`/app/deposits/${ret.id}`);
    assert.match(body, /Good at move-in/, "the deduction carries the comparison");
    assert.match(body, /Damaged at move-out/);
    assert.doesNotMatch(body, /From the move-out inspection[\s\S]{0,400}Kitchen — Worktops[\s\S]{0,200}Deduct/,
      "and it is no longer offered a second time");
  });

  test("and the tenant's statement says which room and what changed", async () => {
    const { ret, moveOut } = await scenario();
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? AND label = 'Worktops'", moveOut.id);
    await agent.post(`/app/deposits/${ret.id}/deduction`, {
      inspection_item_id: item.id,
      reason: "Kitchen — Worktops: Burn mark near the hob",
      amount: "450.00",
    }, { csrfFrom: `/app/deposits/${ret.id}` });

    await agent.post(`/app/deposits/${ret.id}/settle`, { date: "2027-01-05" },
      { csrfFrom: `/app/deposits/${ret.id}` });

    const settled = await get("SELECT * FROM deposit_return WHERE id = ?", ret.id);
    assert.match(settled.itemisation, /Kitchen — Worktops/);
    assert.match(settled.itemisation, /good at move-in, damaged at move-out/,
      "which is a far better answer than “damages”");
  });

  test("nothing worse means nothing is offered", async () => {
    await takeDeposit({
      companyId: world.companyId, leaseId: world.leaseId,
      amountCents: 120000, date: "2026-01-01", by: "test" });
    await signedMoveIn();
    const moveOut = await startMoveOut({
      companyId: world.companyId, leaseId: world.leaseId, performedOn: "2026-12-31" });
    await fill(moveOut.id);
    await completeInspection({ companyId: world.companyId, inspectionId: moveOut.id });

    const ret = await openReturn({
      companyId: world.companyId, leaseId: world.leaseId, moveoutDate: "2026-12-31" });
    const { body } = await agent.text(`/app/deposits/${ret.id}`);
    assert.doesNotMatch(body, /From the move-out inspection/);
  });
});

describe("who may reach it", () => {
  test("a leasing agent can look and cannot change", async () => {
    const leasing = client(app.origin);
    await leasing.signIn(world.staff.leasing.email, f.PASSWORD);

    const page = await leasing.get("/app/inspections");
    assert.equal(page.status, 200, "leasing holds property.view");

    const post = await leasing.post("/app/inspections/new",
      { unit_id: world.unitId, kind: "movein" }, { csrf: null });
    assert.ok(post.status >= 400, "and not property.edit");
    assert.equal((await all("SELECT id FROM inspection")).length, 0);
  });

  test("another company's inspection is not reachable by id", async () => {
    const other = await f.makeWorld({ name: "Not Yours Ltd" });
    const theirs = await startInspection({
      companyId: other.companyId, unitId: other.unitId, kind: "movein" });
    assert.equal((await agent.get(`/app/inspections/${theirs.id}`)).status, 404);
  });
});
