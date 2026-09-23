/* Closing and reopening a period.

   Two operations and a rule between them. The rule is that neither happens
   quietly: both write to `audit_log`, because "who reopened December, and
   when" is the first question anybody asks once a reopened month turns out to
   matter.

   Closing is refused while the trust account does not reconcile. That is the
   opinionated part of this file and it is deliberate: the whole purpose of a
   close is to say "this period is finished and correct", and a period whose
   client funds do not add up is not correct. It can be forced, because a
   manager may have a reason this application cannot see — but forcing is
   recorded as forcing, and the reconciliation that was refused is stored
   alongside it rather than discarded. */
import { all, get, one, insert, update, run, tx } from "../db.js";
import { id } from "../ids.js";
import { stamp, today, human } from "../dates.js";
import { BadRequest } from "../http.js";
import { trustReconciliation } from "./trust.js";

/* --- the snapshot ---------------------------------------------------------- */

/* The reconciliation as it read on the day, stored whole.

   A regulator does not ask what the trust account reconciles to today; they
   ask for the reconciliation as at the period end, as it was produced. Once
   anything has been posted since, those are different questions. */
export async function snapshotReconciliation(companyId, { asOf, by = "system", note = null } = {}) {
  const report = await trustReconciliation(companyId, { asOf });

  const existing = await get(
    "SELECT * FROM trust_reconciliation WHERE company_id = ? AND as_of = ?", companyId, asOf);

  if (existing?.signed_at) {
    throw new BadRequest(
      `The reconciliation for ${human(asOf)} has already been signed by ${existing.signed_by}. `
      + "A signed reconciliation is not replaced — it is the record of what was checked.");
  }

  const row = {
    company_id: companyId, as_of: asOf,
    balanced: report.balanced ? 1 : 0,
    bank_cents: report.legs.bank.cents,
    book_cents: report.legs.book.cents,
    clients_cents: report.legs.clients.cents,
    subledger_cents: report.legs.subledger.cents,
    snapshot: JSON.stringify(report),
    signed_by: by, signed_at: stamp(), note,
  };

  if (existing) {
    await update("trust_reconciliation", existing.id, row);
    return { id: existing.id, report, replaced: true };
  }

  const recId = id();
  await insert("trust_reconciliation", { id: recId, ...row, created_at: stamp() });
  return { id: recId, report, replaced: false };
}

export async function reconciliationsFor(companyId, { limit = 24 } = {}) {
  return await all(
    `SELECT id, as_of, balanced, bank_cents, book_cents, clients_cents,
            subledger_cents, signed_by, signed_at, note
       FROM trust_reconciliation WHERE company_id = ?
      ORDER BY as_of DESC LIMIT ?`, companyId, limit);
}

/* --- closing ---------------------------------------------------------------- */

export async function closePeriod(companyId, { through, by, force = false, note = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(through || ""))) {
    throw new BadRequest("A closing date is needed, as a date.");
  }
  if (through > today()) {
    /* Closing the future would refuse today's rent. */
    throw new BadRequest("The books cannot be closed through a date that has not happened yet.");
  }

  const current = await closedThroughOf(companyId);
  if (current && through <= current) {
    throw new BadRequest(
      `The books are already closed through ${human(current)}. `
      + "Closing only ever moves the line forward; to move it back, reopen.");
  }

  const report = await trustReconciliation(companyId, { asOf: through });
  if (!report.balanced && !force) {
    const worst = report.findings.find((f) => f.severity === "error") || report.findings[0];
    throw new BadRequest(
      `The trust account does not reconcile as at ${human(through)}, so this period is not `
      + `finished.${worst ? ` ${worst.title}.` : ""} Put it right first, or close it as an `
      + "exception, which records that you did.");
  }

  return await tx(async () => {
    /* Stored before the line moves, so the record of what was checked exists
       whether or not anything is posted afterwards. */
    await snapshotReconciliation(companyId, { asOf: through, by, note });
    await update("company", companyId, { books_closed_through: through });
    await insert("audit_log", {
      id: id(), company_id: companyId, at: stamp(), actor: by,
      entity: "books", entity_id: null,
      action: force && !report.balanced ? "closed_as_exception" : "closed",
      detail: JSON.stringify({
        through, balanced: report.balanced,
        forced: Boolean(force && !report.balanced),
        note: note || null,
      }),
    });
    return { through, balanced: report.balanced, forced: force && !report.balanced };
  });
}

/* Reopening needs a reason.

   Not politeness — it is the field somebody reads a year later when they are
   trying to work out why a filed month changed. A blank one makes the audit
   entry worthless, so it is refused. */
export async function reopenPeriod(companyId, { through = null, by, reason }) {
  const current = await closedThroughOf(companyId);
  if (!current) throw new BadRequest("The books are not closed, so there is nothing to reopen.");

  const why = String(reason || "").trim();
  if (why.length < 8) {
    throw new BadRequest(
      "Reopening a closed period needs a reason. It is what somebody reads later when they "
      + "are working out why a finished month changed.");
  }

  if (through && through >= current) {
    throw new BadRequest(
      `The books are closed through ${human(current)}. Reopening moves that line back, `
      + "so the new date has to be earlier than it.");
  }

  return await tx(async () => {
    await update("company", companyId, { books_closed_through: through || null });
    await insert("audit_log", {
      id: id(), company_id: companyId, at: stamp(), actor: by,
      entity: "books", entity_id: null, action: "reopened",
      detail: JSON.stringify({ from: current, to: through || null, reason: why }),
    });
    return { from: current, to: through || null };
  });
}

export async function closedThroughOf(companyId) {
  const row = await one("SELECT books_closed_through FROM company WHERE id = ?", companyId);
  return row.books_closed_through || null;
}

/* Every close and reopen, newest first. The history is the point. */
export async function closeHistory(companyId, { limit = 50 } = {}) {
  const rows = await all(
    `SELECT * FROM audit_log WHERE company_id = ? AND entity = 'books'
      ORDER BY at DESC LIMIT ?`, companyId, limit);
  return rows.map((r) => ({
    ...r,
    detail: (() => { try { return JSON.parse(r.detail); } catch { return {}; } })(),
  }));
}
