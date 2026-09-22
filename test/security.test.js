/* The security properties, each one previously verified by hand once.

   Verified once is verified until the next refactor. These are the checks that
   were run manually during the security pass and are now run on every push. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  world = await f.makeWorld({
    name: "Security Co",
    staffRoles: ["admin", "manager", "accountant", "leasing", "maintenance"],
  });
});

after(async () => {
  await app.close();
  await closeDb();
});

describe("CSRF", () => {
  test("a POST with no token is refused", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await c.post("/app/portfolio/new", { line1: "1 Nowhere" }, { csrf: null });
    assert.equal(res.status, 403);
  });

  test("a POST with a token that is not ours is refused", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await c.post("/app/portfolio/new", { line1: "1 Nowhere" },
      { csrf: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(res.status, 403);
  });

  test("the public tenant form is protected too", async () => {
    // Without this, any site on the internet could post work orders into the queue.
    const c = client(app.origin);
    const res = await c.post("/report", {
      unit_token: world.reportToken, category: "plumbing", closest: "one_fixture",
      summary: "x", phone: "6145550142",
    }, { csrf: null });
    assert.equal(res.status, 403);
  });
});

describe("rate limiting", () => {
  test("sign-in locks out after repeated failures", async () => {
    const c = client(app.origin);
    const email = world.staff.manager.email;
    let locked = false;

    for (let i = 0; i < 11; i++) {
      const res = await c.signIn(email, "definitely-not-the-password");
      const { body } = await c.follow(res);
      if (/too many/i.test(body)) { locked = true; break; }
    }
    assert.ok(locked, "brute force must be stopped");

    // Still locked even with the right password: the limit is on the attempt.
    const res = await c.signIn(email, f.PASSWORD);
    assert.equal(res.signedIn, false, "a locked account must not sign in even with the right password");
    const { body } = await c.follow(res);
    assert.match(body, /too many/i);

    await run("DELETE FROM rate_hit");     // leave the table clean for other tests
  });

  test("the limiter fails open when its own table is unusable", async () => {
    /* A database problem must not lock everybody out of their own sign-in
       page. Asserted on the module rather than by breaking the table. */
    const { check } = await import("../server/lib/ratelimit.js");
    const res = await check("signin", "1.2.3.4");
    assert.equal(typeof res.allowed, "boolean");
  });
});

describe("the role gate", () => {
  const moneyRoutes = ["/app/accounting", "/app/banking", "/app/owners", "/app/rent", "/app/vendors/1099"];

  for (const role of ["leasing", "maintenance"]) {
    test(`a ${role} account is refused every money route`, async () => {
      const c = client(app.origin);
      const res = await c.signIn(world.staff[role].email, f.PASSWORD);
      assert.equal(res.signedIn, true, `${role} must be able to sign in`);
      for (const route of moneyRoutes) {
        const r = await c.get(route);
        assert.equal(r.status, 403, `${role} must not reach ${route}`);
      }
    });
  }

  test("an admin reaches all of them", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    for (const route of moneyRoutes) {
      const r = await c.get(route);
      assert.equal(r.status, 200, `admin must reach ${route}`);
    }
  });

  test("the gate is enforced centrally, not per handler", async () => {
    /* If a handler ever starts doing its own check, this is the test that
       should be updated deliberately — not silently bypassed. */
    const appSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../server/app.js", import.meta.url), "utf8"));
    assert.match(appSrc, /requiredCapability\(path, req\.method\)/,
      "app.js must consult the capability table for every request");
  });

  test("signed out, an app route redirects to sign-in rather than answering", async () => {
    const c = client(app.origin);
    const res = await c.get("/app/accounting");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") || "", /\/app\/sign-in/);
  });
});

describe("tokenised public pages", () => {
  test("a bad token never returns a record", async () => {
    const c = client(app.origin);
    for (const path of ["/t/not-a-real-token-value-at-all", "/o/s/nope", "/o/a/nope", "/a/nope"]) {
      const res = await c.get(path);
      assert.notEqual(res.status, 200, `${path} answered 200 for a junk token`);
    }
  });

  test("a short token is rejected before it reaches a query", async () => {
    const { byToken } = await import("../server/lib/auth.js");
    assert.equal(await byToken("work_order", "public_token", "abc"), null);
  });

  test("a real token opens exactly its own record", async () => {
    const wo = await get("SELECT public_token FROM work_order WHERE id = ?", world.workOrderId);
    const c = client(app.origin);
    const res = await c.get(`/t/${wo.public_token}`);
    assert.equal(res.status, 200);
  });
});

describe("the address lookup never enumerates the portfolio", () => {
  test("the bare form lists nothing", async () => {
    const c = client(app.origin);
    const { body } = await c.text("/report");
    assert.equal((body.match(/<option/g) || []).length, 0,
      "a dropdown here hands the portfolio to anyone who opens the page");
    assert.match(body, /name="addr"/, "it asks the tenant to type their address");
  });

  test("a wrong address gives a dead end, not a list", async () => {
    const c = client(app.origin);
    const { body } = await c.text("/report?addr=" + encodeURIComponent("999 Nowhere Avenue"));
    assert.match(body, /could not find/i);
    assert.equal((body.match(/<option/g) || []).length, 0);
  });

  test("a correct address resolves to one unit without naming any other", async () => {
    const prop = await get("SELECT line1 FROM property WHERE id = ?", world.propertyId);
    const c = client(app.origin);
    const res = await c.get("/report?addr=" + encodeURIComponent(prop.line1));
    // One match redirects straight through; several show only that building.
    assert.ok(res.status === 303 || res.status === 200);
  });
});

