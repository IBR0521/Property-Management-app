/* Checking a whole import before any of it is written.

   ## The dry run and the commit use this, and only this

   A preview that validates with one set of rules and a commit that writes with
   another is a preview nobody can trust — and the divergence is invisible
   until the day the commit rejects something the preview approved, halfway
   through somebody's migration. So this produces the finished, resolved rows,
   and the commit does nothing but insert them.

   ## Matching an existing row: source id, and only source id

   A second upload of the same file must not create a second portfolio, so a
   row whose source id is already here is an update. That is exact and safe.

   What this deliberately does **not** do is match on a natural key. A company
   with "1507 Brice Rd" already in it, importing a file containing "1507 Brice
   Rd", might be re-importing the same building or might have two buildings on
   the same road. Guessing wrong merges two real properties into one and there
   is no undo. So a row with no source id is always a creation, and the
   preview says how many of them look like something already here — which is
   the honest version of the question: it tells the person and lets them
   decide.

   ## References resolve inside the file first

   A lease points at a unit, which points at a property, which points at an
   owner. Those references are resolved against the file being imported, then
   against rows already here by source id. A reference that resolves to
   nothing is an error. A reference that resolves to two things is an error,
   because picking one is picking at random. */
import { all } from "../db.js";
import { readTable } from "./csv.js";
import { ENTITIES, entityOrder, mapHeaders, applyMapping } from "./mappings.js";
import { readDate, readMoney, readInt, readDecimal, readOneOf, readList } from "./read.js";

/* The CHECK constraints, mirrored. A value that does not map is refused here
   rather than at the insert, where it would abort a transaction with a
   constraint name instead of a row number. */
const PROPERTY_KINDS = ["single", "multi", "condo"];
const UNIT_STATUSES = ["occupied", "vacant", "turn", "offline"];
const LEASE_STATUSES = ["pending", "active", "ended"];

const KIND_SYNONYMS = {
  singlefamily: "single", sfr: "single", house: "single", detached: "single",
  multifamily: "multi", apartment: "multi", duplex: "multi", triplex: "multi", fourplex: "multi",
  condominium: "condo", townhouse: "condo", townhome: "condo",
};
const STATUS_SYNONYMS = {
  occupied: "occupied", rented: "occupied", leased: "occupied",
  vacant: "vacant", empty: "vacant", available: "vacant",
  turnover: "turn", maketready: "turn", makeready: "turn",
  offline: "offline", down: "offline", unavailable: "offline",
};
const LEASE_SYNONYMS = {
  active: "active", current: "active", inplace: "active",
  ended: "ended", expired: "ended", past: "ended", terminated: "ended", movedout: "ended",
  pending: "pending", future: "pending", upcoming: "pending",
};

/* --- the whole thing --------------------------------------------------------- */

