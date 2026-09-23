/* Ordering a screening report, and recording what came back.

   With the manual provider this is bookkeeping around something that happens
   somewhere else: the manager sends the applicant to their agency, the
   applicant pays the agency, the report comes back to the manager, and what
   is recorded here is that it happened, what the person read, and — while it
   is kept — the report itself.

   ## No consent, no request

   Checked here and enforced by a NOT NULL on the column, because the version
   that cannot be forgotten is the one in the database.

   ## The summary is prose, on purpose

   What the person who read the report writes down is a sentence, not a
   figure. A `score` column would be a field something could sort on, and the
   day it can be sorted on it can be thresholded on, and then the decision is
   not being made by a person any more. */
import { all, get, one, insert, run, tx } from "../db.js";
import { id } from "../ids.js";
import { stamp } from "../dates.js";
import { activeConsent, intact, ConsentRefused } from "./consent.js";

export class ScreeningRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ScreeningRefused";
  }
}

export async function orderScreening({
  companyId, application, providerKey, by, reference = null, now = stamp,
}) {
  const consent = await activeConsent(application.id);
  if (!consent) {
    throw new ScreeningRefused(
      "This applicant has not consented to being screened. Send them the consent link "
      + "first — nothing may be ordered without it.");
  }
  if (!intact(consent)) {
    throw new ScreeningRefused(
      "The consent record on this application does not match its own hash, which means "
      + "it has been altered. Do not screen against it; ask for consent again.");
  }

  const requestId = id();
  const at = now();

  await tx(async () => {
    await insert("screening_request", {
      id: requestId, company_id: companyId, application_id: application.id,
      consent_id: consent.id, provider: providerKey,
      status: "ordered", reference: String(reference || "").trim() || null,
      ordered_by: by, ordered_at: at,
    });
    if (application.status === "received") {
      await run("UPDATE application SET status = 'screening' WHERE id = ?", application.id);
    }
  });

  return await one("SELECT * FROM screening_request WHERE id = ?", requestId);
}

/* What came back. `summary` is what the person read, in their words; the file
   is optional because plenty of agencies show a report on screen and never
   give you one to keep. */
export async function recordReport({
  requestId, companyId, summary, file = null, reference = null, by, now = stamp,
}) {
  const request = await one(
    "SELECT * FROM screening_request WHERE id = ? AND company_id = ?", requestId, companyId);
  if (request.status === "cancelled") {
    throw new ScreeningRefused("That screening was cancelled. Order another one.");
  }

  const words = String(summary || "").trim();
  if (words.length < 10) {
    throw new ScreeningRefused(
      "Write down what the report said, in your own words. A record that says only "
      + "“received” is no use to anybody reading this decision later.");
  }

  await run(
    `UPDATE screening_request
        SET status = 'received', summary = ?, received_at = ?,
            reference = COALESCE(?, reference),
            report_path = COALESCE(?, report_path),
            report_mime = COALESCE(?, report_mime),
            report_bytes = COALESCE(?, report_bytes)
      WHERE id = ?`,
    words, now(), String(reference || "").trim() || null,
    file?.path || null, file?.mime || null, file?.bytes || null, requestId);

  return await one("SELECT * FROM screening_request WHERE id = ?", requestId);
}

export async function cancelScreening({ requestId, companyId }) {
  const request = await one(
    "SELECT * FROM screening_request WHERE id = ? AND company_id = ?", requestId, companyId);
  if (request.status === "received") {
    throw new ScreeningRefused(
      "A report has already been received against this. Cancelling it would hide that "
      + "somebody's file was looked at.");
  }
  await run("UPDATE screening_request SET status = 'cancelled' WHERE id = ?", requestId);
  return await one("SELECT * FROM screening_request WHERE id = ?", requestId);
}

export async function screeningFor(applicationId) {
  return await all(
    "SELECT * FROM screening_request WHERE application_id = ? ORDER BY ordered_at DESC",
    applicationId);
}

export { ConsentRefused };
