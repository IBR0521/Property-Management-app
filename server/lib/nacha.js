/* NACHA ACH files.

   The property manager uploads this to their own bank, and the bank moves the
   money. Nothing here touches funds — it produces a text file, which is the
   whole point: the platform is never the custodian, so the payout path ends
   at a file the company hands to their own institution.

   The format is published, fixed-width and unforgiving. Every record is
   exactly 94 characters, fields are positional, numeric fields are
   zero-filled on the left and alphanumeric fields space-filled on the right,
   and the file is padded with 9s to a multiple of ten records. A file one
   character out is rejected in full, usually with a message that names the
   line and nothing else.

   Written by hand rather than with a library because it is string padding and
   two checksums, and a dependency for that would be silly.

   **What this cannot tell you.** Whether a specific bank accepts a specific
   file is unknowable from here: ODFI onboarding, the company identification
   they assign, which SEC codes they permit, and whether they want balanced or
   unbalanced files are all per-institution. The offsets below are checked
   against the published record layouts and the arithmetic against a
   hand-computed fixture. The first real upload is the real test, and it is in
   OPEN-ITEMS. */

const RECORD_LENGTH = 94;
const BLOCKING_FACTOR = 10;

/* Credit to a checking account, credit to savings, and the prenote variants.
   Prenotes are zero-dollar entries sent ahead of the first real payment to
   let the receiving bank confirm the account exists — cheaper than a return
   and how a careful company opens an account relationship. */
export const TRANSACTION_CODES = {
  checking_credit: "22",
  checking_prenote: "23",
  savings_credit: "32",
  savings_prenote: "33",
  checking_debit: "27",
  savings_debit: "37",
};

/* --- field helpers ---------------------------------------------------------

   Truncation is deliberate and silent for names, which are display data, and
   refused for anything the money depends on. A truncated account number is a
   payment to nobody, or worse, to somebody. */
/* Letters that carry their mark inside the glyph rather than as a separate
   combining character, so NFD leaves them whole and they would otherwise
   become spaces — a vendor called "Sønner" appearing on a bank file as
   "S NNER". Latin only, and only the ones a US payee list actually turns up. */
const TRANSLITERATE = {
  "Ø": "O", "Æ": "AE", "Đ": "D", "Ð": "D", "Þ": "TH",
  "Ł": "L", "Ĳ": "IJ", "ß": "SS", "Œ": "OE",
};

function alpha(value, width) {
  return String(value ?? "")
    .toUpperCase()
    /* The format is ASCII. A vendor called "Ståhl & Sønner" becomes something
       a bank can read rather than something it rejects. Accents decompose and
       are dropped; the handful of letters that do not decompose are mapped
       above rather than blanked. */
    .replace(/[ØÆĐÐÞŁĲßŒ]/g, (c) => TRANSLITERATE[c])
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .slice(0, width)
    .padEnd(width, " ");
}

function numeric(value, width, { field = "field" } = {}) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length > width) {
    throw new Error(`${field} is ${digits.length} digits and the format allows ${width}.`);
  }
  return digits.padStart(width, "0");
}

function blank(width) {
  return " ".repeat(width);
}

/* The ninth digit of a routing number, derived from the first eight. A typo
   in a routing number is otherwise indistinguishable from a real one, and
   this catches most of them before the file leaves the building. */
export function routingCheckDigit(first8) {
  const digits = String(first8).replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) throw new Error("A routing number needs at least 8 digits.");
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = digits.split("").reduce((n, d, i) => n + Number(d) * weights[i], 0);
  return String((10 - (sum % 10)) % 10);
}

export function validRoutingNumber(routing) {
  const digits = String(routing ?? "").replace(/\D/g, "");
  if (digits.length !== 9) return false;
  return routingCheckDigit(digits.slice(0, 8)) === digits[8];
}

/* YYMMDD and HHMM, in the company's own reckoning. The file carries no
   timezone, so what matters is that the effective date is a banking day the
   originating institution will accept. */
function yymmdd(isoDate) {
  const d = String(isoDate || "").slice(0, 10).replace(/-/g, "");
  if (d.length !== 8) throw new Error(`"${isoDate}" is not a date the file can carry.`);
  return d.slice(2);
}

function hhmm(date = new Date()) {
  return String(date.getUTCHours()).padStart(2, "0") + String(date.getUTCMinutes()).padStart(2, "0");
}

/* --- records ---------------------------------------------------------------

   Each builder returns exactly 94 characters and each asserts it, because a
   short record is the failure that is hardest to see by eye and the one a
   bank rejects the whole file for. */
function fixed(parts, name) {
  const line = parts.join("");
  if (line.length !== RECORD_LENGTH) {
    throw new Error(`${name} came out ${line.length} characters, not ${RECORD_LENGTH}.`);
  }
  return line;
}

