/* Move-in and move-out inspections.

   The property this file is really about is that a move-out says **what
   changed**, not what the condition is — only the first one can justify
   keeping somebody's money. So the move-out is made from the move-in, every
   line pointing back at the line it is compared with, and `worsened()` is
   asserted at its edges because it is the function a deduction rests on. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { sha256 } from "../server/lib/crypto.js";
import {
  startInspection, startMoveOut, setCondition, addItem, attachPhoto,
  completeInspection, signInspection, inspectionDetail, inspectionsFor,
  renderInspection, worsened, intact, conditionLabel,
  DEFAULT_CHECKLIST, CONDITIONS, InspectionRefused,
} from "../server/lib/inspections.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });
beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Inspections Co" });
});

/* A move-in, filled in and signed, which is what a move-out compares with. */
async function signedMoveIn(conditions = {}) {
  const inspection = await startInspection({
    companyId: world.companyId, unitId: world.unitId, leaseId: world.leaseId,
    kind: "movein", performedOn: "2026-01-01", by: "Dana",
  });
  const items = await all(
    "SELECT * FROM inspection_item WHERE inspection_id = ? ORDER BY position", inspection.id);
  for (const item of items) {
    await setCondition({
      companyId: world.companyId, itemId: item.id,
      condition: conditions[item.label] || "good",
    });
  }
  await completeInspection({ companyId: world.companyId, inspectionId: inspection.id });
  await signInspection({
    companyId: world.companyId, inspectionId: inspection.id,
    typedName: "Ravi Bhatt", ip: "203.0.113.5",
  });
  return { inspection, items };
}

/* --- the checklist -------------------------------------------------------------- */

describe("starting one", () => {
  test("it comes with a checklist somebody can walk a property with", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });

    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: inspection.id });

    assert.equal(detail.status, "draft");
    assert.ok(detail.rooms.length >= 6, "rooms in the order you walk them");
    assert.equal(detail.rooms[0].name, "Entry and hallway");
    assert.ok(detail.rooms.some((r) => r.name === "Kitchen"));
    assert.ok(detail.items.some((i) => /Smoke detectors/.test(i.label)),
      "including the things that are argued about afterwards");

    const expected = DEFAULT_CHECKLIST.reduce((n, [, labels]) => n + labels.length, 0);
    assert.equal(detail.items.length, expected);
  });

  test("a company can add a line", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const added = await addItem({
      companyId: world.companyId, inspectionId: inspection.id,
      room: "Kitchen", label: "Dishwasher" });

    assert.equal(added.room, "Kitchen");
    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: inspection.id });
    assert.ok(detail.items.some((i) => i.label === "Dishwasher"));
  });

  test("a condition is a word, never a number", () => {
    /* The same reasoning as `application_check.result`: a number is what a
       model would produce and a number is what somebody would later
       threshold. */
    for (const c of CONDITIONS) assert.equal(typeof c.key, "string");
    assert.deepEqual(CONDITIONS.map((c) => c.key),
      ["good", "fair", "poor", "damaged", "not_present"]);
  });

  test("and nothing else is accepted", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? LIMIT 1", inspection.id);
    await assert.rejects(() => setCondition({
      companyId: world.companyId, itemId: item.id, condition: "7" }),
      InspectionRefused);
  });
});

/* --- what changed ---------------------------------------------------------------- */

