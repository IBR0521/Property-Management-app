/* Exporting a report.

   Two formats and two very different risks.

   **CSV is a security surface.** Everything exported from this application
   has passed through a text field somebody else controls — a tenant's name, a
   repair description, a memo on a payment — and a spreadsheet executes a cell
   that begins with `=`. A manager opening an export is the last person who
   should find that out. Most of the CSV tests here are about that, and about
   the exception that makes it hard: a negative number also begins with a
   character on the dangerous list, and quoting it would turn every negative
   figure in the file into text that will not sum.

   **A PDF is where a report goes to fail at render time.** pdf-lib's standard
   fonts are WinAnsi and throw on anything outside it — a cheque run died at
   cheque forty once over a payee called Đurađ. A report that will not render
   because a tenant has a Turkish surname is not an edge case in a product
   sold across the United States. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { csvCell, csvMoney, toCsv, csvFileName, BOM } from "../server/lib/csv.js";
import { buildReportPdf, pdfFileName } from "../server/lib/pdf/report.js";

/* A deliberately strict RFC 4180 reader, so the tests check the file rather
   than check that the writer agrees with itself. */
function parseCsv(text) {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [], cell = "", quoted = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; continue; }
      if (c === '"') { quoted = false; continue; }
      cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\r" && body[i + 1] === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; i++;
      continue;
    }
    cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* --- what a spreadsheet would execute ---------------------------------------- */

describe("formula injection", () => {
  test("a cell that would run as a formula is neutralised", async () => {
    /* `=HYPERLINK(...)` in a maintenance note becomes a live link in the
       manager's spreadsheet, and the old DDE forms can do a great deal
       worse. */
    for (const attack of [
      "=cmd|'/c calc'!A1",
      '=HYPERLINK("http://example.test","click")',
      "@SUM(1+1)",
      "+1+1",
      "\tleading tab",
    ]) {
      const out = csvCell(attack);
      assert.ok(out.startsWith("'") || out.startsWith('"\''),
        `${JSON.stringify(attack)} was not neutralised: ${out}`);
    }
  });

  test("a negative number is left alone, because it has to stay summable", async () => {
    /* The exception that makes this hard. A minus is on the dangerous list
       and -1450.00 is not an attack; quoting it turns every negative figure
       in the export into text. */
    assert.equal(csvCell("-1450.00"), "-1450.00");
    assert.equal(csvCell("-1450"), "-1450");
    assert.equal(csvCell("1450.00"), "1450.00");
  });

  test("but something that merely starts like one is not", async () => {
    assert.equal(csvCell("-not a number"), "'-not a number");
    assert.equal(csvCell("-1450.00.00"), "'-1450.00.00");
  });

  test("the neutralised value still survives a round trip", async () => {
    /* Escaping that corrupts the data is its own bug. */
    const text = toCsv({
      columns: [{ key: "memo", label: "Memo" }],
      rows: [{ memo: "=cmd|calc" }],
    });
    assert.equal(parseCsv(text)[1][0], "'=cmd|calc");
  });
});

/* --- the format --------------------------------------------------------------- */