function fileHeader({ destinationRouting, originId, destinationName, originName, createdAt, idModifier }) {
  return fixed([
    "1",                                   // record type
    "01",                                  // priority code
    " " + numeric(destinationRouting, 9, { field: "destination routing number" }),
    originField(originId),
    yymmdd(createdAt.slice(0, 10)),
    hhmm(new Date(createdAt)),
    alpha(idModifier || "A", 1),
    "094",                                 // record size
    "10",                                  // blocking factor
    "1",                                   // format code
    alpha(destinationName, 23),
    alpha(originName, 23),
    blank(8),                              // reference code, for the originator's use
  ], "file header");
}

/* Immediate origin is ten characters, and banks disagree about what goes in
   them: some want the company's ten-digit IRS number, others a blank followed
   by the ODFI's nine-digit routing number. Both are accepted here, because
   which one to send is a question for the bank rather than something to
   decide on their behalf. */
function originField(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 9) return " " + digits;
  throw new Error(
    `Immediate origin "${value}" is ${digits.length} digits; the format takes a `
    + `ten-digit company number or a nine-digit routing number.`);
}

function batchHeader({
  serviceClass, companyName, discretionary, companyId, entryClass,
  entryDescription, descriptiveDate, effectiveDate, odfiId, batchNumber,
}) {
  return fixed([
    "5",
    serviceClass,
    alpha(companyName, 16),
    alpha(discretionary, 20),
    alpha(companyId, 10),
    alpha(entryClass, 3),
    alpha(entryDescription, 10),
    alpha(descriptiveDate || "", 6),
    yymmdd(effectiveDate),
    blank(3),                              // settlement date: the ACH operator fills this
    "1",                                   // originator status code
    numeric(odfiId, 8, { field: "originating DFI identification" }),
    numeric(batchNumber, 7),
  ], "batch header");
}

function entryDetail({
  transactionCode, routing, accountNumber, amountCents,
  individualId, individualName, traceNumber, addenda = false,
}) {
  const routingDigits = numeric(routing, 9, { field: "receiving routing number" });
  return fixed([
    "6",
    transactionCode,
    routingDigits.slice(0, 8),
    routingDigits.slice(8, 9),
    /* Account numbers are alphanumeric in the format and left-justified.
       Stripping to digits would mangle the ones that legitimately are not. */
    alpha(accountNumber, 17),
    numeric(Math.round(amountCents), 10, { field: "amount" }),
    alpha(individualId, 15),
    alpha(individualName, 22),
    blank(2),                              // discretionary data
    addenda ? "1" : "0",
    numeric(traceNumber, 15),
  ], "entry detail");
}

function batchControl({
  serviceClass, entryCount, entryHash, debitCents, creditCents,
  companyId, odfiId, batchNumber,
}) {
  return fixed([
    "8",
    serviceClass,
    numeric(entryCount, 6),
    numeric(entryHash, 10),
    numeric(debitCents, 12, { field: "batch debit total" }),
    numeric(creditCents, 12, { field: "batch credit total" }),
    alpha(companyId, 10),
    blank(19),                             // message authentication code
    blank(6),                              // reserved
    numeric(odfiId, 8),
    numeric(batchNumber, 7),
  ], "batch control");
}

function fileControl({ batchCount, blockCount, entryCount, entryHash, debitCents, creditCents }) {
  return fixed([
    "9",
    numeric(batchCount, 6),
    numeric(blockCount, 6),
    numeric(entryCount, 8),
    numeric(entryHash, 10),
    numeric(debitCents, 12, { field: "file debit total" }),
    numeric(creditCents, 12, { field: "file credit total" }),
    blank(39),                             // reserved
  ], "file control");
}

/* The entry hash: the receiving DFI identifications added together, keeping
   only the rightmost ten digits. It is a checksum rather than a sum — it
   overflows on purpose, and a file that computes it as a real total is
   rejected. */
function hashOf(routingNumbers) {
  const total = routingNumbers.reduce(
    (n, r) => n + Number(String(r).replace(/\D/g, "").slice(0, 8)), 0);
  return String(total).slice(-10);
}

/* --- the file --------------------------------------------------------------

   One batch, because that is what a payout run is: one company paying a set
   of owners or vendors on one effective date, under one entry class. A file
   with several batches is a thing banks accept and nothing here needs.

   `entries` are already-vetted payees. This does no compliance checking of
   its own — the workers' compensation barrier lives in `assertPayable()` and
   is applied before anything reaches here, because a rule enforced in two
   places is a rule that will eventually be enforced in one. */
