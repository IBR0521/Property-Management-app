/* What the columns in somebody else's export mean.

   ## One alias list, not four maps

   The roadmap asks for column mappings matching the typical exports of
   AppFolio, Buildium, DoorLoop and Rent Manager. Four separate maps would be
   four near-identical lists that drift apart the first time one of them gains
   a column — so there is one list per field, with every spelling those four
   and a hand-made spreadsheet are known to use.

   `source_system` then does the job it is actually for: recording which system
   a row came from, so its ids mean the same thing on the second upload.

   ## What "it does not guess" means

   A **required field with no matching column is an error.** The import stops
   and says which field and which spellings it looked for. It does not pick
   the most likely column, because the most likely column is sometimes the
   wrong one and nobody finds out until the rent roll is wrong.

   An **extra column is reported and ignored.** AppFolio exports forty columns
   and this uses eight; erroring on the other thirty-two would make the
   feature unusable. What matters is that the person is told what was not
   read, rather than discovering later that a field they cared about went
   nowhere.

   These aliases are written from published documentation. Whether a
   customer's actual export in 2026 matches is a different question, and the
   first real migration will find differences — which is exactly why an
   unmatched required field is loud rather than quiet. */
import { normaliseHeader } from "./csv.js";

export const SOURCE_SYSTEMS = {
  generic: "A spreadsheet",
  appfolio: "AppFolio",
  buildium: "Buildium",
  doorloop: "DoorLoop",
  rentmanager: "Rent Manager",
};

/* Every field is `{ aliases, required?, note? }`. The key is what this
   application calls it; the aliases are what everybody else does.

   `requiredOneOf` is a list of groups, each needing at least one of its
   fields present. A unit has to say which property it belongs to, and a file
   may do that with an id or with an address — neither is required on its own
   and going without both is not an import, it is a list of rooms. The same
   shape holds for a lease and its unit. */
