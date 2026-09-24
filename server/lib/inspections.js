/* Move-in and move-out inspections.

   ## What changed, not what the condition is

   At a move-out the question is never "what is the condition of the carpet",
   it is "is it worse than it was" — and only the second one can justify
   keeping somebody's money. So a move-out inspection is **made from** the
   move-in one: every room, every line, in the same order, each pointing back
   at the item it is being compared with. The screen then shows the two
   together, and a line that got worse can become a deduction with both
   photographs attached.

   ## A condition is a word

   `good / fair / poor / damaged / not_present`, the same shape as
   `application_check.result`. A number is what a model would produce and a
   number is what somebody would later threshold, and neither belongs in a
   judgement a person is making about somebody's home.

   ## The move-in is signed and frozen

   It is the record a deposit dispute turns on. What is kept is the document
   as it stood at the moment the tenant put their name to it, verbatim, with
   a hash over it — the same shape as a lease signature and a screening
   consent, and for the same reason: what matters later is not that somebody
   agreed, it is what they were agreeing to. */
import { all, get, one, insert, run, tx } from "./db.js";
import { id } from "./ids.js";
import { stamp, today } from "./dates.js";
import { sha256 } from "./crypto.js";

export const KINDS = ["movein", "moveout", "periodic"];

export const CONDITIONS = [
  { key: "good", label: "Good", worse: 0 },
  { key: "fair", label: "Fair", worse: 1 },
  { key: "poor", label: "Poor", worse: 2 },
  { key: "damaged", label: "Damaged", worse: 3 },
  { key: "not_present", label: "Not there", worse: null },
];

const RANK = Object.fromEntries(CONDITIONS.map((c) => [c.key, c.worse]));

export class InspectionRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "InspectionRefused";
  }
}

/* A checklist somebody can actually walk a property with.

   Rooms in the order you go through a front door, and per room the things
   that are argued about afterwards. A company can add to it; this is the
   starting point rather than the law. */
export const DEFAULT_CHECKLIST = [
  ["Entry and hallway", ["Front door and lock", "Walls", "Floor", "Ceiling and lighting"]],
  ["Living room", ["Walls", "Floor", "Ceiling and lighting", "Windows and blinds"]],
  ["Kitchen", ["Worktops", "Cupboards", "Sink and taps", "Cooker and hob",
    "Refrigerator", "Floor", "Walls and ceiling"]],
  ["Bathroom", ["Bath or shower", "Basin and taps", "WC", "Tiling and grout",
    "Extractor", "Floor"]],
  ["Bedroom", ["Walls", "Floor", "Ceiling and lighting", "Windows", "Wardrobe"]],
  ["Throughout", ["Smoke detectors", "Carbon monoxide detector", "Heating",
    "Keys handed over"]],
  ["Outside", ["Garden or yard", "Bins", "Parking", "Exterior condition"]],
];

/* --- making one ----------------------------------------------------------------- */

export async function startInspection({
  companyId, unitId, leaseId = null, kind = "movein",
  performedOn = today(), by = "system", checklist = DEFAULT_CHECKLIST, now = stamp,
}) {
  if (!KINDS.includes(kind)) throw new InspectionRefused(`"${kind}" is not a kind of inspection.`);

  const unit = await one(
    "SELECT * FROM unit WHERE id = ? AND company_id = ?", unitId, companyId);

  const inspectionId = id();
  const at = now();

  await tx(async () => {
    await insert("inspection", {
      id: inspectionId, company_id: companyId, unit_id: unit.id,
      lease_id: leaseId, kind, status: "draft",
      performed_by: by, performed_on: performedOn,
      created_by: by, created_at: at,
    });

    let position = 0;
    for (const [room, labels] of checklist) {
      for (const label of labels) {
        await insert("inspection_item", {
          id: id(), company_id: companyId, inspection_id: inspectionId,
          room, label, position: position++, created_at: at,
        });
      }
    }
  });

  return await one("SELECT * FROM inspection WHERE id = ?", inspectionId);
}

/* A move-out made from the move-in, so the comparison exists before anybody
   fills anything in. */
