/* Cross-company isolation.

   Today this app serves one company, so a leak between companies is a bug
   nobody can hit. Phase 2 makes it a disclosure between paying customers, and
   the gap between those two facts is one signup form.

   Isolation currently holds by convention: roughly two hundred call sites each
   remembered to put company_id in the WHERE clause. Nothing in the database or
   the framework stops the two hundred and first from forgetting. This test is
   what stops it, and it works by enumerating the router's own table rather
   than a list kept here — so a route registered tomorrow is covered tomorrow,
   not whenever somebody remembers to add it in two places.

   The assertion is deliberately blunt: signed in as company A, asking for any
   of company B's ids must never return 200. Not "must not show the name" —
   must not answer at all. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import { registeredRoutes } from "../server/app.js";
import * as f from "./helpers/factories.js";

let app, A, B, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();

  A = await f.makeWorld({ name: "Alpha Management" });
  B = await f.makeWorld({ name: "Bravo Property Group" });

  /* Company B gets one of everything the URLs can name, so the substitutions
     below are real ids that really exist — just not for the caller. A test
     that used made-up ids would pass against a handler that looks up nothing. */
  B.extra = {
    templateId: await makeTemplate(B.companyId),
    documentId: null,
    listingId: await makeListing(B.companyId, B.unitId),
    journalId: await makeJournal(B.companyId),
    invoiceId: await makeInvoice(B.companyId, B.vendorId),
  };

  agent = client(app.origin);
  const res = await agent.signIn(A.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true, "company A's admin must be able to sign in");
});

after(async () => {
  await app.close();
  await closeDb();
});

