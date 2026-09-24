/* Is this database sound?

   Written for the restore drill, and useful any time somebody wants an
   answer rather than a feeling: after a point-in-time recovery, after a
   migration, after a conversion that posted journals.

   ## Sound, not merely present

   A restore that brings the rows back is not the same as a restore that
   brings the *books* back. Row counts matching the dump tell you the copy
   worked; they tell you nothing about whether the ledger still balances,
   whether every owner-visible figure still has a journal behind it, or
   whether a file somebody's deposit dispute turns on is still there.

   So this asks the questions the application itself would refuse to be
   wrong about, and it asks them of every company:

     every journal balances
     the trial balance balances
     every ledger entry has a journal behind it
     every split's date matches its journal's
     the trust accounts reconcile against the subsidiary ledgers
     nothing references a row that is gone
     every uploaded file the database names is still readable

   The last one is the one a database backup cannot answer by itself, and it
   is the reason it is in this list. Supabase's point-in-time recovery covers
   Postgres. It does not cover Vercel Blob — the photographs, the receipts and
   the signed documents live somewhere else entirely, and a restore that
   brings back rows pointing at files that were deleted is a restore that
   looks complete and is not. */
import { all, get } from "./db.js";

/* Returns `{ ok, companies: [...], problems: [...] }`. Never throws for a
   finding: a verification that stops at the first problem tells you about one
   problem. */
export async function verifyDatabase({ checkFiles = false, log = () => {} } = {}) {
  const problems = [];
  const note = (severity, what, detail) => {
    problems.push({ severity, what, detail });
    log(`  ${severity === "error" ? "✗" : "!"} ${what}: ${detail}`);
  };

  const companies = await all("SELECT id, name FROM company ORDER BY name");
  log(`${companies.length} compan${companies.length === 1 ? "y" : "ies"}`);

  /* --- the books ---------------------------------------------------------- */

  const unbalanced = await all(
    `SELECT j.company_id, COUNT(*)::int AS n FROM (
       SELECT s.journal_id, SUM(s.debit_cents) AS d, SUM(s.credit_cents) AS c
         FROM journal_split s GROUP BY s.journal_id
        HAVING SUM(s.debit_cents) <> SUM(s.credit_cents)) AS bad
       JOIN journal j ON j.id = bad.journal_id
      GROUP BY j.company_id`);
  for (const row of unbalanced) {
    note("error", "a journal does not balance",
      `${row.n} in company ${row.company_id} — the database refuses these on the way in, `
      + "so finding one means the data did not come through this application");
  }

  const trial = await all(
    `SELECT j.company_id, SUM(s.debit_cents - s.credit_cents)::bigint AS net
       FROM journal_split s JOIN journal j ON j.id = s.journal_id
      GROUP BY j.company_id HAVING SUM(s.debit_cents - s.credit_cents) <> 0`);
  for (const row of trial) {
    note("error", "the trial balance does not balance",
      `company ${row.company_id} is out by ${row.net} cents`);
  }

  const orphanEntries = await all(
    `SELECT company_id, COUNT(*)::int AS n FROM ledger_entry
      WHERE journal_id IS NULL GROUP BY company_id`);
  for (const row of orphanEntries) {
    note("error", "owner-visible money with no journal behind it",
      `${row.n} ledger entr${row.n === 1 ? "y" : "ies"} in company ${row.company_id}`);
  }

  /* The copy that migration 046 made, checked rather than assumed. */
  const dateDrift = await get(
    `SELECT COUNT(*)::int AS n FROM journal_split s
       JOIN journal j ON j.id = s.journal_id
      WHERE s.date IS DISTINCT FROM j.date`);
  if (Number(dateDrift.n)) {
    note("error", "a split's date disagrees with its journal's",
      `${dateDrift.n} of them — every report filters on the copy`);
  }

  /* --- the trust position -------------------------------------------------- */

  /* Not every variance means the same thing, and treating them alike would
     make this tool cry wolf.

     Two of the four depend on facts outside the books — what the bank says,
     and what somebody typed on a lease. They go out of line because a
     reconciliation is behind or a deposit was never posted, which is a
     bookkeeping backlog: real, worth fixing, and *not* evidence that a copy
     of the database is damaged. OPEN-ITEMS A4 is exactly this, and a restore
     drill that failed because of it would be a drill nobody ran twice.

     The other two are the books disagreeing with themselves. Nothing outside
     can explain those away. */
  const TRUST_SEVERITY = {
    bank_vs_book: "warning",        // the bank feed may simply be behind
    book_vs_clients: "warning",     // unallocated receipts sit here legitimately
    clients_vs_subledger: "error",  // the total against its own parts
    deposits_vs_leases: "warning",  // a deposit never posted — see `npm run deposits:plan`
  };
  const TRUST_HINT = {
    deposits_vs_leases: " — `npm run deposits:plan` lists them",
  };

  for (const company of companies) {
    const { trustReconciliation } = await import("./reports/trust.js");
    const rec = await trustReconciliation(company.id);
    for (const v of rec.variances) {
      if (v.unavailable || v.cents === 0) continue;
      note(TRUST_SEVERITY[v.key] || "error",
        `${company.name}: ${v.label.toLowerCase()}`,
        `out by ${(v.cents / 100).toFixed(2)} — ${v.question}${TRUST_HINT[v.key] || ""}`);
    }
  }

  /* --- references ---------------------------------------------------------- */

  /* Foreign keys enforce these while the database is running. A restore that
     loaded tables in the wrong order, or a dump taken without them, would
     not — and the failure is silent until somebody opens the screen. */
  const dangling = [
    ["journal_split", "journal_id", "journal"],
    ["ledger_entry", "journal_id", "journal"],
    ["lease", "unit_id", "unit"],
    ["unit", "property_id", "property"],
    ["property", "owner_id", "owner"],
    ["lease_tenant", "lease_id", "lease"],
    ["deposit_deduction", "return_id", "deposit_return"],
    ["inspection_item", "inspection_id", "inspection"],
  ];
  for (const [table, column, parent] of dangling) {
    const row = await get(
      `SELECT COUNT(*)::int AS n FROM "${table}" c
        WHERE c."${column}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "${parent}" p WHERE p.id = c."${column}")`);
    if (Number(row.n)) {
      note("error", `${table}.${column} points at nothing`,
        `${row.n} row(s) reference a ${parent} that is not here`);
    }
  }

  /* --- the files ------------------------------------------------------------ */

  let files = { checked: 0, missing: 0 };
  if (checkFiles) {
    files = await verifyFiles(note);
  } else {
    note("warning", "uploaded files were not checked",
      "a database backup does not cover the blob store; run with --files to read every "
      + "one the database names");
  }

  /* A stable identity for each finding, so the drill can tell a problem the
     source already had from one the restore introduced. The detail carries
     row ids and amounts that legitimately differ between two copies taken
     moments apart, so the fingerprint is the *kind* of problem, not its
     particulars. */
  for (const p of problems) p.fingerprint = `${p.severity}:${p.what}`;

  const errors = problems.filter((p) => p.severity === "error");
  return {
    ok: errors.length === 0,
    companies: companies.length,
    files,
    problems,
    errors: errors.length,
    warnings: problems.length - errors.length,
  };
}

