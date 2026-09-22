/* Printable cheques, and the positive-pay file that protects them.

   **This prints onto pre-printed cheque stock, and does not draw a MICR
   line.** That is a deliberate limit rather than an omission, and it is the
   most important thing on this page.

   The MICR line along the bottom of a cheque — routing number, account
   number, cheque number — is read magnetically. It requires the E-13B
   typeface at an exact size and position *and* magnetic toner in the printer.
   Drawing those characters in an ordinary font produces something that looks
   right to a person, is not readable by the machine that matters, and is
   rejected or manually processed at a per-item fee. Worse, it looks like it
   worked.

   So this places only the variable data — date, payee, the amount twice, the
   memo and the stubs — at the standard offsets for business cheque stock that
   already carries the MICR line, the bank details and the company name. That
   is what the stock is for, and it is what property management companies
   actually use.

   The geometry below is the common US layout: letter paper, cheque on top,
   two stubs beneath. Stock varies between suppliers, so the offsets are
   adjustable per company and a test page exists to check alignment before a
   run. A cheque printed two millimetres out is rejected by a bank's reader,
   and that is not something that can be confirmed from here — only on paper,
   which is in OPEN-ITEMS. */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { usd } from "./money.js";

/* Points, from the bottom-left of a US Letter page, which is how PDF
   coordinates work. 72 points to the inch. */
const PAGE = { width: 612, height: 792 };

/* Cheque on top, stubs below — the most common business stock. Every offset
   is from the bottom-left of the page. */
export const DEFAULT_LAYOUT = {
  date:        { x: 460, y: 700, size: 10 },
  payee:       { x: 75,  y: 658, size: 11 },
  amountBox:   { x: 470, y: 658, size: 11 },
  amountWords: { x: 62,  y: 634, size: 10, maxWidth: 420 },
  memo:        { x: 62,  y: 580, size: 9 },

  /* The two stubs. A cheque comes back from an owner or a vendor with a
     question about which invoice it settled, and the stub is the answer. */
  stubs: [
    { x: 62, y: 460, size: 9, lineHeight: 12, maxLines: 14 },
    { x: 62, y: 205, size: 9, lineHeight: 12, maxLines: 14 },
  ],
};

/* --- the amount, in words --------------------------------------------------

   The legal amount on a cheque. Where the numerals and the words disagree,
   the words govern in the US under UCC 3-114, so this is the field that
   decides what is paid and it is worth getting exactly right. */
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const SCALES = ["", "Thousand", "Million", "Billion"];

