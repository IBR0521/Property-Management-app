/* Charging part of a month.

   A lease that starts on the 18th does not owe a full month, and what it does
   owe is a matter of convention rather than arithmetic. US practice varies by
   state, by company and by the lease itself, so this is a company setting with
   a defensible default rather than a rule baked in.

   Three bases, because these are the ones people actually use:

     daily_actual   rent divided by the days in that calendar month, times the
                    days occupied. The default. Defensible to a tenant because
                    it is the only one where a day costs the same as any other
                    day of the same month.

     daily_30       rent divided by thirty, times the days occupied — the
                    "banker's month". Common in older leases. In a 31-day month
                    it would charge 103% of the rent for full occupancy, which
                    is why a full period is never prorated at all.

     full_month     the whole rent whatever the dates. Common on month-to-month
                    agreements, and legal in most places when the lease says so.

   **A full period is never prorated.** Somebody in the property for every day
   of the month owes the rent, and running it through a formula to arrive back
   at the same number is how a rounding error turns into a tenant dispute.

   Every result carries the basis and the day count that produced it, because
   "why is my rent $912.50 this month" is a question somebody will ask and
   "the system calculated it" is not an answer. */
import { daysBetween, monthRange } from "./dates.js";

export const PRORATION_BASES = {
  daily_actual: {
    label: "Daily, by the length of the month",
    help: "Rent ÷ days in that month × days occupied. The fairest to explain.",
  },
  daily_30: {
    label: "Daily, on a 30-day month",
    help: "Rent ÷ 30 × days occupied. A longer month is never charged more than the rent.",
  },
  full_month: {
    label: "The full month",
    help: "The whole rent whatever the dates. Usual on month-to-month agreements.",
  },
};

export const DEFAULT_BASIS = "daily_actual";

export function basisOf(value) {
  return PRORATION_BASES[value] ? value : DEFAULT_BASIS;
}

/* Inclusive day count: a tenancy running the 1st to the 30th occupies thirty
   days, not twenty-nine. Off by one here is a day's rent every time. */
const inclusiveDays = (from, to) => (to < from ? 0 : daysBetween(from, to) + 1);

/* What is owed for one lease in one period.

   `occupiedFrom` and `occupiedTo` are the lease's own dates already clamped to
   the period by the caller, or null for "the whole period". */
export function prorate({
  rentCents, basis = DEFAULT_BASIS, period,
  occupiedFrom = null, occupiedTo = null,
}) {
  const { start, end } = monthRange(`${period}-01`);
  const from = occupiedFrom && occupiedFrom > start ? occupiedFrom : start;
  const to = occupiedTo && occupiedTo < end ? occupiedTo : end;

  const daysInPeriod = inclusiveDays(start, end);
  const rent = Math.round(Number(rentCents) || 0);

  /* Nothing of this period was occupied. Not zero rent — no charge at all, and
     the caller needs to be able to tell those apart. */
  if (to < from) {
    return {
      cents: 0, days: 0, daysInPeriod, basis: basisOf(basis),
      prorated: false, charge: false,
      explain: "the lease does not cover any of this period",
    };
  }

  const days = inclusiveDays(from, to);
  const whole = days >= daysInPeriod;

  if (whole || basisOf(basis) === "full_month") {
    return {
      cents: rent, days, daysInPeriod, basis: basisOf(basis),
      prorated: false, charge: true,
      explain: whole
        ? "the whole period"
        : `${days} of ${daysInPeriod} days, charged as a full month`,
    };
  }

  const divisor = basisOf(basis) === "daily_30" ? 30 : daysInPeriod;
  /* Rounded to the cent once, at the end. Rounding a daily rate first and
     multiplying loses up to thirty cents a month, which is small, wrong, and
     exactly the sort of thing a tenant notices and nobody can explain. */
  const cents = Math.round((rent * days) / divisor);

  return {
    cents, days, daysInPeriod, basis: basisOf(basis),
    prorated: true, charge: true,
    explain: `${days} of ${divisor} days`,
  };
}

/* The window of a lease that falls inside a period, or null if none of it
   does. Move-out wins over the lease's end date: keys came back early, so the
   tenancy ended when they did. */
export function occupancyIn(lease, period) {
  const { start, end } = monthRange(`${period}-01`);
  const from = lease.start_date && lease.start_date > start ? lease.start_date : start;

  const ends = [lease.moveout_date, lease.end_date].filter(Boolean);
  const finish = ends.length ? ends.sort()[0] : null;
  const to = finish && finish < end ? finish : end;

  if (to < from) return null;
  return { from, to, startsMidPeriod: from > start, endsMidPeriod: to < end };
}