/* Every upload the database names, read. The slow one, and the only one that
   answers the question a Postgres backup cannot. */
async function verifyFiles(note) {
  const { FILE_COLUMNS, TABLES } = await import("./export/tables.js");
  let checked = 0, missing = 0;

  for (const { table, column } of FILE_COLUMNS) {
    const spec = TABLES[table];
    if (!spec || spec.skip) continue;

    const rows = await all(
      `SELECT id, "${column}" AS stored FROM "${table}" WHERE "${column}" IS NOT NULL`);
    for (const row of rows) {
      checked += 1;
      const ok = await readable(row.stored);
      if (!ok) {
        missing += 1;
        note("error", `${table}.${column} names a file that is not there`,
          `${row.id} -> ${row.stored}`);
      }
    }
  }

  return { checked, missing };
}

async function readable(stored) {
  try {
    if (/^https?:\/\//.test(stored)) {
      const res = await fetch(stored, { method: "HEAD" });
      return res.ok;
    }
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { UPLOAD_DIR } = await import("./files.js");
    if (stored.includes("..") || stored.startsWith("/")) return false;
    await access(join(UPLOAD_DIR, stored));
    return true;
  } catch {
    return false;
  }
}

export function describeVerification(result) {
  const lines = [];
  lines.push(result.ok
    ? "The database is sound."
    : `NOT SOUND — ${result.errors} error(s).`);
  lines.push("");
  lines.push(`  ${result.companies} company/companies`);
  if (result.files.checked) {
    lines.push(`  ${result.files.checked} file(s) named, ${result.files.missing} missing`);
  }
  if (result.problems.length) {
    lines.push("");
    for (const p of result.problems) {
      lines.push(`  ${p.severity === "error" ? "ERROR  " : "warning"}  ${p.what}`);
      lines.push(`           ${p.detail}`);
    }
  }
  return lines.join("\n");
}

/* What the restore introduced, as opposed to what it faithfully copied.

   A backup's job is to bring back what was there — including the problems.
   Failing a drill for a variance the source already had would train whoever
   runs it to ignore the output, so the drill compares and only new findings
   count against it. Pre-existing ones are still printed: hidden is not the
   same as excused. */
export function compareVerifications(before, after) {
  const had = new Set(before.problems.map((p) => p.fingerprint));
  const introduced = after.problems.filter((p) => !had.has(p.fingerprint));
  const preexisting = after.problems.filter((p) => had.has(p.fingerprint));
  const fixedInTransit = before.problems.filter(
    (p) => !after.problems.some((q) => q.fingerprint === p.fingerprint));
  return {
    ok: introduced.filter((p) => p.severity === "error").length === 0,
    introduced, preexisting,
    /* A problem that vanished in the copy is not good news. It means the two
       databases disagree, and the restore is the one that changed. */
    vanished: fixedInTransit,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const checkFiles = argv.includes("--files");
  const json = argv.includes("--json");
  const baselineAt = argv.indexOf("--baseline");
  const result = await verifyDatabase({ checkFiles, log: () => {} });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (baselineAt !== -1) {
    const { readFileSync } = await import("node:fs");
    const before = JSON.parse(readFileSync(argv[baselineAt + 1], "utf8"));
    const cmp = compareVerifications(before, result);
    if (cmp.preexisting.length) {
      console.log(`${cmp.preexisting.length} problem(s) the source already had, copied faithfully:`);
      for (const p of cmp.preexisting) console.log(`  ${p.severity}  ${p.what}`);
      console.log("");
    }
    if (cmp.vanished.length) {
      console.log("Problems present in the source and NOT in the restore — the copy disagrees:");
      for (const p of cmp.vanished) console.log(`  ${p.severity}  ${p.what}`);
      console.log("");
    }
    if (cmp.introduced.length) {
      console.log("INTRODUCED BY THE RESTORE:");
      for (const p of cmp.introduced) console.log(`  ${p.severity}  ${p.what}\n           ${p.detail}`);
    } else {
      console.log("The restore introduced no new problems.");
    }
    process.exit(cmp.ok && cmp.vanished.length === 0 ? 0 : 1);
  }

  console.log(describeVerification(result));
  process.exit(result.ok ? 0 : 1);
}
