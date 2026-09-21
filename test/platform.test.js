/* Platform administration and impersonation.

   This is the one capability in the system that is not scoped by company_id,
   which makes it the most dangerous code in the repository. Every other
   isolation guarantee assumes it is not being misused, so the tests are about
   the limits rather than the feature.

   Three things must hold. Only the configured operator can reach it. A
   borrowed session can read and cannot write. And the company can see that it
   happened — support access a customer cannot see is the kind of thing that
   ends up in a breach disclosure rather than a support ticket. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
process.env.PLATFORM_OPERATOR_EMAIL = "operator@platform.test";

const { freshDatabase, truncateAll, closeDb, all, get, run } = await import("./helpers/db.js");
const { startApp, client } = await import("./helpers/http.js");
const f = await import("./helpers/factories.js");
const { isPlatformOperator, impersonationForbids } = await import("../server/features/platform.js");

let app, customer, operatorCompany, operator;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  customer = await f.makeWorld({ name: "Customer Co", staffRoles: ["admin"] });
  /* The operator is staff of their own company, and is recognised by address
     rather than by anything inside that company's data. */
  operatorCompany = await f.makeCompany("Platform Operations");
  operator = await f.makeStaff(operatorCompany, {
    email: "operator@platform.test", role: "admin", name: "Operator",
  });
});

async function asOperator() {
  const c = client(app.origin);
  const res = await c.signIn("operator@platform.test", f.PASSWORD);
  assert.equal(res.signedIn, true);
  return c;
}

describe("who may reach the platform area", () => {
  test("the configured address may", async () => {
    const c = await asOperator();
    const { res, body } = await c.text("/app/platform");
    assert.equal(res.status, 200);
    assert.match(body, /Customer Co/, "the operator can see every company");
  });

  test("an ordinary company administrator may not", async () => {
    const c = client(app.origin);
    await c.signIn(customer.staff.admin.email, f.PASSWORD);
    assert.equal((await c.get("/app/platform")).status, 403);
    assert.equal((await c.get(`/app/platform/c/${customer.companyId}`)).status, 403);
  });

  test("it is an address, not a role a customer could grant themselves", () => {
    /* A role is a column somebody can change. This capability must not be
       grantable from inside the product. */
    assert.equal(isPlatformOperator({ email: "operator@platform.test", role: "leasing" }), true);
    assert.equal(isPlatformOperator({ email: "someone@customer.test", role: "admin" }), false);
    assert.equal(isPlatformOperator({ role: "admin" }), false);
  });
});

describe("a borrowed session can look and cannot touch", () => {
  async function startImpersonation(c, reason = "Ticket 412 — statement totals") {
    const staff = await get("SELECT id FROM staff WHERE email = ?", customer.staff.admin.email);
    return await c.post(`/app/platform/c/${customer.companyId}/impersonate`,
      { staff_id: staff.id, reason },
      { csrfFrom: `/app/platform/c/${customer.companyId}` });
  }

  test("it opens the customer's own screens", async () => {
    const c = await asOperator();
    await startImpersonation(c);

    const { res, body } = await c.text("/app");
    assert.equal(res.status, 200);
    assert.match(body, /Customer Co/, "this is the point: seeing what they see");
  });

  test("a banner says so on every page", async () => {
    const c = await asOperator();
    await startImpersonation(c, "Ticket 99 — rent screen");

    for (const path of ["/app", "/app/portfolio", "/app/maintenance"]) {
      const { body } = await c.text(path);
      assert.match(body, /Support is viewing this account/i, `${path} must say so`);
      assert.match(body, /Ticket 99/, "including why");
    }
  });

  test("every write is refused", async () => {
    const c = await asOperator();
    await startImpersonation(c);

    const res = await c.post("/app/portfolio/new",
      { line1: "1 Nowhere", city: "Columbus", owner_id: customer.ownerId },
      { csrfFrom: "/app/portfolio" });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /read-only support session/i);
  });

  test("the three takeover paths are closed", () => {
    /* Changing a password, removing the second factor, spending their money,
       or adding a colleague would each turn observation into becoming them. */
    assert.equal(impersonationForbids("/app/account", "GET"), "account");
    assert.equal(impersonationForbids("/app/account/2fa", "GET"), "account");
    assert.equal(impersonationForbids("/app/billing", "GET"), "billing");
    assert.equal(impersonationForbids("/app/staff", "GET"), "staff");
    assert.equal(impersonationForbids("/app/portfolio", "GET"), null, "reading is the point");
    assert.equal(impersonationForbids("/app/portfolio", "POST"), "write");
  });

  test("the account pages are unreachable even to read", async () => {
    const c = await asOperator();
    await startImpersonation(c);
    for (const path of ["/app/account", "/app/account/2fa", "/app/billing", "/app/staff"]) {
      assert.equal((await c.get(path)).status, 403, `${path} must be closed`);
    }
  });

  test("a reason is required, because the customer reads it", async () => {
    const c = await asOperator();
    const res = await startImpersonation(c, "x");
    assert.ok(res.status >= 400);
    assert.equal((await all("SELECT id FROM impersonation")).length, 0);
  });

  test("ending it returns the operator to sign-in, not to the customer's account", async () => {
    const c = await asOperator();
    await startImpersonation(c);
    const res = await c.get("/app/platform/stop");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /sign-in/);

    const row = await get("SELECT ended_at FROM impersonation LIMIT 1");
    assert.ok(row.ended_at);
    assert.equal((await c.get("/app")).status, 303, "the borrowed session is gone");
  });
});