describe("a move-out is made from the move-in", () => {
  test("same rooms, same lines, same order, each pointing back", async () => {
    const { inspection: moveIn, items } = await signedMoveIn();

    const moveOut = await startMoveOut({
      companyId: world.companyId, leaseId: world.leaseId,
      performedOn: "2026-12-31", by: "Dana" });

    assert.equal(moveOut.compares_to, moveIn.id);
    const after = await all(
      "SELECT * FROM inspection_item WHERE inspection_id = ? ORDER BY position", moveOut.id);
    assert.equal(after.length, items.length);
    assert.deepEqual(after.map((i) => i.label), items.map((i) => i.label));
    for (const item of after) assert.ok(item.compares_to, "every line has something to compare");
  });

  test("a line added at move-in is compared too", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, leaseId: world.leaseId,
      kind: "movein" });
    await addItem({
      companyId: world.companyId, inspectionId: inspection.id,
      room: "Kitchen", label: "Dishwasher" });
    for (const item of await all(
      "SELECT * FROM inspection_item WHERE inspection_id = ?", inspection.id)) {
      await setCondition({ companyId: world.companyId, itemId: item.id, condition: "good" });
    }
    await completeInspection({ companyId: world.companyId, inspectionId: inspection.id });

    const moveOut = await startMoveOut({
      companyId: world.companyId, leaseId: world.leaseId });
    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: moveOut.id });
    assert.ok(detail.items.some((i) => i.label === "Dishwasher"),
      "a line worth recording then is worth comparing now");
  });

  test("the comparison is what the screen reads", async () => {
    await signedMoveIn({ "Worktops": "good", "Bath or shower": "fair" });
    const moveOut = await startMoveOut({ companyId: world.companyId, leaseId: world.leaseId });

    const items = await all(
      "SELECT * FROM inspection_item WHERE inspection_id = ?", moveOut.id);
    const worktops = items.find((i) => i.label === "Worktops");
    const bath = items.find((i) => i.label === "Bath or shower");

    await setCondition({
      companyId: world.companyId, itemId: worktops.id, condition: "damaged",
      note: "Burn mark near the hob" });
    await setCondition({
      companyId: world.companyId, itemId: bath.id, condition: "fair" });

    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: moveOut.id });

    const shownWorktops = detail.items.find((i) => i.label === "Worktops");
    assert.equal(shownWorktops.before_condition, "good");
    assert.equal(shownWorktops.condition, "damaged");
    assert.equal(shownWorktops.changed, true);

    const shownBath = detail.items.find((i) => i.label === "Bath or shower");
    assert.equal(shownBath.changed, false, "fair to fair is not damage");

    assert.equal(detail.worse.length, 1, "one line got worse, and that is the list that matters");
  });

  test("with no move-in to compare, it still happens and says nothing changed", async () => {
    /* Plenty of tenancies predate this feature. An inspection with nothing to
       compare against is still worth having; it just cannot say what changed. */
    const moveOut = await startMoveOut({ companyId: world.companyId, leaseId: world.leaseId });
    assert.equal(moveOut.compares_to, null);

    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: moveOut.id });
    assert.ok(detail.items.length > 0);
    for (const item of detail.items) assert.equal(item.changed, false);
  });

  test("a draft move-in is not what a move-out compares with", async () => {
    /* Half a checklist is not a record of anything. */
    await startInspection({
      companyId: world.companyId, unitId: world.unitId, leaseId: world.leaseId,
      kind: "movein" });
    const moveOut = await startMoveOut({ companyId: world.companyId, leaseId: world.leaseId });
    assert.equal(moveOut.compares_to, null);
  });
});

describe("what counts as worse", () => {
  test("down the scale is worse, up it is not", () => {
    assert.equal(worsened("good", "damaged"), true);
    assert.equal(worsened("good", "fair"), true);
    assert.equal(worsened("poor", "damaged"), true);
    assert.equal(worsened("damaged", "good"), false, "somebody fixed it");
    assert.equal(worsened("fair", "fair"), false);
  });

  test("nothing to compare is not damage", () => {
    assert.equal(worsened(null, "damaged"), false,
      "a line with no move-in record cannot justify keeping money");
    assert.equal(worsened("good", null), false);
  });

  test("an item that was not there is neither better nor worse", () => {
    /* Something that appeared is not damage, and something that was never
       there and still is not has not changed. */
    assert.equal(worsened("not_present", "damaged"), false);
    assert.equal(worsened("good", "not_present"), false);
    assert.equal(worsened("not_present", "not_present"), false);
  });
});

/* --- finishing and signing -------------------------------------------------------- */

describe("finishing it", () => {
  test("gaps are refused, because the gaps are where the argument happens", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });

    await assert.rejects(() => completeInspection({
      companyId: world.companyId, inspectionId: inspection.id }),
      /no condition against them/);
  });

  test("and a signature needs a finished one", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    await assert.rejects(() => signInspection({
      companyId: world.companyId, inspectionId: inspection.id, typedName: "Ravi Bhatt" }),
      /Finish the inspection/);
  });

  test("signing freezes what was signed, and an altered record stops matching", async () => {
    const { inspection } = await signedMoveIn();
    const signed = await get("SELECT * FROM inspection WHERE id = ?", inspection.id);

    assert.equal(signed.status, "signed");
    assert.equal(signed.signed_name, "Ravi Bhatt");
    assert.ok(signed.signed_at);
    assert.equal(signed.frozen_hash, sha256(signed.frozen_body));
    assert.equal(intact(signed), true);
    assert.match(signed.frozen_body, /Move-in inspection/);
    assert.match(signed.frozen_body, /Smoke detectors/);

    await run("UPDATE inspection SET frozen_body = ? WHERE id = ?",
      "Everything was broken.", inspection.id);
    const tampered = await get("SELECT * FROM inspection WHERE id = ?", inspection.id);
    assert.equal(intact(tampered), false,
      "what matters in a dispute is what they signed, so an altered record has to show");
  });

  test("a signed inspection cannot be edited", async () => {
    const { inspection } = await signedMoveIn();
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? LIMIT 1", inspection.id);

    await assert.rejects(() => setCondition({
      companyId: world.companyId, itemId: item.id, condition: "damaged" }),
      /put their name to/);
    await assert.rejects(() => addItem({
      companyId: world.companyId, inspectionId: inspection.id, room: "Kitchen", label: "X" }),
      /signed/);
  });

  test("signing twice is refused", async () => {
    const { inspection } = await signedMoveIn();
    await assert.rejects(() => signInspection({
      companyId: world.companyId, inspectionId: inspection.id, typedName: "Ravi Bhatt" }),
      /already been signed/);
  });

  test("a name that is not a name is not a signature", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    for (const item of await all(
      "SELECT * FROM inspection_item WHERE inspection_id = ?", inspection.id)) {
      await setCondition({ companyId: world.companyId, itemId: item.id, condition: "good" });
    }
    await completeInspection({ companyId: world.companyId, inspectionId: inspection.id });
    await assert.rejects(() => signInspection({
      companyId: world.companyId, inspectionId: inspection.id, typedName: " " }),
      /Type your full name/);
  });
});