export const ENTITIES = {
  owner: {
    label: "Owners",
    order: 1,
    fields: {
      sourceId: { aliases: ["id", "owner id", "ownerid", "owner code", "external id"] },
      name: { aliases: ["name", "owner", "owner name", "company", "company name", "display name"], required: true },
      email: { aliases: ["email", "email address", "e mail", "primary email", "owner email"] },
      phone: { aliases: ["phone", "phone number", "primary phone", "mobile", "cell", "telephone"] },
      notes: { aliases: ["notes", "note", "comments", "memo"] },
    },
  },

  property: {
    label: "Properties",
    order: 2,
    fields: {
      sourceId: { aliases: ["id", "property id", "propertyid", "property code", "external id"] },
      ownerSourceId: {
        aliases: ["owner id", "ownerid", "owner code", "owner external id"],
        note: "Links the property to an owner in the owners file.",
      },
      ownerName: { aliases: ["owner", "owner name"], note: "Used when there is no owner id." },
      line1: { aliases: ["address", "address 1", "street", "street address", "line 1", "property address"], required: true },
      city: { aliases: ["city", "town"], required: true },
      state: { aliases: ["state", "province", "region", "st"], required: true },
      zip: { aliases: ["zip", "zip code", "postal code", "postcode"], required: true },
      kind: { aliases: ["type", "property type", "kind"], note: "single, multi or condo." },
      yearBuilt: { aliases: ["year built", "yearbuilt", "built"] },
    },
  },

  unit: {
    label: "Units",
    order: 3,
    /* A unit with no property is a room with no building. */
    requiredOneOf: [["propertySourceId", "propertyAddress"]],
    fields: {
      sourceId: { aliases: ["id", "unit id", "unitid", "unit code", "external id"] },
      propertySourceId: { aliases: ["property id", "propertyid", "property code"] },
      propertyAddress: { aliases: ["property", "property address", "address", "building"] },
      label: { aliases: ["unit", "unit label", "unit name", "unit number", "apt", "apartment", "number"] },
      beds: { aliases: ["beds", "bedrooms", "br", "bed"] },
      baths: { aliases: ["baths", "bathrooms", "ba", "bath"] },
      sqft: { aliases: ["sqft", "square feet", "sq ft", "size", "area"] },
      marketRent: { aliases: ["market rent", "rent", "asking rent", "list rent", "advertised rent"] },
      status: { aliases: ["status", "unit status", "occupancy"] },
    },
  },

  tenant: {
    label: "Tenants",
    order: 4,
    fields: {
      sourceId: { aliases: ["id", "tenant id", "tenantid", "resident id", "external id"] },
      name: { aliases: ["name", "tenant", "tenant name", "resident", "resident name", "full name"], required: true },
      email: { aliases: ["email", "email address", "e mail", "primary email"] },
      phone: { aliases: ["phone", "phone number", "mobile", "cell", "primary phone"] },
    },
  },

  lease: {
    label: "Leases",
    order: 5,
    /* A lease has to name the unit it is for, by id or by label. Which of
       the two is present decides how it is resolved, and a file with
       neither cannot be imported at all. */
    requiredOneOf: [["unitSourceId", "unitLabel"]],
    fields: {
      sourceId: { aliases: ["id", "lease id", "leaseid", "external id"] },
      unitSourceId: { aliases: ["unit id", "unitid", "unit code"] },
      unitLabel: { aliases: ["unit", "unit label", "unit number", "apt", "apartment"] },
      propertyAddress: { aliases: ["property", "property address", "address", "building"] },
      tenantSourceIds: {
        aliases: ["tenant id", "tenantid", "tenant ids", "resident id", "resident ids"],
        note: "Several may be separated by a semicolon.",
      },
      tenantNames: { aliases: ["tenant", "tenants", "tenant name", "resident", "residents"] },
      startDate: { aliases: ["start", "start date", "lease start", "lease from", "move in", "move in date"], required: true },
      endDate: { aliases: ["end", "end date", "lease end", "lease to", "expiration", "expiry"] },
      rent: { aliases: ["rent", "monthly rent", "rent amount", "lease rent", "current rent"], required: true },
      deposit: { aliases: ["deposit", "security deposit", "deposit amount", "security deposit held"] },
      dueDay: { aliases: ["due day", "rent due day", "day due", "due date"] },
      status: { aliases: ["status", "lease status"] },
      moveOut: { aliases: ["move out", "move out date", "moveout", "vacated"] },
      balance: {
        aliases: ["balance", "tenant balance", "outstanding", "amount due", "open balance"],
        note: "Carried in as an opening balance, not as history.",
      },
    },
  },

  vendor: {
    label: "Contractors",
    order: 6,
    fields: {
      sourceId: { aliases: ["id", "vendor id", "vendorid", "vendor code", "external id"] },
      name: { aliases: ["name", "vendor", "vendor name", "company", "company name"], required: true },
      trade: { aliases: ["trade", "category", "type", "vendor type", "service"], required: true },
      email: { aliases: ["email", "email address", "e mail"] },
      phone: { aliases: ["phone", "phone number", "primary phone"] },
      legalName: { aliases: ["legal name", "business name", "tax name", "1099 name"] },
      address: { aliases: ["address", "street", "mailing address"] },
    },
  },
};

/* What each header in the file resolves to, and what it does not.

   Returns the mapping, the columns that were not used, and the required
   fields that were not found — which is the only one of the three that stops
   an import. */