export async function validateImport({ companyId, sourceSystem = "generic", files = {} }) {
  const entities = {};
  const problems = [];

  /* Read and map each file first, so a missing column is reported before a
     thousand rows are validated against a mapping that was never going to
     work. */
  for (const entity of entityOrder()) {
    const text = files[entity];
    if (!text || !String(text).trim()) continue;

    const table = readTable(text);
    for (const p of table.problems) {
      problems.push({ entity, row: p.row, column: p.column || null, message: p.message });
    }

    const mapped = mapHeaders(entity, table.headers);
    for (const m of mapped.missing) {
      problems.push({ entity, row: 1, column: null, message: m.message });
    }

    entities[entity] = {
      entity,
      label: ENTITIES[entity].label,
      headers: table.headers,
      mapping: mapped.mapping,
      ignored: mapped.ignored,
      usable: mapped.missing.length === 0,
      raw: mapped.missing.length ? [] : table.rows.map((r) => applyMapping(r, mapped)),
      rows: [],
    };
  }

  /* What is already here, by source id, so a second upload updates rather
     than duplicates. */
  const existing = await existingBySource(companyId, sourceSystem);

  /* Indexes over the file itself, built as each entity is validated so a
     later one can point at an earlier one. */
  const index = {};

  for (const entity of entityOrder()) {
    const state = entities[entity];
    if (!state || !state.usable) continue;

    const validator = VALIDATORS[entity];
    index[entity] = { bySource: new Map(), byNatural: new Map() };

    for (const data of state.raw) {
      const errors = [];
      const warnings = [];
      const out = validator({ data, errors, warnings, index, existing, companyId });

      /* A duplicate source id inside one file is not a merge, it is two rows
         claiming to be the same thing. */
      const sourceId = String(data.sourceId ?? "").trim() || null;
      if (sourceId && index[entity].bySource.has(sourceId)) {
        errors.push(`Another row in this file already uses the id "${sourceId}".`);
      }

      const action = errors.length ? "error"
        : sourceId && existing[entity].has(sourceId) ? "update"
        : "create";

      const row = { row: data.__row, sourceId, action, data: out, errors, warnings };
      state.rows.push(row);

      if (!errors.length) {
        if (sourceId) index[entity].bySource.set(sourceId, row);
        for (const key of naturalKeys(entity, out)) {
          const list = index[entity].byNatural.get(key) || [];
          list.push(row);
          index[entity].byNatural.set(key, list);
        }
      }

      for (const message of errors) {
        problems.push({ entity, row: data.__row, message });
      }
    }
  }

  /* Money carried in rather than as history: what tenants owe, and what is
     held as a deposit. Totalled here so the preview can show it before
     anybody agrees to post a journal. */
  const opening = openingTotals(entities);

  const summary = {};
  for (const [entity, state] of Object.entries(entities)) {
    summary[entity] = {
      label: state.label,
      total: state.rows.length,
      create: state.rows.filter((r) => r.action === "create").length,
      update: state.rows.filter((r) => r.action === "update").length,
      error: state.rows.filter((r) => r.action === "error").length,
      ignoredColumns: state.ignored,
      usable: state.usable,
    };
  }

  return {
    sourceSystem, entities, summary, problems, opening,
    /* Nothing is written unless every row is good. A partially-correct
       import is worse than a failed one: it leaves a portfolio somebody
       cannot tell the state of. */
    ok: problems.length === 0 && Object.keys(entities).length > 0,
  };
}

/* --- per entity -------------------------------------------------------------- */