function underThousand(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = ONES[n % 10];
    parts.push(ones ? `${tens}-${ones}` : tens);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

export function amountInWords(cents) {
  const total = Math.round(Math.abs(Number(cents) || 0));
  const dollars = Math.floor(total / 100);
  const remainder = total % 100;

  let words = "";
  if (dollars === 0) {
    words = "Zero";
  } else {
    const groups = [];
    let rest = dollars;
    let scale = 0;
    while (rest > 0) {
      const chunk = rest % 1000;
      if (chunk > 0) {
        groups.unshift(`${underThousand(chunk)}${SCALES[scale] ? ` ${SCALES[scale]}` : ""}`);
      }
      rest = Math.floor(rest / 1000);
      scale += 1;
    }
    words = groups.join(" ");
  }

  /* Cents as a fraction rather than words: it is the convention, it is
     unambiguous, and "and 00/100" is what a teller expects to see. */
  return `${words} and ${String(remainder).padStart(2, "0")}/100`;
}

/* The line is filled to its full width so nobody can add to it. An unfilled
   legal line is how a cheque for eight hundred becomes one for eight
   thousand. */
function fillLine(text, font, size, maxWidth) {
  const stars = "*";
  let out = `${text} `;
  while (font.widthOfTextAtSize(out + stars, size) < maxWidth) out += stars;
  return out;
}

/* Text the standard fonts can actually encode.

   pdf-lib's standard fonts are WinAnsi, and a character outside it throws —
   which would fail the whole run because one payee has a Cyrillic name. So
   accents are decomposed and dropped, the letters that do not decompose are
   mapped, and anything still unencodable becomes a question mark rather than
   an exception. A cheque to "P?TR IVANOV" is wrong in a way a person can see
   and fix; a run that dies at cheque forty is wrong in a way that wastes a
   morning. */
const TRANSLITERATE = {
  "\u00d8": "O", "\u00f8": "o", "\u00c6": "AE", "\u00e6": "ae",
  "\u0110": "D", "\u0111": "d", "\u0141": "L", "\u0142": "l",
  "\u0152": "OE", "\u0153": "oe",
};

const WINANSI = /^[\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC]*$/;

export function printable(value) {
  const raw = String(value ?? "");
  if (WINANSI.test(raw)) return raw;

  const mapped = raw
    .replace(/[\u00d8\u00f8\u00c6\u00e6\u0110\u0111\u0141\u0142]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  return [...mapped].map((c) => (WINANSI.test(c) ? c : "?")).join("");
}

/* --- drawing ---------------------------------------------------------------- */

/* One PDF holding every cheque in a run, one page each, ready for the tray.

   `cheques` are already-vetted payments: the workers' compensation barrier
   lives in `assertPayable()` and is applied before anything reaches here. */
export async function buildChecks({ cheques, company, layout = {} }) {
  if (!Array.isArray(cheques) || cheques.length === 0) {
    throw new Error("A cheque run with nothing in it is not a run.");
  }

  const L = { ...DEFAULT_LAYOUT, ...layout };
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Cheques — ${company?.name || ""}`.trim());
  pdf.setProducer("property-ops");
  pdf.setCreationDate(new Date());

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);

  for (const cheque of cheques) {
    if (!(Math.round(Number(cheque.amountCents)) > 0)) {
      throw new Error(`The cheque to ${cheque.payee || "an unnamed payee"} has no amount.`);
    }
    if (!String(cheque.payee || "").trim()) {
      throw new Error("A cheque with no payee cannot be printed.");
    }

    const page = pdf.addPage([PAGE.width, PAGE.height]);
    const put = (text, at, f = font) =>
      page.drawText(printable(text), { x: at.x, y: at.y, size: at.size, font: f, color: ink });

    put(cheque.date, L.date);
    put(cheque.payee, L.payee, bold);

    /* The numeric amount, with the separators, so it cannot be read as a
       larger number. */
    put(usd(cheque.amountCents), L.amountBox, bold);

    put(
      fillLine(amountInWords(cheque.amountCents), font, L.amountWords.size, L.amountWords.maxWidth),
      L.amountWords);

    if (cheque.memo) put(`Memo: ${cheque.memo}`, L.memo);

    /* The same detail on both stubs: one for the payee's records and one for
       the company's, which is what the two-stub stock is for. */
    for (const stub of L.stubs) {
      let y = stub.y;
      const line = (text, f = font) => {
        page.drawText(printable(text), { x: stub.x, y, size: stub.size, font: f, color: ink });
        y -= stub.lineHeight;
      };

      line(company?.name || "", bold);
      line(`${cheque.date}   Cheque ${cheque.number}   ${usd(cheque.amountCents)}`);
      line(cheque.payee, bold);
      if (cheque.memo) line(cheque.memo);
      y -= 4;

      for (const row of (cheque.lines || []).slice(0, stub.maxLines)) {
        line(`${row.label}   ${usd(row.amountCents)}`);
      }
      if ((cheque.lines || []).length > stub.maxLines) {
        line(`… and ${cheque.lines.length - stub.maxLines} more — see the full statement`);
      }
    }
  }

  return await pdf.save();
}

/* A single page with rules and labels where the variable data lands, printed
   on plain paper and held against a real cheque to check the alignment before
   committing a run to expensive stock. */
export async function buildAlignmentSheet({ company, layout = {} }) {
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const pdf = await PDFDocument.create();
  pdf.setTitle("Cheque alignment test");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PAGE.width, PAGE.height]);

  const mark = (label, at) => {
    page.drawText(`<- ${label}`, {
      x: at.x, y: at.y, size: at.size, font, color: rgb(0.65, 0.1, 0.1),
    });
    /* A hairline at the baseline: the thing to line up against the stock. */
    page.drawLine({
      start: { x: at.x - 6, y: at.y }, end: { x: at.x + 150, y: at.y },
      thickness: 0.4, color: rgb(0.8, 0.8, 0.8),
    });
  };

  page.drawText(`Alignment test — ${company?.name || ""}`, {
    x: 62, y: 750, size: 12, font, color: rgb(0, 0, 0),
  });
  page.drawText("Hold this against a blank cheque. Each line marks where that field prints.", {
    x: 62, y: 734, size: 9, font, color: rgb(0.35, 0.35, 0.35),
  });

  mark("date", L.date);
  mark("payee", L.payee);
  mark("amount", L.amountBox);
  mark("amount in words", L.amountWords);
  mark("memo", L.memo);
  L.stubs.forEach((s, i) => mark(`stub ${i + 1}`, s));

  return await pdf.save();
}

/* --- positive pay ----------------------------------------------------------

   The register of cheques actually issued, sent to the bank so it can refuse
   anything else presented against the account. It is the single most
   effective control against cheque fraud, and it is a CSV.

   Column order and the date format differ between banks, so the layout is a
   parameter. The default is the most common shape. */
export const POSITIVE_PAY_COLUMNS = [
  "account", "checkNumber", "amount", "issueDate", "payee", "status",
];

export function positivePayCsv({ cheques, account, columns = POSITIVE_PAY_COLUMNS, dateFormat = "MM/DD/YYYY" }) {
  const rows = cheques.map((c) => ({
    account: String(account || ""),
    checkNumber: String(c.number),
    /* Dollars and cents with a decimal point and no separators or symbol:
       almost every bank's parser wants exactly that, and a "$" or a comma is
       the most common reason one of these files is rejected. */
    amount: (Math.round(Number(c.amountCents)) / 100).toFixed(2),
    issueDate: formatDate(c.date, dateFormat),
    payee: String(c.payee || "").replace(/[\r\n]+/g, " ").slice(0, 80),
    /* "Void" here is how a cancelled cheque is withdrawn from the register. */
    status: c.void ? "V" : "I",
  }));

  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(row[col] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function formatDate(iso, format) {
  const [y, m, d] = String(iso || "").slice(0, 10).split("-");
  if (!y || !m || !d) return "";
  if (format === "YYYY-MM-DD") return `${y}-${m}-${d}`;
  if (format === "YYYYMMDD") return `${y}${m}${d}`;
  return `${m}/${d}/${y}`;
}

function csvCell(value) {
  const s = String(value);
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function checkFileName({ companyName, date, kind = "cheques", extension = "pdf" }) {
  const slug = String(companyName || "company").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `${slug}-${kind}-${String(date).replace(/-/g, "")}.${extension}`;
}
