/* An owner's statement, as a PDF.

   ## It renders the snapshot, never a fresh query

   `owner_statement.totals` holds the figures as they stood when the statement
   was generated, and that is deliberate: an owner who was sent a link in
   April must see April's numbers in April's statement, whatever has been
   posted since. The PDF has to render the same snapshot for the same reason,
   and more sharply — a paper copy and the link it came from disagreeing is
   worse than either being stale, because only one of them can be checked.

   So this takes the parsed snapshot and nothing else. It cannot go and look.

   ## Sections, not one table

   A statement is a summary, then every line, then what was done, then what is
   coming. The report builder does one table well and this is not that, so it
   is its own layout — sharing the page furniture through `kit.js` so the two
   documents look like they came from the same company. */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { printable } from "../checks.js";
import { usd } from "../money.js";
import { human, humanStamp } from "../dates.js";
import {
  INK, SOFT, BRAND, DANGER, HAIRLINE, PAGE, MARGIN, ROW_HEIGHT,
  write, line, brandHeader, pageFooter, fileSlug,
} from "./kit.js";

const [WIDTH, HEIGHT] = PAGE.portrait;
const USABLE = WIDTH - MARGIN * 2;
const BODY_BOTTOM = MARGIN + 28;

export async function buildStatementPdf({ company, owner, statement, totals }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const period = `${human(statement.period_start)} to ${human(statement.period_end)}`;
  const pages = [];

  let page = newPage();
  let y = HEIGHT - 148;

  function newPage() {
    const p = pdf.addPage([WIDTH, HEIGHT]);
    brandHeader({
      page: p, font, bold, company,
      title: "Statement",
      subtitle: `${printable(owner?.name || "")} · ${period}`,
      generatedAt: statement.generated_at,
      pageWidth: WIDTH,
    });
    pages.push(p);
    return p;
  }

  /* Enough room for what is about to be drawn, or a fresh page. Checked
     before each block rather than after, so a heading never lands at the
     bottom of a page with its table on the next one. */
  function room(needed) {
    if (y - needed >= BODY_BOTTOM) return;
    page = newPage();
    y = HEIGHT - 148;
  }

  /* --- the three figures ---------------------------------------------------
   *
   * The summary an owner reads and nothing else, if they read nothing else.
   * Net last and in the brand colour, because it is the answer to the
   * question they opened the document with. */
  const figures = [
    ["Rent collected", totals.rent],
    ["Costs", totals.expenses],
    ["Management fee", totals.fees],
    ["Net to you", totals.net],
  ];
  const boxWidth = USABLE / figures.length;

  figures.forEach(([label, cents], i) => {
    const x = MARGIN + boxWidth * i;
    write(page, font, label, { x, y, width: boxWidth, size: 8, colour: SOFT });
    write(page, bold, usd(cents), {
      x, y: y - 18, width: boxWidth, size: 14,
      colour: i === figures.length - 1 ? BRAND : INK,
    });
  });
  y -= 40;
  line(page, MARGIN, y, WIDTH - MARGIN);
  y -= 22;

  /* --- every line ----------------------------------------------------------- */

  const lines = totals.lines || [];
  room(40);
  write(page, bold, "Every line", { x: MARGIN, y, width: USABLE, size: 11, colour: INK });
  y -= 18;

  const cols = [
    { label: "Date", width: 1.1, align: "left" },
    { label: "What", width: 4.2, align: "left" },
    { label: "Amount", width: 1.3, align: "right" },
  ];
  const widths = cols.map((c) => (c.width / cols.reduce((n, x) => n + x.width, 0)) * USABLE);

  const header = () => {
    let x = MARGIN;
    cols.forEach((c, i) => {
      write(page, bold, c.label, { x, y, width: widths[i], size: 8, colour: SOFT, align: c.align });
      x += widths[i];
    });
    y -= 6;
    line(page, MARGIN, y, WIDTH - MARGIN);
    y -= ROW_HEIGHT;
  };
  header();

  if (!lines.length) {
    write(page, font, "Nothing was recorded between these dates.", {
      x: MARGIN, y, width: USABLE, size: 9, colour: SOFT,
    });
    y -= ROW_HEIGHT;
  }

  for (const entry of lines) {
    if (y - ROW_HEIGHT < BODY_BOTTOM) {
      page = newPage();
      y = HEIGHT - 148;
      /* Repeated on the continuation sheet. A column of numbers with no
         headings is one nobody can read. */
      header();
    }

    const label = `${entry.memo || ""}${entry.memo ? "  " : ""}(${String(entry.kind || "").replace(/_/g, " ")})`;
    const amount = Number(entry.amount_cents);

    let x = MARGIN;
    write(page, font, human(entry.date), { x, y, width: widths[0], size: 9, colour: INK });
    x += widths[0];
    write(page, font, label, { x, y, width: widths[1], size: 9, colour: INK });
    x += widths[1];
    write(page, font, usd(amount), {
      x, y, width: widths[2], size: 9,
      colour: amount < 0 ? DANGER : INK, align: "right",
    });
    y -= ROW_HEIGHT;
  }

  /* The totals, once, at the end of the lines. */
  y -= 4;
  line(page, MARGIN, y + ROW_HEIGHT - 4, WIDTH - MARGIN);
  let tx = MARGIN;
  write(page, bold, "", { x: tx, y, width: widths[0], size: 9, colour: INK });
  tx += widths[0];
  write(page, bold, "Net to you", { x: tx, y, width: widths[1], size: 9, colour: INK });
  tx += widths[1];
  write(page, bold, usd(totals.net), { x: tx, y, width: widths[2], size: 9, colour: BRAND, align: "right" });
  y -= ROW_HEIGHT * 2;

  /* --- what was done --------------------------------------------------------- */

  const jobs = totals.jobs || [];
  if (jobs.length) {
    room(40 + jobs.length * ROW_HEIGHT);
    write(page, bold, "Work done", { x: MARGIN, y, width: USABLE, size: 11, colour: INK });
    y -= 18;

    for (const job of jobs) {
      if (y - ROW_HEIGHT < BODY_BOTTOM) { page = newPage(); y = HEIGHT - 148; }
      const where = `${job.line1 || ""}${job.label ? ` unit ${job.label}` : ""}`;
      write(page, font, `${job.reference || ""}  ${job.summary || ""}`, {
        x: MARGIN, y, width: USABLE * 0.62, size: 9, colour: INK,
      });
      write(page, font, where, {
        x: MARGIN + USABLE * 0.62, y, width: USABLE * 0.2, size: 8, colour: SOFT,
      });
      write(page, font, job.actual_cents != null ? usd(job.actual_cents) : "—", {
        x: MARGIN + USABLE * 0.82, y, width: USABLE * 0.18, size: 9, colour: INK, align: "right",
      });
      y -= ROW_HEIGHT;
    }
    y -= ROW_HEIGHT;
  }

  /* --- what is coming --------------------------------------------------------- */

  const upcoming = totals.upcoming || [];
  if (upcoming.length) {
    room(30 + upcoming.length * 14);
    write(page, bold, "Coming up", { x: MARGIN, y, width: USABLE, size: 11, colour: INK });
    y -= 16;
    for (const item of upcoming) {
      if (y - 14 < BODY_BOTTOM) { page = newPage(); y = HEIGHT - 148; }
      write(page, font, item, { x: MARGIN, y, width: USABLE, size: 9, colour: SOFT });
      y -= 14;
    }
  }

  /* Footers last, once the page count is known. */
  pages.forEach((p, i) => {
    pageFooter({
      page: p, font,
      note: "This statement was produced from the figures held when it was generated.",
      pageNumber: i + 1, pageCount: pages.length, pageWidth: WIDTH,
    });
  });

  return await pdf.save();
}

export function statementFileName({ companyName, ownerName, from, to }) {
  return `${fileSlug(companyName, 24)}-statement-${fileSlug(ownerName, 24)}-${from}-to-${to}.pdf`;
}
