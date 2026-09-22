/* The ACH file a property manager uploads to their own bank.

   Fixed-width and unforgiving: every record is exactly 94 characters, fields
   are positional, and a file one character out is rejected in full — usually
   with a message that names a line number and nothing else. So the tests are
   about offsets and arithmetic rather than about behaviour, and they check
   the fields by slicing at the published positions rather than by matching
   text, because a field that has drifted two columns left still contains the
   right characters.

   What none of this can tell you is whether a *particular* bank accepts a
   particular file. Company identification, permitted SEC codes and whether
   they want balanced files are per-institution. That is in OPEN-ITEMS; this
   is the arithmetic. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFile, routingCheckDigit, validRoutingNumber, fileName, TRANSACTION_CODES,
} from "../server/lib/nacha.js";

/* Real-format routing numbers with correct check digits. Computed below in
   the check-digit tests rather than asserted on faith. */
const BANK = { routing: "021000021", name: "JPMORGAN CHASE" };
const COMPANY = {
  name: "Leafridge Property Management",
  id: "1234567890",
  routing: "021000021",
  account: "000123456789",
  accountType: "checking",
};

const ENTRIES = [
  { name: "Ruth Calloway", routing: "011401533", account: "5512345678", amountCents: 486775, reference: "OWN-001" },
  { name: "Okafor Holdings LLC", routing: "121000248", account: "987654321", amountCents: 220000, reference: "OWN-002" },
];

function build(over = {}) {
  return buildFile({
    entries: ENTRIES, company: COMPANY, bank: BANK,
    effectiveDate: "2026-10-05", entryClass: "PPD", entryDescription: "OWNER DIST",
    createdAt: "2026-09-22T14:35:00.000Z",
    ...over,
  });
}

/* Fields are 1-indexed in the published layouts; slicing is 0-indexed. */
const at = (line, from, to) => line.slice(from - 1, to);

describe("routing numbers", () => {
  test("the check digit is derived, not trusted", () => {
    /* A typo in a routing number is otherwise indistinguishable from a real
       one, and the money goes to a bank that is not expecting it. */
    assert.equal(routingCheckDigit("02100002"), "1");
    assert.equal(routingCheckDigit("01140153"), "3");
    assert.equal(routingCheckDigit("12100024"), "8");
  });

  test("a valid number passes and a transposition fails", () => {
    assert.equal(validRoutingNumber("021000021"), true);
    assert.equal(validRoutingNumber("021000012"), false, "last two digits swapped");
    assert.equal(validRoutingNumber("021000031"), false, "one digit out");
  });

  test("wrong lengths are refused rather than padded", () => {
    for (const bad of ["", "0210000", "0210000211", "abcdefghi", null, undefined]) {
      assert.equal(validRoutingNumber(bad), false, `${bad} should not pass`);
    }
  });

  test("a bad routing number stops the file, naming the payee", () => {
    /* The whole file would be rejected by the bank. Better to refuse here,
       where the message can say which payee to fix. */
    assert.throws(
      () => build({ entries: [{ ...ENTRIES[0], routing: "021000012" }] }),
      /Ruth Calloway.*check digit/s);
  });
});

