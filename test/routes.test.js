/* Every route is gated, or is deliberately public with a reason.

   There are over three hundred route registrations now, added across ten
   phases. Reviewing them is a habit; this is a test.

   Each one has to be one of four things, and the fourth is the only one that
   takes a decision:

     under /app      gated by a capability, or one of the two sign-in paths
     under /portal   a person's session, with authority asked per record
     under /api      a key, through the one door in features/api.js
     public          listed below, **with the reason written beside it**

   A route added in a later phase is then either covered or it fails here. The
   same shape as the export's "every table has a decision" test and the
   sidebar-against-the-gate test from Phase 7b — both of which caught real
   holes, which is why this one exists.

   ## Why a list rather than a rule

   "Anything with a token is public" is a rule, and it would have let
   `/app/reports/:key` through the day somebody renamed it. A list is a
   decision per route, and the cost of adding a route is reading one line. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { registeredRoutes } from "../server/app.js";
import { requiredCapability, CAPABILITIES, capabilitiesFor } from "../server/lib/auth.js";

/* Public on purpose. The reason is the point of the table: a route here is a
   route somebody decided should answer a stranger. */
const PUBLIC = {
  "/r/:tok": "The QR sticker on a front door, redirecting to the repair form.",
  "/report": "Tenant repair intake. No account — that is the whole design.",
  "/c/:slug/report": "The repair form on a named company's own address.",
  "/t/:tok": "A tenant watching their own repair. The token is the capability.",

  "/apply": "The rental application. An applicant has no account and should not need one.",
  "/c/:slug/apply": "The application form on a named company's own address.",
  "/a/:tok": "An applicant adding documents to their own application.",
  "/a/:tok/consent": "Consent to being screened, at the link they already have.",
  "/a/:tok/consent/withdraw": "And changing their mind about it.",

  "/o/s/:tok": "An owner's monthly statement. A link they were sent.",
  "/o/s/:tok/pdf": "The same statement as a file, behind the same token.",
  "/o/a/:tok": "An owner approving a spend, in one click, without a login.",

  "/sign/:tok": "Signing a lease document. The token is what was emailed.",

  "/pay/:tok": "A tenant paying rent. No account, by design.",
  "/pay/:tok/back": "Where the payment provider returns them.",
  "/pay/:tok/autopay": "Setting up autopay from the same link.",

  "/signup": "Creating a company. There is nobody to authenticate yet.",
  "/verify/:tok": "Confirming the email address that signed up.",
  "/join/:tok": "Accepting a staff invitation. Same reason.",

  "/feeds/listings.xml": "A pointer at the per-company feeds. Carries no listings.",
  "/feeds/:slug/listings.xml": "One company's syndication feed. An aggregator holds no account.",

  "/listings": "Places to rent. Meant to be found.",
  "/listings/:id": "One of those places, with an enquiry form on it.",
  "/c/:slug/listings": "A named company's vacancies, on its own address.",
  "/c/:slug/listings/:id": "One place to rent, on a named company's own address.",
  "/listings/:id/enquire": "Asking about one. Rate limited like every other public form.",
  "/c/:slug/listings/:id/enquire": "Asking about one on a named company's address.",

  "/sw.js": "The service worker. A static file the browser fetches by itself.",
  "/offline": "What an installed app shows with no network.",
  "/push/key": "The public half of the push key pair. Public is what it is for.",

  "/app/sign-in": "The form itself. Gating it would be a locked door with no handle.",
  "/app/sign-out": "Leaving. Refusing that would be worse than allowing it.",
};

/* Under /app and needing no capability beyond being signed in. Each one is a
   decision recorded in `auth.js` as an explicit null, and repeated here so
   the two have to agree. */
const SIGNED_IN_IS_ENOUGH = {
  "/app/account": "Somebody's own account: their password, their second factor.",
  "/app/account/2fa": "Enrolling their own second factor, on their own account.",
  "/app/account/2fa/start": "Beginning their own second-factor enrolment.",
  "/app/account/2fa/confirm": "Finishing their own second-factor enrolment.",
  "/app/account/2fa/disable": "Turning off their own second factor.",
  "/app/account/2fa/regenerate": "Replacing their own two-factor recovery codes.",
  "/app/account/password": "Changing their own password, which nobody else may do for them.",
  "/app/account/sign-out-others": "Ending their own sessions on other devices.",

  "/app/reports": "The section. Which reports appear is decided per report, "
    + "because the capability depends on which one — a single gate would be "
    + "either the loosest of them or the strictest.",
  "/app/reports/:key": "Gated per report, in the handler, against the record.",
  "/app/reports/:key/csv": "The same report as a file, behind the same per-report check.",
  "/app/reports/:key/pdf": "The same report as a file, behind the same per-report check.",
  "/app/reports/:key/save": "Checked against the report's own capability.",
  "/app/reports/saved": "The saved views and schedules, each checked per report below.",
  "/app/reports/saved/:id/delete": "Checked against the saved report's own capability.",
  "/app/reports/saved/new/schedule": "Recipients are checked to hold it before it is scheduled.",
  "/app/reports/schedules/:id/toggle": "Checked against the saved report's own capability.",
  "/app/reports/schedules/:id/delete": "Checked against the saved report's own capability.",
};

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({
    name: "Routes Co",
    staffRoles: ["admin", "manager", "accountant", "leasing", "maintenance", "technician"],
  });
});

const isApp = (p) => p === "/app" || p.startsWith("/app/");
const isPortal = (p) => p === "/portal" || p.startsWith("/portal/");
const isApi = (p) => p === "/api" || p.startsWith("/api/");

