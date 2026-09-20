/* Nav badge counts, matched to the four destinations.

   Only things a person has to act on are counted. A badge showing a total
   nobody needs to do anything about is noise, and noise is what made the
   previous nine-item navigation unreadable. */
import { get } from "./db.js";
import { buildQueue } from "./queue.js";

export async function navCounts(companyId) {
  const n = async (sql, ...p) => (await get(sql, ...p)).n;
  const items = await buildQueue(companyId);
  const urgent = items.filter((i) => i.rank <= 1).length;

  const lateRent = n(
    `SELECT COUNT(*) n FROM delinquency WHERE company_id = ? AND status IN ('open','attorney')`, companyId);
  const overdue = n(
    `SELECT COUNT(*) n FROM obligation WHERE company_id = ? AND status = 'overdue'`, companyId);
  const approvals = n(
    `SELECT COUNT(*) n FROM owner_approval WHERE company_id = ? AND status = 'pending'`, companyId);
  const apps = n(
    `SELECT COUNT(*) n FROM application WHERE company_id = ? AND status IN ('received','incomplete','screening')`, companyId);

  return {
    queue: { n: items.length, tone: urgent ? "danger" : items.length ? "warn" : null },
    properties: { n: lateRent + overdue, tone: overdue ? "danger" : lateRent ? "warn" : null },
    people: { n: approvals + apps, tone: approvals ? "warn" : null },
    _raw: { urgent, total: items.length, lateRent, overdue, approvals, apps },
  };
}
