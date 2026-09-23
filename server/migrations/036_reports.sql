/* Saved reports, and sending them on a schedule.

   ## Why a schedule does not store dates

   A saved report holds the filters somebody chose, and for a one-off that is
   exactly right. A schedule cannot work that way: one storing `from
   2026-01-01, to 2026-01-31` would email January's figures every month for
   ever, and the third time it arrived nobody would notice it had stopped
   being useful — the numbers would simply have stopped changing.

   So a schedule stores a *period rule* — last month, this month, the quarter
   just gone, the year to date — and the dates are worked out when it runs.
   The saved report's other filters, a property or an account, carry over
   unchanged because those do not move with the calendar.

   ## Why recipients are staff

   A report covers a whole portfolio. Sent to an owner it would show them
   every other owner's property, which is a disclosure rather than a feature,
   and the owner-facing document already exists: a statement, scoped to one
   owner, snapshotted, on a link that can be revoked.

   So `report_schedule` sends to members of staff, who have accounts and a
   capability gate behind the link. */

CREATE TABLE saved_report (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* A key from the registry. Not a foreign key — the registry is code — so
     a report removed from the code leaves rows behind, and the screen says
     so rather than failing. */
  report_key    TEXT NOT NULL,
  name          TEXT NOT NULL,

  /* The filters, as the registry's parameters. JSON because the shape is the
     report's, and a column per possible filter would be a migration every
     time a report learns a new one. */
  params        TEXT NOT NULL DEFAULT '{}',

  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,

  UNIQUE (company_id, name)
);

CREATE INDEX saved_report_company_idx ON saved_report (company_id, report_key);

CREATE TABLE report_schedule (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  saved_report_id TEXT NOT NULL REFERENCES saved_report(id) ON DELETE CASCADE,

  /* monthly on a day of the month, or weekly on a day of the week. Two
     cadences because those are the two people actually ask for, and a cron
     expression in a text box is a support ticket. */
  cadence         TEXT NOT NULL CHECK (cadence IN ('monthly', 'weekly')),
  /* 1-28 for monthly — the 29th does not exist in every month — or 0-6 for
     weekly, Sunday first. */
  day_of          INTEGER NOT NULL,

  /* Worked out at run time, never stored as dates. */
  period          TEXT NOT NULL
                  CHECK (period IN ('last_month', 'this_month', 'last_quarter',
                                    'year_to_date', 'as_at_today')),

  /* Staff ids. Not owners: a report covers a whole portfolio, and sending one
     to an owner would show them every other owner's property. */
  recipients      TEXT NOT NULL DEFAULT '[]',

  active          INTEGER NOT NULL DEFAULT 1,

  /* When it last went out, so a tick that runs twice in a day does not send
     twice, and a process that was down for a week sends once on its return
     rather than seven times. */
  last_sent_on    TEXT,
  last_error      TEXT,

  created_by      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX report_schedule_due_idx
  ON report_schedule (company_id, active, cadence, day_of);
