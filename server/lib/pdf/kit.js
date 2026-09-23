/* The drawing bits both PDFs share.

   A report is a table and a statement is not, so they are two builders — but
   the page furniture is the same and it should look the same, because an
   owner receiving a statement and an accountant receiving a trial balance are
   looking at documents from the same company.

   Every string that reaches a page goes through `printable`. pdf-lib's
   standard fonts are WinAnsi and throw on anything outside them; a cheque run
   died at cheque forty over a payee called Đurađ, and a statement that will
   not render because an owner has a Turkish surname would be the same bug
   with a worse audience. */
import { rgb } from "pdf-lib";
import { printable } from "../checks.js";
import { humanStamp } from "../dates.js";

/* From the stylesheet, not invented. */
export const INK = rgb(0.04, 0.04, 0.04);
export const BRAND = rgb(0.106, 0.094, 0.306);   // --brand-deep #1b184e
export const SOFT = rgb(0.443, 0.467, 0.517);    // --ink-soft
export const HAIRLINE = rgb(0.902, 0.910, 0.925);
export const DANGER = rgb(0.647, 0.153, 0.106);

export const PAGE = { portrait: [612, 792], landscape: [792, 612] };
export const MARGIN = 48;
export const ROW_HEIGHT = 16;
export const FOOTER_HEIGHT = 36;

/* The header block reserves this much, and it has to clear the subtitle's
   baseline or the column headings print on top of it. They did once: the
   subtitle sat at 692 and the headings began at 696, four points apart, which
   renders as one illegible line. */
export const HEADER_HEIGHT = 124;

/* Text inside a box, clipped to it rather than running into the next one. A
   number overlapping its neighbour is worse than a truncated name, so the
   truncation happens deliberately here and not by accident. */
export function write(page, font, text, { x, y, width, size, colour, align = "left" }) {
  /* Sanitised first, measured second, and that order is the whole of it.

     `widthOfTextAtSize` throws on a character the font cannot encode exactly
     as `drawText` does, so measuring raw input and sanitising at the draw
     call — which is what this did — fails during truncation instead of
     during rendering, with the same unhelpful "WinAnsi cannot encode" and one
     stack frame further from the cause.

     The report builder never hit it because it happens to call `printable`
     upstream. The statement builder passes text straight through, and an
     owner called Đurađ took it down. */
  const original = printable(text ?? "");
  let value = original;
  const pad = 4;
  const room = width - pad * 2;

  while (value.length > 1 && font.widthOfTextAtSize(value, size) > room) {
    value = value.slice(0, -1);
  }
  if (value !== original && value.length > 1) {
    value = `${value.slice(0, -1)}…`;
    if (font.widthOfTextAtSize(value, size) > room) value = value.slice(0, -1);
  }

  const w = font.widthOfTextAtSize(value, size);
  const left = align === "right" ? x + width - pad - w
    : align === "center" ? x + (width - w) / 2
    : x + pad;

  page.drawText(value, { x: left, y, size, font, color: colour });
}

export function line(page, x1, y, x2, colour = HAIRLINE) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: colour });
}

/* The company's own heading. Legal name where there is one, because a
   statement is a financial document and "Leafridge" is not who anybody
   contracted with. */
export function brandHeader({ page, font, bold, company, title, subtitle, generatedAt, pageWidth }) {
  const top = page.getHeight() - MARGIN;

  page.drawText(printable(company?.legal_name || company?.name || "Property operations"), {
    x: MARGIN, y: top, size: 11, font: bold, color: BRAND,
  });

  const contact = [company?.address, company?.phone].filter(Boolean).join(" · ");
  if (contact) {
    page.drawText(printable(contact).slice(0, 110), {
      x: MARGIN, y: top - 13, size: 8, font, color: SOFT,
    });
  }

  page.drawText(printable(title), { x: MARGIN, y: top - 36, size: 16, font: bold, color: INK });
  if (subtitle) {
    page.drawText(printable(subtitle), { x: MARGIN, y: top - 52, size: 9, font, color: SOFT });
  }

  /* When it was produced, on the page. A financial document with no date on
     it is one somebody will still be quoting from in six months. */
  if (generatedAt) {
    const produced = `Produced ${humanStamp(generatedAt)}`;
    page.drawText(produced, {
      x: pageWidth - MARGIN - font.widthOfTextAtSize(produced, 8),
      y: top, size: 8, font, color: SOFT,
    });
  }
}

export function pageFooter({ page, font, note, pageNumber, pageCount, pageWidth }) {
  const y = MARGIN - 18;
  if (note) {
    page.drawText(printable(note).slice(0, 130), { x: MARGIN, y, size: 7, font, color: SOFT });
  }
  const label = `Page ${pageNumber} of ${pageCount}`;
  page.drawText(label, {
    x: pageWidth - MARGIN - font.widthOfTextAtSize(label, 8),
    y, size: 8, font, color: SOFT,
  });
}

export function fileSlug(value, limit = null) {
  const s = String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (limit ? s.slice(0, limit) : s).replace(/-+$/, "");
}
