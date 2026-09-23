/* The specification, built from the declarations rather than written beside
   them.

   A hand-written OpenAPI document is wrong within two releases, and nothing
   makes it wrong loudly: the code keeps working, the document keeps being
   served, and the first anybody hears is an integrator asking why a field
   they were promised is not there.

   So there is one source. `resources.js` names each field once; the response
   is built from that list and so is this. A field that changes shape changes
   its documentation, and a test asserts the two still agree — which is the
   only version of "the docs are up to date" that is worth anything. */
import { RESOURCES, RESOURCE_NAMES } from "./resources.js";
import { SCOPES } from "./scopes.js";

export const API_VERSION = "v1";

export function openApiSpec({ baseUrl = null } = {}) {
  const paths = {};
  const schemas = { Error: errorSchema(), List: listSchema() };

  for (const plural of RESOURCE_NAMES) {
    const resource = RESOURCES[plural];
    const schemaName = pascal(resource.name);
    schemas[schemaName] = schemaFor(resource);

    paths[`/${plural}`] = {
      get: {
        summary: `List ${plural.replace(/-/g, " ")}`,
        description: resource.summary,
        tags: [plural],
        security: [{ bearerAuth: [resource.scope] }],
        parameters: [
          ...listParameters(),
          ...Object.keys(resource.filters || {}).map((name) => ({
            name, in: "query", required: false,
            schema: { type: "string" },
            description: `Only those with this ${name.replace(/_/g, " ")}.`,
          })),
        ],
        responses: {
          200: {
            description: `A page of ${plural.replace(/-/g, " ")}.`,
            content: { "application/json": { schema: {
              allOf: [
                { $ref: "#/components/schemas/List" },
                { type: "object", properties: {
                  data: { type: "array", items: { $ref: `#/components/schemas/${schemaName}` } },
                } },
              ],
            } } },
          },
          ...commonErrors(),
        },
      },
    };

    paths[`/${plural}/{id}`] = {
      get: {
        summary: `Fetch one ${resource.name.replace(/_/g, " ")}`,
        description: resource.summary,
        tags: [plural],
        security: [{ bearerAuth: [resource.scope] }],
        parameters: [{
          name: "id", in: "path", required: true, schema: { type: "string" },
        }],
        responses: {
          200: {
            description: `One ${resource.name.replace(/_/g, " ")}.`,
            content: { "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` } } },
          },
          404: notFound(),
          ...commonErrors(),
        },
      },
    };
  }

  /* The two writes, declared here because their request bodies are their own
     shape rather than a resource's. */
  paths["/work-orders"].post = {
    summary: "Raise a work order",
    description:
      "Goes through the same function the staff screen uses, so the company's "
      + "routing rules apply exactly as they would to a job logged by hand.\n\n"
      + "**An emergency is never queued.** A work order raised with "
      + "`severity: \"emergency\"` is not routed to a contractor; the company's "
      + "on-call number is rung inside this request, and the response says "
      + "whether that reached anybody.",
    tags: ["work-orders"],
    security: [{ bearerAuth: ["maintenance:write"] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object",
        required: ["unit_id", "summary"],
        properties: {
          unit_id: { type: "string", description: "The unit the problem is in." },
          summary: { type: "string", description: "One line saying what is wrong." },
          detail: { type: "string", nullable: true },
          category: { type: "string", description: "Falls back to \"other\" if not recognised." },
          severity: { type: "string", enum: ["normal", "urgent", "emergency"], default: "normal" },
          reported_by_name: { type: "string", nullable: true },
          reported_by_phone: { type: "string", nullable: true },
        },
      } } },
    },
    responses: {
      201: {
        description: "The work order, plus what happened if it was an emergency.",
        content: { "application/json": { schema: {
          allOf: [
            { $ref: "#/components/schemas/WorkOrder" },
            { type: "object", properties: { emergency: emergencySchema() } },
          ],
        } } },
      },
      ...commonErrors(),
    },
  };

  paths["/payments"].post = {
    summary: "Record a payment received",
    description:
      "For rent taken outside the platform — a cheque, a bank transfer, cash. "
      + "Posts through the same function the screens use, so it reaches the "
      + "owner's statement and the double-entry journal together or not at all.\n\n"
      + "Give either `amount_cents` or `amount`. A period that has been closed "
      + "refuses the posting with a 409.",
    tags: ["payments"],
    security: [{ bearerAuth: ["money:write"] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object",
        required: ["lease_id"],
        properties: {
          lease_id: { type: "string" },
          amount_cents: { type: "integer", description: "A positive whole number of cents." },
          amount: { type: "string", description: "Or a decimal, like \"1450.00\"." },
          date: { type: "string", format: "date", description: "Defaults to today." },
          memo: { type: "string" },
          reference: { type: "string", description: "Your own id for it, kept on the journal." },
        },
      } } },
    },
    responses: {
      201: {
        description: "What was written, in both books.",
        content: { "application/json": { schema: {
          type: "object",
          properties: {
            object: { type: "string", example: "payment_record" },
            ledger_entry_id: { type: "string", nullable: true },
            journal_id: { type: "string" },
            lease_id: { type: "string" },
            amount_cents: { type: "integer" },
            date: { type: "string", format: "date" },
          },
        } } },
      },
      409: {
        description: "The period is closed, so nothing was posted.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ...commonErrors(),
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Property operations API",
      version: API_VERSION,
      description:
        "Read-first, company-scoped by the key.\n\n"
        + "**A key can do what its holder could do, and less.** Every key belongs "
        + "to a member of staff; what it may do is its scopes narrowed by that "
        + "person's role, resolved on every request. Changing somebody's role "
        + "changes their keys in the same moment.\n\n"
        + "Amounts are integers in cents. Dates are `YYYY-MM-DD`. Timestamps are "
        + "ISO-8601 in UTC. Lists are paged with `starting_after`, which is the "
        + "id of the last row you saw.",
    },
    servers: [{ url: `${baseUrl || ""}/api/${API_VERSION}` }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http", scheme: "bearer",
          description: "`Authorization: Bearer pmk_…`. Issued in Setup, shown once.",
        },
      },
      schemas,
    },
    security: [{ bearerAuth: [] }],
    tags: RESOURCE_NAMES.map((plural) => ({
      name: plural, description: RESOURCES[plural].summary,
    })),
    /* Not part of OpenAPI, and deliberately here rather than only in prose:
       a caller deciding which scopes to ask for wants the ceiling, not a
       sentence about it. */
    "x-scopes": Object.fromEntries(
      Object.entries(SCOPES).map(([name, s]) => [name, s.describes])),
  };
}

