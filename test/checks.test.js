/* Printed cheques and the positive-pay register.

   Two things are testable here and one is not, and the line between them
   matters more than usual.

   **Testable**: the amount in words, which under UCC 3-114 governs when it
   disagrees with the numerals — so it is the field that decides what gets
   paid; the filled legal line that stops somebody adding to it; and the
   positive-pay CSV, which is the control that makes a forged cheque bounce.

   **Not testable from here**: whether the variable data lands in the right
   place on real stock. That is millimetres on paper against a supplier's
   layout, and a cheque printed slightly out is rejected by the bank's reader.
   There is an alignment sheet for exactly that, and it is in OPEN-ITEMS.

   The MICR line is deliberately absent — see the note at the top of
   checks.js. A test below asserts it stays absent, because drawing it in an
   ordinary font produces something that looks right and is not machine
   readable, which is worse than not drawing it. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  amountInWords, buildChecks, buildAlignmentSheet, positivePayCsv,
  checkFileName, DEFAULT_LAYOUT, printable,
} from "../server/lib/checks.js";

/* pdf-lib writes compressed object streams, so the structure is not visible
   in the raw bytes. Loading it back is both more honest and more useful:
   these assertions are about the document, not about its encoding. */
const reopen = (bytes) => PDFDocument.load(bytes);

const COMPANY = { name: "Leafridge Property Management" };
const CHEQUES = [
  {
    number: 1041, date: "2026-10-05", payee: "Ruth Calloway", amountCents: 486775,
    memo: "Owner distribution September 2026",
    lines: [
      { label: "Rent collected", amountCents: 575000 },
      { label: "Management fee", amountCents: -51750 },
      { label: "Repairs", amountCents: -36475 },
    ],
  },
  { number: 1042, date: "2026-10-05", payee: "Okafor Holdings LLC", amountCents: 220000 },
];

describe("the amount in words", () => {
  test("it is the field that governs, so it is exact", () => {
    /* UCC 3-114: where the words and the numerals disagree, the words win.
       A bug here pays the wrong amount and is legally defensible. */
    const cases = [
      [0, "Zero and 00/100"],
      [1, "Zero and 01/100"],
      [99, "Zero and 99/100"],
      [100, "One and 00/100"],
      [1500, "Fifteen and 00/100"],
      [2000, "Twenty and 00/100"],
      [2100, "Twenty-One and 00/100"],
      [10000, "One Hundred and 00/100"],
      [10500, "One Hundred Five and 00/100"],
      [11900, "One Hundred Nineteen and 00/100"],
      [100000, "One Thousand and 00/100"],
      [486775, "Four Thousand Eight Hundred Sixty-Seven and 75/100"],
      [100000000, "One Million and 00/100"],
      [123456789, "One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven and 89/100"],
    ];
    for (const [cents, expected] of cases) {
      assert.equal(amountInWords(cents), expected, `${cents} cents`);
    }
  });

  test("the teens are not the tens", () => {
    /* The classic off-by-one in every implementation of this. */
    assert.equal(amountInWords(1300), "Thirteen and 00/100");
    assert.equal(amountInWords(3000), "Thirty and 00/100");
    assert.equal(amountInWords(1900), "Nineteen and 00/100");
    assert.equal(amountInWords(9000), "Ninety and 00/100");
  });

  test("a hundred with nothing after it does not trail a conjunction", () => {
    assert.equal(amountInWords(20000), "Two Hundred and 00/100");
    assert.equal(amountInWords(20001), "Two Hundred and 01/100");
  });

  test("a gap in the middle is skipped, not padded with zeroes", () => {
    /* $1,000,007 has no thousands group at all. */
    assert.equal(amountInWords(100000700), "One Million Seven and 00/100");
  });

  test("cents are a fraction, always two digits", () => {
    assert.match(amountInWords(505), /and 05\/100$/);
    assert.match(amountInWords(500), /and 00\/100$/);
  });

  test("a negative amount is written as its magnitude", () => {
    /* A cheque for a negative amount is not a thing; the caller refuses it.
       This just never prints a minus sign into the legal line. */
    assert.equal(amountInWords(-486775), amountInWords(486775));
  });
});