/* --- the document ----------------------------------------------------------------- */

describe("what it reads like", () => {
  test("a move-in lists each room and what was found", async () => {
    const { inspection } = await signedMoveIn({ "Worktops": "fair" });
    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: inspection.id });
    const text = renderInspection(detail);

    assert.match(text, /Move-in inspection/);
    assert.match(text, /Kitchen/);
    assert.match(text, /Worktops\s+Fair/);
    assert.match(text, /Front door and lock\s+Good/);
  });

  test("a move-out shows both sides and marks what got worse", async () => {
    await signedMoveIn();
    const moveOut = await startMoveOut({ companyId: world.companyId, leaseId: world.leaseId });
    const items = await all(
      "SELECT * FROM inspection_item WHERE inspection_id = ?", moveOut.id);

    for (const item of items) {
      await setCondition({
        companyId: world.companyId, itemId: item.id,
        condition: item.label === "Worktops" ? "damaged" : "good",
        note: item.label === "Worktops" ? "Burn mark near the hob" : null,
      });
    }

    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: moveOut.id });
    const text = renderInspection(detail);

    assert.match(text, /Move-out inspection/);
    assert.match(text, /Worktops\s+Good\s+→\s+Damaged\s+\(worse\)/);
    assert.match(text, /Burn mark near the hob/);
    assert.match(text, /Front door and lock\s+Good\s+→\s+Good/);
    assert.doesNotMatch(text, /Front door and lock.*\(worse\)/);
  });

  test("photographs are counted on the line they belong to", async () => {
    const inspection = await startInspection({
      companyId: world.companyId, unitId: world.unitId, kind: "movein" });
    const item = await get(
      "SELECT * FROM inspection_item WHERE inspection_id = ? AND label = 'Worktops'",
      inspection.id);
    await attachPhoto({
      companyId: world.companyId, inspectionId: inspection.id, itemId: item.id,
      file: { path: "inspections/worktop.jpg", mime: "image/jpeg", bytes: 900 } });

    const detail = await inspectionDetail({
      companyId: world.companyId, inspectionId: inspection.id });
    const shown = detail.items.find((i) => i.label === "Worktops");
    assert.equal(detail.rooms.find((r) => r.name === "Kitchen")
      .items.find((i) => i.label === "Worktops").photos.length, 1);
    assert.ok(shown);
  });

  test("a condition nobody recorded says so rather than guessing", () => {
    assert.equal(conditionLabel(null), "not recorded");
    assert.equal(conditionLabel("not_present"), "Not there");
  });
});

/* --- listing ---------------------------------------------------------------------- */

describe("finding them", () => {
  test("by unit and by tenancy, newest first", async () => {
    await signedMoveIn();
    await startMoveOut({ companyId: world.companyId, leaseId: world.leaseId,
      performedOn: "2026-12-31" });

    const byUnit = await inspectionsFor({
      companyId: world.companyId, unitId: world.unitId });
    assert.equal(byUnit.length, 2);
    assert.equal(byUnit[0].kind, "moveout", "newest first");
    assert.ok(byUnit[0].unmarked > 0, "and it says how much is left to do");

    const byLease = await inspectionsFor({
      companyId: world.companyId, leaseId: world.leaseId });
    assert.equal(byLease.length, 2);
  });

  test("another company's are not in the list", async () => {
    const other = await f.makeWorld({ name: "Not Yours Ltd" });
    await startInspection({
      companyId: other.companyId, unitId: other.unitId, kind: "movein" });

    const mine = await inspectionsFor({ companyId: world.companyId });
    assert.equal(mine.length, 0);
  });
});
