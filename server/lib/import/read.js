/* Reading the values inside the cells.

   `banking.js` has readers of its own for a pasted bank statement, and these
   are deliberately not those. The duplication is about thirty lines and it is
   the safer trade: the payment reconciliation path works, nothing tests its
   readers directly, and refactoring it in the middle of a different phase
   would be changing a working thing with no net under it. These are tested
   here, and if the two ever need to agree, that is the moment to merge them
   rather than now.

   What they have in common is the rule: **a value that cannot be read is
   null, never a guess.** The caller decides whether null is an error. Nothing
   here returns zero for an unparseable amount, because zero is a number
   somebody will believe. */

/* ISO passes through. The ambiguous slash forms are read US-style, because a
   US property management export means US dates — and a file that means
   otherwise will fail loudly on the first day over the twelfth rather than
   quietly for eleven days a month. */
export function readDate(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isReal(s) ? s : null;

  const slash = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (slash) {
    const [, month, day, y] = slash;
    /* A two-digit year is this century. A lease starting in 1998 is not
       something these files contain, and "28" meaning 1928 would be worse
       than refusing it. */
    const year = y.length === 2 ? `20${y}` : y;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isReal(iso) ? iso : null;
  }

  /* A timestamp, which exports produce as often as a date. */
  const stamped = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  if (stamped) return isReal(stamped[1]) ? stamped[1] : null;

  return null;
}

/* 2026-02-30 parses and is not a date. Round-tripping it through Date is the
   cheapest way to find out. */
function isReal(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? iso : null;
}

/* Money as cents.

   Parentheses are how an accounting export writes a negative and they are
   respected here — unlike `parseMoney`, which is used by forms where somebody
   typing "(250)" into a rent box means something went wrong rather than minus
   two hundred and fifty. */
export function readMoney(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }

  s = s.replace(/[$£€,\s]/g, "");
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;

  const cents = Math.round(parseFloat(s) * 100);
  return negative ? -cents : cents;
}

export function readInt(value) {
  const s = String(value ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/* Bedrooms and bathrooms arrive as "2", "2.0" and "2.5". Kept as a number
   because half a bathroom is a real thing and the column is numeric. */
export function readDecimal(value) {
  const s = String(value ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s);
}

/* One of a fixed set, matched loosely, or null. The database has CHECK
   constraints on every one of these, so a value that does not map has to be
   refused here rather than at the insert. */
export function readOneOf(value, allowed, synonyms = {}) {
  const s = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return null;
  const mapped = synonyms[s] || s;
  return allowed.find((a) => a.replace(/[\s_-]+/g, "") === mapped) || null;
}

/* Several ids or names in one cell. Every export that puts two tenants on a
   lease separates them differently. */
export function readList(value) {
  const s = String(value ?? "").trim();
  if (!s) return [];
  return s.split(/[;|]|,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
}