describe("the shape of the file", () => {
  test("every record is exactly 94 characters", () => {
    const { lines } = build();
    for (const [i, line] of lines.entries()) {
      assert.equal(line.length, 94, `record ${i + 1} is ${line.length} characters`);
    }
  });

  test("it is padded to a whole number of ten-record blocks", () => {
    /* Not advisory. A file that ends mid-block is rejected. */
    const { lines } = build();
    assert.equal(lines.length % 10, 0);
    assert.equal(lines.length, 10, "header, batch header, 2 entries, 2 controls, 4 filler");
    for (const line of lines.slice(6)) {
      assert.equal(line, "9".repeat(94), "filler is a record of nines");
    }
  });

  test("a bigger run rolls onto a second block", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...ENTRIES[0], name: `Owner ${i}`, amountCents: 10000 + i,
    }));
    const { lines, totals } = build({ entries: many });
    assert.equal(lines.length, 20);
    assert.equal(totals.blocks, 2);
  });

  test("records appear in the order the format requires", () => {
    const { lines } = build();
    assert.equal(lines[0][0], "1", "file header");
    assert.equal(lines[1][0], "5", "batch header");
    assert.equal(lines[2][0], "6", "entry");
    assert.equal(lines[3][0], "6", "entry");
    assert.equal(lines[4][0], "8", "batch control");
    assert.equal(lines[5][0], "9", "file control");
  });

  test("lines end CRLF, because the parsers are as old as the format", () => {
    const { text } = build();
    assert.ok(text.endsWith("\r\n"));
    assert.equal(text.split("\r\n").length - 1, 10);
    assert.ok(!text.includes("\n\n"));
  });

  test("an empty run is refused rather than producing an empty file", () => {
    assert.throws(() => build({ entries: [] }), /no entries/i);
  });

  test("a zero amount is refused, because that is a prenote", () => {
    assert.throws(
      () => build({ entries: [{ ...ENTRIES[0], amountCents: 0 }] }),
      /prenote/i);
  });

  test("an entry with no account number is refused", () => {
    assert.throws(() => build({ entries: [{ ...ENTRIES[0], account: "  " }] }), /no account number/i);
  });
});

describe("the file header", () => {
  test("a nine-digit origin is blank-prefixed instead", () => {
    /* Banks disagree about this field: some want the company's ten-digit IRS
       number, others a blank plus the routing number. Both are accepted
       because which to send is a question for the bank. */
    const h = build({ company: { ...COMPANY, id: "021000021" } }).lines[0];
    assert.equal(at(h, 14, 23), " 021000021");
  });

  test("something that is neither length is refused", () => {
    assert.throws(
      () => build({ company: { ...COMPANY, id: "12345" } }),
      /ten-digit company number or a nine-digit routing number/);
  });

  test("its fields sit at the published offsets", () => {
    const h = build().lines[0];
    assert.equal(at(h, 1, 1), "1");
    assert.equal(at(h, 2, 3), "01", "priority code");
    assert.equal(at(h, 4, 13), " 021000021", "immediate destination, blank-prefixed");
    assert.equal(at(h, 14, 23), "1234567890", "immediate origin, a ten-digit company number");
    assert.equal(at(h, 24, 29), "260922", "creation date, YYMMDD");
    assert.equal(at(h, 30, 33), "1435", "creation time");
    assert.equal(at(h, 35, 37), "094", "record size");
    assert.equal(at(h, 38, 39), "10", "blocking factor");
    assert.equal(at(h, 40, 40), "1", "format code");
    assert.equal(at(h, 41, 63), "JPMORGAN CHASE".padEnd(23));
    assert.equal(at(h, 64, 86), "LEAFRIDGE PROPERTY MANA", "origin name, truncated to 23");
  });
});

describe("the batch header", () => {
  test("its fields sit at the published offsets", () => {
    const b = build().lines[1];
    assert.equal(at(b, 1, 1), "5");
    assert.equal(at(b, 2, 4), "220", "credits only");
    assert.equal(at(b, 5, 20), "LEAFRIDGE PROPER", "company name, 16");
    assert.equal(at(b, 41, 50), "1234567890", "company identification");
    assert.equal(at(b, 51, 53), "PPD", "standard entry class");
    assert.equal(at(b, 54, 63), "OWNER DIST", "entry description");
    assert.equal(at(b, 70, 75), "261005", "effective entry date");
    assert.equal(at(b, 76, 78), "   ", "settlement date is the operator's to fill");
    assert.equal(at(b, 79, 79), "1", "originator status");
    assert.equal(at(b, 80, 87), "02100002", "originating DFI, 8 digits");
    assert.equal(at(b, 88, 94), "0000001", "batch number");
  });

  test("PPD is for people and CCD for businesses", () => {
    assert.equal(at(build({ entryClass: "CCD" }).lines[1], 51, 53), "CCD");
  });
});