export async function startMoveOut({
  companyId, leaseId, performedOn = today(), by = "system", now = stamp,
}) {
  const lease = await one(
    "SELECT * FROM lease WHERE id = ? AND company_id = ?", leaseId, companyId);

  const moveIn = await get(
    `SELECT * FROM inspection
      WHERE lease_id = ? AND kind = 'movein' AND status <> 'draft'
      ORDER BY performed_on DESC LIMIT 1`, leaseId);

  if (!moveIn) {
    /* Not refused. Plenty of tenancies predate this feature, and a move-out
       inspection with nothing to compare against is still worth having — it
       just cannot say what changed, and the screen says so. */
    return await startInspection({
      companyId, unitId: lease.unit_id, leaseId, kind: "moveout",
      performedOn, by, now,
    });
  }

  const items = await all(
    "SELECT * FROM inspection_item WHERE inspection_id = ? ORDER BY position", moveIn.id);

  const inspectionId = id();
  const at = now();

  await tx(async () => {
    await insert("inspection", {
      id: inspectionId, company_id: companyId, unit_id: lease.unit_id,
      lease_id: leaseId, kind: "moveout", status: "draft",
      compares_to: moveIn.id,
      performed_by: by, performed_on: performedOn,
      created_by: by, created_at: at,
    });

    /* The same rooms, the same lines, the same order — including anything the
       company added at move-in, because a line that was worth recording then
       is worth comparing now. */
    for (const item of items) {
      await insert("inspection_item", {
        id: id(), company_id: companyId, inspection_id: inspectionId,
        room: item.room, label: item.label, position: item.position,
        compares_to: item.id, created_at: at,
      });
    }
  });

  return await one("SELECT * FROM inspection WHERE id = ?", inspectionId);
}

/* --- filling it in --------------------------------------------------------------- */

export async function setCondition({
  companyId, itemId, condition, note = null,
}) {
  const item = await one(
    "SELECT * FROM inspection_item WHERE id = ? AND company_id = ?", itemId, companyId);
  const inspection = await one("SELECT * FROM inspection WHERE id = ?", item.inspection_id);

  if (inspection.status === "signed") {
    throw new InspectionRefused(
      "This inspection has been signed. Changing it now would alter a record the tenant "
      + "put their name to — start another one instead.");
  }
  if (condition != null && !RANK.hasOwnProperty(condition)) {
    throw new InspectionRefused(`"${condition}" is not a condition.`);
  }

  await run(
    "UPDATE inspection_item SET condition = ?, note = ? WHERE id = ?",
    condition || null, String(note || "").trim() || null, itemId);
  return await one("SELECT * FROM inspection_item WHERE id = ?", itemId);
}

export async function addItem({
  companyId, inspectionId, room, label, now = stamp,
}) {
  const inspection = await one(
    "SELECT * FROM inspection WHERE id = ? AND company_id = ?", inspectionId, companyId);
  if (inspection.status === "signed") {
    throw new InspectionRefused("This inspection has been signed and cannot be added to.");
  }
  const words = String(label || "").trim();
  if (!words) throw new InspectionRefused("An item needs a name.");

  const last = await get(
    "SELECT COALESCE(MAX(position), 0)::int AS n FROM inspection_item WHERE inspection_id = ?",
    inspectionId);

  const itemId = id();
  await insert("inspection_item", {
    id: itemId, company_id: companyId, inspection_id: inspectionId,
    room: String(room || "Other").trim() || "Other", label: words,
    position: Number(last?.n || 0) + 1, created_at: now(),
  });
  return await one("SELECT * FROM inspection_item WHERE id = ?", itemId);
}

export async function attachPhoto({
  companyId, inspectionId, itemId = null, file, caption = null, now = stamp,
}) {
  const photoId = id();
  await insert("inspection_photo", {
    id: photoId, company_id: companyId, inspection_id: inspectionId,
    item_id: itemId, path: file.path, mime: file.mime || null,
    bytes: file.bytes || null, caption: caption || null, created_at: now(),
  });
  return await one("SELECT * FROM inspection_photo WHERE id = ?", photoId);
}

/* --- finishing it ---------------------------------------------------------------- */

export async function completeInspection({ companyId, inspectionId, now = stamp }) {
  const inspection = await one(
    "SELECT * FROM inspection WHERE id = ? AND company_id = ?", inspectionId, companyId);
  if (inspection.status === "signed") return inspection;

  const unmarked = await get(
    `SELECT COUNT(*)::int AS n FROM inspection_item
      WHERE inspection_id = ? AND condition IS NULL`, inspectionId);
  if (Number(unmarked.n) > 0) {
    throw new InspectionRefused(
      `${unmarked.n} line(s) have no condition against them. An inspection with gaps is `
      + "worse than none, because the gaps are where the argument happens.");
  }

  await run(
    "UPDATE inspection SET status = 'complete', completed_at = ? WHERE id = ?",
    now(), inspectionId);
  return await one("SELECT * FROM inspection WHERE id = ?", inspectionId);
}

/* The tenant's signature on a move-in.

   Frozen the same way a lease document is: the record as it stood is rendered
   to text, stored verbatim, and hashed. What matters in a dispute is not that
   somebody signed, it is what they signed. */
export async function signInspection({
  companyId, inspectionId, typedName, ip = null, now = stamp,
}) {
  const detail = await inspectionDetail({ companyId, inspectionId });
  if (detail.status === "draft") {
    throw new InspectionRefused(
      "Finish the inspection before asking anybody to sign it.");
  }
  if (detail.status === "signed") {
    throw new InspectionRefused("This has already been signed.");
  }

  const typed = String(typedName || "").trim();
  if (typed.length < 2) throw new InspectionRefused("Type your full name to sign.");

  const body = renderInspection(detail);
  await run(
    `UPDATE inspection
        SET status = 'signed', signed_name = ?, signed_at = ?, signed_ip = ?,
            frozen_body = ?, frozen_hash = ?
      WHERE id = ?`,
    typed, now(), ip, body, sha256(body), inspectionId);

  return await one("SELECT * FROM inspection WHERE id = ?", inspectionId);
}

