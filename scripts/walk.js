/* Walk every route the application registers.

   The test suite proves behaviour. This proves *reach*: that every page a
   person can navigate to actually renders, in a sensible time, and that every
   form on it points at a route that exists, carries a CSRF token, and does
   not crash when it is submitted.

   Those are different questions. A route can be covered by a unit test and
   still 500 on a real request because a template reads a column the query
   stopped selecting. A form can point at a route that was renamed. A page can
   answer correctly and take nine seconds. None of that shows up in a suite
   that calls functions.

   It runs against its own database and seeds its own data, because it submits
   every form it finds with deliberate rubbish to see what happens. Never
   point it at anything you care about.

   The database has to be named like a throwaway — the schema drop guards
   itself and refuses anything not ending in `_test`.

       createdb propops_walk_test
       sed 's/propops_test/propops_walk_test/' .env.test > .env.walk
       node --env-file=.env.walk scripts/walk.js

   Add PLATFORM_OPERATOR_EMAIL to that file to walk the platform pages as an
   operator rather than as a 403.
*/
import { performance } from "node:perf_hooks";

const SLOW_MS = Number(process.env.WALK_SLOW_MS || 1000);

/* --- fixture ---------------------------------------------------------------- */

export async function buildFixture() {
  const { ready, all, get, run, insert } = await import("../server/lib/db.js");
  await ready();

  const f = await import("../test/helpers/factories.js");
  const { id, token } = await import("../server/lib/ids.js");
  const { stamp, today, monthKey } = await import("../server/lib/dates.js");

  const world = await f.makeWorld({
    name: "Walk Co",
    staffRoles: ["admin", "accountant", "leasing", "technician"],
  });
  await run("UPDATE company SET timezone = 'UTC' WHERE id = ?", world.companyId);

  /* Enough real rows that the screens have something to render. A page that
     renders an empty state is not the page a person sees. */
  const wo = await f.makeWorkOrder(world.companyId, world.unitId, { leaseId: world.leaseId });
  const { postMoney } = await import("../server/lib/ledger.js");
  for (let i = 0; i < 3; i += 1) {
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, propertyId: world.propertyId,
      unitId: world.unitId, leaseId: world.leaseId, date: `2026-0${i + 1}-05`,
      kind: "rent_payment", amountCents: 120000, memo: `Rent ${i + 1}`,
      source: "manual", postedBy: "walk",
    });
  }

  /* A platform operator, so the two routes gated to one can be walked as
     something other than a 403. */
  if (process.env.PLATFORM_OPERATOR_EMAIL) {
    await f.makeStaff(world.companyId, {
      email: process.env.PLATFORM_OPERATOR_EMAIL, role: "admin", name: "Walk Operator",
    }).catch(() => {});
  }

  const vendorId = id();
  await insert("vendor", {
    id: vendorId, company_id: world.companyId, name: "Walk Plumbing",
    trade: "plumbing", email: "v@walk.test", active: 1, created_at: stamp(),
  });

  /* A row of every kind a route can be asked for.

     Without these the walk reports a 404 for a page that is perfectly fine —
     the token simply pointed at nothing. Sixteen routes were being counted as
     answered when what they had answered was "no such thing". */
  const rows = {};
  const C = world.companyId;

  rows.application = id(); rows.applicationToken = token();
  await insert("application", {
    id: rows.application, company_id: C, unit_id: world.unitId,
    applicant_name: "Walk Applicant", email: "applicant@walk.test",
    status: "received", token: rows.applicationToken, received_at: stamp(),
  });

  const { sha256 } = await import("../server/lib/crypto.js");
  const docBody = "# Lease\n\nBody.";
  rows.leaseDoc = id(); rows.leaseDocToken = token();
  rows.leaseTemplate = id();
  await insert("lease_template", {
    id: rows.leaseTemplate, company_id: C, name: "Walk template",
    kind: "lease", body_md: "# Lease\n\nBody.", active: 1,
    created_at: stamp(), updated_at: stamp(),
  });
  await insert("lease_document", {
    id: rows.leaseDoc, company_id: C, lease_id: world.leaseId, unit_id: world.unitId,
    template_id: rows.leaseTemplate, title: "Walk lease", body_md: docBody,
    body_hash: sha256(docBody), status: "out_for_signature", token: rows.leaseDocToken,
    required: JSON.stringify(["tenant", "manager"]), created_by: "walk", created_at: stamp(),
  });

  rows.verifyToken = token();
  await insert("email_verification", {
    id: id(), company_id: C, staff_id: world.staff.admin.id,
    email: "verify@walk.test", token: rows.verifyToken,
    expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: stamp(),
  });

  rows.approval = id(); rows.approvalToken = token();
  await insert("owner_approval", {
    id: rows.approval, company_id: C, owner_id: world.ownerId, work_order_id: wo,
    amount_cents: 90000, status: "pending", token: rows.approvalToken,
    requested_at: stamp(),
  });

  rows.statement = id(); rows.statementToken = token();
  await insert("owner_statement", {
    id: rows.statement, company_id: C, owner_id: world.ownerId,
    period_start: "2026-01-01", period_end: "2026-01-31",
    totals: JSON.stringify({
      rent: 120000, expenses: 0, fees: 0, other: 0, net: 120000, jobs: [], leaseEnds: [],
    }),
    token: rows.statementToken, generated_at: stamp(),
  });

  rows.inviteToken = token();
  await insert("staff_invite", {
    id: id(), company_id: C, email: "invite@walk.test", name: "Walk Invitee",
    role: "leasing", token: rows.inviteToken, invited_by: world.staff.admin.id,
    expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: stamp(),
  });

  rows.turn = id();
  await insert("turn", {
    id: rows.turn, company_id: C, unit_id: world.unitId, lease_id: world.leaseId,
    stage: "notice", notice_date: today(), status: "open", created_at: stamp(),
  });

  rows.listing = id();
  await insert("listing", {
    id: rows.listing, company_id: C, unit_id: world.unitId, status: "active",
    headline: "Walk listing", description: "A flat.", rent_cents: 120000,
    deposit_cents: 120000, available_date: today(), created_at: stamp(), updated_at: stamp(),
  });

  rows.delinquency = id();
  await insert("delinquency", {
    id: rows.delinquency, company_id: C, lease_id: world.leaseId,
    period: monthKey(today()), late_since: today(), amount_cents: 120000,
    stage: 1, status: "open", opened_at: stamp(),
  });

  rows.payment = (await get(
    "SELECT id FROM tenant_payment WHERE company_id = ? LIMIT 1", C))?.id || null;
  rows.ledgerEntry = (await get(
    "SELECT id FROM ledger_entry WHERE company_id = ? LIMIT 1", C))?.id || null;
  rows.journal = (await get(
    "SELECT id FROM journal WHERE company_id = ? LIMIT 1", C))?.id || null;
  rows.workOrderToken = (await get(
    "SELECT public_token FROM work_order WHERE id = ?", wo))?.public_token || null;

  /* And a key, so the API is walked as a caller rather than as a stranger.

     Not wrapped in a catch that returns null. It was, and the scopes passed
     were `["read","write"]` — neither of which is a scope — so `issueKey`
     threw, the catch ate it, and twenty API routes reported 401 as though
     that were the finding. A fixture that fails silently makes the walk lie. */
  const { issueKey, SCOPE_NAMES } = await import("../server/lib/api/keys.js");
  const issued = await issueKey({
    companyId: C, name: "walk", scopes: SCOPE_NAMES,
    staffId: world.staff.admin.id, createdBy: "walk",
  });
  rows.apiKey = issued.key;

  /* An inspection, its item, a turn task, and a deposit return with a
     deduction — the rows behind the routes the walk was skipping. */
  const inspections = await import("../server/lib/inspections.js");
  try {
    const insp = await inspections.startMoveOut
      ? await inspections.startMoveOut({ companyId: C, leaseId: world.leaseId, by: "walk" })
      : null;
    rows.inspection = insp?.id || insp || null;
  } catch { rows.inspection = null; }
  if (!rows.inspection) {
    rows.inspection = id();
    await insert("inspection", {
      id: rows.inspection, company_id: C, unit_id: world.unitId, lease_id: world.leaseId,
      kind: "move_out", status: "open", performed_by: "walk", performed_on: today(),
      created_at: stamp(), created_by: "walk",
    }).catch(() => { rows.inspection = null; });
  }
  if (rows.inspection) {
    rows.inspectionItem = id();
    await insert("inspection_item", {
      id: rows.inspectionItem, company_id: C, inspection_id: rows.inspection,
      room: "Kitchen", label: "Worktop", condition: "good", created_at: stamp(),
    }).catch(() => { rows.inspectionItem = null; });
  }

  rows.turnTask = id();
  await insert("turn_task", {
    id: rows.turnTask, turn_id: rows.turn, label: "Clean", sort: 1,
  }).catch(() => { rows.turnTask = null; });

  const deposits = await import("../server/lib/deposits.js");
  try {
    await deposits.takeDeposit({
      companyId: C, leaseId: world.leaseId, amountCents: 120000,
      date: today(), by: "walk",
    });
    const ret = await deposits.openReturn({
      companyId: C, leaseId: world.leaseId, by: "walk",
    });
    rows.depositReturn = ret?.id || ret;
    const ded = await deposits.addDeduction({
      companyId: C, returnId: rows.depositReturn, amountCents: 5000,
      reason: "Cleaning", by: "walk",
    });
    rows.deduction = ded?.id || ded;
  } catch { /* the routes fall back to skipped, and the report says so */ }

  return { world, wo, vendorId, rows, all, get, run, insert, id, token, today, monthKey };
}