describe("an entry", () => {
  test("its fields sit at the published offsets", () => {
    const e = build().lines[2];
    assert.equal(at(e, 1, 1), "6");
    assert.equal(at(e, 2, 3), "22", "credit to a checking account");
    assert.equal(at(e, 4, 11), "01140153", "receiving DFI, first 8");
    assert.equal(at(e, 12, 12), "3", "its check digit");
    assert.equal(at(e, 13, 29), "5512345678".padEnd(17), "account, left-justified");
    assert.equal(at(e, 30, 39), "0000486775", "amount in cents, zero-filled");
    assert.equal(at(e, 40, 54), "OWN-001".padEnd(15), "individual id");
    assert.equal(at(e, 55, 76), "RUTH CALLOWAY".padEnd(22), "individual name");
    assert.equal(at(e, 79, 79), "0", "no addenda");
    assert.equal(at(e, 80, 94), "021000020000001", "trace: ODFI plus sequence");
  });

  test("trace numbers increment across the batch", () => {
    const { lines } = build();
    assert.equal(at(lines[2], 80, 94), "021000020000001");
    assert.equal(at(lines[3], 80, 94), "021000020000002");
  });

  test("a savings account gets a different transaction code", () => {
    const { lines } = build({
      entries: [{ ...ENTRIES[0], accountType: "savings" }],
    });
    assert.equal(at(lines[2], 2, 3), TRANSACTION_CODES.savings_credit);
  });

  test("an account number that is not all digits survives intact", () => {
    /* Some are genuinely alphanumeric, and stripping to digits would send the
       money somewhere else. */
    const { lines } = build({ entries: [{ ...ENTRIES[0], account: "GB-4471A" }] });
    assert.equal(at(lines[2], 13, 29), "GB-4471A".padEnd(17));
  });

  test("an accented name becomes something a bank can read", () => {
    const { lines } = build({ entries: [{ ...ENTRIES[0], name: "Ståhl & Sønner" }] });
    const name = at(lines[2], 55, 76);
    assert.equal(name, "STAHL & SONNER".padEnd(22));
    assert.ok(/^[\x20-\x7E]*$/.test(name), "ASCII only");
  });

  test("letters that do not decompose are mapped, not blanked", () => {
    /* NFD splits an "å" into a base and a combining ring, but an "ø" is a
       single character with the stroke built in — so it survives NFD and
       would become a space, printing "S NNER" on a bank file. */
    for (const [input, expected] of [
      ["Sønner", "SONNER"], ["Ægir Ltd", "AEGIR LTD"],
      ["Łukasz", "LUKASZ"], ["Straße Co", "STRASSE CO"],
    ]) {
      const { lines } = build({ entries: [{ ...ENTRIES[0], name: input }] });
      assert.equal(at(lines[2], 55, 76), expected.padEnd(22), input);
    }
  });

  test("a name in a script with no Latin form does not break the record", () => {
    /* It cannot be transliterated and must not be guessed at, but the record
       still has to be 94 characters and the payment still has to go. */
    const { lines } = build({ entries: [{ ...ENTRIES[0], name: "北京物业" }] });
    assert.equal(lines[2].length, 94);
    assert.ok(/^[\x20-\x7E]*$/.test(at(lines[2], 55, 76)));
  });

  test("a long name is truncated rather than pushing every later field along", () => {
    const { lines } = build({
      entries: [{ ...ENTRIES[0], name: "The Very Long Property Holdings Company Limited" }],
    });
    assert.equal(lines[2].length, 94);
    assert.equal(at(lines[2], 55, 76), "THE VERY LONG PROPERTY");
  });

  test("an amount too large for the field is refused, not silently truncated", () => {
    /* Ten digits is $99,999,999.99. Wrapping it would pay a wrong amount,
       which is worse than refusing. */
    assert.throws(
      () => build({ entries: [{ ...ENTRIES[0], amountCents: 100_000_000_00 }] }),
      /amount is 11 digits/);
  });
});