describe("RFC 4180", () => {
  test("commas, quotes and line breaks all round trip", async () => {
    /* The old escaper did not check for line breaks, which is how a tenant's
       two-line address turns a thirty-row export into thirty-two rows and
       nobody can see why. */
    const rows = [
      { a: "plain", b: "has,comma" },
      { a: 'has"quote', b: "two\nlines" },
      { a: "trailing space ", b: "" },
    ];
    const text = toCsv({
      columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      rows,
    });

    const parsed = parseCsv(text);
    assert.deepEqual(parsed[0], ["A", "B"]);
    assert.deepEqual(parsed[1], ["plain", "has,comma"]);
    assert.deepEqual(parsed[2], ['has"quote', "two\nlines"]);
    assert.equal(parsed.length, 4, "three rows and a header, not five");
  });

  test("it starts with a byte order mark", async () => {
    /* Without one, Excel reads UTF-8 as the local codepage and a tenant
       called Nuñez arrives as NuÃ±ez. */
    const text = toCsv({ columns: [{ key: "a", label: "A" }], rows: [] });
    assert.ok(text.startsWith(BOM));
  });

  test("money is a number, not a formatted string", async () => {
    /* The point of an export is that somebody sums the column. A currency
       symbol and a thousands separator make that impossible. */
    assert.equal(csvMoney(145000), "1450.00");
    assert.equal(csvMoney(-2500), "-25.00");
    assert.equal(csvMoney(0), "0.00");
    assert.equal(csvMoney(null), "");

    const text = toCsv({
      columns: [{ key: "rent", label: "Rent", money: true }],
      rows: [{ rent: 145000 }],
    });
    assert.equal(parseCsv(text)[1][0], "1450.00");
  });

  test("a totals row is separated by a blank line", async () => {
    /* So a reader selecting the data range does not drag the totals into the
       middle of a sort. */
    const text = toCsv({
      columns: [{ key: "a", label: "A" }, { key: "n", label: "N", money: true }],
      rows: [{ a: "one", n: 100 }, { a: "two", n: 200 }],
      totals: { a: "Total", n: 300 },
    });
    const parsed = parseCsv(text);
    assert.deepEqual(parsed.at(-2), [""]);
    assert.deepEqual(parsed.at(-1), ["Total", "3.00"]);
  });

  test("a null is an empty cell, not the word null", async () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  test("the filename says what and when", async () => {
    assert.equal(
      csvFileName({ companyName: "Leafridge Property Management", report: "Rent roll", to: "2026-09-30" }),
      "leafridge-property-management-rent-roll-as-at-2026-09-30.csv");
  });

  test("truncating a long name does not leave a trailing hyphen", async () => {
    /* Cutting at thirty characters lands on a hyphen as often as not, and
       nobody notices until it is in every filename a customer has
       downloaded. */
    const name = csvFileName({
      companyName: "Leafridge Property Management LLC", report: "Rent roll",
    });
    assert.ok(!name.includes("--"), name);
    assert.match(name, /^leafridge-property-management-rent-roll\.csv$/);
  });
});

/* --- the PDF -------------------------------------------------------------------- */

describe("the PDF", () => {
  const columns = [
    { key: "where", label: "Property", width: 3 },
    { key: "rent", label: "Rent", money: true },
  ];
  const company = { legal_name: "Leafridge Property Management LLC", address: "1 Main St" };

  const rows = (n) => Array.from({ length: n }, (_, i) => ({
    where: `Property ${i}`, rent: 100000 + i,
  }));

  test("it is a PDF", async () => {
    const bytes = await buildReportPdf({ company, title: "Rent roll", columns, rows: rows(3) });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("a name outside WinAnsi does not kill the run", async () => {
    /* A cheque run died at cheque forty over exactly this. Transliterated
       where it can be, replaced where it cannot, never thrown. */
    const bytes = await buildReportPdf({
      company, title: "Rent roll", columns,
      rows: [{ where: "Đurađ Ćosić", rent: 100000 },
             { where: "Ольга Иванова", rent: 100000 },
             { where: "田中さん", rent: 100000 }],
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("a company name outside WinAnsi does not either", async () => {
    const bytes = await buildReportPdf({
      company: { legal_name: "Łukasz Property Ø", address: "Ståhl Street" },
      title: "Rent roll", columns, rows: rows(2),
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("a long report is paginated rather than truncated", async () => {
    /* A general ledger for a year is thousands of rows. Rendering them onto
       one enormous page, or silently stopping at the first break, are both
       things a report library will happily do. */
    const bytes = await buildReportPdf({ company, title: "Ledger", columns, rows: rows(140) });
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() > 1, "it should run to several pages");
    assert.ok(pdf.getPageCount() < 20, "and not one page per row");
  });

  test("a report with no rows is still a page", async () => {
    /* "Nothing is overdue" is an answer, and a zero-byte file is not. */
    const bytes = await buildReportPdf({ company, title: "Aged receivables", columns, rows: [] });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
  });

  test("landscape fits more across", async () => {
    const wide = await buildReportPdf({
      company, title: "Ledger", columns, rows: rows(10), landscape: true,
    });
    const pdf = await PDFDocument.load(wide);
    const page = pdf.getPage(0);
    assert.ok(page.getWidth() > page.getHeight());
  });

  test("a value too wide for its column is truncated, not overlapped", async () => {
    /* A number running into its neighbour is worse than a shortened name, so
       the truncation is deliberate rather than accidental. */
    const bytes = await buildReportPdf({
      company, title: "Rent roll", columns,
      rows: [{ where: "A property with an extremely long name ".repeat(6), rent: 100000 }],
    });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  });

  test("the filename says what and when", async () => {
    assert.equal(
      pdfFileName({ companyName: "Leafridge", report: "Profit and loss", from: "2026-01-01", to: "2026-12-31" }),
      "leafridge-profit-and-loss-2026-01-01-to-2026-12-31.pdf");
  });
});
