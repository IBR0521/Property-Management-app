/* Installing the application, and the one rule the service worker exists to
   keep.

   Most of this file reads the service worker's **source** rather than driving
   its behaviour, which is unusual enough to justify.

   The thing being guarded against is not a bug. It is somebody — reasonably,
   helpfully, six months from now — adding a runtime cache so the portal loads
   faster, and thereby writing a tenant's rent balance to a handset where it
   survives signing out and is readable by whoever picks the phone up. That
   change would pass every behavioural test anyone would think to write,
   because it makes the application work better. It fails here, on the source,
   because the source is where the decision is visible.

   The rest is ordinary: the manifests are valid, everything they reference
   exists, and the right shells offer the right one. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDatabase, truncateAll, closeDb } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world;

const SW = readFileSync(new URL("../app-assets/sw.js", import.meta.url), "utf8");

/* Every path that knows who you are. Not used by the worker — it works by
   allowlist — but this is the list the allowlist has to stay clear of, and
   writing it down is what makes the next test mean something. */
const PRIVATE = ["/app", "/portal", "/pay", "/o", "/t", "/r", "/sign", "/a", "/apply", "/c"];

/* By segment, not by string. "/app" is a prefix of "/app-assets" and of
   "/apply", and the same mistake in the router once let /apply through a
   guard meant for the back office. */
const under = (path, prefix) => path === prefix || path.startsWith(prefix + "/");

/* The cached list, read out of the source so the test cannot drift from it. */
const SHELL = (() => {
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(SW);
  assert.ok(block, "the service worker must declare a SHELL list");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  world = await f.makeWorld({ name: "Install Co" });
});

after(async () => {
  await app.close();
  await closeDb();
});

/* --- the rule ------------------------------------------------------------- */

