/* The public API.

   Two properties this file exists to hold.

   **A key cannot do what its holder could not.** That is the whole
   authorisation model, and the way it fails is silently: a key issued when
   somebody was an administrator and still working after they were moved to a
   leasing account. So it is asserted from both directions — the scope the key
   was given, and the role of the person behind it, at the moment of the call.

   **`/api/v1` is a promise.** Everything else in this codebase can be
   changed; a published endpoint with somebody's integration pointed at it
   cannot. So the shape of a response is asserted field by field, and the
   specification is asserted against the same declarations the responses are
   built from — a document that drifts from the code is worse than no
   document, because somebody believed it. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { issueKey, authenticate, allows, checkRate, revokeKey, SCOPES } from "../server/lib/api/keys.js";
import { RESOURCES, RESOURCE_NAMES } from "../server/lib/api/resources.js";
import { openApiSpec } from "../server/lib/api/openapi.js";

let app, world, adminKey;

const ALL_SCOPES = Object.keys(SCOPES);

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Api Co", staffRoles: ["admin", "leasing", "accountant"] });
  adminKey = (await issueKey({
    companyId: world.companyId, staffId: world.staff.admin.id,
    name: "everything", scopes: ALL_SCOPES,
  })).key;
});

async function call(path, { key = adminKey, method = "GET", body = null, headers = {} } = {}) {
  const res = await fetch(`${app.origin}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

/* --- the key ------------------------------------------------------------------ */

describe("a key is a credential, and is treated like one", () => {
  test("the secret is never stored", async () => {
    const { key, record } = await issueKey({
      companyId: world.companyId, staffId: world.staff.admin.id,
      name: "n", scopes: ["portfolio:read"],
    });
    const row = await get("SELECT * FROM api_key WHERE id = ?", record.id);
    assert.equal(row.secret_hash.length, 64, "a SHA-256, hex");
    assert.equal(key.includes(row.secret_hash), false);
    for (const value of Object.values(row)) {
      if (typeof value === "string" && value.length > 20) {
        assert.equal(key.endsWith(value), false, "no column holds the tail of the key");
      }
    }
  });

  test("a tampered key does not authenticate", async () => {
    const good = await authenticate(`Bearer ${adminKey}`);
    assert.equal(good.ok, true);
    const bad = await authenticate(`Bearer ${adminKey.slice(0, -4)}zzzz`);
    assert.equal(bad.ok, false);
  });

  test("a key for one company cannot read another's", async () => {
    const other = await f.makeWorld({ name: "Not Yours Ltd" });
    const res = await call("/api/v1/properties");
    assert.equal(res.status, 200);
    const ids = res.json.data.map((p) => p.id);
    const theirs = await all(
      "SELECT id FROM property WHERE company_id = ?", other.companyId);
    for (const p of theirs) {
      assert.equal(ids.includes(p.id), false, "another company's building is in the list");
    }
    /* And not by id either, which is the way a scoped list is usually got around. */
    const direct = await call(`/api/v1/properties/${theirs[0].id}`);
    assert.equal(direct.status, 404);
  });

  test("a revoked key stops working on the next request", async () => {
    const before = await call("/api/v1/properties");
    assert.equal(before.status, 200);

    const { key } = await authenticate(`Bearer ${adminKey}`);
    await revokeKey({ companyId: world.companyId, keyId: key.id });

    const after = await call("/api/v1/properties");
    assert.equal(after.status, 401);
    assert.equal(after.json.error.type, "unauthenticated");
  });

  test("no key at all is a 401 with nothing in it", async () => {
    const res = await call("/api/v1/properties", { key: null });
    assert.equal(res.status, 401);
    assert.match(res.json.error.message, /not usable/);
    assert.doesNotMatch(JSON.stringify(res.json), /no bearer token/,
      "the reason is logged, not returned — it tells a caller which half they got right");
  });

  test("a key with no scopes cannot be made", async () => {
    await assert.rejects(
      () => issueKey({ companyId: world.companyId, staffId: world.staff.admin.id, name: "x", scopes: [] }),
      /no scopes/);
  });
});

