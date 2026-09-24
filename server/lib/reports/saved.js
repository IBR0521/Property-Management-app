/* Saved reports, and sending them on a schedule.

   ## A schedule does not store dates

   A saved report holds the filters somebody chose, which for a one-off is
   exactly right. A schedule cannot work that way: one holding `from
   2026-01-01, to 2026-01-31` would email January's figures every month for
   ever, and the third time it arrived nobody would notice — the numbers would
   simply have stopped changing.

   So a schedule stores a period *rule* and the dates are worked out when it
   runs. The other filters — a property, an account — carry over unchanged,
   because those do not move with the calendar.

   ## It sends a link, not the file

   An emailed PDF of somebody's finances sits in an inbox for ever and gets
   forwarded. A link goes through the capability gate every time it is opened,
   shows the figures as they are rather than as they were, and stops working
   the moment somebody's account does.

   ## Recipients are staff

   A report covers a portfolio. Sent to an owner it would show them every
   other owner's property, which is a disclosure rather than a feature — and
   the owner-facing document already exists, scoped to one owner, snapshotted,
   on a link that can be revoked. */
import { all, get, one, insert, update, run } from "../db.js";
import { id } from "../ids.js";
import { stamp, today, addDays, monthKey, monthRange, prevMonthRange, human } from "../dates.js";
import { log } from "../logger.js";
import { BadRequest } from "../http.js";
import { reportDefinition, paramsFor, REPORTS } from "./index.js";

/* --- period rules ------------------------------------------------------------ */

export const PERIODS = {
  last_month: {
    label: "Last month",
    help: "The month that has just finished. The usual one.",
    resolve: (on) => {
      const { start, end } = prevMonthRange(on);
      return { from: start, to: end, asOf: end };
    },
  },
  this_month: {
    label: "This month so far",
    resolve: (on) => ({ from: monthRange(on).start, to: on, asOf: on }),
  },
  last_quarter: {
    label: "The quarter just gone",
    resolve: (on) => {
      const [y, m] = on.split("-").map(Number);
      /* The quarter containing the previous month, so a run on 1 April
         reports January to March rather than an empty April. */
      const q = Math.floor(((m - 2 + 12) % 12) / 3);
      const year = m === 1 ? y - 1 : y;
      const startMonth = q * 3 + 1;
      const from = `${year}-${String(startMonth).padStart(2, "0")}-01`;
      const to = monthRange(`${year}-${String(startMonth + 2).padStart(2, "0")}-01`).end;
      return { from, to, asOf: to };
    },
  },
  year_to_date: {
    label: "Year to date",
    resolve: (on) => ({ from: `${on.slice(0, 4)}-01-01`, to: on, asOf: on }),
  },
  as_at_today: {
    label: "As at the day it runs",
    help: "For a report that is a position rather than a period.",
    resolve: (on) => ({ from: null, to: on, asOf: on }),
  },
};

export function resolvePeriod(period, on = today()) {
  const rule = PERIODS[period];
  if (!rule) throw new BadRequest(`"${period}" is not a period this can work out.`);
  return rule.resolve(on);
}

/* --- saving ------------------------------------------------------------------- */

export async function saveReport({ companyId, reportKey, name, params = {}, by = null }) {
  const report = reportDefinition(reportKey);
  const clean = String(name || "").trim();
  if (!clean) throw new BadRequest("Give the saved report a name you will recognise.");

  /* Only the parameters this report actually takes. Anything else is dropped
     rather than stored, so a report that later loses a filter does not carry
     a stale one around for ever. */
  const kept = {};
  for (const key of report.params) {
    if (params[key] != null && params[key] !== "") kept[key] = String(params[key]);
  }

  const existing = await get(
    "SELECT * FROM saved_report WHERE company_id = ? AND name = ?", companyId, clean);

  if (existing) {
    await update("saved_report", existing.id, {
      report_key: reportKey, params: JSON.stringify(kept), updated_at: stamp(),
    });
    return { id: existing.id, replaced: true };
  }

  const savedId = id();
  await insert("saved_report", {
    id: savedId, company_id: companyId, report_key: reportKey, name: clean,
    params: JSON.stringify(kept), created_by: by, created_at: stamp(),
  });
  return { id: savedId, replaced: false };
}