export function buildFile({
  entries,
  company,               // { name, id, routing, account, accountType }
  bank,                  // { routing, name }
  effectiveDate,
  entryClass = "CCD",    // CCD for businesses, PPD for individuals
  entryDescription = "PAYMENT",
  descriptiveDate = null,
  createdAt = new Date().toISOString(),
  idModifier = "A",
  offsetEntry = false,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("An ACH file with no entries is not a file anybody wants.");
  }
  if (!validRoutingNumber(bank?.routing)) {
    throw new Error(`"${bank?.routing}" is not a valid routing number — its check digit does not match.`);
  }

  for (const e of entries) {
    if (!validRoutingNumber(e.routing)) {
      throw new Error(
        `${e.name || "An entry"} has routing number "${e.routing}", whose check digit does not match. `
        + `This is almost always a typo, and the bank would reject the whole file.`);
    }
    if (!String(e.account || "").trim()) {
      throw new Error(`${e.name || "An entry"} has no account number.`);
    }
    if (!(Math.round(Number(e.amountCents)) > 0)) {
      throw new Error(`${e.name || "An entry"} has no amount. A zero-dollar entry is a prenote, sent separately.`);
    }
  }

  const odfiId = String(bank.routing).replace(/\D/g, "").slice(0, 8);
  const lines = [];

  lines.push(fileHeader({
    destinationRouting: bank.routing,
    originId: company.id || bank.routing,
    destinationName: bank.name || "BANK",
    originName: company.name,
    createdAt, idModifier,
  }));

  /* An offset entry is the debit that balances the credits — the money has to
     come from somewhere, and some banks want that stated in the file rather
     than taken from the account automatically. Which one a bank wants is a
     question for the bank, so it is a switch rather than a decision. */
  const serviceClass = offsetEntry ? "200" : "220";

  lines.push(batchHeader({
    serviceClass,
    companyName: company.name,
    discretionary: "",
    companyId: company.id || `1${String(bank.routing).replace(/\D/g, "").slice(0, 9)}`,
    entryClass, entryDescription, descriptiveDate,
    effectiveDate, odfiId, batchNumber: 1,
  }));

  let creditCents = 0;
  let debitCents = 0;
  const routings = [];
  let sequence = 0;

  for (const e of entries) {
    sequence += 1;
    const amount = Math.round(Number(e.amountCents));
    creditCents += amount;
    routings.push(e.routing);

    lines.push(entryDetail({
      transactionCode: e.transactionCode
        || (e.accountType === "savings" ? TRANSACTION_CODES.savings_credit : TRANSACTION_CODES.checking_credit),
      routing: e.routing,
      accountNumber: e.account,
      amountCents: amount,
      individualId: e.reference || "",
      individualName: e.name,
      traceNumber: `${odfiId}${String(sequence).padStart(7, "0")}`,
    }));
  }

  if (offsetEntry) {
    sequence += 1;
    debitCents = creditCents;
    routings.push(company.routing);
    lines.push(entryDetail({
      transactionCode: company.accountType === "savings"
        ? TRANSACTION_CODES.savings_debit : TRANSACTION_CODES.checking_debit,
      routing: company.routing,
      accountNumber: company.account,
      amountCents: creditCents,
      individualId: "OFFSET",
      individualName: company.name,
      traceNumber: `${odfiId}${String(sequence).padStart(7, "0")}`,
    }));
  }

  const entryHash = hashOf(routings);

  lines.push(batchControl({
    serviceClass, entryCount: sequence, entryHash,
    debitCents, creditCents,
    companyId: company.id || `1${String(bank.routing).replace(/\D/g, "").slice(0, 9)}`,
    odfiId, batchNumber: 1,
  }));

  /* Batch header, entries, batch control, file header and file control: the
     record count the block maths works from. */
  const recordsSoFar = lines.length + 1;
  const blockCount = Math.ceil(recordsSoFar / BLOCKING_FACTOR);

  lines.push(fileControl({
    batchCount: 1, blockCount, entryCount: sequence, entryHash, debitCents, creditCents,
  }));

  /* Padded to a whole number of blocks with lines of 9s. The blocking factor
     is not advisory: a file that ends mid-block is rejected. */
  while (lines.length % BLOCKING_FACTOR !== 0) {
    lines.push("9".repeat(RECORD_LENGTH));
  }

  return {
    /* CRLF, because the format predates everything else and banks' parsers
       are the same age. */
    text: lines.join("\r\n") + "\r\n",
    lines,
    totals: {
      entries: sequence, creditCents, debitCents, entryHash,
      blocks: blockCount, records: lines.length,
    },
  };
}

/* A name a person can find on a bank portal three weeks later. */
export function fileName({ companyName, effectiveDate, kind = "payouts" }) {
  const slug = String(companyName || "company").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `${slug}-${kind}-${String(effectiveDate).replace(/-/g, "")}.ach`;
}