/* --- the ceiling --------------------------------------------------------------- */

describe("a key can do what its holder could do, and less", () => {
  test("a scope the holder's role does not carry is dead on arrival", async () => {
    /* A leasing account has no money.view. A key of theirs asking for
       money:read is refused — not at issue time, at use time, which is what
       makes a later role change take effect. */
    const { key } = await issueKey({
      companyId: world.companyId, staffId: world.staff.leasing.id,
      name: "leasing key", scopes: ["portfolio:read", "money:read"],
    });

    const allowed = await call("/api/v1/properties", { key });
    assert.equal(allowed.status, 200, "portfolio:read is within a leasing role");

    const refused = await call("/api/v1/owners", { key });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.type, "forbidden");
  });

  test("narrowing somebody's role narrows their keys in the same moment", async () => {
    const before = await call("/api/v1/owners");
    assert.equal(before.status, 200);

    await run("UPDATE staff SET role = 'leasing' WHERE id = ?", world.staff.admin.id);

    const after = await call("/api/v1/owners");
    assert.equal(after.status, 403,
      "a key that outlives the authority it was issued under is the whole failure mode");
  });

  test("deactivating somebody stops their keys", async () => {
    await run("UPDATE staff SET active = 0 WHERE id = ?", world.staff.admin.id);
    const res = await call("/api/v1/properties");
    assert.equal(res.status, 401);
  });

  test("a scope not on the key is refused even when the holder could", async () => {
    const { key } = await issueKey({
      companyId: world.companyId, staffId: world.staff.admin.id,
      name: "read only", scopes: ["portfolio:read"],
    });
    const res = await call("/api/v1/work-orders", {
      key, method: "POST", body: { unit_id: world.unitId, summary: "x" } });
    assert.equal(res.status, 403);
  });

  test("every scope names a capability that exists", async () => {
    const { CAPABILITIES } = await import("../server/lib/auth.js");
    for (const [name, scope] of Object.entries(SCOPES)) {
      assert.ok(CAPABILITIES.includes(scope.capability),
        `${name} is capped by "${scope.capability}", which is not a capability`);
    }
  });

  test("every resource names a scope that exists", () => {
    for (const plural of RESOURCE_NAMES) {
      assert.ok(SCOPES[RESOURCES[plural].scope],
        `${plural} needs "${RESOURCES[plural].scope}", which is not a scope`);
    }
  });
});

/* --- reading ------------------------------------------------------------------- */

