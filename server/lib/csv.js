/* CSV, written once.

   There was a `csvCell` inside checks.js doing the positive-pay file and
   nothing else. This is that, generalised, with the two things it was missing.

   ## Quoting

   RFC 4180: a field is quoted if it contains a comma, a quote or a line
   break, and an internal quote is doubled. The old one did not check for line
   breaks, which is how a tenant's two-line address turns a thirty-row export
   into a thirty-two row one and nobody can see why.

   ## Formula injection, which is the part that matters

   A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`, tab or carriage
   return as a formula, and will execute it on open. Everything exported from
   this application has passed through a text field somebody else controls — a
   tenant's name, a repair description, a memo on a payment. `=HYPERLINK(...)`
   in a maintenance note becomes a live link in the manager's spreadsheet, and
   the old DDE forms can do a great deal worse than that.

   So a risky cell is prefixed with an apostrophe, which is how a spreadsheet
   itself marks a literal. **Except when it is a number**: `-1450.00` begins
   with a minus and is not an attack, and quoting it would turn every negative
   figure in the export into text that will not sum. That exception is the
   whole reason this needs a test rather than a one-liner. */

const RISKY = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

export const CSV_TYPE = "text/csv; charset=utf-8";

/* Excel reads a UTF-8 file as the local codepage unless it finds a byte order
   mark, so a tenant called Nuñez arrives as NuÃ±ez. The mark is three bytes
   and every other reader tolerates it. */
export const BOM = "﻿";

export function csvCell(value) {
  if (value == null) return "";
  const raw = String(value);
  const safe = RISKY.test(raw) && !NUMERIC.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(values) {
  return values.map(csvCell).join(",");
}

/* Money as a decimal number, not as "$1,234.56".

   The point of an export is that somebody sums the column. A currency symbol
   and a thousands separator make that impossible, and the person opening it
   already knows what currency their own portfolio is in. */
export const csvMoney = (cents) =>
  cents == null ? "" : (Number(cents) / 100).toFixed(2);

/* columns: [{ key, label, money?, map? }] */
export function toCsv({ columns, rows, totals = null }) {
  const lines = [csvRow(columns.map((c) => c.label))];

  for (const row of rows) {
    lines.push(csvRow(columns.map((c) => cellOf(c, row))));
  }

  if (totals) {
    /* A blank line before it, so a reader sorting the data range does not
       drag the totals row into the middle of it. */
    lines.push("");
    lines.push(csvRow(columns.map((c) => cellOf(c, totals))));
  }

  return BOM + lines.join("\r\n") + "\r\n";
}

function cellOf(column, row) {
  const raw = column.map ? column.map(row) : row[column.key];
  return column.money ? csvMoney(raw) : raw;
}

/* A filename somebody can find again in a downloads folder six weeks later. */
export function csvFileName({ companyName, report, from = null, to = null }) {
  const period = from && to ? `-${from}-to-${to}` : to ? `-as-at-${to}` : "";
  return `${slug(companyName, 30)}-${slug(report)}${period}.csv`;
}

/* Trimmed after truncating, not before: cutting a long company name at thirty
   characters lands on a hyphen as often as not, and "leafridge-property-
   management--rent-roll" is the sort of thing nobody notices until it is in
   every filename a customer has downloaded. */
export function slug(value, limit = null) {
  const s = String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (limit ? s.slice(0, limit) : s).replace(/-+$/, "");
}