describe("every route is accounted for", () => {
  test("there are a lot of them, which is why this is a test", () => {
    assert.ok(registeredRoutes().length > 250,
      "if this drops sharply, something stopped registering and the rest of this file "
      + "is asserting properties of an empty list");
  });

  test("each one is gated, or public with a reason written down", () => {
    const undecided = [];

    for (const route of registeredRoutes()) {
      const p = route.pattern;

      if (PUBLIC[p]) continue;
      if (isPortal(p)) continue;       // a person's session; authority per record
      if (isApi(p)) continue;          // a key, through the one door

      if (isApp(p)) {
        if (requiredCapability(p, route.method)) continue;
        if (SIGNED_IN_IS_ENOUGH[p]) continue;
        undecided.push(`${route.method} ${p}  (under /app and needs no capability)`);
        continue;
      }

      undecided.push(`${route.method} ${p}  (answers a stranger and is not in PUBLIC)`);
    }

    assert.deepEqual(undecided, [],
      "Each of these is either missing a capability or missing a line in this file's "
      + "PUBLIC table saying why a stranger may reach it:\n  " + undecided.join("\n  "));
  });

  test("and nothing in the tables describes a route that no longer exists", () => {
    const patterns = new Set(registeredRoutes().map((r) => r.pattern));
    const stale = [...Object.keys(PUBLIC), ...Object.keys(SIGNED_IN_IS_ENOUGH)]
      .filter((p) => !patterns.has(p));
    assert.deepEqual(stale, [],
      "a decision about a route that is gone is a decision nobody will notice has "
      + "stopped applying");
  });

  test("every reason is a reason, not a placeholder", () => {
    for (const [route, why] of Object.entries({ ...PUBLIC, ...SIGNED_IN_IS_ENOUGH })) {
      assert.ok(why.length > 20, `${route} has no real reason beside it`);
      assert.doesNotMatch(why, /^(todo|tbd|public|n\/a)/i, `${route}: "${why}"`);
    }
  });

  test("every capability the table names is one that exists", () => {
    for (const route of registeredRoutes()) {
      const need = requiredCapability(route.pattern, route.method);
      if (!need) continue;
      assert.ok(CAPABILITIES.includes(need),
        `${route.pattern} needs "${need}", which is not a capability`);
    }
  });

  test("a write is never easier to reach than the read beside it", () => {
    /* A POST gated more loosely than the GET on the same path is a way in that
       nobody would think to look for. */
    const gets = new Map();
    for (const r of registeredRoutes()) {
      if (r.method === "GET") gets.set(r.pattern, requiredCapability(r.pattern, "GET"));
    }
    for (const r of registeredRoutes()) {
      if (r.method !== "POST" || !isApp(r.pattern)) continue;
      const read = gets.get(r.pattern);
      const write = requiredCapability(r.pattern, "POST");
      if (!read) continue;
      assert.ok(write, `POST ${r.pattern} needs no capability and GET needs ${read}`);
    }
  });
});

/* --- and the gate actually refuses ---------------------------------------------- */

describe("the gate is not only a table", () => {
  /* One route per capability, driven through HTTP as somebody who lacks it.
     The table above is a statement about the code; this is a statement about
     what the server does. */
  const CASES = [
    ["money.view", "technician", "/app/owners"],
    ["money.view", "technician", "/app/deposits"],
    ["money.view", "leasing", "/app/accounting"],
    ["property.view", "technician", "/app/portfolio"],
    ["property.view", "technician", "/app/inspections"],
    ["maintenance.work", "leasing", "/app/maintenance"],
    ["leasing.work", "maintenance", "/app/listings"],
    ["settings.manage", "maintenance", "/app/setup"],
    ["settings.manage", "maintenance", "/app/company"],
    ["settings.manage", "maintenance", "/app/billing"],
    ["staff.manage", "manager", "/app/staff"],
    ["queue.view", "technician", "/app/messages"],
    ["bank.link", "leasing", "/app/banking"],
    ["vendor.manage", "leasing", "/app/vendors"],
  ];

  for (const [capability, role, path] of CASES) {
    test(`a ${role} account, which lacks ${capability}, is refused ${path}`, async () => {
      assert.equal(capabilitiesFor(role).has(capability), false,
        `this test assumes a ${role} lacks ${capability}; it does not, so the case is wrong`);

      const c = client(app.origin);
      const signedIn = await c.signIn(world.staff[role].email, f.PASSWORD);
      assert.equal(signedIn.signedIn, true, `${role} must be able to sign in`);

      const res = await c.get(path);
      assert.equal(res.status, 403, `${role} reached ${path}`);
    });
  }

  test("signed out, every gated path sends somebody to sign in rather than answering",
    async () => {
      const c = client(app.origin);
      for (const path of ["/app", "/app/portfolio", "/app/accounting", "/app/deposits",
        "/app/inspections", "/app/setup", "/app/staff"]) {
        const res = await c.get(path);
        assert.equal(res.status, 303, `${path} answered a stranger`);
        assert.match(res.headers.get("location") || "", /\/app\/sign-in/);
      }
    });

  test("a public route really is reachable without anything", async () => {
    /* The other direction: a route in the PUBLIC table that has quietly
       started requiring a session is a door that was open and is not. */
    const c = client(app.origin);
    for (const path of ["/report", "/apply", "/signup", "/offline", "/push/key",
      "/feeds/listings.xml", "/listings"]) {
      const res = await c.get(path);
      assert.ok(res.status < 400 || res.status === 404,
        `${path} answered ${res.status} to a stranger and is listed as public`);
      assert.notEqual(res.status, 403, `${path} is listed as public and refuses`);
    }
  });
});