export function mapHeaders(entity, headers) {
  const spec = ENTITIES[entity];
  if (!spec) throw new Error(`There is nothing here called "${entity}".`);

  /* Built once per call rather than held as module state: two entities share
     alias spellings — "id", "address", "phone" — and an alias table shared
     between them would resolve a property's "id" as an owner's. */
  const byAlias = new Map();
  for (const [field, def] of Object.entries(spec.fields)) {
    for (const alias of def.aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, field);
    }
  }

  const mapping = {};      // field -> the header as the file spells it
  const ignored = [];
  const taken = new Set();

  for (const header of headers) {
    const key = normaliseHeader(header);
    const field = byAlias.get(key);
    /* First column wins. A file with both "rent" and "monthly rent" has one
       of them as the real one, and taking the later would depend on column
       order rather than on anything meaningful. */
    if (field && !taken.has(field)) {
      mapping[field] = header;
      taken.add(field);
    } else {
      ignored.push(header);
    }
  }

  const missing = Object.entries(spec.fields)
    .filter(([field, def]) => def.required && !taken.has(field))
    .map(([field, def]) => ({
      field,
      looked: def.aliases,
      message: `No column for ${field}. Looked for: ${def.aliases.join(", ")}.`,
    }));

  /* And the groups where at least one is needed. Reported with every
     spelling of every alternative, because somebody staring at a file needs
     to know what would satisfy it rather than only that something does
     not. */
  for (const group of spec.requiredOneOf || []) {
    if (group.some((field) => taken.has(field))) continue;
    const looked = group.flatMap((field) => spec.fields[field]?.aliases || []);
    missing.push({
      field: group.join(" or "),
      looked,
      message: `No column for ${group.join(" or ")}, and one of them is needed. `
        + `Looked for: ${looked.join(", ")}.`,
    });
  }

  return { entity, mapping, ignored, missing, fields: spec.fields };
}

/* A row as this application's field names, reading through the mapping. */
export function applyMapping(row, { mapping, ignored = [] }) {
  const out = { __row: row.__row };
  for (const [field, header] of Object.entries(mapping)) {
    out[field] = row[normaliseHeader(header)] ?? "";
  }

  /* The recurring-money columns are carried rather than dropped.

     Everything unmapped used to be discarded here, which was right while
     there was nowhere to put it. There is now: a column called "pet rent"
     with 50.00 in it is a charge somebody is contractually paying, and
     reading the heading while throwing away the figure would be a strange
     place to stop. Nothing is created from them without being asked — see
     the import screen — but they have to survive to be offered. */
  const extra = {};
  for (const header of ignored) {
    if (!RECURRING_MONEY.includes(normaliseHeader(header))) continue;
    const value = row[normaliseHeader(header)];
    if (String(value ?? "").trim()) extra[header] = value;
  }
  if (Object.keys(extra).length) out.__recurring = extra;

  return out;
}

/* Columns that mean money somebody pays every month, which this application
   has nowhere to put.

   A lease here has one rent and one due day. It has no pet rent, no parking,
   no monthly utility billing — the feature does not exist, and the roadmap
   still has "recurring charges" on it. So an AppFolio export where a tenant
   pays $1,450 rent, $50 for the dog and $75 for a space imports as $1,450 and
   loses $125 a month, on every lease, silently.

   The ordinary "columns that were not read" list would show these, and that
   is not enough: it reads as a list of things that did not matter. Money that
   a tenant is contractually paying is not a column that did not matter, so it
   gets said in its own words, on its own row, before anybody commits.

   Not an error. The import is still the right thing to do; the person just has
   to decide what to do about the difference — fold it into the rent, or carry
   it outside this system until the feature exists. */
const RECURRING_MONEY = [
  "pet rent", "pet fee", "parking", "parking rent", "garage", "storage",
  "storage rent", "utility", "utilities", "water", "sewer", "trash",
  "rubbish", "valet trash", "internet", "cable", "renters insurance fee",
  "insurance fee", "amenity", "amenity fee", "admin fee", "monthly fee",
  "recurring charge", "recurring charges", "other charge", "other charges",
  "additional rent", "addl rent", "surcharge", "ratio utility billing", "rubs",
  "pest control", "lawn care", "hoa", "hoa fee",
];

/* The ignored headers on a lease file that name money somebody pays monthly.
   Returns the headers as the file spells them, because that is what the
   person will look for in their spreadsheet. */
export function unplaceableMoney(entity, ignored) {
  if (entity !== "lease") return [];
  return (ignored || []).filter((header) => {
    const key = normaliseHeader(header);
    return RECURRING_MONEY.includes(key);
  });
}

export const entityOrder = () =>
  Object.entries(ENTITIES).sort((a, b) => a[1].order - b[1].order).map(([key]) => key);
