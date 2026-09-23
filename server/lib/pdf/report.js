/* A report as a PDF.

   The thing somebody prints, or attaches to an email, or hands to an
   accountant. It has to look like it came from the company rather than from a
   database, and it has to survive whatever is in the data.

   ## Why every string goes through `printable`

   `pdf-lib`'s standard fonts are WinAnsi, and a character outside that set
   throws rather than rendering a box. A cheque run died at cheque forty once
   because of a payee name with a Đ in it, and the fix — transliterate, then
   fall back to a question mark — lives in checks.js. Every string here goes
   through it. A report that fails to render because a tenant has a Turkish
   surname is not an edge case in a product sold across the United States.

   ## Pagination is not optional

   A general ledger for a year is thousands of rows. Rendering them onto one
   enormous page, or silently truncating at the first page break, are both
   things a report library will happily do. Rows are measured and laid out
   page by page, every page repeats the column headers, and the footer says
   which page of how many — so a printout dropped on the floor can be put back
   together. */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { printable } from "../checks.js";
import { usd } from "../money.js";
import { stamp } from "../dates.js";
import {
  INK, SOFT, PAGE, MARGIN, ROW_HEIGHT, FOOTER_HEIGHT, HEADER_HEIGHT,
  write, line, brandHeader, pageFooter, fileSlug,
} from "./kit.js";

/* columns: [{ key, label, money?, align?, width? , map? }] */
export async function buildReportPdf({
  company, title, subtitle = null, columns, rows, totals = null,
  landscape = false, note = null, generatedAt = stamp(),
}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const [pageWidth, pageHeight] = PAGE[landscape ? "landscape" : "portrait"];
  const usable = pageWidth - MARGIN * 2;

  /* Widths are proportions of the usable width so a report renders the same
     on either orientation, rather than being tuned to one and clipped on the
     other. */
  const weights = columns.map((c) => c.width || 1);
  const totalWeight = weights.reduce((n, w) => n + w, 0);
  const widths = weights.map((w) => (w / totalWeight) * usable);

  const bodyTop = pageHeight - HEADER_HEIGHT;
  const bodyBottom = FOOTER_HEIGHT + (totals ? ROW_HEIGHT * 2 : 0);
  const perPage = Math.max(1, Math.floor((bodyTop - bodyBottom - ROW_HEIGHT) / ROW_HEIGHT));

  const pages = [];
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / perPage)); i++) {
    pages.push(rows.slice(i * perPage, (i + 1) * perPage));
  }

  pages.forEach((pageRows, index) => {
    const page = pdf.addPage([pageWidth, pageHeight]);
    brandHeader({ page, font, bold, company, title, subtitle, generatedAt, pageWidth });

    let y = bodyTop;

    /* Repeated on every page. A continuation sheet with no headings is a
       column of numbers nobody can read. */
    let x = MARGIN;
    columns.forEach((column, i) => {
      write(page, bold, printable(column.label), {
        x, y, width: widths[i], size: 8, colour: SOFT,
        align: column.align || (column.money ? "right" : "left"),
      });
      x += widths[i];
    });
    y -= 6;
    line(page, MARGIN, y, pageWidth - MARGIN);
    y -= ROW_HEIGHT;

    for (const row of pageRows) {
      let cx = MARGIN;
      columns.forEach((column, i) => {
        write(page, font, cellText(column, row), {
          x: cx, y, width: widths[i], size: 9, colour: INK,
          align: column.align || (column.money ? "right" : "left"),
        });
        cx += widths[i];
      });
      y -= ROW_HEIGHT;
    }

    /* Only on the last page. A totals row repeated on every sheet is a
       report somebody double-counts. */
    if (totals && index === pages.length - 1) {
      y -= 4;
      line(page, MARGIN, y + ROW_HEIGHT - 4, pageWidth - MARGIN);
      let tx = MARGIN;
      columns.forEach((column, i) => {
        write(page, bold, cellText(column, totals), {
          x: tx, y, width: widths[i], size: 9, colour: INK,
          align: column.align || (column.money ? "right" : "left"),
        });
        tx += widths[i];
      });
    }

    pageFooter({
      page, font, note,
      pageNumber: index + 1, pageCount: pages.length, pageWidth,
    });
  });

  return await pdf.save();
}

function cellText(column, row) {
  const raw = column.map ? column.map(row) : row[column.key];
  if (column.money) return raw == null ? "" : usd(Number(raw));
  return printable(raw ?? "");
}



/* Text inside a column box, clipped to it rather than running into the next
   one. A number that overlaps its neighbour is worse than a truncated name,
   so the truncation happens here and not by accident. */


export function pdfFileName({ companyName, report, from = null, to = null }) {
  const period = from && to ? `-${from}-to-${to}` : to ? `-as-at-${to}` : "";
  return `${fileSlug(companyName, 30)}-${fileSlug(report)}${period}.pdf`;
}
