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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { printable } from "../checks.js";
import { usd } from "../money.js";
import { human, humanStamp, stamp } from "../dates.js";
import { slug } from "../csv.js";

/* The brand, from the stylesheet rather than invented. */
const INK = rgb(0.04, 0.04, 0.04);
const BRAND = rgb(0.106, 0.094, 0.306);   // --brand-deep #1b184e
const SOFT = rgb(0.443, 0.467, 0.517);    // --ink-soft
const HAIRLINE = rgb(0.902, 0.910, 0.925);

const PAGE = { portrait: [612, 792], landscape: [792, 612] };
const MARGIN = 48;
const ROW_HEIGHT = 16;
/* The header block reserves this much, and it has to clear the subtitle's
   baseline or the column headings print on top of it. They did: the subtitle
   sat at 692 and the headings began at 696, four points apart, which renders
   as one illegible line. Measured against the lowest thing the header draws
   rather than guessed at. */
const HEADER_HEIGHT = 124;
const FOOTER_HEIGHT = 36;

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
    drawHeader({ page, font, bold, company, title, subtitle, generatedAt, pageWidth });

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

    drawFooter({
      page, font, company, note,
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

function drawHeader({ page, font, bold, company, title, subtitle, generatedAt, pageWidth }) {
  const top = page.getHeight() - MARGIN;

  page.drawText(printable(company?.legal_name || company?.name || "Property operations"), {
    x: MARGIN, y: top, size: 11, font: bold, color: BRAND,
  });

  if (company?.address) {
    page.drawText(printable(company.address).slice(0, 90), {
      x: MARGIN, y: top - 13, size: 8, font, color: SOFT,
    });
  }

  page.drawText(printable(title), { x: MARGIN, y: top - 36, size: 16, font: bold, color: INK });
  if (subtitle) {
    page.drawText(printable(subtitle), { x: MARGIN, y: top - 52, size: 9, font, color: SOFT });
  }

  /* When it was produced, on the page. A financial report with no date on it
     is one somebody will still be quoting from in six months. */
  const produced = `Produced ${humanStamp(generatedAt)}`;
  page.drawText(produced, {
    x: pageWidth - MARGIN - font.widthOfTextAtSize(produced, 8),
    y: top, size: 8, font, color: SOFT,
  });
}

function drawFooter({ page, font, company, note, pageNumber, pageCount, pageWidth }) {
  const y = MARGIN - 18;
  if (note) {
    page.drawText(printable(note).slice(0, 120), { x: MARGIN, y, size: 7, font, color: SOFT });
  }
  const label = `Page ${pageNumber} of ${pageCount}`;
  page.drawText(label, {
    x: pageWidth - MARGIN - font.widthOfTextAtSize(label, 8),
    y, size: 8, font, color: SOFT,
  });
}

/* Text inside a column box, clipped to it rather than running into the next
   one. A number that overlaps its neighbour is worse than a truncated name,
   so the truncation happens here and not by accident. */
function write(page, font, text, { x, y, width, size, colour, align }) {
  let value = String(text ?? "");
  const pad = 4;
  const room = width - pad * 2;

  while (value.length > 1 && font.widthOfTextAtSize(value, size) > room) {
    value = value.slice(0, -1);
  }
  if (value !== String(text ?? "") && value.length > 1) {
    value = `${value.slice(0, -1)}…`;
    /* The ellipsis is WinAnsi, but only just — if the font cannot take it,
       fall back rather than throwing at render time. */
    if (font.widthOfTextAtSize(value, size) > room) value = value.slice(0, -1);
  }

  const w = font.widthOfTextAtSize(value, size);
  const left = align === "right" ? x + width - pad - w
    : align === "center" ? x + (width - w) / 2
    : x + pad;

  page.drawText(printable(value), { x: left, y, size, font, color: colour });
}

function line(page, x1, y, x2) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: HAIRLINE });
}

export function pdfFileName({ companyName, report, from = null, to = null }) {
  const period = from && to ? `-${from}-to-${to}` : to ? `-as-at-${to}` : "";
  return `${slug(companyName, 30)}-${slug(report)}${period}.pdf`;
}
