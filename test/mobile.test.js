/* The phone.

   An honest note about what this file is and is not.

   The audit itself was done in a browser at 375 CSS pixels, page by page,
   measuring real computed layout — `node:test` has no layout engine, so
   nothing here can measure a rendered height or catch a box that sticks out
   past the right edge. What these tests do is hold the *structural causes*
   still, so the faults the audit found cannot come back and the ones it
   cleared cannot reappear unnoticed.

   What the audit found, at 375px, across twenty-four pages:

     no page-level horizontal scroll anywhere — the one fault that makes a
       page unusable rather than awkward, and it is clean

     touch targets under 44px: the compact pill (33-35px) and the navigation
       links (35px), which are the action controls. Fixed, by giving them a
       44px hit area that leaves their appearance untouched.

     text under 14px: 11px on a count badge and a relative date, 12px on the
       compact pill, chips and secondary lines. Reported, not fixed — raising
       the type scale changes the density of every screen, which is a design
       decision and not mine to take.

     one form whose submit is reached by scrolling sideways: /app/setup, whose
       Save buttons sit in a table that scrolls inside its own container.
       Reachable, but sideways. Reported. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDatabase, truncateAll, closeDb } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world, c;

const APP_CSS = readFileSync(new URL("../app-assets/app.css", import.meta.url), "utf8");

/* The pages driven here. Named rather than crawled, so the report can say
   which ones were checked instead of claiming "all of them". */
const PAGES = [
  "/app", "/app/portfolio", "/app/inbox", "/app/owners", "/app/accounting",
  "/app/accounting/journals", "/app/accounting/trust", "/app/banking",
  "/app/payments", "/app/payouts", "/app/vendors", "/app/vendors/1099",
  "/app/listings", "/app/leases", "/app/jobs", "/app/messages", "/app/staff",
  "/app/company", "/app/billing", "/app/setup", "/app/account",
  "/app/maintenance", "/app/maintenance/new", "/app/rent", "/app/compliance",
  "/app/turns", "/app/applications", "/app/owners/new", "/app/portfolio/new",
];

const PUBLIC_PAGES = ["/report", "/apply", "/portal/sign-in", "/app/sign-in", "/offline"];

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  world = await f.makeWorld({ name: "Phone Co" });
  c = client(app.origin);
  await c.signIn(world.staff.admin.email, f.PASSWORD);
});
after(async () => { await app.close(); await closeDb(); });

/* --- the thing that makes all of it possible ------------------------------ */

describe("the viewport", () => {
  test("every page declares one, or none of the rest matters", async () => {
    /* Without this a phone renders at 980px and scales down, and every
       measurement in the audit would have been of a different page than the
       one somebody is looking at. */
    for (const path of [...PAGES, ...PUBLIC_PAGES]) {
      const { res, body } = await c.text(path);
      if (res.status !== 200) continue;
      assert.match(body, /<meta name="viewport" content="width=device-width, initial-scale=1"/, path);
    }
  });
});

/* --- the structural cause of a sideways page ------------------------------ */