/* --- the pieces ------------------------------------------------------------- */

function schemaFor(resource) {
  const properties = {};
  for (const [name, , type, about] of resource.fields) {
    properties[name] = { ...typeToSchema(type), ...(about ? { description: about } : {}) };
  }
  return {
    type: "object",
    description: resource.summary,
    properties,
    /* Everything a resource declares is always present — null when it has no
       value, never absent. A consumer checking `"field" in row` and one
       checking `row.field === null` should not get different answers. */
    required: resource.fields.map(([name]) => name),
  };
}

function typeToSchema(type) {
  const nullable = String(type).includes("|null");
  const base = String(type).replace("|null", "");

  if (base === "split[]") {
    return { type: "array", items: {
      type: "object",
      properties: {
        account_code: { type: "string" },
        account_name: { type: "string" },
        debit_cents: { type: "integer" },
        credit_cents: { type: "integer" },
        memo: { type: "string", nullable: true },
        owner_id: { type: "string", nullable: true },
        property_id: { type: "string", nullable: true },
        unit_id: { type: "string", nullable: true },
        lease_id: { type: "string", nullable: true },
      },
    } };
  }
  if (base === "string[]") return { type: "array", items: { type: "string" } };
  if (base === "integer") return { type: "integer", nullable };
  if (base === "number") return { type: "number", nullable };
  if (base === "date") return { type: "string", format: "date", nullable };
  if (base === "timestamp") return { type: "string", format: "date-time", nullable };
  return { type: "string", nullable };
}

function listParameters() {
  return [
    {
      name: "limit", in: "query", required: false,
      schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      description: "How many to return. Anything over 200 is treated as 200.",
    },
    {
      name: "starting_after", in: "query", required: false,
      schema: { type: "string" },
      description:
        "The id of the last row you saw. Unlike an offset this cannot skip or "
        + "repeat a row when something is inserted while you are paging.",
    },
  ];
}

function listSchema() {
  return {
    type: "object",
    properties: {
      object: { type: "string", example: "list" },
      data: { type: "array", items: { type: "object" } },
      has_more: { type: "boolean" },
      next_cursor: {
        type: "string", nullable: true,
        description: "Pass as `starting_after` for the next page. Null on the last one.",
      },
    },
    required: ["object", "data", "has_more", "next_cursor"],
  };
}

function errorSchema() {
  return {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["invalid_request", "unauthenticated", "forbidden", "not_found",
              "rate_limited", "period_closed", "server_error"],
          },
          message: { type: "string", description: "Plain words. Safe to show a person." },
        },
        required: ["type", "message"],
      },
      request_id: {
        type: "string",
        description: "Quote this if you ask us about a request. It is in our log.",
      },
    },
    required: ["error", "request_id"],
  };
}

function emergencySchema() {
  return {
    type: "object", nullable: true,
    description: "Present only when the work order is an emergency.",
    properties: {
      routed_to_a_contractor: { type: "boolean", example: false },
      on_call_alerted: {
        type: "boolean",
        description: "Whether the SMS was accepted by the provider. False means nobody "
          + "has been told by this system.",
      },
      on_call_number: { type: "string", nullable: true },
      note: { type: "string" },
    },
  };
}

function notFound() {
  return {
    description: "No such record in this company.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function commonErrors() {
  const ref = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };
  return {
    400: { description: "Something about the request is wrong.", content: ref },
    401: { description: "The key is missing, malformed, revoked, or its holder is gone.", content: ref },
    403: { description: "The key lacks the scope, or its holder lacks the access behind it.", content: ref },
    429: { description: "This key has used its calls for the hour.", content: ref },
  };
}

function pascal(name) {
  return String(name).split(/[_-]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