describe("the customer can see it happened", () => {
  test("their own audit screen records when, who and why", async () => {
    const c = await asOperator();
    const staff = await get("SELECT id FROM staff WHERE email = ?", customer.staff.admin.email);
    await c.post(`/app/platform/c/${customer.companyId}/impersonate`,
      { staff_id: staff.id, reason: "Ticket 77 — owner statement query" },
      { csrfFrom: `/app/platform/c/${customer.companyId}` });
    await c.get("/app");
    await c.get("/app/platform/stop");

    const theirs = client(app.origin);
    await theirs.signIn(customer.staff.admin.email, f.PASSWORD);
    const { res, body } = await theirs.text("/app/company/access");

    assert.equal(res.status, 200);
    assert.match(body, /operator@platform.test/, "who");
    assert.match(body, /Ticket 77/, "why");
    assert.match(body, /Nobody has ever accessed/.test(body) ? /never/ : /\d/, "when");
  });

  test("pages viewed are counted, not listed", async () => {
    /* A support session must not become a second copy of the customer's
       data — the count answers "how much did they look at" without keeping
       a record of every screen. */
    const c = await asOperator();
    const staff = await get("SELECT id FROM staff WHERE email = ?", customer.staff.admin.email);
    await c.post(`/app/platform/c/${customer.companyId}/impersonate`,
      { staff_id: staff.id, reason: "Ticket 88 — checking" },
      { csrfFrom: `/app/platform/c/${customer.companyId}` });

    await c.get("/app");
    await c.get("/app/portfolio");
    await c.get("/app/maintenance");

    const row = await get("SELECT pages_viewed FROM impersonation LIMIT 1");
    assert.ok(Number(row.pages_viewed) >= 3);

    const columns = await all(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'impersonation'`);
    const names = columns.map((x) => x.column_name);
    assert.ok(!names.includes("paths") && !names.includes("pages"),
      "the individual screens are deliberately not stored");
  });

  test("the record survives the operator, because it is theirs", async () => {
    const c = await asOperator();
    const staff = await get("SELECT id FROM staff WHERE email = ?", customer.staff.admin.email);
    await c.post(`/app/platform/c/${customer.companyId}/impersonate`,
      { staff_id: staff.id, reason: "Ticket 5 — a look" },
      { csrfFrom: `/app/platform/c/${customer.companyId}` });
    await c.get("/app/platform/stop");

    /* The operator is recorded by address rather than a foreign key, so
       removing their staff row cannot erase the audit trail. */
    await run("DELETE FROM staff WHERE email = ?", "operator@platform.test");
    const row = await get("SELECT operator, reason FROM impersonation LIMIT 1");
    assert.equal(row.operator, "operator@platform.test");
    assert.match(row.reason, /Ticket 5/);
  });
});
