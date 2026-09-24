/* Owner statements, on the day the owner was promised one.

   `owner.statement_day` has been on the owner form since Phase 2, with a help
   text reading "Day of the month. 28 is the highest, because February." It
   was written, it was shown in the owner directory, and **nothing ever read
   it**. A manager setting "Statement day: 15" was setting a preference that
   changed nothing at all: statements were produced only when somebody opened
   the screen and asked for one.

   A field that describes a behaviour the software does not have is worse than
   a missing feature, because the missing feature is at least visible.

   ## What this does, and what it deliberately does not

   It generates. On an owner's statement day it snapshots the month that has
   just finished and files it, which is exactly what the screen does when a
   person clicks the button.

   It does not send. The manual path queues an email to the owner; this one
   does not, and `sent_at` stays null so the screen goes on reporting "not
   sent". Generating is internal and can be done again; sending a statement of
   somebody's finances to their inbox cannot be taken back, and a job that
   quietly began emailing every owner every month the day it shipped is not a
   thing to switch on without being asked. The statements are waiting on the
   screen with their links, and the existing button sends them.

   ## Never twice

   The database refuses it. `owner_statement` has a unique constraint on
   (owner_id, period_start, period_end), so a second run for a month already
   filed is rejected by Postgres rather than by a check in this file — the
   same shape as the rent charge, and for the same reason: a check-then-insert
   has a window between the two, and that window is where the duplicate lives.

   A statement that is already there is left exactly as it is. The manual
   regenerate refreshes the snapshot on purpose, because a person asked it to;
   a scheduled run silently rewriting a figure an owner has already been shown
   is a different thing entirely. */
import { all, get, insert } from "./db.js";
import { id, token } from "./ids.js";
import { stamp, monthKey, prevMonthRange, monthRange } from "./dates.js";
import { todayIn } from "./timezone.js";
import { log } from "./logger.js";

/* The day this owner's statement lands on in the month `on` falls in.

   Clamped, so 31 means the last day of the month rather than a day that does
   not exist in seven of them. The form used to stop at 28 to avoid the
   question; it asks for 1 to 31 now and this is what answers it. */
export function statementDayIn(on, statementDay) {
  const last = Number(monthRange(on).end.slice(8));
  return Math.min(Math.max(Number(statementDay) || 1, 1), last);
}

export function isStatementDay(on, statementDay) {
  return Number(on.slice(8)) === statementDayIn(on, statementDay);
}

/* Owners due a statement today, with the period it would cover. Read by the
   job and available to a screen that wants to say what is coming. */
export async function dueToday(companyId, on) {
  const owners = await all(
    "SELECT id, name, email, statement_day FROM owner WHERE company_id = ? ORDER BY name",
    companyId);
  const { start, end } = prevMonthRange(on);

  const due = [];
  for (const owner of owners) {
    if (!isStatementDay(on, owner.statement_day)) continue;
    const already = await get(
      "SELECT id FROM owner_statement WHERE owner_id = ? AND period_start = ? AND period_end = ?",
      owner.id, start, end);
    due.push({ owner, from: start, to: end, already: Boolean(already) });
  }
  return due;
}

export async function generateForCompany(company, { on = null } = {}) {
  const localToday = on || todayIn(company.timezone);
  const out = { statementsGenerated: 0, statementsSkipped: 0 };

  const { computeStatement } = await import("../features/owners.js");

  for (const row of await dueToday(company.id, localToday)) {
    if (row.already) { out.statementsSkipped += 1; continue; }

    try {
      const totals = await computeStatement(row.owner.id, row.from, row.to);
      await insert("owner_statement", {
        id: id(), company_id: company.id, owner_id: row.owner.id,
        period_start: row.from, period_end: row.to,
        totals: JSON.stringify(totals), token: token(), generated_at: stamp(),
      });
      out.statementsGenerated += 1;
    } catch (err) {
      /* The unique constraint doing its job — another tick got there first.
         Expected on an overlapping retry, and the reason the guarantee lives
         in the database. */
      if (String(err.message).includes("duplicate key")) {
        out.statementsSkipped += 1;
        continue;
      }
      /* One owner's broken data must not cost every other owner their
         statement. */
      log.error("owner statement generation failed", {
        companyId: company.id, ownerId: row.owner.id,
        reason: String(err.message).slice(0, 200),
      });
    }
  }
  return out;
}

/* Every company. Called by the scheduler. */
export async function runOwnerStatements({ on = null } = {}) {
  const out = { statementsGenerated: 0, statementsSkipped: 0 };
  for (const company of await all("SELECT id, timezone FROM company ORDER BY id")) {
    try {
      const res = await generateForCompany(company, { on });
      out.statementsGenerated += res.statementsGenerated;
      out.statementsSkipped += res.statementsSkipped;
    } catch (err) {
      log.error("owner statement run failed for a company", {
        companyId: company.id, reason: String(err.message).slice(0, 200),
      });
    }
  }
  return out;
}