describe("the printed cheque", () => {
  test("it produces a PDF, one page per cheque", async () => {
    const bytes = await buildChecks({ cheques: CHEQUES, company: COMPANY });
    assert.equal(Buffer.from(bytes).toString("latin1", 0, 5), "%PDF-");

    const doc = await reopen(bytes);
    assert.equal(doc.getPageCount(), 2);
    const [page] = doc.getPages();
    /* US Letter. Cheque stock is cut to it, and a page of another size feeds
       crooked or not at all. */
    assert.equal(Math.round(page.getWidth()), 612);
    assert.equal(Math.round(page.getHeight()), 792);
  });

  test("it draws no MICR line, and cannot start to", async () => {
    /* Deliberate, and asserted on the source rather than the output. The
       MICR line needs the E-13B typeface and magnetic toner; drawn in an
       ordinary font it looks right to a person, is unreadable by the machine
       that matters, and is rejected or charged as a manual item. The stock
       carries it.

       Checking the source is what catches somebody adding it later, which is
       the real risk — it would look like an improvement. */
    const src = readFileSync(new URL("../server/lib/checks.js", import.meta.url), "utf8");

    const fonts = [...src.matchAll(/StandardFonts\.(\w+)/g)].map((m) => m[1]);
    assert.ok(fonts.length > 0, "it embeds some font");
    for (const f of fonts) {
      assert.match(f, /^Helvetica/, `${f} is not a font this should be using`);
    }
    assert.ok(!/embedFont\s*\(\s*(?!StandardFonts)/.test(src),
      "a custom font is being embedded — if that is E-13B, read the note at the top of checks.js");

    for (const glyph of ["\u2446", "\u2447", "\u2448", "\u2449"]) {
      assert.ok(!src.includes(glyph), "a MICR glyph is in the source");
    }

    const bytes = await buildChecks({ cheques: CHEQUES, company: COMPANY });
    assert.equal((await reopen(bytes)).getPageCount(), 2, "and it still produces cheques");
  });

  test("a name the font cannot encode does not kill the run", async () => {
    /* pdf-lib's standard fonts are WinAnsi and throw on anything outside it.
       One Cyrillic payee would otherwise fail the whole batch — wrong at
       cheque forty, discovered after the stock is loaded. */
    const bytes = await buildChecks({
      cheques: [
        { number: 1, date: "2026-10-05", payee: "\u041f\u0451\u0442\u0440 \u0418\u0432\u0430\u043d\u043e\u0432", amountCents: 1000 },
        { number: 2, date: "2026-10-05", payee: "Ruth Calloway", amountCents: 2000 },
      ],
      company: COMPANY,
    });
    assert.equal((await reopen(bytes)).getPageCount(), 2, "both cheques printed");
  });

  test("a name is printed properly where the font can, and approximated where it cannot", () => {
    /* Deliberately different from the ACH file, which is strict ASCII and
       has to flatten everything. A printed cheque can carry the accents
       WinAnsi holds, so it does — the payee's name is spelt correctly on the
       thing they take to the bank. */
    assert.equal(printable("Ståhl"), "Ståhl", "WinAnsi has å");
    assert.equal(printable("Sønner"), "Sønner", "and ø");
    assert.equal(printable("Plain Name"), "Plain Name");

    /* Outside it, a readable approximation rather than an exception that
       fails the whole run. */
    assert.equal(printable("Łukasz"), "Lukasz", "Ł is not in WinAnsi");
    assert.equal(printable("Пётр"), "????", "unmappable, but visible and fixable");
  });

  test("a cheque with no payee is refused", async () => {
    await assert.rejects(
      () => buildChecks({ cheques: [{ ...CHEQUES[0], payee: "  " }], company: COMPANY }),
      /no payee/i);
  });

  test("a cheque with no amount is refused, and names who it was for", async () => {
    await assert.rejects(
      () => buildChecks({ cheques: [{ ...CHEQUES[0], amountCents: 0 }], company: COMPANY }),
      /Ruth Calloway.*no amount/s);
  });

  test("an empty run is refused", async () => {
    await assert.rejects(() => buildChecks({ cheques: [], company: COMPANY }), /not a run/i);
  });

  test("the layout is adjustable, because stock differs between suppliers", async () => {
    /* Two runs differing only in where the payee prints must differ as
       documents; if the layout parameter were ignored they would be
       byte-identical apart from the timestamp. */
    const at = (bytes) => Buffer.from(bytes).toString("latin1");
    const moved = await buildChecks({
      cheques: [CHEQUES[0]], company: COMPANY,
      layout: { payee: { x: 120, y: 600, size: 12 } },
    });
    const normal = await buildChecks({ cheques: [CHEQUES[0]], company: COMPANY });
    assert.notEqual(at(moved).length, at(normal).length);
    assert.equal((await reopen(moved)).getPageCount(), 1);
  });

  test("a long stub is cut off with a pointer to the full statement", async () => {
    /* Rather than running off the page or over the next field. */
    const many = {
      ...CHEQUES[0],
      lines: Array.from({ length: 40 }, (_, i) => ({ label: `Line ${i}`, amountCents: 100 })),
    };
    const bytes = await buildChecks({ cheques: [many], company: COMPANY });
    assert.equal((await reopen(bytes)).getPageCount(), 1, "it does not spill onto a second page");
  });

  test("an alignment sheet can be printed before committing to stock", async () => {
    const bytes = await buildAlignmentSheet({ company: COMPANY });
    assert.equal(Buffer.from(bytes).toString("latin1", 0, 5), "%PDF-");
    assert.equal((await reopen(bytes)).getPageCount(), 1);
  });

  test("the default layout keeps every field on the page", () => {
    /* A field at a negative coordinate, or above the paper, prints nowhere
       and takes its data with it. */
    for (const [name, at] of Object.entries(DEFAULT_LAYOUT)) {
      const spots = Array.isArray(at) ? at : [at];
      for (const s of spots) {
        assert.ok(s.x >= 0 && s.x <= 612, `${name} x is off the page`);
        assert.ok(s.y >= 0 && s.y <= 792, `${name} y is off the page`);
      }
    }
  });
});

describe("the positive-pay register", () => {
  test("it lists what was issued, so the bank can refuse the rest", () => {
    const csv = positivePayCsv({ cheques: CHEQUES, account: "000123456789" });
    const rows = csv.trim().split("\r\n");
    assert.equal(rows.length, 3, "a header and two cheques");
    assert.equal(rows[0], "account,checkNumber,amount,issueDate,payee,status");
    assert.equal(rows[1], "000123456789,1041,4867.75,10/05/2026,Ruth Calloway,I");
  });

  test("the amount has no symbol and no separators", () => {
    /* The single most common reason a bank rejects one of these files. */
    const csv = positivePayCsv({ cheques: CHEQUES, account: "1" });
    assert.ok(!csv.includes("$"));
    assert.ok(!/\d,\d{3}\.\d\d/.test(csv), "no thousands separator inside an amount");
    assert.match(csv, /,4867\.75,/);
  });

  test("a payee with a comma does not become two columns", () => {
    const csv = positivePayCsv({
      cheques: [{ ...CHEQUES[0], payee: "Calloway, Ruth" }], account: "1",
    });
    assert.match(csv, /"Calloway, Ruth"/);
    assert.equal(csv.trim().split("\r\n")[1].split(",").length, 7,
      "quoted, so the comma inside stays inside");
  });

  test("a payee with a quote is escaped, not dropped", () => {
    const csv = positivePayCsv({
      cheques: [{ ...CHEQUES[0], payee: 'The "Big" Company' }], account: "1",
    });
    assert.match(csv, /"The ""Big"" Company"/);
  });

  test("a newline in a payee cannot break the row", () => {
    const csv = positivePayCsv({
      cheques: [{ ...CHEQUES[0], payee: "Ruth\nCalloway" }], account: "1",
    });
    assert.equal(csv.trim().split("\r\n").length, 2, "still one header and one row");
  });

  test("a voided cheque is marked so the bank withdraws it", () => {
    const csv = positivePayCsv({
      cheques: [{ ...CHEQUES[0], void: true }], account: "1",
    });
    assert.match(csv, /,V\r?\n?$/m);
  });

  test("the date format follows the bank, because they disagree", () => {
    for (const [format, expected] of [
      ["MM/DD/YYYY", "10/05/2026"],
      ["YYYY-MM-DD", "2026-10-05"],
      ["YYYYMMDD", "20261005"],
    ]) {
      const csv = positivePayCsv({ cheques: [CHEQUES[0]], account: "1", dateFormat: format });
      assert.ok(csv.includes(expected), `${format} produced neither ${expected}`);
    }
  });

  test("the column order follows the bank too", () => {
    const csv = positivePayCsv({
      cheques: [CHEQUES[0]], account: "1",
      columns: ["checkNumber", "issueDate", "amount", "payee"],
    });
    assert.equal(csv.trim().split("\r\n")[0], "checkNumber,issueDate,amount,payee");
    assert.equal(csv.trim().split("\r\n")[1], "1041,10/05/2026,4867.75,Ruth Calloway");
  });

  test("rows end CRLF", () => {
    assert.ok(positivePayCsv({ cheques: CHEQUES, account: "1" }).endsWith("\r\n"));
  });
});

describe("file names", () => {
  test("they say who, what and when", () => {
    assert.equal(
      checkFileName({ companyName: "Leafridge Property Management", date: "2026-10-05" }),
      "leafridge-property-management-cheques-20261005.pdf");
    assert.equal(
      checkFileName({ companyName: "Leafridge", date: "2026-10-05", kind: "positive-pay", extension: "csv" }),
      "leafridge-positive-pay-20261005.csv");
  });
});
