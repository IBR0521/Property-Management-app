/* The public API.

   ## Every route goes through one door

   Routes here are not registered with the router directly. They are declared
   through `endpoint()`, which authenticates the key, checks the rate, checks
   the scope against the holder's role, records the call and turns a thrown
   error into JSON. A route that forgot to authenticate cannot exist, because
   there is no way to write one.

   That is the same argument as the app-level capability gate and it is made
   differently here on purpose: the app's authority is a property of the path,
   and the API's is a property of the endpoint — `/api/v1/journals` and
   `/api/v1/units` are the same path prefix and nothing alike in what they
   need.

   ## Why there is no CSRF check

   CSRF exists because a cookie is ambient: a browser attaches it to a request
   the person did not mean to make. An `Authorization` header is not ambient.
   Nothing attaches it for you, so there is nothing to forge. Adding a CSRF
   token to an API would be a ritual, and rituals are how the reason gets
   forgotten. Said here rather than left as an absence.

   ## What a caller sees when something is wrong

   The type, the message, and the request id — nothing about which half of
   the credential was right. Everything more specific is in the log. */
import { all, get, insert } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp } from "../lib/dates.js";
import { sendJson, securityHeaders } from "../lib/http.js";
import { clientIp } from "../lib/ratelimit.js";
import { authenticate, allows, checkRate, recordUse, SCOPES } from "../lib/api/keys.js";
import { RESOURCES, RESOURCE_NAMES, shape, columnsFor } from "../lib/api/resources.js";
import { openApiSpec } from "../lib/api/openapi.js";

export const API_PREFIX = "/api/v1";

/* How many rows a list returns, and the most it will. */
const PAGE = { default: 50, max: 200 };

/* A response with a status other than 200.

   A class rather than `{ status, body }`, because a handler returning a bare
   object cannot be told apart from one returning a record that happens to
   have a `status` field — and units, leases, work orders and payments all
   have one. The first version of this read a unit's `status` of "occupied"
   as the HTTP status and threw. Found by fetching a unit. */
export class ApiResponse {
  constructor(body, status = 200) {
    this.body = body;
    this.status = status;
  }
}

const created = (body) => new ApiResponse(body, 201);

/* An error a caller is allowed to read. Anything else becomes a generic
   message and a request id. */
export class ApiError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function registerApi(router) {
  /* --- the one door -------------------------------------------------------- */

  /* `scope: null` means the endpoint needs a valid key and no particular
     scope — the index and the specification, which describe the API rather
     than the portfolio. */
  function endpoint({ method, path, scope, handler }) {
    const register = method === "POST" ? router.post.bind(router) : router.get.bind(router);

    register(path, async (ctx) => {
      const began = Date.now();
      const ip = clientIp(ctx.req);
      let auth = null;
      let status = 500;

      try {
        auth = await authenticate(ctx.req.headers.authorization);
        if (!auth.ok) {
          /* The reason is logged and never sent. Telling an unauthenticated
             caller which half they got right is telling them what to change. */
          ctx.log.warn("api key refused", { reason: auth.reason, path, ip });
          throw new ApiError(401, "unauthenticated",
            "That key is not usable. Check the Authorization header, or issue a new key.");
        }

        const rate = await checkRate(auth.key.id);
        ctx.res.setHeader("X-RateLimit-Limit", String(rate.limit));
        ctx.res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
        if (!rate.allowed) {
          ctx.res.setHeader("Retry-After", String(rate.retryAfter));
          throw new ApiError(429, "rate_limited",
            `This key has used its ${rate.limit} calls for the hour. `
            + `It can carry on in ${rate.retryAfter} seconds.`);
        }

        if (scope && !allows(auth.key, auth.staff, scope)) {
          /* Two different refusals with one message on purpose: whether the
             key lacks the scope or the holder lacks the capability is the
             company's business and not the caller's. Both are in the log. */
          ctx.log.warn("api scope refused", {
            scope, keyId: auth.key.id, role: auth.staff.role,
            hasScope: auth.key.scopes.includes(scope), path,
          });
          throw new ApiError(403, "forbidden",
            `This key cannot ${SCOPES[scope].describes.toLowerCase()}. It needs the `
            + `"${scope}" scope, and the person it belongs to needs the matching access.`);
        }

        const result = await handler({
          ctx,
          companyId: auth.key.company_id,
          key: auth.key,
          staff: auth.staff,
          query: ctx.query,
          body: ctx.fields || {},
          params: ctx.params,
        });

        const out = result instanceof ApiResponse ? result : new ApiResponse(result);
        status = out.status;
        sendJson(ctx.res, out.body, status);
      } catch (err) {
        status = err instanceof ApiError ? err.status : 500;
        const safe = err instanceof ApiError
          ? { type: err.type, message: err.message }
          : { type: "server_error",
              message: "Something went wrong at our end. The request id below is in our log." };

        if (status >= 500) ctx.log.error("api request failed", { path, err });
        else ctx.log.warn("api request rejected", { path, status, reason: err.message });

        if (!ctx.res.headersSent) {
          sendJson(ctx.res, { error: safe, request_id: ctx.requestId }, status);
        }
      } finally {
        if (auth?.ok) {
          await recordUse(auth.key.id, ip);
          await logRequest(ctx, {
            company_id: auth.key.company_id, key_id: auth.key.id,
            method, route: path, status, ms: Date.now() - began, ip,
          });
        }
      }
    });
  }

