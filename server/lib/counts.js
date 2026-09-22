/* Nav badge counts.

   These run on every single page, so they are counts and nothing else. This
   used to call buildQueue() — which assembles the whole work queue, with all
   its joins — purely to read two numbers off the end of it. On SQLite that was
   invisible. Against a network database it doubled the query load of every
   page in the app.

   Eight COUNTs, issued concurrently, in one round trip's worth of time. */
import { get } from "./db.js";
import { today } from "./dates.js";

export async function navCounts(companyId) {
  const n = async (sql, ...p) => Number((await get(sql, ...p)).n || 0);

  const [emergencies, unassigned, blocked, overdue, approvals, lateRent, lateTurns, apps, unreadMail] =
    await Promise.all([
      n(`SELECT COUNT(*) n FROM work_order WHERE company_id = ? AND severity = 'emergency'
           AND status NOT IN ('complete','cancelled')`, companyId),
      n(`SELECT COUNT(*) n FROM work_order WHERE company_id = ? AND severity != 'emergency'
           AND status IN ('new','triaged')`, companyId),
      n(`SELECT COUNT(DISTINCT subject) n FROM (
           SELECT subject FROM outbox WHERE company_id = ? AND about_type = 'notice_blocked'
             AND status = 'queued') q`, companyId),
      n(`SELECT COUNT(*) n FROM obligation WHERE company_id = ? AND status = 'overdue'`, companyId),
      n(`SELECT COUNT(*) n FROM owner_approval WHERE company_id = ? AND status = 'pending'`, companyId),
      n(`SELECT COUNT(*) n FROM delinquency WHERE company_id = ? AND status IN ('open','attorney')`, companyId),
      n(`SELECT COUNT(*) n FROM turn WHERE company_id = ? AND status = 'open'
           AND target_ready_date IS NOT NULL AND target_ready_date < ?`, companyId, today()),
      n(`SELECT COUNT(*) n FROM application WHERE company_id = ?
           AND status IN ('received','incomplete','screening')`, companyId),
      /* Conversations nobody has opened. Somebody wrote to this company and
         is waiting, which belongs on the same footing as an unassigned job. */
      n(`SELECT COUNT(*) n FROM thread WHERE company_id = ? AND unread = 1
           AND state <> 'resolved'`, companyId),
    ]);

  // Ranks 0 and 1 are the things that need a person today; the badge on Queue
  // turns red for those and amber for the rest.
  const urgent = emergencies + approvals + overdue + unassigned + blocked;
  const total = urgent + lateRent + lateTurns + apps;

  return {
    queue: { n: total, tone: urgent ? "danger" : total ? "warn" : null },
    inbox: { n: unreadMail, tone: unreadMail ? "warn" : null },
    properties: { n: lateRent + overdue, tone: overdue ? "danger" : lateRent ? "warn" : null },
    people: { n: approvals + apps, tone: approvals ? "warn" : null },
    _raw: { urgent, total, emergencies, unassigned, overdue, approvals, lateRent, apps },
  };
}