const VALIDATORS = {
  owner({ data, errors }) {
    const name = String(data.name ?? "").trim();
    if (!name) errors.push("An owner needs a name.");
    return {
      name,
      email: blankToNull(data.email),
      phone: blankToNull(data.phone),
      notes: blankToNull(data.notes),
    };
  },

  property({ data, errors, warnings, index, existing }) {
    const out = {
      line1: String(data.line1 ?? "").trim(),
      city: String(data.city ?? "").trim(),
      state: String(data.state ?? "").trim(),
      zip: String(data.zip ?? "").trim(),
      kind: "single",
      yearBuilt: readInt(data.yearBuilt),
    };

    for (const [field, label] of [["line1", "address"], ["city", "city"], ["state", "state"], ["zip", "zip"]]) {
      if (!out[field]) errors.push(`A property needs a ${label}.`);
    }

    if (String(data.kind ?? "").trim()) {
      const kind = readOneOf(data.kind, PROPERTY_KINDS, KIND_SYNONYMS);
      if (!kind) {
        errors.push(`"${data.kind}" is not a property type. Use one of: ${PROPERTY_KINDS.join(", ")}.`);
      } else out.kind = kind;
    }

    out.ownerRef = resolve({
      entity: "owner", index, existing, errors,
      bySource: data.ownerSourceId,
      byNatural: data.ownerName,
      what: "owner",
      /* A property with no owner is not importable: the whole ledger hangs
         off it, and inventing a placeholder owner would put somebody else's
         money against a name nobody chose. */
      required: true,
    });

    return out;
  },

  unit({ data, errors, index, existing }) {
    const out = {
      label: String(data.label ?? "").trim(),
      beds: readDecimal(data.beds),
      baths: readDecimal(data.baths),
      sqft: readInt(data.sqft),
      marketRentCents: readMoney(data.marketRent),
      status: "vacant",
    };

    if (String(data.marketRent ?? "").trim() && out.marketRentCents == null) {
      errors.push(`"${data.marketRent}" is not an amount.`);
    }
    if (String(data.status ?? "").trim()) {
      const status = readOneOf(data.status, UNIT_STATUSES, STATUS_SYNONYMS);
      if (!status) {
        errors.push(`"${data.status}" is not a unit status. Use one of: ${UNIT_STATUSES.join(", ")}.`);
      } else out.status = status;
    }

    out.propertyRef = resolve({
      entity: "property", index, existing, errors,
      bySource: data.propertySourceId,
      byNatural: data.propertyAddress,
      what: "property", required: true,
    });

    return out;
  },

  tenant({ data, errors }) {
    const name = String(data.name ?? "").trim();
    if (!name) errors.push("A tenant needs a name.");
    return {
      name,
      email: blankToNull(data.email),
      phone: blankToNull(data.phone),
    };
  },

  lease({ data, errors, warnings, index, existing }) {
    const out = {
      startDate: readDate(data.startDate),
      endDate: readDate(data.endDate),
      moveoutDate: readDate(data.moveOut),
      rentCents: readMoney(data.rent),
      depositCents: readMoney(data.deposit) ?? 0,
      balanceCents: readMoney(data.balance) ?? 0,
      dueDay: readInt(data.dueDay),
      status: "active",
    };

    if (!out.startDate) {
      errors.push(String(data.startDate ?? "").trim()
        ? `"${data.startDate}" is not a date. Use YYYY-MM-DD or MM/DD/YYYY.`
        : "A lease needs a start date.");
    }
    if (out.rentCents == null) {
      errors.push(String(data.rent ?? "").trim()
        ? `"${data.rent}" is not an amount.`
        : "A lease needs a rent.");
    } else if (out.rentCents < 0) {
      errors.push("A rent cannot be negative.");
    }

    if (out.startDate && out.endDate && out.endDate < out.startDate) {
      errors.push("The lease ends before it starts.");
    }

    /* 1 to 28. The 29th, 30th and 31st do not exist in every month, which is
       the same rule the rent charge and the report schedules follow. */
    if (out.dueDay != null && (out.dueDay < 1 || out.dueDay > 28)) {
      errors.push(`Rent day ${out.dueDay} is not usable — later days do not exist in every month.`);
      out.dueDay = null;
    }

    if (String(data.status ?? "").trim()) {
      const status = readOneOf(data.status, LEASE_STATUSES, LEASE_SYNONYMS);
      if (!status) {
        errors.push(`"${data.status}" is not a lease status. Use one of: ${LEASE_STATUSES.join(", ")}.`);
      } else out.status = status;
    }

    out.unitRef = resolve({
      entity: "unit", index, existing, errors,
      bySource: data.unitSourceId,
      byNatural: data.unitLabel,
      what: "unit", required: true,
    });

    /* Tenants are optional on a lease — a signed lease before anybody has
       moved in is ordinary — but a named tenant that resolves to nothing is
       an error rather than a silently empty tenancy. */
    out.tenantRefs = [];
    const ids = readList(data.tenantSourceIds);
    const names = readList(data.tenantNames);
    for (const value of ids.length ? ids : names) {
      const ref = resolve({
        entity: "tenant", index, existing, errors,
        bySource: ids.length ? value : null,
        byNatural: ids.length ? null : value,
        what: "tenant", required: true,
      });
      if (ref) out.tenantRefs.push(ref);
    }

    return out;
  },

  vendor({ data, errors }) {
    const name = String(data.name ?? "").trim();
    const trade = String(data.trade ?? "").trim();
    if (!name) errors.push("A contractor needs a name.");
    if (!trade) errors.push("A contractor needs a trade.");
    return {
      name, trade,
      email: blankToNull(data.email),
      phone: blankToNull(data.phone),
      legalName: blankToNull(data.legalName),
      address: blankToNull(data.address),
    };
  },
};