/* Resolve a route parameter to something real, by what the route is about. */
export async function resolver(fx) {
  const { world, wo, vendorId, rows, get } = fx;
  const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
  const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);

  /* `:id` means a different thing on every branch of the tree, and `:tok` is
     worse — seven kinds of token share the name. Matching on the route's own
     prefix is what stops the walk reporting a 404 for a page that is fine and
     a token that pointed at nothing. */
  const idBy = [
    [/^\/app\/owners/, world.ownerId],
    [/^\/app\/portfolio\/p/, world.propertyId],
    [/^\/app\/portfolio\/u/, world.unitId],
    [/^\/app\/portfolio/, world.propertyId],
    [/^\/app\/(queue|maintenance|jobs)/, wo],
    [/^\/app\/vendors/, vendorId],
    [/^\/app\/staff/, world.staff.admin.id],
    [/^\/app\/leases\/templates/, rows.leaseTemplate],
    [/^\/app\/leases\/d/, rows.leaseDoc],
    [/^\/app\/leases/, world.leaseId],
    [/^\/app\/accounting\/j/, rows.journal],
    [/^\/app\/applications/, rows.application],
    [/^\/app\/turns/, rows.turn],
    [/^\/app\/rent/, rows.delinquency],
    [/^\/app\/deposits/, rows.depositReturn || world.leaseId],
    [/^\/app\/inspections/, rows.inspection],
    [/^\/app\/platform/, world.companyId],
    [/listings/, rows.listing],
    [/^\/api\/v1\/properties/, world.propertyId],
    [/^\/api\/v1\/units/, world.unitId],
    [/^\/api\/v1\/leases/, world.leaseId],
    [/^\/api\/v1\/tenants/, world.tenantId],
    [/^\/api\/v1\/owners/, world.ownerId],
    [/^\/api\/v1\/work-orders/, wo],
    [/^\/api\/v1\/journals/, rows.journal],
    [/^\/api\/v1\/payments/, rows.payment],
    [/^\/api\/v1\/ledger-entries/, rows.ledgerEntry],
  ];

  const tokBy = [
    [/^\/t\//, rows.workOrderToken],
    [/^\/a\//, rows.applicationToken],
    [/^\/sign\//, rows.leaseDocToken],
    [/^\/join\//, rows.inviteToken],
    [/^\/verify\//, rows.verifyToken],
    [/^\/o\/s\//, rows.statementToken],
    [/^\/o\/a\//, rows.approvalToken],
    [/^\/pay\//, lease.pay_token],
    [/^\/r\//, rows.workOrderToken],
    [/^\/portal\/enter/, "walk-not-a-real-token"],
  ];

  const pick = (table, pattern, fallback) => {
    for (const [re, value] of table) if (re.test(pattern)) return value;
    return fallback;
  };

  return {
    id: (pattern) => pick(idBy, pattern, world.leaseId),
    tok: (pattern) => pick(tokBy, pattern, lease.pay_token),
    token: (pattern) => pick(tokBy, pattern, lease.pay_token),
    leaseId: () => world.leaseId,
    propertyId: () => world.propertyId,
    itemId: () => rows.inspectionItem,
    deductionId: () => rows.deduction,
    requestId: () => rows.approval,
    taskId: () => rows.turnTask,
    sid: () => rows.statement,
    entity: () => "lease",
    key: () => "rent_roll",
    slug: () => company.slug || "walk-co",
  };
}

/* Routes that need a query string to mean anything. `/app/rent/record` reads
   `?lease=`, and without it answers 404 — which the walk would otherwise
   report as a broken page rather than as a question asked wrong. */
const QUERY = {
  "/app/rent/record": (fx) => `lease=${fx.world.leaseId}`,
  "/app/reports/:key": () => "from=2026-01-01&to=2026-12-31",
};

export function fill(pattern, keys, res) {
  let out = pattern;
  for (const k of keys) {
    const v = typeof res[k] === "function" ? res[k](pattern) : res[k];
    if (v == null) return null;
    out = out.replace(`:${k}`, encodeURIComponent(v));
  }
  return out;
}

/* --- the walk ---------------------------------------------------------------- */

export async function walk({ log = console.log } = {}) {
  const fx = await buildFixture();
  const { startApp, client } = await import("../test/helpers/http.js");
  const app = await startApp();
  const { registeredRoutes } = await import("../server/app.js");

  const agent = client(app.origin);
  const signedIn = await agent.signIn(fx.world.staff.admin.email,
    (await import("../test/helpers/factories.js")).PASSWORD);
  if (!signedIn.signedIn) throw new Error("could not sign in; the walk would measure sign-in pages");

  const res = await resolver(fx);
  const routes = registeredRoutes();
  const report = {
    gets: [], posts: [], forms: [], skipped: [],
    crashes: [], slow: [], brokenForms: [],
  };

  /* --- every GET ----------------------------------------------------------- */
  for (const r of routes.filter((x) => x.method === "GET")) {
    let path = fill(r.pattern, r.keys, res);
    if (!path) { report.skipped.push({ pattern: r.pattern, why: "no fixture for a parameter" }); continue; }
    if (QUERY[r.pattern]) path += `?${QUERY[r.pattern](fx)}`;

    const t0 = performance.now();
    let status = 0, body = "", err = null;
    const opts = path.startsWith("/api/") && fx.rows.apiKey
      ? { headers: { authorization: `Bearer ${fx.rows.apiKey}` } } : {};
    try {
      const out = await agent.text(path, opts);
      status = out.res.status;
      body = out.body || "";
    } catch (e) { err = String(e.message).slice(0, 120); }
    const ms = Math.round(performance.now() - t0);

    const row = { pattern: r.pattern, path, status, ms, bytes: body.length, err };
    report.gets.push(row);
    if (err || status >= 500) report.crashes.push(row);
    if (ms > SLOW_MS) report.slow.push(row);

    /* Every form on the page: does it point somewhere real, and is it
       protected? */
    if (status === 200 && body) {
      for (const m of body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const attrs = m[1];
        const inner = m[2];
        const action = (attrs.match(/action=["']([^"']*)["']/) || [])[1] || path;
        const method = ((attrs.match(/method=["']([^"']*)["']/) || [])[1] || "GET").toUpperCase();
        const hasCsrf = /name=["']_csrf["']/.test(inner);
        const f = { on: path, action, method, hasCsrf };
        report.forms.push(f);
        if (method === "POST" && !hasCsrf) report.brokenForms.push({ ...f, why: "no CSRF token" });
        if (method === "POST" && !routeExists(routes, "POST", action)) {
          report.brokenForms.push({ ...f, why: "action matches no registered POST route" });
        }
      }
    }
  }

  /* --- every POST, submitted empty ---------------------------------------- */
  /* Not to see it succeed — to see it refuse properly. An empty submission
     should be a 400 with a reason, or a redirect; a 500 is a route that
     trusts its input. */
  for (const r of routes.filter((x) => x.method === "POST")) {
    const path = fill(r.pattern, r.keys, res);
    if (!path) { report.skipped.push({ pattern: r.pattern, why: "no fixture for a parameter" }); continue; }
    if (/sign-out|platform|impersonat/.test(path)) {
      report.skipped.push({ pattern: r.pattern, why: "would end the session the walk runs in" });
      continue;
    }

    const t0 = performance.now();
    let status = 0, err = null;
    const popts = path.startsWith("/api/") && fx.rows.apiKey
      ? { csrfFrom: "/app", headers: { authorization: `Bearer ${fx.rows.apiKey}` } }
      : { csrfFrom: "/app" };
    try {
      const out = await agent.post(path, {}, popts);
      status = out.status;
    } catch (e) { err = String(e.message).slice(0, 120); }
    const ms = Math.round(performance.now() - t0);

    const row = { pattern: r.pattern, path, status, ms, err };
    report.posts.push(row);
    if (err || status >= 500) report.crashes.push(row);
  }

  /* --- the routes the main session cannot survive -------------------------- */

  /* Sign-out ends the session the walk runs in, so it gets a session of its
     own. Skipping them would leave three routes untested for a reason that is
     about the walk rather than about the routes. */
  const f2 = await import("../test/helpers/factories.js");
  for (const path of ["/app/account/sign-out-others", "/app/sign-out"]) {
    const spare = client(app.origin);
    const ok = await spare.signIn(fx.world.staff.admin.email, f2.PASSWORD);
    if (!ok.signedIn) continue;
    const t0 = performance.now();
    let status = 0, err = null;
    try { status = (await spare.post(path, {}, { csrfFrom: "/app" })).status; }
    catch (e) { err = String(e.message).slice(0, 120); }
    const row = { pattern: path, path, status, ms: Math.round(performance.now() - t0), err };
    report.posts.push(row);
    if (err || status >= 500) report.crashes.push(row);
  }

  /* And the platform area, which correctly refuses an ordinary admin. Walking
     it as one proves the gate; walking it as an operator proves the page. */
  if (process.env.PLATFORM_OPERATOR_EMAIL) {
    const op = client(app.origin);
    const ok = await op.signIn(process.env.PLATFORM_OPERATOR_EMAIL, f2.PASSWORD);
    if (ok.signedIn) {
      for (const pattern of ["/app/platform", "/app/platform/c/:id"]) {
        const path = pattern.replace(":id", fx.world.companyId);
        const t0 = performance.now();
        let status = 0, body = "", err = null;
        try {
          const out = await op.text(path);
          status = out.res.status; body = out.body || "";
        } catch (e) { err = String(e.message).slice(0, 120); }
        const row = { pattern: `${pattern} (as operator)`, path, status,
          ms: Math.round(performance.now() - t0), bytes: body.length, err };
        report.gets.push(row);
        if (err || status >= 500) report.crashes.push(row);
      }
    }
  }

  await app.close();
  return report;
}

function routeExists(routes, method, action) {
  const path = String(action).split("?")[0];
  if (!path.startsWith("/")) return true; // relative or absolute URL; not ours to judge
  return routes.some((r) => {
    if (r.method !== method) return false;
    const re = new RegExp("^" + r.pattern.replace(/:[a-zA-Z]+/g, "[^/]+") + "$");
    return re.test(path);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await walk();
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/walk-report.json", JSON.stringify(report, null, 2));

  const ok = (rows) => rows.filter((r) => r.status >= 200 && r.status < 400).length;
  console.log(`\nGET   ${report.gets.length} routes, ${ok(report.gets)} answered 2xx/3xx`);
  console.log(`POST  ${report.posts.length} routes, ${ok(report.posts)} answered 2xx/3xx`);
  console.log(`forms ${report.forms.length} found, ${report.brokenForms.length} with a problem`);
  console.log(`skipped ${report.skipped.length}`);
  console.log(`\nCRASHES (5xx or threw): ${report.crashes.length}`);
  for (const c of report.crashes.slice(0, 40)) {
    console.log(`  ${String(c.status).padEnd(4)} ${c.pattern}${c.err ? `  ${c.err}` : ""}`);
  }
  console.log(`\nBROKEN FORMS: ${report.brokenForms.length}`);
  for (const b of report.brokenForms.slice(0, 40)) console.log(`  ${b.why}: ${b.action} (on ${b.on})`);

  const slowest = [...report.gets].sort((a, b) => b.ms - a.ms).slice(0, 15);
  console.log(`\nSLOWEST PAGES`);
  for (const s of slowest) console.log(`  ${String(s.ms).padStart(6)}ms  ${s.pattern}`);
  console.log("\nfull report: /tmp/walk-report.json");
  process.exit(report.crashes.length ? 1 : 0);
}
