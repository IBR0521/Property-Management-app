/* Money is integer cents everywhere. These are the only two places it becomes
   a string, so rounding never drifts. */

export function usd(cents, { sign = false } = {}) {
  if (cents == null) return "—";
  const neg = cents < 0;
  const v = Math.abs(cents);
  const s = `$${Math.floor(v / 100).toLocaleString("en-US")}.${String(v % 100).padStart(2, "0")}`;
  if (neg) return `-${s}`;
  return sign ? `+${s}` : s;
}

/* Accepts "1,250", "1250.00", "$1,250.50" — anything an operator types in a
   hurry — and returns cents, or null if it is not a number at all. */
export function parseMoney(input) {
  if (input == null || input === "") return null;
  const cleaned = String(input).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}
