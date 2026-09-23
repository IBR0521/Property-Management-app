/* Writing an import, once, in one transaction.

   ## It writes what the validator produced and decides nothing

   Everything that could be refused was refused already. This resolves
   references to real ids, inserts, and posts one opening journal. If it finds
   itself making a judgement, something belongs in `validate.js` instead —
   because a decision made here happens without a preview in front of it.

   ## One transaction, or none of it

   A lease points at a unit, which points at a property, which points at an
   owner. Committing table by table leaves a customer with half a portfolio
   and no way to tell which half. Ten thousand rows in one transaction is
   comfortably within what Postgres does, and the alternative is the failure
   this exists to prevent.

   ## The opening journal is a position, not a history

   `convert.js` made this argument in Phase 3 and the import does not get to
   make a different one. A journal per historical transaction would assert
   detail — which account, which side, on which date — that is being inferred
   now from a spreadsheet rather than recorded then.

   So: one journal, dated the conversion date, against
   `3100 Opening balance conversion`, carrying the position each lease and
   each owner arrives in. What a tenant owes, what they have paid ahead, what
   is held as their deposit.

   **What it will not invent is the trust cash.** The files say what is owed;
   only a bank says what is held. If the person migrating supplies their trust
   balance it is posted and the trust reconciliation is meaningful from the
   first day. If they do not, it is left out and the preview says plainly that
   the deposits will read as unbacked until a bank balance is entered — which
   is true, and better than a number nobody chose. */
import { all, get, insert, update, run, tx } from "../db.js";
import { id, stickerToken } from "../ids.js";
import { stamp, today } from "../dates.js";
import { usd } from "../money.js";
import { BadRequest } from "../http.js";
import { entityOrder } from "./mappings.js";

export async function commitImport({
  companyId, validated, sourceSystem = "generic",
  batchId = null, by = "import",
  conversionDate = today(), trustCashCents = null,
}) {
  if (!validated?.ok) {
    throw new BadRequest(
      "This import has problems that have to be fixed first. Nothing was written.");
  }

  return await tx(async () => {
    /* sourceId or row number to the real id, per entity. Pre-loaded with what
       is already here so a reference can point at a row imported last month. */
    const ids = {};
    for (const entity of entityOrder()) {
      ids[entity] = new Map();
      const rows = await all(
        `SELECT id, source_id FROM ${entity}
          WHERE company_id = ? AND source_system = ? AND source_id IS NOT NULL`,
        companyId, sourceSystem);
      for (const row of rows) ids[entity].set(row.source_id, row.id);
    }

    const created = {};
    const updated = {};

    for (const entity of entityOrder()) {
      const state = validated.entities[entity];
      if (!state) continue;
      created[entity] = 0;
      updated[entity] = 0;

      for (const row of state.rows) {
        const existingId = row.sourceId ? ids[entity].get(row.sourceId) : null;
        const record = await WRITERS[entity]({
          companyId, sourceSystem, row, ids, existingId,
        });

        if (existingId) updated[entity] += 1; else created[entity] += 1;

        /* Indexed by both, because a reference may name a row that has no id
           of its own and can only be found by where it sat in the file. */
        if (row.sourceId) ids[entity].set(row.sourceId, record);
        ids[entity].set(`row:${row.row}`, record);
      }
    }

    /* Leases carry their tenants, once the leases exist. */
    let tenancies = 0;
    for (const row of validated.entities.lease?.rows || []) {
      const leaseId = ids.lease.get(row.sourceId) || ids.lease.get(`row:${row.row}`);
      for (const ref of row.data.tenantRefs || []) {
        const tenantId = resolveRef(ids, ref);
        if (!tenantId) continue;
        /* A join row that is already there is not an error on a second
           upload; it is the same tenancy. */
        const already = await get(
          "SELECT lease_id FROM lease_tenant WHERE lease_id = ? AND tenant_id = ?",
          leaseId, tenantId);
        if (already) continue;
        await insert("lease_tenant", { lease_id: leaseId, tenant_id: tenantId });
        tenancies += 1;
      }
    }

    const opening = await postOpeningJournal({
      companyId, validated, ids, conversionDate, trustCashCents, by,
    });

    if (batchId) {
      await update("import_batch", batchId, {
        status: "done",
        result: JSON.stringify({ created, updated, tenancies, opening }),
        committed_at: stamp(),
      });
    }

    return { created, updated, tenancies, opening };
  });
}