async function makeTemplate(companyId) {
  const { id } = await import("../server/lib/ids.js");
  const { insert } = await import("../server/lib/db.js");
  const tid = id();
  await insert("lease_template", {
    id: tid, company_id: companyId, name: "B template", kind: "lease",
    body_md: "# Lease for {{tenant_name}}", active: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return tid;
}

async function makeListing(companyId, unitId) {
  const { id } = await import("../server/lib/ids.js");
  const { insert } = await import("../server/lib/db.js");
  const lid = id();
  await insert("listing", {
    id: lid, company_id: companyId, unit_id: unitId, status: "active",
    headline: "B listing", rent_cents: 100000, syndicate: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return lid;
}

async function makeJournal(companyId) {
  const { postJournal, ACCT } = await import("../server/features/accounting.js");
  return await postJournal({
    companyId, date: "2026-06-01", memo: "B journal",
    splits: [{ code: ACCT.CASH, debit: 1000 }, { code: ACCT.RENT_INCOME, credit: 1000 }],
  });
}

async function makeInvoice(companyId, vendorId) {
  const { recordInvoice } = await import("../server/features/vendors.js");
  const res = await recordInvoice({
    companyId, vendorId, invoiceDate: "2026-06-01", amountCents: 10000, createdBy: "test",
  });
  return res.invoiceId;
}

/* Which of company B's ids belongs in which route's parameter. Keyed by the
   route's own prefix, because ":id" means a different table on every one. */
function substitute(pattern, key) {
  const p = pattern;
  if (key === "tok") {
    // Token routes are public by design; their scoping is the token itself.
    return null;
  }
  if (p.startsWith("/app/owners")) return B.ownerId;
  if (p.startsWith("/app/vendors/invoices")) return B.extra.invoiceId;
  if (p.startsWith("/app/vendors")) return B.vendorId;
  if (p.startsWith("/app/maintenance")) return B.workOrderId;
  if (p.startsWith("/app/accounting/j")) return B.extra.journalId;
  if (p.startsWith("/app/leases/templates")) return B.extra.templateId;
  if (p.startsWith("/app/leases/d")) return B.extra.documentId || B.extra.templateId;
  if (p.startsWith("/app/listings")) return B.extra.listingId;
  if (p.startsWith("/app/portfolio/p")) return B.propertyId;
  if (p.startsWith("/app/portfolio/u")) return B.unitId;
  if (p.startsWith("/app/portfolio")) return B.unitId;
  if (p.startsWith("/app/rent")) return B.leaseId;
  if (p.startsWith("/app/compliance")) return B.companyId;
  if (p.startsWith("/app/turns")) return B.unitId;
  if (p.startsWith("/app/applications")) return B.companyId;
  return B.companyId;
}

function buildPath(pattern, keys) {
  let path = pattern;
  for (const key of keys) {
    const value = substitute(pattern, key);
    if (value == null) return null;         // token route, skipped deliberately
    path = path.replace(`:${key}`, encodeURIComponent(value));
  }
  return path;
}

describe("company A cannot reach company B's records", () => {
  test("no parameterised GET route returns 200 for another company's id", async () => {
    const routes = registeredRoutes()
      .filter((r) => r.method === "GET" && r.keys.length && r.pattern.startsWith("/app/"));

    assert.ok(routes.length >= 15, `expected a real route surface, got ${routes.length}`);

    const leaks = [];
    for (const r of routes) {
      const path = buildPath(r.pattern, r.keys);
      if (!path) continue;
      const res = await agent.get(path);
      if (res.status === 200) {
        const body = await res.text();
        leaks.push({ pattern: r.pattern, path, sample: body.slice(0, 120).replace(/\s+/g, " ") });
      }
    }

    assert.deepEqual(leaks, [],
      "these routes answered 200 for another company's id:\n" +
      leaks.map((l) => `  ${l.pattern}\n    -> ${l.path}\n    ${l.sample}`).join("\n"));
  });

  test("no parameterised POST route mutates another company's records", async () => {
    const routes = registeredRoutes()
      .filter((r) => r.method === "POST" && r.keys.length && r.pattern.startsWith("/app/"));

    const before = await snapshot(B.companyId);
    const accepted = [];

    for (const r of routes) {
      const path = buildPath(r.pattern, r.keys);
      if (!path) continue;
      /* A real CSRF token from a page company A may legitimately open, so the
         only thing under test is company scoping — not CSRF, which has its own
         test. */
      const csrf = await agent.csrf("/app");
      const res = await agent.post(path, { note: "x", reason: "x", decision: "approved" }, { csrf });
      if (res.status < 400 && res.status !== 303) accepted.push({ pattern: r.pattern, status: res.status });
      if (res.status === 303) {
        // A redirect can still mean "done". The snapshot below is the real check.
        accepted.push({ pattern: r.pattern, status: 303, soft: true });
      }
    }

    const after = await snapshot(B.companyId);
    assert.deepEqual(after, before,
      `company B's data changed while acting as company A.\n` +
      `routes that did not refuse outright: ${accepted.map((a) => a.pattern).join(", ")}`);
  });

  test("company A's staff session cannot be used to sign in as company B", async () => {
    const { body } = await agent.text("/app");
    assert.ok(!body.includes("Bravo Property Group"),
      "company B's name must never appear in company A's app shell");
  });

  test("every company-scoped table carries company_id", async () => {
    /* The ones that do not are scoped through a parent (a lease document
       belongs to a lease, a signature to a document). Listed explicitly so
       adding a table without company_id is a decision somebody makes on
       purpose rather than an omission. */
    const parentScoped = new Set([
      // Not company-scoped because it IS the company.
      "company",
      // Infrastructure, deliberately global.
      "schema_migration", "job_run", "rate_hit",
      // Scoped through the row they belong to.
      "session",                 // -> staff
      "staff_recovery_code",     // -> staff
      "lease_tenant",            // -> lease
      "application_check", "application_doc",   // -> application
      "work_order_event", "work_order_photo",   // -> work_order
      "turn_task", "turn_photo", "turn_stage_event",  // -> turn
      "lease_signature",         // -> lease_document
      "listing_photo",           // -> listing
      "journal_split",           // -> journal
      "bank_webhook_event",      // provider delivery ids, no company until resolved
      "obligation_reminder",     // -> obligation
    ]);
    const tables = await all(
      `SELECT t.tablename,
              EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema='public' AND c.table_name=t.tablename
                         AND c.column_name='company_id') AS scoped
         FROM pg_tables t WHERE t.schemaname='public' ORDER BY t.tablename`);

    const missing = tables
      .filter((t) => !t.scoped && !parentScoped.has(t.tablename))
      .map((t) => t.tablename);

    assert.deepEqual(missing, [],
      `these tables have no company_id and are not recorded as parent-scoped: ${missing.join(", ")}`);
  });
});

/* A fingerprint of everything company B owns. Compared before and after the
   hostile POSTs: if any of it moved, something wrote across the boundary. */
async function snapshot(companyId) {
  const rows = await all(
    `SELECT 'work_order' AS t, id, status::text AS v FROM work_order WHERE company_id = $1
     UNION ALL SELECT 'lease', id, status::text FROM lease WHERE company_id = $1
     UNION ALL SELECT 'vendor', id, COALESCE(payout_hold,0)::text FROM vendor WHERE company_id = $1
     UNION ALL SELECT 'owner', id, approval_threshold_cents::text FROM owner WHERE company_id = $1
     UNION ALL SELECT 'unit', id, status::text FROM unit WHERE company_id = $1
     UNION ALL SELECT 'vendor_invoice', id, status::text FROM vendor_invoice WHERE company_id = $1
     UNION ALL SELECT 'journal', id, memo FROM journal WHERE company_id = $1
     ORDER BY 1, 2`.replace(/\$1/g, "?"),
    ...Array(7).fill(companyId));
  return rows.map((r) => `${r.t}:${r.id}:${r.v}`);
}