describe("wide tables", () => {
  test("every table is inside something that can scroll on its own", async () => {
    /* The audit found no page-level horizontal scroll. A bare wide table is
       how that comes back: a column of account names is wider than 375px, and
       without a container that scrolls, the whole page does. */
    const loose = [];
    let examined = 0;
    for (const path of PAGES) {
      const { res, body } = await c.text(path);
      if (res.status !== 200) continue;

      /* Walked rather than matched with one regex: a table inside a table
         would otherwise read as wrapped because an ancestor was. */
      /* Every opening div that carries the tablewrap class, wherever it sits
         in the class list. Matching the literal `<div class="tablewrap">`
         misses `tablewrap tablewrap--narrow`, which is what most of them
         are — and then five correctly wrapped pages read as broken. */
      const wraps = [...body.matchAll(/<div[^>]*class="[^"]*\btablewrap\b[^"]*"[^>]*>/g)]
        .map((m) => m.index);

      let from = 0;
      for (;;) {
        const at = body.indexOf("<table", from);
        if (at === -1) break;
        from = at + 6;
        examined += 1;

        const opened = wraps.filter((i) => i < at).pop();
        if (opened === undefined) { loose.push(`${path} @${at}`); continue; }

        /* The wrap has to still be open where the table starts: no </div>
           may have closed it in between. Counting divs from its own opening
           tag is enough at this depth. */
        const between = body.slice(opened, at);
        const opens = (between.match(/<div\b/g) || []).length;
        const closes = (between.match(/<\/div>/g) || []).length;
        if (closes >= opens) loose.push(`${path} @${at}`);
      }
    }

    /* A guard on the guard. If the scan ever stops finding tables — a markup
       change, a regex that no longer matches — this test would pass by
       examining nothing and keep passing forever.

       Eight rather than one per page: the fixture is a minimal company, so
       most list screens render their empty state instead of a table, and the
       real figure here is eleven. */
    assert.ok(examined >= 8, `only ${examined} tables were examined`);

    assert.deepEqual(loose, [],
      "a table outside a .tablewrap makes the whole page scroll sideways on a phone");
  });
});

/* --- the fix the audit produced ------------------------------------------- */

describe("touch targets", () => {
  test("the phone hit area is still there", async () => {
    /* Measured at 375px: the compact pill renders 33-35px and a navigation
       link 35px, both under the ~44px a thumb needs. This is the rule that
       fixes it, and it is easy to lose in a tidy-up because it looks like it
       does nothing — which is exactly its merit. */
    const rule = /@media \(max-width:40rem\)\{[\s\S]*?\.pill::after, \.navlink::after\{[\s\S]*?height:44px;/;
    assert.match(APP_CSS, rule, "the 44px hit area for phones has gone");
  });

  test("it enlarges the tap and not the control", async () => {
    /* The distinction the whole approach rests on. If this rule ever grows a
       `min-height` or a `padding`, it has stopped being a mis-tap fix and
       become a redesign, which is somebody else's decision. */
    const block = /@media \(max-width:40rem\)\{[\s\S]*?\n\}/.exec(
      APP_CSS.slice(APP_CSS.indexOf(".pill, .navlink{ position:relative; }") - 200));
    assert.ok(block, "the phone block should be findable");
    assert.ok(!/min-height|font-size|padding|margin/.test(block[0]),
      "this block may change the hit area and nothing else");
  });

  test("it is scoped to phones", async () => {
    /* On a wider screen the overlap between two stacked controls would be a
       cost with no benefit — a pointer does not miss. */
    const at = APP_CSS.indexOf(".pill::after, .navlink::after");
    const media = APP_CSS.lastIndexOf("@media", at);
    assert.match(APP_CSS.slice(media, at), /max-width:40rem/);
  });
});

/* --- what the technician's screen has to keep ----------------------------- */

describe("the screen that is only ever used on a phone", () => {
  test("it needs no JavaScript of its own", async () => {
    /* One bar of signal, a browser that gave up on the stylesheet, and a
       person standing in a stairwell. Every action is a form that posts. */
    await (async () => {
      const { run } = await import("../server/lib/db.js");
      await run("UPDATE work_order SET assigned_staff_id = ? WHERE id = ?",
        world.staff.admin.id, world.workOrderId);
    })();

    const { body } = await c.text(`/app/jobs/${world.workOrderId}`);
    const scripts = [...body.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(scripts, ['<script src="/app-assets/js/register-sw.js" defer>']);
  });

  test("the camera opens rather than the photo library", async () => {
    /* `capture="environment"` is the difference between photographing the
       problem you are standing in front of and hunting through a gallery. */
    const { body } = await c.text(`/app/jobs/${world.workOrderId}`);
    const files = [...body.matchAll(/<input[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
    assert.ok(files.length >= 2, "there should be a progress and a completion upload");
    for (const input of files) {
      assert.match(input, /capture="environment"/, input);
    }
  });
});