/* --- resolving one row's reference to another -------------------------------- */

/* By source id first, because it is exact. By a natural key second, because
   plenty of files do not carry ids. Two matches is an error rather than a
   choice: picking one is picking at random, and the wrong pick puts a lease
   on somebody else's unit. */
function resolve({ entity, index, existing, errors, bySource, byNatural, what, required }) {
  const sourceId = String(bySource ?? "").trim();
  if (sourceId) {
    const inFile = index[entity]?.bySource.get(sourceId);
    if (inFile) return { kind: "file", entity, sourceId };
    if (existing[entity]?.has(sourceId)) return { kind: "existing", entity, sourceId };
    if (required) {
      errors.push(`No ${what} with the id "${sourceId}" — not in this import and not already here.`);
    }
    return null;
  }

  const natural = normaliseNatural(byNatural);
  if (natural) {
    const matches = index[entity]?.byNatural.get(natural) || [];
    if (matches.length === 1) return { kind: "file", entity, sourceId: matches[0].sourceId, row: matches[0].row };
    if (matches.length > 1) {
      errors.push(`"${byNatural}" matches ${matches.length} ${what}s in this import. `
        + "Give them ids so it is unambiguous.");
      return null;
    }
    if (required) {
      errors.push(`No ${what} called "${byNatural}" in this import.`);
    }
    return null;
  }

  if (required) errors.push(`This row does not say which ${what} it belongs to.`);
  return null;
}

/* What a row can be recognised by when there is no id. Loose enough to match
   the same address typed twice, strict enough not to match two different
   ones. */
function naturalKeys(entity, out) {
  if (entity === "owner") return out.name ? [normaliseNatural(out.name)] : [];
  if (entity === "tenant") return out.name ? [normaliseNatural(out.name)] : [];
  if (entity === "property") return out.line1 ? [normaliseNatural(out.line1)] : [];
  if (entity === "unit") {
    /* A unit label alone is never unique — every building has a "1" — so it
       is only ever a key together with its property. */
    const keys = [];
    if (out.label && out.propertyRef?.sourceId) {
      keys.push(normaliseNatural(`${out.propertyRef.sourceId} ${out.label}`));
    }
    if (out.label) keys.push(normaliseNatural(out.label));
    return keys;
  }
  return [];
}

const normaliseNatural = (v) =>
  String(v ?? "").trim().toLowerCase().replace(/[\s,.#-]+/g, " ").trim() || null;

/* --- what is already here ------------------------------------------------------ */

async function existingBySource(companyId, sourceSystem) {
  const out = {};
  for (const entity of entityOrder()) {
    const rows = await all(
      `SELECT source_id FROM ${entity}
        WHERE company_id = ? AND source_system = ? AND source_id IS NOT NULL`,
      companyId, sourceSystem);
    out[entity] = new Set(rows.map((r) => r.source_id));
  }
  return out;
}

/* --- the money that comes in as a position, not as history --------------------- */

function openingTotals(entities) {
  const leases = entities.lease?.rows?.filter((r) => r.action !== "error") || [];
  return {
    arrearsCents: leases.reduce((n, r) => n + (r.data.balanceCents > 0 ? r.data.balanceCents : 0), 0),
    creditCents: leases.reduce((n, r) => n + (r.data.balanceCents < 0 ? -r.data.balanceCents : 0), 0),
    depositsCents: leases.reduce((n, r) => n + (r.data.depositCents || 0), 0),
    leases: leases.length,
  };
}

const blankToNull = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};