/* --- one table at a time ------------------------------------------------------- */

const WRITERS = {
  async owner({ companyId, sourceSystem, row, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, name: d.name, email: d.email, phone: d.phone, notes: d.notes,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    if (existingId) { await update("owner", existingId, record); return existingId; }
    const newId = id();
    await insert("owner", { id: newId, ...record, created_at: stamp() });
    return newId;
  },

  async property({ companyId, sourceSystem, row, ids, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, owner_id: resolveRef(ids, d.ownerRef),
      line1: d.line1, city: d.city, state: d.state, zip: d.zip,
      kind: d.kind, year_built: d.yearBuilt,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    if (existingId) { await update("property", existingId, record); return existingId; }
    const newId = id();
    await insert("property", { id: newId, ...record, created_at: stamp() });
    return newId;
  },

  async unit({ companyId, sourceSystem, row, ids, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, property_id: resolveRef(ids, d.propertyRef),
      label: d.label || "", beds: d.beds, baths: d.baths, sqft: d.sqft,
      market_rent_cents: d.marketRentCents ?? 0, status: d.status,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    if (existingId) { await update("unit", existingId, record); return existingId; }
    const newId = id();
    /* NOT NULL with no default: the sticker token is what a tenant scans to
       report a repair, and a unit without one cannot be reached from the
       QR code that will be printed for it. */
    await insert("unit", {
      id: newId, ...record, report_token: stickerToken(), created_at: stamp(),
    });
    return newId;
  },

  async tenant({ companyId, sourceSystem, row, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, name: d.name, email: d.email, phone: d.phone,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    if (existingId) { await update("tenant", existingId, record); return existingId; }
    const newId = id();
    await insert("tenant", { id: newId, ...record, created_at: stamp() });
    return newId;
  },

  async lease({ companyId, sourceSystem, row, ids, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, unit_id: resolveRef(ids, d.unitRef),
      start_date: d.startDate, end_date: d.endDate, moveout_date: d.moveoutDate,
      rent_cents: d.rentCents, deposit_cents: d.depositCents ?? 0,
      status: d.status,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    /* Left to the column default when the file does not say, rather than
       imposed: a company's own rent day is a setting, and overwriting it
       with 1 on every import would be quietly wrong. */
    if (d.dueDay != null) record.rent_due_day = d.dueDay;

    if (existingId) { await update("lease", existingId, record); return existingId; }
    const newId = id();
    await insert("lease", { id: newId, ...record, created_at: stamp() });
    return newId;
  },

  async vendor({ companyId, sourceSystem, row, existingId }) {
    const d = row.data;
    const record = {
      company_id: companyId, name: d.name, trade: d.trade,
      email: d.email, phone: d.phone,
      legal_name: d.legalName, address: d.address,
      source_system: sourceSystem, source_id: row.sourceId,
    };
    if (existingId) { await update("vendor", existingId, record); return existingId; }
    const newId = id();
    await insert("vendor", { id: newId, ...record, created_at: stamp() });
    return newId;
  },
};

function resolveRef(ids, ref) {
  if (!ref) return null;
  const table = ids[ref.entity];
  if (!table) return null;
  return (ref.sourceId ? table.get(ref.sourceId) : null)
    || (ref.row ? table.get(`row:${ref.row}`) : null)
    || null;
}

/* --- the opening journal --------------------------------------------------------- */

async function postOpeningJournal({
  companyId, validated, ids, conversionDate, trustCashCents, by,
}) {
  const { postJournal, ACCT, ensureChart } = await import("../../features/accounting.js");
  await ensureChart(companyId);

  const splits = [];
  const creditEntries = [];
  let arrears = 0, credits = 0, deposits = 0;

  for (const row of validated.entities.lease?.rows || []) {
    const leaseId = ids.lease.get(row.sourceId) || ids.lease.get(`row:${row.row}`);
    const unitId = resolveRef(ids, row.data.unitRef);
    const unit = unitId ? await get("SELECT property_id FROM unit WHERE id = ?", unitId) : null;
    const property = unit
      ? await get("SELECT owner_id FROM property WHERE id = ?", unit.property_id) : null;

    /* Every split carries the dimensions, so a report by property or by
       owner sees the carried-in position rather than a lump nobody can
       attribute. */
    const dims = {
      leaseId, unitId,
      propertyId: unit?.property_id || null,
      ownerId: property?.owner_id || null,
    };

    const balance = row.data.balanceCents || 0;
    if (balance > 0) {
      arrears += balance;
      splits.push({ code: ACCT.TENANT_RECEIVABLE, debit: balance, ...dims,
        memo: "owed at conversion" });
    } else if (balance < 0) {
      credits += -balance;
      splits.push({ code: ACCT.PREPAID_RENT, credit: -balance, ...dims,
        memo: "paid ahead at conversion" });
      /* 2300 is money held for the owner, and the trust reconciliation checks
         the owners' control accounts against the sum of the owner ledgers. A
         credit posted to one and not the other reads, correctly, as a control
         account disagreeing with its subsidiary ledger — which is how this was
         found: importing a portfolio with one tenant in credit made every
         migrated company report a variance of exactly that credit. */
      creditEntries.push({ ...dims, cents: -balance });
    }

    const deposit = row.data.depositCents || 0;
    if (deposit > 0) {
      deposits += deposit;
      splits.push({ code: ACCT.DEPOSITS_HELD, credit: deposit, ...dims,
        memo: "deposit held at conversion" });
    }
  }

  /* What is actually in the trust account, if the person migrating said. The
     files know what is owed; only a bank knows what is held. */
  const cash = Number(trustCashCents) || 0;
  if (cash > 0) {
    splits.push({ code: ACCT.TRUST_CASH, debit: cash, memo: "trust balance at conversion" });
  }

  if (!splits.length) {
    return { posted: false, reason: "nothing carried a balance", arrears: 0, credits: 0, deposits: 0 };
  }

  /* The balancing figure, and it is equity on purpose: the books begin here
     and this is what was carried in. */
  const debits = splits.reduce((n, s) => n + (s.debit || 0), 0);
  const creditTotal = splits.reduce((n, s) => n + (s.credit || 0), 0);
  const difference = debits - creditTotal;

  if (difference > 0) {
    splits.push({ code: ACCT.OPENING_CONVERSION, credit: difference, memo: "carried in" });
  } else if (difference < 0) {
    splits.push({ code: ACCT.OPENING_CONVERSION, debit: -difference, memo: "carried in" });
  }

  const journalId = await postJournal({
    companyId, date: conversionDate,
    memo: "Conversion: opening balances from an import",
    source: "system", sourceType: "import_opening", sourceId: companyId,
    postedBy: by, splits,
  });

  /* Carried on the journal that was just posted rather than posting a second
     one: they are the same event seen from the two books. */
  const { postMoney } = await import("../ledger.js");
  for (const e of creditEntries) {
    await postMoney({
      companyId, ownerId: e.ownerId, propertyId: e.propertyId,
      unitId: e.unitId, leaseId: e.leaseId,
      date: conversionDate, kind: "rent_payment", amountCents: e.cents,
      memo: "Rent paid ahead, carried in at conversion",
      source: "system", sourceType: "import_opening", sourceId: companyId,
      postedBy: by, journalId,
    });
  }

  return {
    posted: true, journalId,
    arrears, credits, deposits, trustCash: cash,
    /* Said rather than left to be discovered on the reconciliation. */
    unbacked: cash === 0 && deposits > 0
      ? `${usd(deposits)} of deposits was recorded with no trust balance to back it. `
        + "Until a bank balance is entered or a statement reconciled, the trust "
        + "reconciliation will read this as a shortfall — which is true."
      : null,
  };
}