export async function savedReports(companyId) {
  const rows = await all(
    "SELECT * FROM saved_report WHERE company_id = ? ORDER BY name", companyId);
  return rows.map(decorate);
}

export async function savedReport(companyId, savedId) {
  return decorate(await one(
    "SELECT * FROM saved_report WHERE id = ? AND company_id = ?", savedId, companyId));
}

function decorate(row) {
  const params = (() => { try { return JSON.parse(row.params); } catch { return {}; } })();
  /* A report removed from the code leaves its saved rows behind. The screen
     says so rather than throwing, because deleting somebody's saved filters
     on a deploy would be worse than showing them a row that no longer
     works. */
  const known = Boolean(REPORTS[row.report_key]);
  return {
    ...row, params, known,
    title: known ? REPORTS[row.report_key].title : row.report_key,
    need: known ? REPORTS[row.report_key].need : null,
  };
}

export async function deleteSavedReport(companyId, savedId) {
  const r = await run(
    "DELETE FROM saved_report WHERE id = ? AND company_id = ?", savedId, companyId);
  return r.changes;
}

/* --- scheduling ---------------------------------------------------------------- */

export async function scheduleReport({
  companyId, savedReportId, cadence, dayOf, period, recipients, by = null,
}) {
  const saved = await savedReport(companyId, savedReportId);
  if (!saved.known) {
    throw new BadRequest("That saved report points at a report this application no longer has.");
  }
  if (!PERIODS[period]) throw new BadRequest("Choose a period for the schedule.");

  const day = Number(dayOf);
  if (cadence === "monthly" && !(day >= 1 && day <= 31)) {
    /* It used to stop at 28, because a schedule that skips February is one
       nobody debugs until March — and with `isDue` comparing the day exactly,
       skipping is what would have happened. `isDue` clamps now, so the 31st
       means the last day of the month and February is not skipped. */
    throw new BadRequest("Pick a day from 1 to 31.");
  }
  if (cadence === "weekly" && !(day >= 0 && day <= 6)) {
    throw new BadRequest("Pick a day of the week.");
  }

  const ids = [...new Set((recipients || []).map(String).filter(Boolean))];
  if (!ids.length) throw new BadRequest("Choose at least one person to send it to.");

  /* Staff of this company, active, and holding the capability the report
     needs. A schedule that emails somebody a link they cannot open is worse
     than no schedule: it looks like it is working. */
  const people = await all(
    "SELECT id, name, email, role, active FROM staff WHERE company_id = ? AND id = ANY(?::text[])",
    companyId, ids);

  const { can } = await import("../auth.js");
  for (const person of people) {
    if (!person.active) throw new BadRequest(`${person.name}'s account is not active.`);
    if (saved.need && !can(person, saved.need)) {
      throw new BadRequest(
        `${person.name} cannot open the ${saved.title.toLowerCase()}, so there is no point sending it to them.`);
    }
  }
  if (people.length !== ids.length) {
    throw new BadRequest("One of those people is not on this company's staff.");
  }

  const scheduleId = id();
  await insert("report_schedule", {
    id: scheduleId, company_id: companyId, saved_report_id: savedReportId,
    cadence, day_of: day, period,
    recipients: JSON.stringify(people.map((p) => p.id)),
    created_by: by, created_at: stamp(),
  });
  return { id: scheduleId };
}

export async function schedulesFor(companyId) {
  const rows = await all(
    `SELECT s.*, r.name AS report_name, r.report_key
       FROM report_schedule s JOIN saved_report r ON r.id = s.saved_report_id
      WHERE s.company_id = ? ORDER BY r.name`, companyId);
  return rows.map((r) => ({
    ...r,
    recipients: (() => { try { return JSON.parse(r.recipients); } catch { return []; } })(),
    periodLabel: PERIODS[r.period]?.label || r.period,
  }));
}

export async function setScheduleActive(companyId, scheduleId, active) {
  await run("UPDATE report_schedule SET active = ? WHERE id = ? AND company_id = ?",
    active ? 1 : 0, scheduleId, companyId);
}

export async function deleteSchedule(companyId, scheduleId) {
  const r = await run(
    "DELETE FROM report_schedule WHERE id = ? AND company_id = ?", scheduleId, companyId);
  return r.changes;
}

/* --- sending ------------------------------------------------------------------- */

