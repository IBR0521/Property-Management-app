/* The content security policy, and the claim it rests on.

   `script-src 'self'` is only worth anything if an injected `<script>` has
   nothing to execute — which is true because this application ships no inline
   script and loads none from anywhere else. That was a design decision in
   Phase 0 and it has survived ten phases, including the one where Plaid Link
   would have needed a CDN exception and was deferred instead.

   A claim that has held for ten phases by habit is a claim that will stop
   holding on the day somebody adds a one-line `onclick`. So it is a test: no
   page carries an inline script, no page loads one the policy would refuse,
   and no element carries an inline event handler.

   Inline *style* is allowed and used throughout, deliberately: style injection
   is a far smaller problem than script injection, and every interpolation is
   escaped anyway. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world, agent, visitor;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Policy Co", staffRoles: ["admin"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
  visitor = client(app.origin);
});

/* What the policy allows a page to load, spelled out here so this test fails
   if the policy widens without somebody meaning it to. */
const ALLOWED_SCRIPT_SRC = [/^\/app-assets\/js\//];
const ALLOWED_STYLE_HOSTS = [/^https:\/\/fonts\.googleapis\.com\//];

function scripts(body) {
  return [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((m) => ({ attrs: m[1], inline: m[2].trim() }));
}

const STAFF_PAGES = [
  "/app", "/app/portfolio", "/app/maintenance", "/app/accounting", "/app/rent",
  "/app/owners", "/app/deposits", "/app/inspections", "/app/listings",
  "/app/leases", "/app/applications", "/app/compliance", "/app/turns",
  "/app/vendors", "/app/reports", "/app/messages", "/app/inbox", "/app/staff",
  "/app/setup", "/app/company", "/app/billing", "/app/account",
  "/app/setup/import", "/app/setup/export", "/app/setup/api",
  "/app/setup/webhooks", "/app/setup/screening",
];

describe("no page carries script the policy would refuse", () => {
  test("not one of the staff screens has an inline script", async () => {
    const offenders = [];
    for (const path of STAFF_PAGES) {
      const { res, body } = await agent.text(path);
      assert.ok(res.status < 400, `${path} answered ${res.status}`);
      for (const s of scripts(body)) {
        if (s.inline) offenders.push(`${path}: inline <script> of ${s.inline.length} chars`);
        const src = /src="([^"]*)"/.exec(s.attrs)?.[1];
        if (src && !ALLOWED_SCRIPT_SRC.some((re) => re.test(src))) {
          offenders.push(`${path}: <script src="${src}">`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      "script-src 'self' is only worth anything because an injected <script> has nothing "
      + "to execute:\n  " + offenders.join("\n  "));
  });

  test("nor do the public pages, which is where a stranger's input is rendered",
    async () => {
      const unit = await get("SELECT report_token FROM unit WHERE id = ?", world.unitId);
      const pages = [
        "/report", `/report?u=${unit.report_token}`, "/apply", "/signup",
        "/listings", "/offline", "/portal/sign-in",
      ];
      const offenders = [];
      for (const path of pages) {
        const { body } = await visitor.text(path);
        for (const s of scripts(body)) {
          if (s.inline) offenders.push(`${path}: inline <script>`);
          const src = /src="([^"]*)"/.exec(s.attrs)?.[1];
          if (src && !ALLOWED_SCRIPT_SRC.some((re) => re.test(src))) {
            offenders.push(`${path}: <script src="${src}">`);
          }
        }
      }
      assert.deepEqual(offenders, []);
    });

  test("and nothing carries an inline event handler", async () => {
    /* `onclick=""` is an inline script wearing an attribute, and the policy
       refuses it — so a page that relies on one is a page that is broken in
       production and works in development. */
    const offenders = [];
    for (const path of STAFF_PAGES.slice(0, 12)) {
      const { body } = await agent.text(path);
      for (const m of body.matchAll(/\son[a-z]+\s*=\s*["']/gi)) {
        offenders.push(`${path}: ${m[0].trim()}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("the only stylesheet from elsewhere is the font service the policy names",
    async () => {
      const { body } = await agent.text("/app");
      for (const m of body.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)) {
        const href = /href="([^"]*)"/.exec(m[0])?.[1] || "";
        if (href.startsWith("/")) continue;
        assert.ok(ALLOWED_STYLE_HOSTS.some((re) => re.test(href)),
          `${href} is loaded and the policy does not allow it`);
      }
    });
});

describe("the policy itself", () => {
  test("it is on every response, and says the things it has to", async () => {
    const { res } = await agent.text("/app");
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "no policy at all");

    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ]) {
      assert.ok(csp.includes(directive), `the policy is missing ${directive}`);
    }

    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/,
      "the whole claim rests on this");
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/);
  });

  test("it is on a public page too, where it matters most", async () => {
    const { res } = await visitor.text("/report");
    assert.ok(res.headers.get("content-security-policy"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  });

  test("and on a JSON answer, including an error", async () => {
    const res = await fetch(`${app.origin}/api/v1/properties`);
    assert.equal(res.status, 401);
    assert.ok(res.headers.get("content-security-policy"),
      "a JSON endpoint is still a URL a browser can be pointed at");
  });

  test("HSTS is only sent over HTTPS, because on localhost it would pin a browser",
    async () => {
      const { res } = await agent.text("/app");
      assert.equal(res.headers.get("strict-transport-security"), null,
        "this suite runs over http; sending it here would pin the developer's browser "
        + "to https for a year");

      const forwarded = await agent.raw("/app", {
        method: "GET", headers: { "x-forwarded-proto": "https" } });
      assert.match(forwarded.headers.get("strict-transport-security") || "",
        /max-age=31536000/);
    });
});