  /* --- what the API is ----------------------------------------------------- */

  endpoint({
    method: "GET", path: API_PREFIX, scope: null,
    handler: ({ key, staff }) => ({
      object: "index",
      version: "v1",
      resources: RESOURCE_NAMES.map((plural) => ({
        name: plural,
        url: `${API_PREFIX}/${plural}`,
        scope: RESOURCES[plural].scope,
        summary: RESOURCES[plural].summary,
        /* Said per resource rather than as a list of scopes somewhere else,
           because "why did that 403" is asked about a URL. */
        readable: allows(key, staff, RESOURCES[plural].scope),
      })),
      openapi: `${API_PREFIX}/openapi.json`,
    }),
  });

  endpoint({
    method: "GET", path: `${API_PREFIX}/openapi.json`, scope: null,
    handler: () => openApiSpec(),
  });

  /* --- the resources ------------------------------------------------------- */

  /* Registered one at a time rather than behind `/:resource`, so an unknown
     name is a 404 from the router instead of a branch in a handler — and so
     the route recorded in the request log is the pattern rather than the
     path. */
  for (const plural of RESOURCE_NAMES) {
    const resource = RESOURCES[plural];

    endpoint({
      method: "GET", path: `${API_PREFIX}/${plural}`, scope: resource.scope,
      handler: (call) => listResource(resource, call),
    });

    endpoint({
      method: "GET", path: `${API_PREFIX}/${plural}/:id`, scope: resource.scope,
      handler: (call) => oneResource(resource, call),
    });
  }

  /* --- the two writes ------------------------------------------------------ */

  endpoint({
    method: "POST", path: `${API_PREFIX}/work-orders`, scope: "maintenance:write",
    handler: createWorkOrder,
  });

  endpoint({
    method: "POST", path: `${API_PREFIX}/payments`, scope: "money:write",
    handler: recordPayment,
  });
}

/* --- reading ---------------------------------------------------------------- */

async function listResource(resource, { companyId, query }) {
  const limit = pageSize(query.limit);
  const columns = columnsFor(resource).map(quote).join(", ");

  const where = ["company_id = ?"];
  const params = [companyId];

  for (const [name, column] of Object.entries(resource.filters || {})) {
    const value = query[name];
    if (value === undefined || value === "") continue;
    where.push(`${quote(column)} = ?`);
    params.push(String(value));
  }

  /* Keyset pagination on the id. Ids begin with the creation time in base 36,
     so ordering by id is ordering by when the row was made — and unlike an
     offset it does not skip or repeat a row when something is inserted while
     a caller is halfway through a list. */
  if (query.starting_after) {
    where.push("id > ?");
    params.push(String(query.starting_after));
  }

  /* One more than asked for, so `has_more` is known without a second count. */
  const rows = await all(
    `SELECT ${columns} FROM ${quote(resource.table)}
      WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${limit + 1}`, ...params);

  const page = rows.slice(0, limit);
  const expanded = resource.expand ? await resource.expand(page, { all }) : page;

  return {
    object: "list",
    data: expanded.map((row) => shape(resource, row)),
    has_more: rows.length > limit,
    next_cursor: rows.length > limit && page.length ? page[page.length - 1].id : null,
  };
}

async function oneResource(resource, { companyId, params }) {
  const columns = columnsFor(resource).map(quote).join(", ");
  const row = await get(
    `SELECT ${columns} FROM ${quote(resource.table)} WHERE id = ? AND company_id = ?`,
    params.id, companyId);

  if (!row) {
    throw new ApiError(404, "not_found",
      `There is no ${resource.name} with that id in this company.`);
  }
  const [expanded] = resource.expand ? await resource.expand([row], { all }) : [row];
  return shape(resource, expanded);
}

/* --- writing ---------------------------------------------------------------- */

/* Through `raiseWorkOrder`, which is the same function the staff screen
   calls. Two copies of "what happens when a job is raised" is how the routing
   rules get applied on one path and not the other. */
