/* A company at the size somebody would actually run.

   2,000 units and five years, which is roughly what the largest customer this
   application is aimed at looks like. The point is not that the data is
   realistic in detail — it is that every screen has to read past a table with
   half a million rows in it, and the ones that do work per row will say so.

   ## Why this does not use the ordinary write path

   `postMoney` and `chargeRent` are the right way to write one rent charge and
   the wrong way to write 120,000 of them: each one is a transaction, several
   round trips, and the whole seed would take longer than the phase. So this
   builds rows and inserts them in batches, and then **checks its own work
   against the invariants** — every ledger entry has a journal, every journal
   balances, the trial balance balances. A seed that produced books the
   application would refuse to produce is a seed that tests nothing.

   ## What it makes

       1 company, 5 years
       120 properties, 2,000 units, 2,000 tenancies
       ~120,000 rent charges and the receipts against them
       ~480,000 journal splits
       ~8,000 work orders with their events
       ~2,000 deposits

   Run it against a database you do not mind losing:

       node --env-file=.env.test scripts/loadseed.js
*/
import { all, get, run, ready } from "../server/lib/db.js";
import { id, token, stickerToken, ref } from "../server/lib/ids.js";
import { stamp, monthKey, addDays } from "../server/lib/dates.js";
import { hashPassword } from "../server/lib/auth.js";

const YEARS = Number(process.env.LOAD_YEARS || 5);
const UNITS = Number(process.env.LOAD_UNITS || 2000);
const UNITS_PER_PROPERTY = 17;

const now = () => stamp();
const pick = (list, n) => list[n % list.length];

/* --- bulk insert ----------------------------------------------------------- */

/* One statement per batch. Postgres takes 65,535 parameters in a statement,
   so the batch size is whatever fits inside that for the row width. */
/* `groupBy` names a column whose rows must not be split across two batches.

   `journal_split_balanced` is a deferred constraint trigger: it asks whether
   a journal balances, and it asks at the end of the statement. A journal
   whose splits straddle a batch boundary is therefore checked when only half
   of it has been written, and is correctly reported as not balancing.

   That this worked before was arithmetic luck. Batches are sized at 60,000
   parameters divided by the column count, so adding two columns to
   `journal_split` moved every boundary and the first journal to land across
   one failed — "debits 290000 vs credits 145000", exactly one side of a
   deposit. Wrapping the call in a transaction does not help, because the
   insert below takes the pool's connection rather than the transaction's.

   So a batch grows until the group ends. */
async function insertMany(table, columns, rows, { batch = null, groupBy = null } = {}) {
  if (!rows.length) return 0;
  const perRow = columns.length;
  const size = batch || Math.max(1, Math.floor(60000 / perRow));
  const quoted = columns.map((c) => `"${c}"`).join(", ");

  let written = 0;
  for (let i = 0; i < rows.length;) {
    let end = Math.min(i + size, rows.length);
    if (groupBy) {
      while (end < rows.length && rows[end][groupBy] === rows[end - 1][groupBy]) end += 1;
    }
    const slice = rows.slice(i, end);
    const values = slice
      .map((_, n) => `(${columns.map((__, c) => `$${n * perRow + c + 1}`).join(", ")})`)
      .join(", ");
    const params = slice.flatMap((r) => columns.map((c) => r[c] ?? null));
    const { db } = await import("../server/lib/db.js");
    await db.unsafe(`INSERT INTO "${table}" (${quoted}) VALUES ${values}`, params);
    written += slice.length;
    i = end;
  }
  return written;
}

/* --- the months we are covering -------------------------------------------- */