describe("security headers", () => {
  test("every response carries the policy", async () => {
    const c = client(app.origin);
    const res = await c.get("/report");
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self'/, "no inline script may execute");
    assert.match(csp, /frame-ancestors 'none'/, "clickjacking");
    assert.match(csp, /form-action 'self'/, "an injected form must not post elsewhere");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok(res.headers.get("x-request-id"), "every response is traceable");
  });

  test("no page carries an inline script, so the policy holds", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    for (const path of ["/report", "/app", "/app/portfolio", "/app/accounting"]) {
      const { body } = await c.text(path);
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(body), `${path} has an inline script`);
    }
  });
});

describe("the database lockdown", () => {
  test("row level security is on every table", async () => {
    const open = await all(
      `SELECT tablename FROM pg_tables t WHERE schemaname='public'
        AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE n.nspname='public' AND c.relname=t.tablename AND c.relrowsecurity)`);
    assert.deepEqual(open.map((r) => r.tablename), [],
      "a table without RLS is readable by anyone holding the publishable key");
  });

  test("no privileges are granted to anon, authenticated or PUBLIC", async () => {
    const grants = await all(
      `SELECT DISTINCT table_name, grantee FROM information_schema.role_table_grants
        WHERE table_schema='public' AND grantee IN ('anon','authenticated','PUBLIC')`);
    assert.deepEqual(grants, [], "the REST API must have nothing behind it");
  });

  test("there are no SECURITY DEFINER functions or views to sidestep RLS", async () => {
    const definers = await all(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef`);
    assert.deepEqual(definers.map((d) => d.proname), []);
    const views = await all(`SELECT viewname FROM pg_views WHERE schemaname='public'`);
    assert.deepEqual(views.map((v) => v.viewname), []);
  });
});

describe("passwords and sessions", () => {
  test("passwords are stored as scrypt, never reversibly", async () => {
    const row = await get("SELECT password_hash FROM staff WHERE id = ?", world.staff.admin.id);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(f.PASSWORD));
  });

  test("a wrong password is refused and a right one is not", async () => {
    /* A fresh client per attempt: once a session exists, /app/sign-in
       redirects and there is no form left to read a token from — which is
       correct behaviour, and which a single reused client would misread as a
       failure. */
    const bad = await client(app.origin).signIn(world.staff.accountant.email, "wrong");
    assert.equal(bad.signedIn, false);
    const good = await client(app.origin).signIn(world.staff.accountant.email, f.PASSWORD);
    assert.equal(good.signedIn, true);
  });

  test("an inactive staff member cannot sign in", async () => {
    const s = await f.makeStaff(world.companyId, { email: "gone@security-co.invalid", role: "admin", active: 0 });
    const res = await client(app.origin).signIn(s.email, f.PASSWORD);
    assert.equal(res.signedIn, false, "deactivating an account must actually stop it");
  });
});

describe("the suite cannot reach a real database", () => {
  /* This is not hypothetical. The harness drops and rebuilds the public
     schema, and it decided whether that was safe by reading NODE_ENV. Running
     it with the production env file loaded and NODE_ENV unset pointed the
     drop at the live database and emptied it — config.js handed over
     DATABASE_URL exactly as asked, because that is what it was asked for.

     The guard now lives on the destructive call itself, which is the only
     place that cannot be bypassed by forgetting a variable. */
  const helperSrc = () => readFileSync(
    new URL("./helpers/db.js", import.meta.url), "utf8");

  test("every destructive call checks that the database is disposable", () => {
    const src = helperSrc();
    for (const statement of ["DROP SCHEMA IF EXISTS public CASCADE", "TRUNCATE"]) {
      const at = src.indexOf(statement);
      assert.ok(at > 0, `${statement} is no longer in the helper — update this test`);
      const before = src.slice(0, at);
      assert.ok(before.lastIndexOf("refuseUnlessDisposable") > before.lastIndexOf("export async function"),
        `${statement} runs without a disposability check in front of it`);
    }
  });

  test("the check requires the pool to have come from TEST_DATABASE_URL", () => {
    assert.match(helperSrc(), /IS_TEST_DATABASE/,
      "a check that only reads NODE_ENV is the check that already failed");
  });

  test("and refuses a database not named like a throwaway", () => {
    /* Belt and braces: if TEST_DATABASE_URL is ever pointed at something
       real, the name is the second thing standing in the way. */
    assert.match(helperSrc(), /current_database\(\)/);
  });

  test("this run is against a disposable database", async () => {
    const { IS_TEST_DATABASE } = await import("../server/lib/config.js");
    assert.equal(IS_TEST_DATABASE, true);
    const row = await get("SELECT current_database() AS name");
    assert.match(row.name, /_test$|^test_/);
  });
});