async function createWorkOrder({ ctx, companyId, staff, body }) {
  const { raiseWorkOrder, SEVERITIES } = await import("../lib/workorders.js");

  const unitId = String(body.unit_id || "").trim();
  if (!unitId) throw new ApiError(400, "invalid_request", "unit_id is required.");

  const unit = await get(
    "SELECT id FROM unit WHERE id = ? AND company_id = ?", unitId, companyId);
  if (!unit) {
    throw new ApiError(400, "invalid_request", "There is no unit with that id in this company.");
  }

  const summary = String(body.summary || "").trim();
  if (!summary) {
    throw new ApiError(400, "invalid_request",
      "summary is required — one line saying what is wrong.");
  }

  const severity = String(body.severity || "normal");
  if (!SEVERITIES.includes(severity)) {
    throw new ApiError(400, "invalid_request",
      `severity must be one of: ${SEVERITIES.join(", ")}.`);
  }

  const raised = await raiseWorkOrder({
    companyId, unitId,
    category: body.category,
    severity, summary,
    detail: body.detail,
    reportedByName: body.reported_by_name,
    reportedByPhone: body.reported_by_phone,
    channel: "api",
    actor: `API key of ${staff.name}`,
  });

  await insert("audit_log", {
    id: id(), company_id: companyId, at: stamp(), actor: `api:${staff.name}`,
    entity: "work_order", entity_id: raised.workOrderId, action: "raised",
    detail: `${severity} · ${summary}`.slice(0, 300),
  });

  const row = await get(
    `SELECT ${columnsFor(RESOURCES["work-orders"]).map(quote).join(", ")}
       FROM work_order WHERE id = ?`, raised.workOrderId);

  return created({
    ...shape(RESOURCES["work-orders"], row),
    /* An emergency is never queued, and the caller is told what happened
       instead of being left to assume a queue entry is a response. */
    emergency: raised.severity === "emergency" ? {
      routed_to_a_contractor: false,
      on_call_alerted: Boolean(raised.emergency?.alerted),
      on_call_number: raised.emergency?.to || null,
      note: raised.emergency?.alerted
        ? "This was not routed to a contractor. The on-call number was rung."
        : "This was not routed to a contractor, and the on-call alert did not send"
          + `${raised.emergency?.reason ? ` — ${raised.emergency.reason}` : ""}. `
          + "Ring somebody.",
    } : null,
  });
}

/* Through `postMoney`, which is the only writer of owner-visible money, so an
   API payment lands in both books exactly as one typed on a screen does. */
async function recordPayment({ companyId, staff, body }) {
  const { postMoney } = await import("../lib/ledger.js");
  const { parseMoney } = await import("../lib/money.js");

  const leaseId = String(body.lease_id || "").trim();
  if (!leaseId) throw new ApiError(400, "invalid_request", "lease_id is required.");

  const lease = await get(
    `SELECT l.id, l.unit_id, u.property_id, p.owner_id
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.id = ? AND l.company_id = ?`, leaseId, companyId);
  if (!lease) {
    throw new ApiError(400, "invalid_request", "There is no lease with that id in this company.");
  }

  /* Cents if given as an integer, a decimal string otherwise. Both, because
     an integration written against a spreadsheet has dollars and one written
     against this API has cents, and guessing between them is how a payment
     lands a hundred times too big. */
  const cents = body.amount_cents !== undefined
    ? Math.round(Number(body.amount_cents))
    : parseMoney(body.amount);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new ApiError(400, "invalid_request",
      "amount_cents must be a positive whole number of cents, or amount a decimal like \"1450.00\".");
  }

  const date = String(body.date || "").trim() || stamp().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "invalid_request", "date must be YYYY-MM-DD.");
  }

  let posted;
  try {
    posted = await postMoney({
      companyId, ownerId: lease.owner_id, propertyId: lease.property_id,
      unitId: lease.unit_id, leaseId: lease.id,
      date, kind: "rent_payment", amountCents: cents,
      memo: String(body.memo || "").trim() || "Rent received",
      source: "api", sourceType: "api_payment",
      sourceId: String(body.reference || "").trim() || null,
      postedBy: `api:${staff.name}`,
    });
  } catch (err) {
    /* A closed period refuses the posting, and that refusal is the caller's
       business rather than a fault. */
    if (err?.name === "PeriodClosed" || /closed/i.test(String(err.message))) {
      throw new ApiError(409, "period_closed", err.message);
    }
    throw err;
  }

  await insert("audit_log", {
    id: id(), company_id: companyId, at: stamp(), actor: `api:${staff.name}`,
    entity: "lease", entity_id: lease.id, action: "payment",
    detail: `${(cents / 100).toFixed(2)} on ${date}`,
  });

  return created({
    object: "payment_record",
    ledger_entry_id: posted.entryId,
    journal_id: posted.journalId,
    lease_id: lease.id,
    amount_cents: cents,
    date,
  });
}

/* --- plumbing ---------------------------------------------------------------- */

function pageSize(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE.default;
  return Math.min(n, PAGE.max);
}

/* Identifiers come from the resource declarations, never from a request.
   Quoted anyway, for the same reason the export quotes them. */
function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/* Written after the response has gone, on purpose: an audit row is
   bookkeeping and a caller should not wait on it.

   The failure is caught, because a log that fails must not fail the request
   it is logging — and it is *said*, because the first version of this passed
   camelCase keys to `insert`, which meant every row was rejected by the
   database and swallowed here. Nothing was logged for as long as it took a
   test to ask. A silent catch is how that lasts. */
async function logRequest(ctx, row) {
  try {
    await insert("api_request", { id: id(), at: stamp(), ...row });
  } catch (err) {
    ctx.log.warn("api request not logged", { reason: String(err.message).slice(0, 200) });
  }
}