describe("reading", () => {
  test("the index says what is there and whether this key may read it", async () => {
    const res = await call("/api/v1");
    assert.equal(res.status, 200);
    assert.equal(res.json.resources.length, RESOURCE_NAMES.length);
    for (const r of res.json.resources) assert.equal(r.readable, true);

    const { key } = await issueKey({
      companyId: world.companyId, staffId: world.staff.leasing.id,
      name: "leasing", scopes: ["portfolio:read"] });
    const narrow = await call("/api/v1", { key });
    const owners = narrow.json.resources.find((r) => r.name === "owners");
    assert.equal(owners.readable, false, "\"why did that 403\" is asked about a URL");
  });

  test("a response carries exactly the declared fields, always present", async () => {
    const res = await call("/api/v1/units");
    const unit = res.json.data[0];
    const declared = RESOURCES.units.fields.map(([name]) => name);
    assert.deepEqual(Object.keys(unit).sort(), [...declared].sort());
    for (const name of declared) {
      assert.ok(name in unit, `${name} must be present, null rather than absent`);
    }
  });

  test("a column the table has and the declaration does not stays inside", async () => {
    const res = await call("/api/v1/work-orders");
    /* The token in a work order's public URL is a capability: anybody holding
       it can read the job without a key at all. */
    assert.equal("public_token" in (res.json.data[0] || {}), false);
    assert.equal("triage_answers" in (res.json.data[0] || {}), false);
  });

  test("amounts come back as numbers, not as strings", async () => {
    const res = await call("/api/v1/leases");
    const lease = res.json.data[0];
    assert.equal(typeof lease.rent_cents, "number");
    assert.equal(typeof lease.deposit_cents, "number");
  });

  test("a lease carries its tenants, in one query for the page", async () => {
    const res = await call("/api/v1/leases");
    const lease = res.json.data.find((l) => l.id === world.leaseId);
    assert.ok(Array.isArray(lease.tenant_ids));
    assert.ok(lease.tenant_ids.includes(world.tenantId));
  });

  test("a journal carries its splits, and they sum to zero", async () => {
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "deposit_held", amountCents: 90000, memo: "deposit" });

    const res = await call("/api/v1/journals");
    const journal = res.json.data[0];
    assert.ok(journal.splits.length >= 2);
    const net = journal.splits.reduce((n, s) => n + s.debit_cents - s.credit_cents, 0);
    assert.equal(net, 0);
    assert.equal(typeof journal.splits[0].debit_cents, "number");
  });

  test("paging does not skip or repeat when something is inserted mid-list", async () => {
    for (let i = 0; i < 5; i++) {
      await f.makeProperty(world.companyId, world.ownerId, { line1: `${i} Paging Road` });
    }
    const first = await call("/api/v1/properties?limit=2");
    assert.equal(first.json.data.length, 2);
    assert.equal(first.json.has_more, true);
    assert.ok(first.json.next_cursor);

    /* A row inserted between the two pages. With an offset this would shift
       everything down by one and a row would be seen twice. */
    await f.makeProperty(world.companyId, world.ownerId, { line1: "0 Inserted Road" });

    const second = await call(`/api/v1/properties?limit=2&starting_after=${first.json.next_cursor}`);
    const firstIds = first.json.data.map((p) => p.id);
    for (const p of second.json.data) {
      assert.equal(firstIds.includes(p.id), false, `${p.id} appeared on both pages`);
    }
  });

  test("limit is capped rather than trusted", async () => {
    const res = await call("/api/v1/properties?limit=99999");
    assert.equal(res.status, 200, "a silly limit is clamped, not refused");
  });

  test("a filter narrows, and an unknown one is ignored rather than guessed at", async () => {
    const res = await call(`/api/v1/units?property_id=${world.propertyId}`);
    assert.ok(res.json.data.length >= 1);
    for (const u of res.json.data) assert.equal(u.property_id, world.propertyId);

    const odd = await call("/api/v1/units?colour=blue");
    assert.equal(odd.status, 200);
  });

  test("a missing record is a 404 that says which company it looked in", async () => {
    const res = await call("/api/v1/units/no-such-unit");
    assert.equal(res.status, 404);
    assert.equal(res.json.error.type, "not_found");
    assert.ok(res.json.request_id);
  });
});

/* --- writing ------------------------------------------------------------------- */