describe("what the service worker may store", () => {
  test("nothing private is in the cached list", async () => {
    for (const path of SHELL) {
      for (const prefix of PRIVATE) {
        assert.ok(!under(path, prefix),
          `${path} is cached and is under ${prefix}, which knows who you are`);
      }
    }
  });

  test("every cached path is a static asset or the offline page", async () => {
    /* Stated positively as well as negatively: a new prefix nobody added to
       PRIVATE still cannot get in. */
    for (const path of SHELL) {
      assert.ok(
        path === "/offline" || /^\/(assets|app-assets)\//.test(path),
        `${path} is neither a static asset nor the offline page`);
    }
  });

  test("there is exactly one write to the cache, and it is in install", async () => {
    /* The test this file exists for. A runtime cache added later — however
       sensible it looks — lands outside install and fails here. */
    const install = SW.slice(
      SW.indexOf('addEventListener("install"'),
      SW.indexOf('addEventListener("activate"'));
    assert.ok(install.length > 100, "the install handler must be found to be checked");

    const writes = [...SW.matchAll(/\bcaches?\.(open|put|add|addAll)\s*\(/g)];
    const outside = writes.filter((m) => {
      const at = m.index;
      return at < SW.indexOf('addEventListener("install"')
          || at >= SW.indexOf('addEventListener("activate"');
    });

    /* `caches.delete` and `caches.match` are reads and removals, and are
       allowed anywhere. Only the four above put bytes on a device. */
    assert.deepEqual(outside.map((m) => m[0]), [],
      "a cache write outside install can store a page that knows who you are");
  });

  test("a response from the network is never written back", async () => {
    /* Network-first with a read-only fallback. The moment a successful
       response is put into the cache, every page becomes cacheable. */
    assert.ok(!/\.put\s*\(/.test(SW), "cache.put would make responses storable");
  });

  test("only GET, and only this origin, is handled at all", async () => {
    assert.match(SW, /request\.method !== "GET"/);
    assert.match(SW, /url\.origin !== self\.location\.origin/);
  });

  test("a failed navigation goes to the offline page, not a cached copy", async () => {
    /* `caches.match(OFFLINE)` rather than `caches.match(request)` is the
       difference between showing a generic page and showing the last private
       page this device happened to load. */
    assert.match(SW, /caches\.match\(OFFLINE\)/);
    assert.ok(!/navigate[\s\S]{0,400}caches\.match\(request\)/.test(SW));
  });

  test("nothing queues a write for later", async () => {
    /* No background sync: a report that says it was filed and was not is
       worse than one that plainly failed. */
    for (const forbidden of [
      'addEventListener("sync"', 'addEventListener("periodicsync"',
      "registration.sync", "indexedDB", "IndexedDB", "localStorage",
    ]) {
      assert.ok(!SW.includes(forbidden), `${forbidden} would mean holding a write on the device`);
    }
  });
});

/* --- that the cached list actually works ---------------------------------- */

describe("the shell it caches", () => {
  test("every cached path is served by this application", async () => {
    /* `cache.add` swallows a 404 per asset rather than failing the install.
       That is the right behaviour and it is also how a typo here would go
       unnoticed forever. */
    const c = client(app.origin);
    for (const path of SHELL) {
      const res = await c.get(path);
      assert.equal(res.status, 200, `${path} is cached but returns ${res.status}`);
    }
  });

  test("the worker is served from the root, so its scope is the whole site", async () => {
    /* A worker at /app-assets/sw.js could only ever control /app-assets/. */
    const c = client(app.origin);
    const res = await c.get("/sw.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /javascript/);
  });

  test("the worker itself is never cached hard", async () => {
    /* Replacing this file is how an installed worker gets removed from a
       device nobody holds. It only works if the browser revalidates it. */
    const c = client(app.origin);
    const res = await c.get("/sw.js");
    assert.match(res.headers.get("cache-control") || "", /no-cache|no-store|max-age=0/);
  });
});

/* --- the offline page ----------------------------------------------------- */

describe("the offline page", () => {
  test("it says plainly that nothing was sent", async () => {
    /* The failure being designed against is a friendly "we'll send this when
       you're back online" that somebody believes. */
    const c = client(app.origin);
    const { res, body } = await c.text("/offline");
    assert.equal(res.status, 200);
    assert.match(body, /Nothing you typed was sent/);
    assert.match(body, /no queue/i);
  });

  test("it tells somebody with an emergency to pick up a phone", async () => {
    const { body } = await client(app.origin).text("/offline");
    assert.match(body, /emergency/i);
    assert.match(body, /phone call/i);
  });

  test("it needs no session, because somebody offline cannot get one", async () => {
    const res = await client(app.origin).get("/offline");
    assert.equal(res.status, 200, "a redirect to sign-in would be useless offline");
  });
});

/* --- the manifests -------------------------------------------------------- */

describe("the install metadata", () => {
  const manifests = ["/app-assets/manifest.webmanifest", "/app-assets/portal.webmanifest"];

  test("both are valid JSON served as a manifest", async () => {
    /* Served as application/json a manifest is fetched, ignored, and nothing
       is reported anywhere. */
    const c = client(app.origin);
    for (const path of manifests) {
      const res = await c.get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), "application/manifest+json", path);
      JSON.parse(await res.text());
    }
  });

  test("each carries what a browser needs to offer an install", async () => {
    const c = client(app.origin);
    for (const path of manifests) {
      const { body } = await c.text(path);
      const m = JSON.parse(body);
      assert.ok(m.name && m.short_name, `${path} has no name`);
      assert.ok(m.start_url, `${path} has no start_url`);
      assert.equal(m.display, "standalone", path);
      assert.ok(m.icons.some((i) => i.sizes === "192x192"), `${path} needs a 192`);
      assert.ok(m.icons.some((i) => i.sizes === "512x512"), `${path} needs a 512`);
      assert.ok(m.icons.some((i) => i.purpose === "maskable"),
        `${path} has no maskable icon, so Android will crop the corners off it`);
    }
  });

  test("every icon they name exists and is a PNG", async () => {
    const c = client(app.origin);
    for (const path of manifests) {
      const { body } = await c.text(path);
      for (const icon of JSON.parse(body).icons) {
        const res = await c.get(icon.src);
        assert.equal(res.status, 200, icon.src);
        assert.equal(res.headers.get("content-type"), "image/png", icon.src);
      }
    }
  });

  test("the two are separate installs, landing in different places", async () => {
    /* A tenant should not be offered the back office, and a manager should
       not be offered "Your home". */
    const c = client(app.origin);
    const [appM, portalM] = await Promise.all(
      manifests.map(async (p) => JSON.parse((await c.text(p)).body)));
    assert.notEqual(appM.id, portalM.id);
    assert.equal(appM.start_url, "/app");
    assert.equal(portalM.start_url, "/portal");
  });
});

/* --- which page offers which ---------------------------------------------- */

describe("what each kind of page offers", () => {
  test("the back office offers the back-office manifest", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const { body } = await c.text("/app");
    assert.match(body, /rel="manifest" href="\/app-assets\/manifest\.webmanifest"/);
    assert.match(body, /register-sw\.js/);
  });

  test("the portal offers the tenant one", async () => {
    /* /portal itself redirects somebody with no session; the sign-in form is
       the same shell and is where a tenant would install from anyway. */
    const { body } = await client(app.origin).text("/portal/sign-in");
    assert.match(body, /rel="manifest" href="\/app-assets\/portal\.webmanifest"/);
  });

  test("a tokenised public page offers neither and installs nothing", async () => {
    /* Somebody who followed a one-off link to report a leak should not end up
       with a service worker on their phone. */
    const { body } = await client(app.origin).text("/report");
    assert.ok(!/rel="manifest"/.test(body), "a one-off page must not offer an install");
    assert.ok(!/register-sw\.js/.test(body), "nor leave a worker behind");
  });

  test("the registration is an external script, so the policy still holds", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const { res, body } = await c.text("/app");

    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(body), "an inline script would need unsafe-inline");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /manifest-src 'self'/);
  });

  test("the theme colour is the one in the stylesheet, not a new one", async () => {
    /* --brand-deep. An installed app draws its title bar in this. */
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const { body } = await c.text("/app");
    assert.match(body, /<meta name="theme-color" content="#1b184e"/);

    const css = readFileSync(new URL("../assets/css/styles.css", import.meta.url), "utf8");
    assert.match(css, /--brand-deep:\s*#1b184e/);
  });
});
