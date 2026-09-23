/* Reading CSV, which is a harder problem than writing it.

   Writing, this application controls: it quotes what needs quoting and emits
   CRLF. Reading, it controls nothing. A file arrives from somebody else's
   export, somebody's spreadsheet, or somebody's hand, and it will contain at
   least one of: a byte order mark, CRLF or LF or a mixture, quoted fields with
   embedded newlines, doubled quotes, a trailing blank line, a header row in a
   different case, and a column somebody renamed.

   ## What it refuses to guess

   A header it cannot place is reported, never skipped. A row with the wrong
   number of cells is reported, never padded. The whole point of an import is
   that somebody can trust what came out the other end, and a parser that
   quietly fixes things is a parser that quietly loses them.

   ## Why not a dependency

   The same reason as the rest of this codebase: the surface actually needed is
   a hundred lines that can be read, against a dependency tree that cannot. */

/* The byte order mark. Excel writes one; every parser that does not strip it
   ends up with a first column called "﻿Name" that matches nothing. */
const BOM = "﻿";

export function parseCsv(text, { delimiter = null } = {}) {
  const body = String(text ?? "").replace(/^﻿/, "");
  if (!body.trim()) return { rows: [], delimiter: delimiter || "," };

  const sep = delimiter || sniffDelimiter(body);

  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let started = false;   // has this cell begun, so a quote mid-cell is literal

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; continue; }
        quoted = false;
        continue;
      }
      cell += c;
      continue;
    }

    if (c === '"' && !started) { quoted = true; started = true; continue; }

    if (c === sep) { row.push(cell); cell = ""; started = false; continue; }

    if (c === "\r" || c === "\n") {
      /* CRLF, LF and a file with both. The second half of a CRLF is skipped
         rather than producing an empty row, which is the usual way a
         thirty-row file becomes sixty. */
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = []; cell = ""; started = false;
      continue;
    }

    cell += c;
    started = true;
  }

  /* Whatever is left. A file with no trailing newline is ordinary. */
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }

  return { rows, delimiter: sep };
}

/* Comma unless something else is obviously more common on the header line.

   A European export is semicolon-separated and a tab-separated file is
   routine, and both arrive named .csv. Sniffed from the first line only,
   because a comma inside a quoted address would otherwise outvote the real
   delimiter. */
function sniffDelimiter(body) {
  const firstLine = body.split(/\r?\n/, 1)[0] || "";
  const outside = firstLine.replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t", "|"].map((d) => [d, outside.split(d).length - 1]);
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/* --- rows with names on them ------------------------------------------------ */

/* Headers are matched loosely — case, spaces, underscores and punctuation are
   all noise somebody's export adds — and the original spelling is kept so an
   error message can quote the file rather than our normalisation of it. */
export const normaliseHeader = (h) =>
  String(h ?? "").trim().toLowerCase().replace(/[\s_\-.]+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();

export function readTable(text, { delimiter = null } = {}) {
  const { rows, delimiter: sep } = parseCsv(text, { delimiter });
  if (!rows.length) {
    return { headers: [], rows: [], problems: [{ row: 0, message: "The file is empty." }], delimiter: sep };
  }

  const headers = rows[0].map((h) => String(h ?? "").trim());
  const normalised = headers.map(normaliseHeader);
  const problems = [];

  /* A duplicate header means one of the two columns is silently unreachable,
     and which one depends on the order they happen to be read in. */
  const seen = new Map();
  normalised.forEach((h, i) => {
    if (!h) return;
    if (seen.has(h)) {
      problems.push({
        row: 1, column: headers[i],
        message: `"${headers[i]}" appears twice, in columns ${seen.get(h) + 1} and ${i + 1}. `
          + "One of them would be ignored and there is no way to say which.",
      });
    } else seen.set(h, i);
  });

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];

    /* A wholly empty line, which every export puts at the end of the file and
       some put between sections. Skipped, because it means nothing — as
       against a row with the wrong number of cells, which means something
       went wrong. */
    if (cells.every((c) => String(c ?? "").trim() === "")) continue;

    if (cells.length !== headers.length) {
      problems.push({
        row: i + 1,
        message: `${cells.length} value${cells.length === 1 ? "" : "s"} against `
          + `${headers.length} column${headers.length === 1 ? "" : "s"}. `
          + "An unescaped comma or quote is the usual cause.",
      });
      continue;
    }

    const record = Object.create(null);
    normalised.forEach((h, j) => {
      if (h) record[h] = String(cells[j] ?? "").trim();
    });
    /* The line number as the file has it, so an error names the row somebody
       can actually go and look at. */
    record.__row = i + 1;
    out.push(record);
  }

  return { headers, normalised, rows: out, problems, delimiter: sep };
}