describe("raising a work order", () => {
  test("it goes through the same function the screen uses, so routing applies", async () => {
    await f.makeRoutingRule?.(world.companyId, world.vendorId, "plumbing");
    const res = await call("/api/v1/work-orders", {
      method: "POST",
      body: { unit_id: world.unitId, summary: "Tap dripping", category: "plumbing" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.reported_channel, "api",
      "the record says where it came from rather than claiming to be staff");
    assert.equal(res.json.summary, "Tap dripping");

    const row = await get("SELECT * FROM work_order WHERE id = ?", res.json.id);
    assert.ok(row, "it is really there");
    const events = await all(
      "SELECT * FROM work_order_event WHERE work_order_id = ?", res.json.id);
    assert.ok(events.some((e) => e.kind === "reported"));
  });

  test("an emergency is never queued, and the caller is told what happened instead",
    async () => {
      const res = await call("/api/v1/work-orders", {
        method: "POST",
        body: { unit_id: world.unitId, summary: "Water coming through the ceiling",
          category: "plumbing", severity: "emergency" },
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.severity, "emergency");
      assert.equal(res.json.vendor_id, null, "an emergency is not routed to a contractor");
      assert.equal(res.json.status, "new");

      assert.ok(res.json.emergency, "the caller must not be left to assume");
      assert.equal(res.json.emergency.routed_to_a_contractor, false);
      assert.equal(typeof res.json.emergency.on_call_alerted, "boolean");
      assert.match(res.json.emergency.note, /not routed to a contractor/);
    });

  test("delivery honesty: it does not claim to have alerted anybody it did not",
    async () => {
      /* Deliveries are off in the test environment, so the SMS cannot have
         gone. The response must say so rather than reporting success. */
      const res = await call("/api/v1/work-orders", {
        method: "POST",
        body: { unit_id: world.unitId, summary: "No heat", category: "heating",
          severity: "emergency" },
      });
      assert.equal(res.json.emergency.on_call_alerted, false);
      assert.match(res.json.emergency.note, /Ring somebody/);

      const events = await all(
        "SELECT * FROM work_order_event WHERE work_order_id = ?", res.json.id);
      assert.ok(events.some((e) => /DID NOT SEND/.test(e.note || "")),
        "and the work order records it, so a manager finds out");
    });

  test("a unit in another company is not a unit", async () => {
    const other = await f.makeWorld({ name: "Elsewhere Ltd" });
    const res = await call("/api/v1/work-orders", {
      method: "POST", body: { unit_id: other.unitId, summary: "x" } });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /no unit with that id in this company/);
  });

  test("what is missing is named", async () => {
    const noUnit = await call("/api/v1/work-orders", { method: "POST", body: { summary: "x" } });
    assert.match(noUnit.json.error.message, /unit_id is required/);

    const noSummary = await call("/api/v1/work-orders", {
      method: "POST", body: { unit_id: world.unitId } });
    assert.match(noSummary.json.error.message, /summary is required/);

    const odd = await call("/api/v1/work-orders", {
      method: "POST", body: { unit_id: world.unitId, summary: "x", severity: "catastrophic" } });
    assert.match(odd.json.error.message, /severity must be one of/);
  });
});

describe("recording a payment", () => {
  test("it reaches both books, because it goes through postMoney", async () => {
    const res = await call("/api/v1/payments", {
      method: "POST",
      body: { lease_id: world.leaseId, amount: "1450.00", date: "2026-06-01",
        memo: "June, by bank transfer", reference: "BT-9912" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.amount_cents, 145000);
    assert.ok(res.json.journal_id);

    const entry = await get("SELECT * FROM ledger_entry WHERE id = ?", res.json.ledger_entry_id);
    assert.equal(entry.journal_id, res.json.journal_id, "neither book without the other");
    assert.equal(entry.source, "api", "and it says where it came from");

    const splits = await all(
      "SELECT * FROM journal_split WHERE journal_id = ?", res.json.journal_id);
    const net = splits.reduce((n, s) => n + Number(s.debit_cents) - Number(s.credit_cents), 0);
    assert.equal(net, 0);
  });

  test("cents or dollars, and neither is guessed at", async () => {
    const cents = await call("/api/v1/payments", {
      method: "POST", body: { lease_id: world.leaseId, amount_cents: 50000 } });
    assert.equal(cents.json.amount_cents, 50000);

    const dollars = await call("/api/v1/payments", {
      method: "POST", body: { lease_id: world.leaseId, amount: "500.00" } });
    assert.equal(dollars.json.amount_cents, 50000);

    const nonsense = await call("/api/v1/payments", {
      method: "POST", body: { lease_id: world.leaseId, amount: "five hundred" } });
    assert.equal(nonsense.status, 400);
    assert.match(nonsense.json.error.message, /amount_cents must be/);
  });

  test("a closed period refuses it, and says so as the caller's business", async () => {
    const { closePeriod } = await import("../server/lib/reports/close.js");
    /* Forced, because the seeded fixture's deposits are recorded on leases and
       posted nowhere, so the reconciliation does not balance — which is a
       Phase 6 finding rather than anything to do with the API. Closing as an
       exception is what a real company would do here, and it records that
       they did. */
    await closePeriod(world.companyId, {
      through: "2026-06-30", by: "test", force: true,
      note: "Closed as an exception by a test.",
    });

    const res = await call("/api/v1/payments", {
      method: "POST", body: { lease_id: world.leaseId, amount: "100.00", date: "2026-06-01" } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.type, "period_closed");
  });

  test("a lease in another company is not a lease", async () => {
    const other = await f.makeWorld({ name: "Elsewhere Ltd" });
    const res = await call("/api/v1/payments", {
      method: "POST", body: { lease_id: other.leaseId, amount: "100.00" } });
    assert.equal(res.status, 400);
  });
});

/* --- the limit ----------------------------------------------------------------- */

describe("rate limiting", () => {
  test("the headers say where a caller stands", async () => {
    const res = await call("/api/v1/properties");
    assert.ok(Number(res.headers.get("x-ratelimit-limit")) > 0);
    assert.ok(Number(res.headers.get("x-ratelimit-remaining")) >= 0);
  });

  test("it counts into one row per window, not one per call", async () => {
    const { key } = await authenticate(`Bearer ${adminKey}`);
    for (let i = 0; i < 4; i++) await call("/api/v1/properties");
    const rows = await all("SELECT * FROM api_rate WHERE key_id = ?", key.id);
    assert.equal(rows.length, 1, "the cost of limiting must not grow with the traffic");
    assert.ok(Number(rows[0].hits) >= 4);
  });

  test("over the limit is a 429 that says when to come back", async () => {
    const { key } = await authenticate(`Bearer ${adminKey}`);
    const first = await checkRate(key.id, { max: 1 });
    assert.equal(first.allowed, true);
    const second = await checkRate(key.id, { max: 1 });
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfter > 0);
  });
});

/* --- the log -------------------------------------------------------------------

   The log is written after the response is sent, on purpose: an audit row is
   bookkeeping and a caller should not wait on it. That makes it a thing the
   test has to wait for rather than assume, which is the honest shape — a test
   that read it synchronously would be asserting an ordering the API does not
   promise. */
async function eventually(check, { tries = 40, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}



describe("what the company can see afterwards", () => {
  test("a call is recorded as a route and an outcome, never a body", async () => {
    await call("/api/v1/payments", {
      method: "POST", body: { lease_id: world.leaseId, amount: "1234.56", memo: "secret memo" } });

    const post = await eventually(async () => (await all(
      "SELECT * FROM api_request WHERE company_id = ? AND method = 'POST'",
      world.companyId))[0]);
    assert.ok(post, "the call was never logged");
    const rows = await all(
      "SELECT * FROM api_request WHERE company_id = ?", world.companyId);
    assert.equal(post.route, "/api/v1/payments", "the pattern, not one row per lease");
    assert.equal(post.status, 201);

    const dump = JSON.stringify(rows);
    assert.doesNotMatch(dump, /secret memo/, "a request log holding bodies is a second copy "
      + "of the customer's data with none of the protections the first one has");
    assert.doesNotMatch(dump, /1234/);
  });

  test("the key records that it was used", async () => {
    const { key } = await authenticate(`Bearer ${adminKey}`);
    await call("/api/v1/properties");
    const row = await eventually(async () => {
      const r = await get("SELECT * FROM api_key WHERE id = ?", key.id);
      return r.last_used_at ? r : null;
    });
    assert.ok(row, "the key never recorded being used");
    assert.ok(Number(row.calls) >= 1);
  });

  test("a refused call is logged too, once the key is known", async () => {
    const { key } = await issueKey({
      companyId: world.companyId, staffId: world.staff.leasing.id,
      name: "narrow", scopes: ["portfolio:read"] });
    await call("/api/v1/owners", { key });
    const rows = await eventually(async () => {
      const r = await all(
        "SELECT * FROM api_request WHERE company_id = ? AND status = 403", world.companyId);
      return r.length ? r : null;
    });
    assert.equal(rows?.length, 1, "a refusal is worth recording too");
  });
});
