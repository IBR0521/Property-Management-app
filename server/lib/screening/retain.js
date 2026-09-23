/* Deleting screening reports when they have outlived their use.

   A tenant screening report holds somebody's credit file, their addresses and
   possibly their criminal history. It is the most sensitive thing this
   database would ever hold, and short retention is worth more than any amount
   of care elsewhere: the report that is not there cannot leak.

   ## What goes and what stays

   **Goes:** the report file, and the note of where it was stored.

   **Stays, for ever:** that screening happened, when, against which consent,
   what the person who read it wrote down, the decision and its reason, and
   the adverse action notice. Those are the compliance trail. A company that
   deletes them cannot defend a decision later, and an applicant who disputes
   one has nothing to dispute against.

   The summary stays too, and that is deliberate — it is a person's own words
   about what they read, not a copy of the consumer report. Deleting it would
   leave a decision with no visible basis, which helps nobody.

   ## Counted from the decision, not from the report

   An application still being decided needs its report. The clock starts when
   the decision does, and an application that is never decided keeps its
   report until it is — which is a thing worth seeing on a screen rather than
   a thing to quietly clean up. */
import { all, get, run } from "../db.js";
import { stamp } from "../dates.js";
import { screeningSettings } from "./settings.js";

/* Deletes what is due across every company, oldest first.

   `removeFile` is injectable so a test can assert the file was asked for
   without a filesystem, and so a blob store can be swept the same way a disk
   is. */
export async function sweepScreeningReports({
  now = () => new Date(), removeFile = defaultRemove, limit = 500,
} = {}) {
  const companies = await all("SELECT id FROM company");
  const out = { screeningReportsDeleted: 0, screeningReportsFailed: 0 };

  for (const company of companies) {
    const { retentionDays } = await screeningSettings(company.id);
    const cutoff = new Date(now().getTime() - retentionDays * 86400_000).toISOString();

    const due = await all(
      `SELECT r.* FROM screening_request r
         JOIN application a ON a.id = r.application_id
        WHERE r.company_id = ?
          AND r.report_path IS NOT NULL
          AND r.deleted_at IS NULL
          AND a.decided_at IS NOT NULL
          AND a.decided_at < ?
        ORDER BY a.decided_at
        LIMIT ${Number(limit)}`, company.id, cutoff);

    for (const request of due) {
      try {
        await removeFile(request.report_path);
      } catch (err) {
        /* A file that cannot be removed must not be marked as removed — the
           whole value of this is that "deleted" means deleted. */
        out.screeningReportsFailed += 1;
        console.error("[screening] could not delete a report:", err.message);
        continue;
      }
      await run(
        `UPDATE screening_request
            SET report_path = NULL, report_mime = NULL, report_bytes = NULL,
                deleted_at = ?, deleted_why = ?
          WHERE id = ?`,
        stamp(),
        `Deleted ${retentionDays} days after the decision, under this company's retention rule.`,
        request.id);
      out.screeningReportsDeleted += 1;
    }
  }

  return out;
}

/* Deleting one on purpose — an applicant asking, or a manager deciding it is
   not needed any more. Same effect, a different reason recorded. */
export async function deleteReport({ requestId, companyId, why, by }) {
  const request = await get(
    "SELECT * FROM screening_request WHERE id = ? AND company_id = ?", requestId, companyId);
  if (!request || !request.report_path) return null;

  await defaultRemove(request.report_path);
  await run(
    `UPDATE screening_request
        SET report_path = NULL, report_mime = NULL, report_bytes = NULL,
            deleted_at = ?, deleted_why = ?
      WHERE id = ?`,
    stamp(), `${why || "Deleted by hand"}${by ? ` — ${by}` : ""}`, requestId);

  return await get("SELECT * FROM screening_request WHERE id = ?", requestId);
}

/* Local disk or the blob store, whichever this instance uses. A file that is
   already gone is not an error: the point was that it should not be there. */
async function defaultRemove(stored) {
  if (!stored) return;

  if (/^https?:\/\//.test(stored)) {
    const { BLOB_READ_WRITE_TOKEN } = await import("../config.js");
    if (!BLOB_READ_WRITE_TOKEN) {
      throw new Error("the blob store is not configured, so this file cannot be deleted");
    }
    const { del } = await import("@vercel/blob");
    await del(stored, { token: BLOB_READ_WRITE_TOKEN });
    return;
  }

  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { UPLOAD_DIR } = await import("../files.js");
  if (stored.includes("..") || stored.startsWith("/")) {
    throw new Error("that is not a path this application wrote");
  }
  await rm(join(UPLOAD_DIR, stored), { force: true });
}
