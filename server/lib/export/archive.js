/* Everything a company has, in one archive they can open without us.

   ## What "everything" means here

   Every table named in `tables.js`, as CSV, one file per table with its
   columns as the database spells them. Plus the uploaded files themselves —
   the photographs on a work order, the receipts, the certificates of
   insurance — because a row saying `2026-03/a7f2.jpg` is not a copy of a
   photograph.

   Raw tables rather than tidied-up reports, deliberately. A report is a view
   with decisions baked into it, and the decisions are ours. What somebody
   needs when they leave is the record, in the shape it is held, so that
   whoever they move to can map it themselves.

   ## The README is part of the deliverable

   It says what is in the archive, what was left out and why, and which files
   could not be read. A customer who finds out six months later that their
   receipts were not in it has been misled by an export that looked complete.

   ## Memory, and where this stops working

   The uploaded files are read one at a time and the zip writer yields as it
   goes, so a thousand photographs cost one photograph.

   The **table data is not** streamed, and that is a deliberate trade against
   the snapshot below: all of it is read inside one transaction, which means
   all of it is held until the archive is written. For a portfolio of a few
   thousand units that is tens of megabytes and fine. For one with millions of
   journal splits it is not, and the answer there is a background job that
   builds the archive into blob storage and emails a link — not a bigger
   buffer. Written down rather than discovered, because the shape of the fix
   is different from the shape of this code and pretending otherwise is how a
   feature quietly stops working at the size where it matters most. */
import { all, get, tx } from "../db.js";
import { BOM, csvRow } from "../csv.js";
import { zipStream } from "../zip.js";
import { TABLES, FILE_COLUMNS, skipped } from "./tables.js";
import { stamp } from "../dates.js";

/* A stored path is either a key under the upload directory or an absolute
   URL at the blob store, depending on where this instance keeps them. */
/* The blob store, and only the blob store.

   Every value this reads was written by `storeUpload`, so today it can only
   be a URL at the blob host or a key under the upload directory. The check is
   here anyway: this function turns a database column into an outbound request,
   and the day something else writes that column is not the day to find out
   what it fetches. */
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

