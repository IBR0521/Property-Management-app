/* The same portfolio, in the shape this application's own importer reads.

   ## Why the archive carries two shapes of the same thing

   `data/` is the record as it is held: database column names, amounts in
   cents, every column of every table. That is what somebody mapping into a
   different system needs, and it is deliberately not tidied.

   It is also, for exactly those reasons, not importable. `line1` is not a
   column name the importer looks for; `rent_cents` holding 120000 would read
   as a rent of one hundred and twenty thousand dollars. Neither is a defect
   in either half — they are two different jobs.

   So `import/` holds the six things the importer understands, spelled the way
   it spells them and with money in dollars. That makes "no lock-in" a thing
   that can be **tested** rather than asserted: export a company, import it
   into an empty one, and compare. A test does exactly that.

   ## What it carries and what it cannot

   Owners, properties, units, tenants, leases with their tenancies, and
   contractors — with each lease's position: what it is owed, what it has been
   paid ahead, what deposit is held. That is the same conversion the import
   performs from anybody else's export, and it is all the importer can accept.

   It is **not** the whole archive. Work orders, journals, messages and
   documents are in `data/` and there is nothing in this application that
   reads them back in. Said in the README rather than implied by the folder's
   existence, because "import/" looks like it means everything. */
import { all } from "../db.js";
import { BOM, csvRow, csvMoney } from "../csv.js";

/* One file per entity, and the header is the first alias the importer lists
   for each field — so these files are read by exactly the code that reads a
   customer's own export, with no special case anywhere. */
export async function portableFiles(companyId) {
  const [owners, properties, units, tenants, leases, tenancies, positions, vendors] =
    await Promise.all([
      all(`SELECT id, name, email, phone, notes FROM owner
            WHERE company_id = ? ORDER BY name`, companyId),
      all(`SELECT id, owner_id, line1, city, state, zip, kind, year_built
             FROM property WHERE company_id = ? ORDER BY line1`, companyId),
      all(`SELECT id, property_id, label, beds, baths, sqft, market_rent_cents, status
             FROM unit WHERE company_id = ? ORDER BY property_id, label`, companyId),
      all(`SELECT id, name, email, phone FROM tenant
            WHERE company_id = ? ORDER BY name`, companyId),
      all(`SELECT id, unit_id, start_date, end_date, moveout_date, rent_cents,
                  deposit_cents, rent_due_day, status
             FROM lease WHERE company_id = ? ORDER BY start_date`, companyId),
      all(`SELECT lt.lease_id, lt.tenant_id
             FROM lease_tenant lt
             JOIN lease l ON l.id = lt.lease_id
            WHERE l.company_id = ? ORDER BY lt.lease_id`, companyId),
      leasePositions(companyId),
      all(`SELECT id, name, trade, email, phone, legal_name, address
             FROM vendor WHERE company_id = ? ORDER BY name`, companyId),
    ]);

  const byLease = new Map();
  for (const t of tenancies) {
    const list = byLease.get(t.lease_id) || [];
    list.push(t.tenant_id);
    byLease.set(t.lease_id, list);
  }

  return {
    "import/owner.csv": table(
      ["id", "name", "email", "phone", "notes"],
      owners.map((o) => [o.id, o.name, o.email, o.phone, o.notes])),

    "import/property.csv": table(
      ["id", "owner id", "address", "city", "state", "zip", "type", "year built"],
      properties.map((p) => [p.id, p.owner_id, p.line1, p.city, p.state, p.zip, p.kind, p.year_built])),

    "import/unit.csv": table(
      ["id", "property id", "unit", "beds", "baths", "sqft", "market rent", "status"],
      units.map((u) => [u.id, u.property_id, u.label, u.beds, u.baths, u.sqft,
        csvMoney(u.market_rent_cents), u.status])),

    "import/tenant.csv": table(
      ["id", "name", "email", "phone"],
      tenants.map((t) => [t.id, t.name, t.email, t.phone])),

    "import/lease.csv": table(
      ["id", "unit id", "tenant ids", "start date", "end date", "move out",
        "rent", "security deposit", "due day", "status", "balance"],
      leases.map((l) => [
        l.id, l.unit_id,
        /* Semicolons, which is what the importer splits on: a comma would
           need quoting and a name can contain one anyway. */
        (byLease.get(l.id) || []).join(";"),
        l.start_date, l.end_date, l.moveout_date,
        csvMoney(l.rent_cents), csvMoney(l.deposit_cents),
        l.rent_due_day, l.status,
        csvMoney(positions.get(l.id) ?? 0),
      ])),

    "import/vendor.csv": table(
      ["id", "name", "trade", "email", "phone", "legal name", "address"],
      vendors.map((v) => [v.id, v.name, v.trade, v.email, v.phone, v.legal_name, v.address])),
  };
}

/* Each lease's position as one signed figure, which is the shape the importer
   reads a balance in: positive is owed, negative is paid ahead.

   Taken from the journal rather than from anything cached, because the
   journal is what the trust reconciliation reads and an export that
   disagreed with it would be an export of a portfolio that does not exist. */
async function leasePositions(companyId) {
  const rows = await all(
    `SELECT l.id,
            COALESCE(SUM(CASE WHEN a.code = '1300'
                         THEN s.debit_cents - s.credit_cents ELSE 0 END), 0)::bigint AS receivable,
            COALESCE(SUM(CASE WHEN a.code = '2300'
                         THEN s.credit_cents - s.debit_cents ELSE 0 END), 0)::bigint AS prepaid
       FROM lease l
       LEFT JOIN journal_split s ON s.lease_id = l.id
       LEFT JOIN account a ON a.id = s.account_id
      WHERE l.company_id = ?
      GROUP BY l.id`, companyId);

  const out = new Map();
  for (const r of rows) out.set(r.id, Number(r.receivable) - Number(r.prepaid));
  return out;
}

function table(headers, rows) {
  const lines = [csvRow(headers)];
  for (const row of rows) lines.push(csvRow(row));
  return BOM + lines.join("\r\n") + "\r\n";
}
