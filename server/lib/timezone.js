/* Company-local calendar maths.

   `company.timezone` has been on the table since migration 001 and nothing has
   ever read it. Every date in this app is computed in whatever zone the server
   happens to run in — which was fine when the server was a laptop in the same
   city as the buildings, and is not fine on a platform whose function region
   is Oregon and whose customers are in Columbus and London.

   It matters in exactly one way, and it matters a lot: **rent is due on a
   calendar date where the building is.** A sweep that runs at 09:00 UTC runs
   at 04:00 in Columbus. On the first of the month that is still the previous
   day locally, so a lease due on the 1st with no grace would be marked late
   before it was due — or, at the other end of the year with the offset the
   other way, a day late.

   Intl.DateTimeFormat does the work. It ships with Node, knows the tz
   database, and handles daylight saving, which is the part nobody gets right
   by hand. */

/* The zones a US-and-Europe property manager actually picks from. Not the full
   list, because a dropdown of six hundred entries is a worse experience than a
   short one plus a request. */
export const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Australia/Sydney",
  "UTC",
];

export function isValidZone(zone) {
  const z = String(zone || "");
  if (!z) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function safeZone(zone) {
  return isValidZone(zone) ? String(zone) : "UTC";
}

/* Today's date in a company's own zone, as YYYY-MM-DD.

   `en-CA` because its short date format is already ISO order, which avoids
   parsing a localised string back apart. */
export function todayIn(zone, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(zone),
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/* Minutes past local midnight, for business-hours decisions. */
export function minutesIn(zone, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone(zone),
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

/* For showing somebody what time it is where their buildings are, so the
   setting is verifiable rather than a guess. */
export function nowInZone(zone, at = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone(zone),
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(at);
}

export function withinBusinessHours(company, at = new Date()) {
  const minutes = minutesIn(company?.timezone, at);
  const open = Number(company?.business_open_minute ?? 540);
  const close = Number(company?.business_close_minute ?? 1020);
  return minutes >= open && minutes < close;
}

/* The offset a zone is at on a given instant, as a signed minute count.
   Daylight saving means this is a question about a moment, not about a zone. */
export function offsetMinutes(zone, at = new Date()) {
  const tz = safeZone(zone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const read = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    read("year"), read("month") - 1, read("day"),
    read("hour") % 24, read("minute"), read("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}