function months(count) {
  const out = [];
  const end = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/* --- the run ---------------------------------------------------------------- */

export async function loadSeed({ units = UNITS, years = YEARS, log = console.log } = {}) {
  const began = Date.now();
  await ready();

  const existing = await get("SELECT id FROM company LIMIT 1");
  if (existing) {
    throw new Error(
      "There is already a company here. This writes half a million rows and is not "
      + "something to run on top of anything you want to keep.");
  }

  const at = now();
  const companyId = id();
  const period = months(years * 12);

  log(`Seeding ${units} units over ${period.length} months…`);

  await run(
    `INSERT INTO company (id, name, slug, timezone, currency, phone, emergency_phone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId, "Meridian Residential", "meridian", "America/New_York", "USD",
    "(614) 555-0100", "(614) 555-0911", at);

  const staffId = id();
  await run(
    `INSERT INTO staff (id, company_id, name, email, password_hash, role, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    staffId, companyId, "Dana Whitfield", "dana@meridian.test",
    hashPassword("load-test-password"), "admin", at);

  /* --- the chart, so journals have somewhere to go --- */
  const { ensureChart } = await import("../server/features/accounting.js");
  await ensureChart(companyId);
  const accounts = new Map(
    (await all("SELECT id, code FROM account WHERE company_id = ?", companyId))
      .map((a) => [a.code, a.id]));

  /* --- owners, properties, units --- */
  const propertyCount = Math.ceil(units / UNITS_PER_PROPERTY);
  const ownerCount = Math.max(1, Math.ceil(propertyCount / 3));

  const owners = [];
  for (let i = 0; i < ownerCount; i++) {
    owners.push({
      id: id(), company_id: companyId, name: `Owner ${i + 1} Holdings LLC`,
      email: `owner${i + 1}@example.test`, phone: "(614) 555-0200",
      approval_threshold_cents: 50000, created_at: at,
    });
  }
  await insertMany("owner",
    ["id", "company_id", "name", "email", "phone", "approval_threshold_cents", "created_at"],
    owners);

  const STREETS = ["Brice", "Tillerman", "Hawthorn", "Maple Grove", "Calder", "Pemberton",
    "Anselm", "Rowe", "Kestrel", "Dunmore"];
  const properties = [];
  for (let i = 0; i < propertyCount; i++) {
    properties.push({
      id: id(), company_id: companyId, owner_id: pick(owners, i).id,
      line1: `${100 + i} ${pick(STREETS, i)} Road`, city: "Columbus",
      state: "OH", zip: "43201", kind: "multi",
      year_built: 1960 + (i % 60), created_at: at,
    });
  }
  await insertMany("property",
    ["id", "company_id", "owner_id", "line1", "city", "state", "zip", "kind",
      "year_built", "created_at"], properties);

  const unitRows = [];
  for (let i = 0; i < units; i++) {
    const property = properties[i % properties.length];
    unitRows.push({
      id: id(), company_id: companyId, property_id: property.id,
      label: String(101 + Math.floor(i / properties.length)),
      beds: 1 + (i % 3), baths: 1, sqft: 600 + (i % 5) * 120,
      market_rent_cents: 95000 + (i % 11) * 5000,
      status: "occupied", report_token: stickerToken(), created_at: at,
    });
  }
  await insertMany("unit",
    ["id", "company_id", "property_id", "label", "beds", "baths", "sqft",
      "market_rent_cents", "status", "report_token", "created_at"], unitRows);
  log(`  ${owners.length} owners, ${properties.length} properties, ${unitRows.length} units`);

  /* --- tenants and tenancies --- */
  const tenants = [];
  const leases = [];
  const tenancies = [];
  const start = `${period[0]}-01`;

  for (let i = 0; i < unitRows.length; i++) {
    const unit = unitRows[i];
    const tenant = {
      id: id(), company_id: companyId, name: `Tenant ${i + 1}`,
      email: `tenant${i + 1}@example.test`, phone: "(614) 555-0300", created_at: at,
    };
    tenants.push(tenant);

    const lease = {
      id: id(), company_id: companyId, unit_id: unit.id,
      start_date: start, end_date: null, status: "active",
      rent_cents: unit.market_rent_cents, deposit_cents: unit.market_rent_cents,
      rent_due_day: 1, grace_days: 5, pay_token: token(), created_at: at,
    };
    leases.push(lease);
    tenancies.push({ lease_id: lease.id, tenant_id: tenant.id });
  }
  await insertMany("tenant",
    ["id", "company_id", "name", "email", "phone", "created_at"], tenants);
  await insertMany("lease",
    ["id", "company_id", "unit_id", "start_date", "end_date", "status", "rent_cents",
      "deposit_cents", "rent_due_day", "grace_days", "pay_token", "created_at"], leases);
  await insertMany("lease_tenant", ["lease_id", "tenant_id"], tenancies);
  log(`  ${leases.length} tenancies`);

  /* --- the books --- */
  const journals = [];
  const splits = [];
  const entries = [];

  const post = ({ date, memo, source, sourceType, sourceId, lines, entry }) => {
    const journalId = id();
    journals.push({
      id: journalId, company_id: companyId, date, memo,
      source, source_type: sourceType, source_id: sourceId,
      posted_by: "loadseed", created_at: at,
    });
    for (const line of lines) {
      splits.push({
        id: id(), journal_id: journalId, account_id: accounts.get(line.code),
        date,
        /* The journal's, copied — migration 048, checked by a trigger. */
        source_type: sourceType ?? null, source_id: sourceId ?? null,
        debit_cents: line.debit || 0, credit_cents: line.credit || 0,
        owner_id: line.ownerId || null, property_id: line.propertyId || null,
        unit_id: line.unitId || null, lease_id: line.leaseId || null,
        memo: line.memo || null,
      });
    }
    if (entry) entries.push({ ...entry, journal_id: journalId, id: id() });
    return journalId;
  };

  /* Deposits, once each. */
  for (let i = 0; i < leases.length; i++) {
    const lease = leases[i];
    const unit = unitRows[i];
    const property = properties.find((p) => p.id === unit.property_id);
    const dims = {
      ownerId: property.owner_id, propertyId: property.id,
      unitId: unit.id, leaseId: lease.id,
    };
    post({
      date: start, memo: "Security deposit received", source: "manual",
      sourceType: "deposit", sourceId: lease.id,
      lines: [
        { code: "1010", debit: lease.deposit_cents, ...dims, memo: "deposit received into trust" },
        { code: "2100", credit: lease.deposit_cents, ...dims, memo: "deposit owed to tenant" },
      ],
      entry: {
        company_id: companyId, owner_id: property.owner_id, property_id: property.id,
        unit_id: unit.id, lease_id: lease.id, date: start, kind: "deposit_held",
        amount_cents: lease.deposit_cents, memo: "Security deposit received",
        source: "manual", created_at: at,
      },
    });
  }

  /* Rent, every month, charged and received. */
  for (const month of period) {
    const first = `${month}-01`;
    for (let i = 0; i < leases.length; i++) {
      const lease = leases[i];
      const unit = unitRows[i];
      const property = properties.find((p) => p.id === unit.property_id);
      const dims = {
        ownerId: property.owner_id, propertyId: property.id,
        unitId: unit.id, leaseId: lease.id,
      };

      post({
        date: first, memo: `Rent ${month}`, source: "rent",
        sourceType: "rent_charge", sourceId: `${lease.id}:${month}`,
        lines: [
          { code: "1300", debit: lease.rent_cents, ...dims, memo: "rent charged" },
          { code: "2400", credit: lease.rent_cents, ...dims, memo: "owed to owner when collected" },
        ],
      });

      /* Nine in ten pay. The rest are the arrears every report needs
         something to find. */
      if ((i + period.indexOf(month)) % 10 === 0) continue;

      post({
        date: addDays(first, 2), memo: `Rent ${month} received`, source: "rent",
        sourceType: "rent_payment", sourceId: `${lease.id}:${month}`,
        lines: [
          { code: "1010", debit: lease.rent_cents, ...dims, memo: "rent received into trust" },
          { code: "1300", credit: lease.rent_cents, ...dims, memo: "tenant receivable cleared" },
          { code: "2400", debit: lease.rent_cents, ...dims, memo: "uncollected rent now collected" },
          { code: "2200", credit: lease.rent_cents, ...dims, memo: "held for the owner" },
        ],
        entry: {
          company_id: companyId, owner_id: property.owner_id, property_id: property.id,
          unit_id: unit.id, lease_id: lease.id, date: addDays(first, 2),
          kind: "rent_payment", amount_cents: lease.rent_cents,
          memo: `Rent ${month}`, source: "manual", created_at: at,
        },
      });
    }
    log(`  ${month}: ${journals.length} journals so far`);
  }

  await insertMany("journal",
    ["id", "company_id", "date", "memo", "source", "source_type", "source_id",
      "posted_by", "created_at"], journals);

  /* Grouped by journal, so a journal's splits are never divided between two
     statements — see `insertMany`. */
  await insertMany("journal_split",
    ["id", "journal_id", "account_id", "date", "source_type", "source_id",
      "debit_cents", "credit_cents", "owner_id",
      "property_id", "unit_id", "lease_id", "memo"], splits,
    { groupBy: "journal_id" });
  await insertMany("ledger_entry",
    ["id", "company_id", "owner_id", "property_id", "unit_id", "lease_id", "date",
      "kind", "amount_cents", "memo", "source", "journal_id", "created_at"], entries);
  log(`  ${journals.length} journals, ${splits.length} splits, ${entries.length} ledger entries`);

  /* --- work orders, because the queue and the reports read them --- */
  const CATEGORIES = ["plumbing", "electrical", "heating", "appliance", "other"];
  const workOrders = [];
  const events = [];
  for (let i = 0; i < Math.floor(units * 4); i++) {
    const unit = unitRows[i % unitRows.length];
    const lease = leases[i % leases.length];
    const month = pick(period, i);
    const woId = id();
    const done = i % 4 !== 0;
    workOrders.push({
      id: woId, company_id: companyId, unit_id: unit.id, lease_id: lease.id,
      reference: ref("WO"), category: pick(CATEGORIES, i),
      severity: i % 23 === 0 ? "urgent" : "normal",
      summary: `Reported problem ${i + 1}`,
      reported_channel: "web", status: done ? "complete" : "triaged",
      actual_cents: done ? 8000 + (i % 30) * 500 : null,
      public_token: token(), created_at: `${month}-05T09:00:00.000Z`,
      closed_at: done ? `${month}-09T15:00:00.000Z` : null,
    });
    events.push({
      id: id(), work_order_id: woId, at: `${month}-05T09:00:00.000Z`,
      actor: "tenant", kind: "reported", note: "Reported", tenant_visible: 1,
    });
    if (done) {
      events.push({
        id: id(), work_order_id: woId, at: `${month}-09T15:00:00.000Z`,
        actor: "staff", kind: "completed", note: "Closed out", tenant_visible: 1,
      });
    }
  }
  await insertMany("work_order",
    ["id", "company_id", "unit_id", "lease_id", "reference", "category", "severity",
      "summary", "reported_channel", "status", "actual_cents", "public_token",
      "created_at", "closed_at"], workOrders);
  await insertMany("work_order_event",
    ["id", "work_order_id", "at", "actor", "kind", "note", "tenant_visible"], events);
  log(`  ${workOrders.length} work orders, ${events.length} events`);

  const seconds = Math.round((Date.now() - began) / 1000);
  log(`Done in ${seconds}s.`);

  return {
    companyId, staffId, email: "dana@meridian.test", password: "load-test-password",
    counts: {
      owners: owners.length, properties: properties.length, units: unitRows.length,
      leases: leases.length, journals: journals.length, splits: splits.length,
      entries: entries.length, workOrders: workOrders.length,
    },
    seconds,
  };
}

/* --- checking its own work --------------------------------------------------- */

/* A seed that produced books the application would refuse to produce is a
   seed that tests nothing. */
export async function checkSeed(companyId) {
  const problems = [];

  const unbalanced = await get(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT s.journal_id FROM journal_split s
        JOIN journal j ON j.id = s.journal_id
       WHERE j.company_id = ?
       GROUP BY s.journal_id
       HAVING SUM(s.debit_cents) <> SUM(s.credit_cents)) AS bad`, companyId);
  if (Number(unbalanced.n)) problems.push(`${unbalanced.n} journal(s) do not balance`);

  const orphaned = await get(
    "SELECT COUNT(*)::int AS n FROM ledger_entry WHERE company_id = ? AND journal_id IS NULL",
    companyId);
  if (Number(orphaned.n)) problems.push(`${orphaned.n} ledger entr(ies) have no journal`);

  const trial = await get(
    `SELECT SUM(s.debit_cents - s.credit_cents)::bigint AS net
       FROM journal_split s JOIN journal j ON j.id = s.journal_id
      WHERE j.company_id = ?`, companyId);
  if (Number(trial.net) !== 0) problems.push(`the trial balance is out by ${trial.net}`);

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await loadSeed();
  const problems = await checkSeed(result.companyId);
  if (problems.length) {
    console.error("\nThe seed produced books this application would refuse:");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log("\nThe books balance. Sign in as", result.email, "/", result.password);
  process.exit(0);
}
