/* Date helpers.

   Everything in this app is a calendar date, not an instant: a deposit-return
   deadline is a day, and "day 5 of being late" is a day. So dates are handled
   as ISO 'YYYY-MM-DD' strings and compared lexically, which avoids an entire
   class of timezone bug that appears when you parse them into Date objects
   and read them back in a different offset. */

export function today(now = new Date()) {
  return iso(now);
}

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function stamp(now = new Date()) {
  return now.toISOString();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/* Calendar arithmetic done in UTC so a DST boundary can never shift a day. */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const out = new Date(t);
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

export function daysBetween(fromIso, toIso) {
  const utc = (s) => {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toIso) - utc(fromIso)) / 86400000);
}

export function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

/* First and last day of the month containing isoDate. */
export function monthRange(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  const start = `${y}-${pad(m)}-01`;
  const end = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`, -1);
  return { start, end };
}

export function prevMonthRange(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return monthRange(m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`);
}

/* Rent is due on rent_due_day, clamped for short months: a lease due on the
   31st is due on the 30th in April and the 28th in February. */
export function dueDateFor(period, dueDay) {
  const [y, m] = period.split("-").map(Number);
  const last = Number(addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`, -1).slice(8));
  return `${y}-${pad(m)}-${pad(Math.min(dueDay, last))}`;
}

/* How a rent day reads to a person.

   31 is the last day of the month and nothing else: `dueDateFor` clamps it to
   28, 29, 30 or 31 depending on the month, so a lease set to 31 falls due on
   the last day every time. Saying "the 31st" would be wrong in eleven months
   of the year, so it does not.

   29 and 30 are left as themselves. They are genuinely the 29th and the 30th
   and only bend in February, which is the ordinary behaviour of a date and
   not worth a special phrase. */
export function rentDayLabel(dueDay) {
  const n = Number(dueDay) || 1;
  if (n >= 31) return "the last day of the month";
  const s = ["th", "st", "nd", "rd"][((n % 100) - 20) % 10]
    || ["th", "st", "nd", "rd"][n % 100] || "th";
  return `the ${n}${s}`;
}

export function human(isoDate) {
  if (!isoDate) return "—";
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${names[m - 1]} ${y}`;
}

export function humanStamp(isoStamp) {
  if (!isoStamp) return "—";
  const d = new Date(isoStamp);
  return `${human(iso(d))}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