export function intact(inspection) {
  return Boolean(inspection?.frozen_body)
    && sha256(inspection.frozen_body) === inspection.frozen_hash;
}

/* --- reading it ------------------------------------------------------------------ */

export async function inspectionDetail({ companyId, inspectionId }) {
  const inspection = await one(
    `SELECT i.*, u.label AS unit_label, p.line1, p.city, p.state, p.zip
       FROM inspection i
       JOIN unit u ON u.id = i.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE i.id = ? AND i.company_id = ?`, inspectionId, companyId);

  const items = await all(
    `SELECT i.*, c.condition AS before_condition, c.note AS before_note
       FROM inspection_item i
       LEFT JOIN inspection_item c ON c.id = i.compares_to
      WHERE i.inspection_id = ? ORDER BY i.position`, inspectionId);

  const photos = await all(
    "SELECT * FROM inspection_photo WHERE inspection_id = ? ORDER BY created_at", inspectionId);

  const byItem = new Map();
  for (const photo of photos) {
    const key = photo.item_id || "";
    byItem.set(key, [...(byItem.get(key) || []), photo]);
  }

  /* Grouped the way somebody walked it. */
  const rooms = [];
  for (const item of items) {
    let room = rooms.find((r) => r.name === item.room);
    if (!room) rooms.push((room = { name: item.room, items: [] }));
    room.items.push({
      ...item,
      changed: worsened(item.before_condition, item.condition),
      photos: byItem.get(item.id) || [],
    });
  }

  return {
    ...inspection,
    rooms,
    items: items.map((i) => ({ ...i, changed: worsened(i.before_condition, i.condition) })),
    photos: byItem.get("") || [],
    /* What a move-out is for. */
    worse: items.filter((i) => worsened(i.before_condition, i.condition)),
    unmarked: items.filter((i) => !i.condition).length,
  };
}

/* Whether a line got worse. Null when there is nothing to compare with, or
   when either end is "not there" — an item that was not present at move-in
   and is not present now has not changed, and one that appeared is not
   damage. */
export function worsened(before, after) {
  if (!before || !after) return false;
  const a = RANK[before];
  const b = RANK[after];
  if (a == null || b == null) return false;
  return b > a;
}

export async function inspectionsFor({ companyId, unitId = null, leaseId = null }) {
  const where = ["i.company_id = ?"];
  const params = [companyId];
  if (unitId) { where.push("i.unit_id = ?"); params.push(unitId); }
  if (leaseId) { where.push("i.lease_id = ?"); params.push(leaseId); }

  return await all(
    `SELECT i.*, u.label AS unit_label, p.line1,
            (SELECT COUNT(*) FROM inspection_item t WHERE t.inspection_id = i.id)::int AS items,
            (SELECT COUNT(*) FROM inspection_item t
              WHERE t.inspection_id = i.id AND t.condition IS NULL)::int AS unmarked
       FROM inspection i
       JOIN unit u ON u.id = i.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE ${where.join(" AND ")}
      ORDER BY i.performed_on DESC, i.created_at DESC`, ...params);
}

/* The document a tenant signs, and the one kept afterwards. Plain text for
   the same reason the deposit itemisation is: somebody may be about to
   disagree with it, and it should be readable without this application. */
export function renderInspection(detail) {
  const lines = [];
  const where = `${detail.line1}${detail.unit_label ? `, unit ${detail.unit_label}` : ""}`;
  const heading = detail.kind === "movein" ? "Move-in inspection"
    : detail.kind === "moveout" ? "Move-out inspection" : "Inspection";

  lines.push(`${heading} — ${where}`);
  lines.push(`Carried out ${detail.performed_on} by ${detail.performed_by || "—"}`);
  lines.push("");

  for (const room of detail.rooms) {
    lines.push(room.name);
    for (const item of room.items) {
      const label = String(item.label).slice(0, 40).padEnd(40);
      const now = conditionLabel(item.condition);
      if (item.before_condition) {
        lines.push(`  ${label}${conditionLabel(item.before_condition).padEnd(12)}→  ${now}`
          + `${item.changed ? "   (worse)" : ""}`);
      } else {
        lines.push(`  ${label}${now}`);
      }
      if (item.note) lines.push(`      ${item.note}`);
      if (item.photos.length) {
        lines.push(`      ${item.photos.length} photograph(s)`);
      }
    }
    lines.push("");
  }

  if (detail.note) {
    lines.push("Notes");
    lines.push(`  ${detail.note}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function conditionLabel(key) {
  return CONDITIONS.find((c) => c.key === key)?.label || "not recorded";
}