describe("the control records", () => {
  test("the batch control totals the batch", () => {
    const c = build().lines[4];
    assert.equal(at(c, 1, 1), "8");
    assert.equal(at(c, 2, 4), "220");
    assert.equal(at(c, 5, 10), "000002", "entry count");
    assert.equal(at(c, 21, 32), "000000000000", "no debits in a credits-only batch");
    assert.equal(at(c, 33, 44), "000000706775", "$4,867.75 + $2,200.00");
    assert.equal(at(c, 80, 87), "02100002");
  });

  test("the entry hash is a checksum, not a total", () => {
    /* The receiving DFI ids added together, rightmost ten digits kept. It
       overflows on purpose; a file that computes a real sum is rejected. */
    const expected = String(1140153 + 12100024).slice(-10);
    assert.equal(at(build().lines[4], 11, 20), expected.padStart(10, "0"));
    assert.equal(at(build().lines[5], 22, 31), expected.padStart(10, "0"),
      "and the file control repeats it");
  });

  test("the file control totals the file", () => {
    const f = build().lines[5];
    assert.equal(at(f, 1, 1), "9");
    assert.equal(at(f, 2, 7), "000001", "one batch");
    assert.equal(at(f, 8, 13), "000001", "one block");
    assert.equal(at(f, 14, 21), "00000002", "two entries");
    assert.equal(at(f, 32, 43), "000000000000", "debits");
    assert.equal(at(f, 44, 55), "000000706775", "credits");
    assert.equal(at(f, 56, 94), " ".repeat(39), "reserved");
  });

  test("the totals reconcile with what went in", () => {
    const { totals } = build();
    assert.equal(totals.entries, ENTRIES.length);
    assert.equal(totals.creditCents, ENTRIES.reduce((n, e) => n + e.amountCents, 0));
    assert.equal(totals.debitCents, 0);
  });
});

describe("a balanced file", () => {
  /* Some banks want the offsetting debit stated in the file rather than
     taking it from the account automatically. Which one is a question for the
     bank, so it is a switch rather than a decision. */
  test("it adds the offsetting debit and says the batch is mixed", () => {
    const { lines, totals } = build({ offsetEntry: true });
    assert.equal(at(lines[1], 2, 4), "200", "mixed debits and credits");

    const offset = lines[4];
    assert.equal(offset[0], "6");
    assert.equal(at(offset, 2, 3), "27", "debit to the company's checking account");
    assert.equal(at(offset, 40, 54), "OFFSET".padEnd(15));
    assert.equal(totals.debitCents, totals.creditCents, "it nets to zero");
  });

  test("and the controls carry both sides", () => {
    const { lines } = build({ offsetEntry: true });
    const control = lines.find((l) => l[0] === "8");
    assert.equal(at(control, 5, 10), "000003", "two credits and the offset");
    assert.equal(at(control, 21, 32), "000000706775", "debits");
    assert.equal(at(control, 33, 44), "000000706775", "credits");
  });

  test("an unbalanced file is the default, because most banks take it from the account", () => {
    assert.equal(at(build().lines[1], 2, 4), "220");
  });
});

describe("the file name", () => {
  test("it says who, what and when", () => {
    assert.equal(
      fileName({ companyName: "Leafridge Property Management", effectiveDate: "2026-10-05", kind: "owners" }),
      "leafridge-property-management-owners-20261005.ach");
  });

  test("it survives a company name that is mostly punctuation", () => {
    const name = fileName({ companyName: "!!! & ???", effectiveDate: "2026-10-05" });
    assert.match(name, /^[a-z0-9-]*-?payouts-20261005\.ach$/);
    assert.ok(!name.includes("!"));
  });
});