/* Whether a schedule is due on a given day.

   `last_sent_on` is the whole guarantee, and it is a date rather than a
   timestamp on purpose: the question is "has this gone out today", and a tick
   running every ten minutes must answer it the same way each time. A process
   that was down for a week sends once on its return, not seven times. */
export function isDue(schedule, on = today()) {
  if (!schedule.active) return false;
  if (schedule.last_sent_on === on) return false;

  const date = new Date(`${on}T00:00:00Z`);
  if (schedule.cadence === "monthly") {
    /* Clamped to the length of the month, so a schedule set to the 31st runs
       on the 28th in February and the 30th in April rather than skipping
       those months entirely. Exact equality was the reason the day could not
       go past 28: `getUTCDate()` never returns 31 in February, so the run
       was silently missed in five months of the year. Comparing against the
       clamped day is what lets the last day of the month be chosen at all. */
    return date.getUTCDate() === dayInMonth(on, Number(schedule.day_of));
  }
  return date.getUTCDay() === Number(schedule.day_of);
}

/* The day this schedule lands on in the month `on` falls in. */
function dayInMonth(on, dayOf) {
  const last = Number(monthRange(on).end.slice(8));
  return Math.min(Math.max(dayOf, 1), last);
}

export async function runReportSchedules({ on = today(), baseUrl = null } = {}) {
  const due = await all(
    `SELECT s.*, r.name AS report_name, r.report_key, r.params AS report_params, c.timezone
       FROM report_schedule s
       JOIN saved_report r ON r.id = s.saved_report_id
       JOIN company c ON c.id = s.company_id
      WHERE s.active = 1`);

  let sent = 0, skipped = 0;

  for (const schedule of due) {
    const { todayIn } = await import("../timezone.js");
    /* The company's day, not the server's. A schedule set for the first of
       the month must fire on their first. */
    const localToday = on || todayIn(schedule.timezone);
    if (!isDue(schedule, localToday)) { skipped += 1; continue; }

    try {
      await sendSchedule(schedule, localToday, baseUrl);
      await run("UPDATE report_schedule SET last_sent_on = ?, last_error = NULL WHERE id = ?",
        localToday, schedule.id);
      sent += 1;
    } catch (err) {
      /* One broken schedule must not stop the others. Recorded on the row so
         a person can see why theirs stopped arriving. */
      await run("UPDATE report_schedule SET last_error = ? WHERE id = ?",
        String(err.message).slice(0, 200), schedule.id);
      log.error("a report schedule failed", {
        scheduleId: schedule.id, reason: String(err.message).slice(0, 160),
      });
    }
  }

  return { reportsScheduled: sent, reportSchedulesSkipped: skipped };
}

async function sendSchedule(schedule, on, baseUrl) {
  const saved = (() => { try { return JSON.parse(schedule.report_params); } catch { return {}; } })();
  const resolved = resolvePeriod(schedule.period, on);
  const report = reportDefinition(schedule.report_key);

  /* The period rule wins over anything saved, and the saved filters that are
     not dates carry over. A schedule is the report for *this* period. */
  const params = { ...saved };
  for (const name of report.params) {
    if (name === "from") params.from = resolved.from;
    if (name === "to") params.to = resolved.to;
    if (name === "asOf") params.asOf = resolved.asOf;
  }

  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const link = `${baseUrl || ""}/app/reports/${schedule.report_key}?${query}`;

  const recipients = JSON.parse(schedule.recipients || "[]");
  const people = await all(
    "SELECT id, name, email FROM staff WHERE id = ANY(?::text[]) AND active = 1", recipients);

  const period = resolved.from
    ? `${human(resolved.from)} to ${human(resolved.to)}`
    : `as at ${human(resolved.asOf)}`;

  for (const person of people) {
    if (!person.email) continue;
    await insert("outbox", {
      id: id(), company_id: schedule.company_id, channel: "email",
      to_contact: person.email,
      subject: `${schedule.report_name} — ${period}`,
      /* A link, never the file. An emailed PDF of somebody's finances sits in
         an inbox for ever and gets forwarded; a link goes through the
         capability gate every time it is opened and stops working when their
         account does. */
      body: `${report.title} for ${period}.\n\n${link}\n\n`
        + "This is a link rather than an attachment: it opens the live report, "
        + "and it only works while you are signed in.",
      about_type: "report_schedule", about_id: schedule.id,
      status: "queued", queued_at: stamp(),
    });
  }
}