async function readStored(stored) {
  if (/^https?:\/\//.test(stored)) {
    const url = new URL(stored);
    if (url.protocol !== "https:" || !BLOB_HOST.test(url.hostname)) {
      throw new Error("that is not an address this application stores files at");
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the file store answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { UPLOAD_DIR } = await import("../files.js");
  /* A stored key is written by this application and never by a person, but
     it is still read out of a database and joined onto a path, so it is
     checked rather than trusted. */
  if (stored.includes("..") || stored.startsWith("/")) {
    throw new Error("that is not a path this application wrote");
  }
  return await readFile(join(UPLOAD_DIR, stored));
}

/* The columns a table actually has, in the order the database holds them,
   minus anything the policy withholds. Read from the catalogue rather than
   from the first row, so an empty table still exports its headings. */
async function columnsOf(table, redact = []) {
  const rows = await all(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?
      ORDER BY ordinal_position`, table);
  const hidden = new Set(redact);
  return rows.map((r) => r.column_name).filter((c) => !hidden.has(c));
}

async function rowsOf(table, spec, companyId) {
  const columns = await columnsOf(table, spec.redact || []);
  if (!columns.length) return { columns, rows: [] };
  const list = columns.map(quoteIdent).join(", ");

  if (spec.by === "self") {
    return { columns, rows: await all(`SELECT ${list} FROM company WHERE id = ?`, companyId) };
  }
  if (spec.by === "company") {
    return { columns, rows: await all(
      `SELECT ${list} FROM ${quoteIdent(table)} WHERE company_id = ?`, companyId) };
  }
  /* A child table with no company of its own: take the rows whose parent is
     theirs. One level is enough everywhere in this schema — no child of a
     child carries records rather than pointers. */
  const parentKey = spec.parentKey || "id";
  return { columns, rows: await all(
    `SELECT ${list} FROM ${quoteIdent(table)}
      WHERE ${quoteIdent(spec.on)} IN (
        SELECT ${quoteIdent(parentKey)} FROM ${quoteIdent(spec.parent)} WHERE company_id = ?)`,
    companyId) };
}

/* Every identifier here comes from this application's own policy file or
   from the database's catalogue, never from a request. Quoted anyway, and
   doubled rather than trusted, because "it cannot reach here" is a property
   of today's call sites rather than of this function. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableCsv(columns, rows) {
  const lines = [csvRow(columns)];
  for (const row of rows) lines.push(csvRow(columns.map((c) => row[c])));
  return BOM + lines.join("\r\n") + "\r\n";
}

/* --- the files -------------------------------------------------------------- */

/* Every upload this company owns, as `{ stored, name, table, recordId }`.
   Named inside the archive by the record it belongs to, so a folder of a
   thousand photographs is navigable rather than a heap of ids. */
async function fileList(companyId) {
  const out = [];

  for (const { table, column, folder } of FILE_COLUMNS) {
    const spec = TABLES[table];
    if (!spec || spec.skip) continue;

    let rows;
    if (spec.by === "self") {
      rows = await all(
        `SELECT id, ${quoteIdent(column)} AS stored FROM company
          WHERE id = ? AND ${quoteIdent(column)} IS NOT NULL`, companyId);
    } else if (spec.by === "company") {
      rows = await all(
        `SELECT id, ${quoteIdent(column)} AS stored FROM ${quoteIdent(table)}
          WHERE company_id = ? AND ${quoteIdent(column)} IS NOT NULL`, companyId);
    } else {
      const parentKey = spec.parentKey || "id";
      rows = await all(
        `SELECT id, ${quoteIdent(column)} AS stored FROM ${quoteIdent(table)}
          WHERE ${quoteIdent(column)} IS NOT NULL
            AND ${quoteIdent(spec.on)} IN (
              SELECT ${quoteIdent(parentKey)} FROM ${quoteIdent(spec.parent)} WHERE company_id = ?)`,
        companyId);
    }

    /* Named after the record rather than after the stored key, so a folder
       of a thousand photographs can be traced back to what it is a
       photograph of. One upload attached to two records is written twice,
       which is what each of those records needs. */
    for (const row of rows) {
      out.push({
        stored: row.stored, table, column, recordId: row.id,
        name: `${folder}/${row.id}${extensionOf(row.stored)}`,
      });
    }
  }
  return out;
}

function extensionOf(stored) {
  const clean = String(stored).split("?")[0];
  const match = /\.([a-z0-9]{1,5})$/i.exec(clean);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/* --- the archive ------------------------------------------------------------ */

/* Yields the bytes of a ZIP. `onProblem` is called with anything that could
   not be read, and whatever it collects ends up in the README — which is why
   the README is written last. */
export async function* exportArchive({ companyId, requestedBy = null, now = () => new Date() }) {
  const company = await get("SELECT * FROM company WHERE id = ?", companyId);
  if (!company) throw new Error("There is no company with that id.");

  const tableEntries = [];
  const counts = [];
  let files = [];

  /* One snapshot for all of it.

     Sixty-odd sequential reads at the default isolation see sixty-odd
     different moments, and a portfolio in use during an export would produce
     an archive whose files do not agree: a lease naming a journal that is not
     in journal.csv because it was posted between the two queries. Nobody
     would notice until they tried to load it somewhere.

     The uploaded files are read afterwards, outside this, because fetching a
     thousand photographs is not something to hold a database connection
     open for. A file that moves in between is reported in the README as one
     that could not be read, which is what it is. */
  await tx(async () => {
    for (const [table, spec] of Object.entries(TABLES)) {
      if (spec.skip) continue;
      const { columns, rows } = await rowsOf(table, spec, companyId);
      counts.push({ table, rows: rows.length, redacted: spec.redact || [] });
      tableEntries.push({ name: `data/${table}.csv`, data: tableCsv(columns, rows) });
    }
    files = await fileList(companyId);
    /* The phrase Postgres wants, in full: `BEGIN repeatable read` is a syntax
       error, and `read only` is here because an export has no business
       writing and this is free. */
  }, { isolation: "isolation level repeatable read read only" });
  const problems = [];

  /* The README depends on what went wrong reading the files, and a ZIP's
     entries are written in order — so the files are read first, into the
     archive, and the README goes last. A reader does not care about the
     order; a person opening it does not either, because every extractor
     lists by name. */
  const fileEntries = files.map((f) => ({
    name: f.name,
    read: async () => {
      try {
        return await readStored(f.stored);
      } catch (err) {
        problems.push({ name: f.name, stored: f.stored, why: String(err.message).slice(0, 200) });
        /* An entry that stands in for the file, rather than an archive that
           fails halfway through because one photograph is missing. */
        return Buffer.from(
          `This file could not be read when the export ran.\r\n`
          + `Stored as: ${f.stored}\r\n`
          + `Reason: ${String(err.message).slice(0, 200)}\r\n`, "utf8");
      }
    },
  }));

  const indexEntry = {
    name: "files/index.csv",
    data: BOM + [
      csvRow(["archive_path", "stored_path", "table", "column", "record_id"]),
      ...files.map((f) => csvRow([f.name, f.stored, f.table, f.column, f.recordId])),
    ].join("\r\n") + "\r\n",
  };

  /* A function rather than a value, so it is built after the files have been
     read and can say which of them could not be. */
  const readme = {
    name: "README.txt",
    read: () => Buffer.from(
      readmeText({ company, counts, files, problems, requestedBy, at: now() }), "utf8"),
  };

  yield* zipStream([...tableEntries, indexEntry, ...fileEntries, readme], { now });
}

function readmeText({ company, counts, files, problems, requestedBy, at }) {
  const lines = [];
  const rule = "-".repeat(72);

  lines.push(`${company.name} — a copy of everything`);
  lines.push(rule);
  lines.push("");
  lines.push(`Made on ${at.toISOString().slice(0, 10)}${requestedBy ? ` at the request of ${requestedBy}` : ""}.`);
  lines.push("");
  lines.push("This archive is your data as it is held, not as a report renders it.");
  lines.push("Each file under data/ is one database table, with its columns named as");
  lines.push("the database names them. Amounts are in cents, as integers, because that");
  lines.push("is how they are stored and rounding them here would be a decision we do");
  lines.push("not get to make on your behalf.");
  lines.push("");
  lines.push("Dates are ISO-8601 (YYYY-MM-DD). Timestamps are UTC.");
  lines.push("");

  lines.push("WHAT IS IN IT");
  lines.push(rule);
  for (const c of counts) {
    const note = c.redacted.length ? `   (without: ${c.redacted.join(", ")})` : "";
    lines.push(`  data/${c.table}.csv`.padEnd(42) + String(c.rows).padStart(8)
      + (c.rows === 1 ? " row " : " rows") + note);
  }
  lines.push("");
  lines.push("  files/".padEnd(42) + String(files.length).padStart(8)
    + (files.length === 1 ? " uploaded file" : " uploaded files")
    + ", listed in files/index.csv");
  lines.push("");

  lines.push("WHAT IS NOT, AND WHY");
  lines.push(rule);
  lines.push("Some columns and tables are left out. None of them is a figure, a date or");
  lines.push("a record of something that happened — those are all here. What is missing");
  lines.push("is credentials and other people's keys:");
  lines.push("");
  for (const s of skipped()) {
    lines.push(`  ${s.name}`);
    lines.push(`      ${s.why}`);
  }
  lines.push("");
  const redactedTables = counts.filter((c) => c.redacted.length);
  if (redactedTables.length) {
    lines.push("And these columns, from tables that are otherwise complete:");
    lines.push("");
    for (const c of redactedTables) {
      lines.push(`  ${c.table}: ${c.redacted.join(", ")}`);
    }
    lines.push("");
  }

  if (problems.length) {
    lines.push("FILES THAT COULD NOT BE READ");
    lines.push(rule);
    lines.push("These are in the archive as a note saying what happened, rather than");
    lines.push("silently absent. If you need them, ask before this archive is your only");
    lines.push("copy.");
    lines.push("");
    for (const p of problems) {
      lines.push(`  ${p.name}`);
      lines.push(`      stored as ${p.stored}`);
      lines.push(`      ${p.why}`);
    }
    lines.push("");
  } else if (files.length) {
    lines.push("Every uploaded file was read and is in this archive.");
    lines.push("");
  }

  lines.push("HOW THE TABLES JOIN");
  lines.push(rule);
  lines.push("  property.owner_id      -> owner.id");
  lines.push("  unit.property_id       -> property.id");
  lines.push("  lease.unit_id          -> unit.id");
  lines.push("  lease_tenant           -> lease.id and tenant.id");
  lines.push("  journal_split.journal_id -> journal.id      (the double-entry book)");
  lines.push("  ledger_entry.journal_id  -> journal.id      (what each owner is shown)");
  lines.push("  work_order.unit_id     -> unit.id");
  lines.push("  files/index.csv        -> the row each uploaded file belongs to");
  lines.push("");
  lines.push(`Exported ${stamp()}.`);
  lines.push("");
  return lines.join("\r\n");
}
