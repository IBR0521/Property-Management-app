/* What the API returns, declared once.

   ## Why a declaration rather than a handler per endpoint

   A hand-written OpenAPI document is wrong within two releases, because
   nothing makes it wrong loudly. Here each resource names its fields in one
   place: the response is built from that list and so is the specification, so
   a field that changes shape changes its documentation or fails a test.

   The cost is that a resource has to fit the shape — a table, a scope, a set
   of fields, an optional expansion. Everything worth publishing does. A thing
   that does not fit is a sign it should be its own endpoint with its own
   handler rather than bent into this.

   ## What is published, and what is not

   Eight resources read-first, and two writes on the things an integration
   genuinely needs: raising a work order, and recording a payment received.

   `/api/v1` is a promise. Everything else in this codebase can be changed;
   a published endpoint with somebody's integration pointed at it cannot. So
   it is deliberately less than the application can do, and it will grow —
   which is the direction that does not break anybody.

   Internal columns are not exposed and it is not an oversight: a work order's
   `public_token` is a capability, `triage_answers` is a tenant's own words,
   and Stripe's identifiers belong to Stripe. */

/* Every field is `[apiName, column, type, about]`. The column may be null
   when the value is computed. */
export const RESOURCES = {
  properties: {
    name: "property",
    table: "property",
    scope: "portfolio:read",
    summary: "A building. Units hang off it and it belongs to one owner.",
    fields: [
      ["id", "id", "string", "Stable, and what every other resource references."],
      ["owner_id", "owner_id", "string", "The owner this building belongs to."],
      ["line1", "line1", "string", "Street address."],
      ["city", "city", "string", null],
      ["state", "state", "string", null],
      ["zip", "zip", "string", null],
      ["kind", "kind", "string", "single, multi or condo."],
      ["year_built", "year_built", "integer|null", null],
      ["created_at", "created_at", "timestamp", null],
    ],
  },

  units: {
    name: "unit",
    table: "unit",
    scope: "portfolio:read",
    summary: "A lettable space inside a property.",
    filters: { property_id: "property_id", status: "status" },
    fields: [
      ["id", "id", "string", null],
      ["property_id", "property_id", "string", null],
      ["label", "label", "string", "What the unit is called — \"A\", \"101\", or empty for a single."],
      ["beds", "beds", "integer|null", null],
      ["baths", "baths", "number|null", null],
      ["sqft", "sqft", "integer|null", null],
      ["market_rent_cents", "market_rent_cents", "integer", "Asking rent, in cents."],
      ["status", "status", "string", "occupied, vacant, turn or offline."],
      ["created_at", "created_at", "timestamp", null],
    ],
  },

  leases: {
    name: "lease",
    table: "lease",
    scope: "portfolio:read",
    summary: "A tenancy: who is renting which unit, for how much, from when.",
    filters: { unit_id: "unit_id", status: "status" },
    fields: [
      ["id", "id", "string", null],
      ["unit_id", "unit_id", "string", null],
      ["status", "status", "string", "pending, active or ended."],
      ["start_date", "start_date", "date", null],
      ["end_date", "end_date", "date|null", null],
      ["moveout_date", "moveout_date", "date|null", null],
      ["rent_cents", "rent_cents", "integer", "Monthly rent, in cents."],
      ["deposit_cents", "deposit_cents", "integer", "Deposit held, in cents."],
      ["rent_due_day", "rent_due_day", "integer", "Day of the month rent falls due, 1 to 28."],
      ["grace_days", "grace_days", "integer", "Days after the due date before it counts as late."],
      ["tenant_ids", null, "string[]", "The tenants on this lease."],
      ["created_at", "created_at", "timestamp", null],
    ],
    /* One query for the whole page rather than one per row. */
    async expand(rows, { all }) {
      if (!rows.length) return rows;
      const ids = rows.map((r) => r.id);
      const links = await all(
        `SELECT lease_id, tenant_id FROM lease_tenant
          WHERE lease_id = ANY(?::text[]) ORDER BY lease_id`, ids);
      const byLease = new Map();
      for (const l of links) {
        const list = byLease.get(l.lease_id) || [];
        list.push(l.tenant_id);
        byLease.set(l.lease_id, list);
      }
      return rows.map((r) => ({ ...r, tenant_ids: byLease.get(r.id) || [] }));
    },
  },

  tenants: {
    name: "tenant",
    table: "tenant",
    scope: "portfolio:read",
    summary: "Somebody who rents. A tenant may be on more than one lease.",
    fields: [
      ["id", "id", "string", null],
      ["name", "name", "string", null],
      ["email", "email", "string|null", null],
      ["phone", "phone", "string|null", null],
      ["created_at", "created_at", "timestamp", null],
    ],
  },

  owners: {
    name: "owner",
    table: "owner",
    scope: "money:read",
    summary: "A client whose property this company manages.",
    fields: [
      ["id", "id", "string", null],
      ["name", "name", "string", null],
      ["email", "email", "string|null", null],
      ["phone", "phone", "string|null", null],
      ["approval_threshold_cents", "approval_threshold_cents", "integer",
        "Spend above this needs the owner's recorded approval before a job is dispatched."],
      ["created_at", "created_at", "timestamp", null],
    ],
  },

  "work-orders": {
    name: "work_order",
    table: "work_order",
    scope: "maintenance:read",
    summary: "A repair.",
    filters: { unit_id: "unit_id", status: "status", severity: "severity" },
    fields: [
      ["id", "id", "string", null],
      ["reference", "reference", "string", "What people call it: WO-ABCD."],
      ["unit_id", "unit_id", "string", null],
      ["lease_id", "lease_id", "string|null", "The tenancy at the time it was raised."],
      ["category", "category", "string", null],
      ["severity", "severity", "string", "normal, urgent or emergency."],
      ["status", "status", "string", "new, triaged, dispatched, scheduled, complete or cancelled."],
      ["summary", "summary", "string", null],
      ["detail", "detail", "string|null", null],
      ["vendor_id", "vendor_id", "string|null", "The contractor it went to, once it has."],
      ["scheduled_start", "scheduled_start", "timestamp|null", null],
      ["estimate_cents", "estimate_cents", "integer|null", null],
      ["actual_cents", "actual_cents", "integer|null", "What it came to, once closed out."],
      ["reported_channel", "reported_channel", "string", "web, staff, phone or api."],
      ["created_at", "created_at", "timestamp", null],
      ["closed_at", "closed_at", "timestamp|null", null],
    ],
  },

  payments: {
    name: "payment",
    table: "tenant_payment",
    scope: "money:read",
    summary: "Rent taken from a tenant through the platform's payment provider.",
    filters: { lease_id: "lease_id", status: "status" },
    fields: [
      ["id", "id", "string", null],
      ["lease_id", "lease_id", "string", null],
      ["unit_id", "unit_id", "string|null", null],
      ["kind", "kind", "string", "ach or card."],
      ["amount_cents", "amount_cents", "integer", "What the tenant's rent was reduced by."],
      ["tenant_fee_cents", "tenant_fee_cents", "integer", "What the tenant paid on top, if anything."],
      ["charged_cents", "charged_cents", "integer", "What their account was actually debited."],
      ["period", "period", "string|null", "The month it is for, YYYY-MM."],
      ["status", "status", "string", null],
      ["failure_reason", "failure_reason", "string|null", "Plain words, when it did not go through."],
      ["created_at", "created_at", "timestamp", null],
      ["settled_at", "settled_at", "timestamp|null", null],
    ],
  },

  "ledger-entries": {
    name: "ledger_entry",
    table: "ledger_entry",
    scope: "money:read",
    summary: "What an owner sees on their statement. Every one has a journal behind it.",
    filters: { owner_id: "owner_id", lease_id: "lease_id", kind: "kind" },
    fields: [
      ["id", "id", "string", null],
      ["owner_id", "owner_id", "string", null],
      ["property_id", "property_id", "string|null", null],
      ["unit_id", "unit_id", "string|null", null],
      ["lease_id", "lease_id", "string|null", null],
      ["date", "date", "date", null],
      ["kind", "kind", "string",
        "rent_charge, rent_payment, expense, management_fee, deposit_held, deposit_returned or other."],
      ["amount_cents", "amount_cents", "integer",
        "Signed from the owner's point of view: positive is money towards them."],
      ["memo", "memo", "string|null", null],
      ["journal_id", "journal_id", "string", "The double-entry record behind this line."],
      ["created_at", "created_at", "timestamp", null],
    ],
  },

  journals: {
    name: "journal",
    table: "journal",
    scope: "money:read",
    summary: "A double-entry posting. Append-only: a mistake is corrected by "
      + "a reversal, never by an edit.",
    filters: { source: "source", source_type: "source_type" },
    fields: [
      ["id", "id", "string", null],
      ["date", "date", "date", null],
      ["memo", "memo", "string|null", null],
      ["source", "source", "string", null],
      ["source_type", "source_type", "string|null", null],
      ["reverses_id", "reverses_id", "string|null", "The journal this one reverses, if it does."],
      ["reversed_by", "reversed_by", "string|null", null],
      ["posted_by", "posted_by", "string", null],
      ["splits", null, "split[]",
        "The lines, each `{ account_code, account_name, debit_cents, credit_cents, "
        + "memo, owner_id, property_id, unit_id, lease_id }`. They sum to zero."],
      ["created_at", "created_at", "timestamp", null],
    ],
    async expand(rows, { all }) {
      if (!rows.length) return rows;
      const ids = rows.map((r) => r.id);
      const splits = await all(
        `SELECT s.journal_id, a.code AS account_code, a.name AS account_name,
                s.debit_cents, s.credit_cents, s.memo,
                s.owner_id, s.property_id, s.unit_id, s.lease_id
           FROM journal_split s JOIN account a ON a.id = s.account_id
          WHERE s.journal_id = ANY(?::text[])
          ORDER BY s.journal_id, a.code`, ids);
      const byJournal = new Map();
      for (const s of splits) {
        const { journal_id, ...rest } = s;
        const list = byJournal.get(journal_id) || [];
        list.push({
          ...rest,
          debit_cents: Number(rest.debit_cents),
          credit_cents: Number(rest.credit_cents),
        });
        byJournal.set(journal_id, list);
      }
      return rows.map((r) => ({ ...r, splits: byJournal.get(r.id) || [] }));
    },
  },
};

export const RESOURCE_NAMES = Object.keys(RESOURCES);

/* Turns a database row into the object the API promises, and nothing else
   from that row gets out. The allow-list is the point: a column added to a
   table tomorrow does not appear in a published response by accident. */
export function shape(resource, row) {
  const out = {};
  for (const [apiName, column, type] of resource.fields) {
    const value = column === null ? row[apiName] : row[column];
    out[apiName] = coerce(value, type);
  }
  return out;
}

/* Postgres returns BIGINT as a string, because it does not fit a JS number in
   general. Every amount in this schema does — cents, and nobody manages a
   portfolio worth ninety thousand trillion — so they are returned as numbers,
   which is what a JSON consumer expects of a figure they will add up. */
function coerce(value, type) {
  if (value === null || value === undefined) return null;
  const base = String(type).replace("|null", "").replace("[]", "");
  if (base === "integer") return Number(value);
  if (base === "number") return Number(value);
  return value;
}

/* The columns a list query has to select: the ones a field maps to, plus `id`
   for the cursor. */
export function columnsFor(resource) {
  const set = new Set(["id"]);
  for (const [, column] of resource.fields) if (column) set.add(column);
  return [...set];
}
