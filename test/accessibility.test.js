/* Accessibility.

   Not a badge. Three specific groups of people use this software and would be
   shut out by the failures below, and two of them are not optional customers:

   - a tenant with a screen reader, on the portal, trying to pay rent. The
     portal is the only way in; there is no phone line behind it.
   - a maintenance technician using the mobile screens one-handed in bad light,
     where a 3:1 contrast ratio is not a preference.
   - an owner reading a statement, who is likelier than the rest of the
     userbase to be over seventy.

   So these tests fetch the pages the application actually serves — signed in,
   through the router, not template fragments — and check the things that make
   a page unusable rather than merely imperfect. An unlabelled input is a field
   a screen reader announces as "edit text, blank". An icon-only button with no
   name is announced as "button". A page that skips from h1 to h3 breaks the
   heading navigation most screen-reader users move around with.

   What this does not do is claim WCAG conformance. It checks a specific list.
   Conformance is a judgement a person makes with a real screen reader, and
   saying otherwise in a test file would be the kind of claim this project has
   spent ten phases refusing to make. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import {
  elements, textOf, accessibleName, idsIn, labelableControls, labelTargets,
} from "./helpers/a11y.js";
import { NAV } from "../server/views/layout.js";
import { requestLink } from "../server/lib/magiclink.js";
import { linkTenant } from "../server/lib/identity.js";

let app, world, agent;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Access Co", staffRoles: ["admin"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* Taken from the navigation itself rather than typed out here, so a page
   added to the sidebar is a page these checks cover from the day it appears.
   A hand-kept copy of this list would go stale, and a stale accessibility
   list is one that quietly stops covering the newest screens — which are
   exactly the ones most likely to have the problem. */
const STAFF_PAGES = NAV.flatMap((g) => g.items.map((i) => i.href));

/* The portal is the part that matters most here. A tenant using a screen
   reader has no alternative route: there is no phone line behind this, and
   the rent is due either way. */
const PORTAL_PAGES = ["/portal/home", "/portal/home/renting"];

const TENANT_EMAIL = "reader@example.test";

async function portalAgent() {
  await run("UPDATE tenant SET email = ? WHERE id = ?", TENANT_EMAIL, world.tenantId);
  await linkTenant({ tenantId: world.tenantId });
  const a = client(app.origin);
  const link = await requestLink({ email: TENANT_EMAIL, ip: "1.1.1.1", baseUrl: app.origin });
  assert.equal(link.delivered, true, "no portal link issued");
  const res = await a.get(`/portal/enter/${link.secret}`);
  assert.equal(res.status, 303, "the portal link should let them in");
  return a;
}

/* Staff pages and portal pages together — every check below applies to both. */
async function allPages() {
  const staff = await pages(STAFF_PAGES, agent);
  const portal = await pages(PORTAL_PAGES, await portalAgent());
  return [...staff, ...portal];
}

async function pages(paths, fetcher) {
  const out = [];
  const missed = [];
  for (const path of paths) {
    let at = path;
    let { res, body } = await fetcher.text(at);
    /* A browser follows these; a check that did not would be testing an empty
       redirect body and calling it accessible. `/portal/home` sends a person
       on to whichever of their roles applies. */
    for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(res.status); hop += 1) {
      at = res.headers.get("location");
      ({ res, body } = await fetcher.text(at));
    }
    if (res.status !== 200) { missed.push(`${path} -> ${res.status}`); continue; }
    out.push({ path: at === path ? path : `${path} -> ${at}`, html: body });
  }
  /* Every listed page must actually render. Skipping quietly is how an
     accessibility suite ends up passing against a set of error pages. */
  assert.deepEqual(missed, [], `these pages did not render:\n${missed.join("\n")}`);
  assert.ok(out.every((p) => p.html.length > 500), "a page too short to be a page");
  return out;
}

describe("every control a person has to operate has a name", () => {
  test("no form field is announced as 'edit text, blank'", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const ids = idsIn(html);
      const targets = labelTargets(html);
      for (const el of labelableControls(html)) {
        const a = el.attrs;
        const labelled =
          (a.id && targets.has(a.id)) ||
          a["aria-label"]?.trim() ||
          (a["aria-labelledby"]?.split(/\s+/).some((r) => ids.has(r))) ||
          el.ancestors.includes("label") ||
          a.title?.trim();
        if (!labelled) {
          problems.push(`${path}: <${el.name} name=${a.name || "?"} type=${a.type || "text"}>`);
        }
      }
    }
    assert.deepEqual(problems, [], `unlabelled form controls:\n${problems.join("\n")}`);
  });

  test("no button or link is announced as just 'button'", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const ids = idsIn(html);
      for (const el of elements(html, ["button", "a"])) {
        if (el.attrs["aria-hidden"] === "true") continue;
        if (el.name === "a" && !el.attrs.href) continue; // an anchor, not a link
        const name = accessibleName(html, el, ids);
        if (!name) problems.push(`${path}: <${el.name} ${el.attrs.href || el.attrs.class || ""}>`);
      }
    }
    assert.deepEqual(problems, [], `nameless controls:\n${problems.join("\n")}`);
  });

  test("a label's `for` points at a control that exists", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const ids = idsIn(html);
      for (const [target, text] of labelTargets(html)) {
        if (!ids.has(target)) problems.push(`${path}: label "${text}" -> #${target}, which is not there`);
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });
});

describe("images", () => {
  test("every image has alt text, or is explicitly decorative", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      for (const el of elements(html, ["img"])) {
        const a = el.attrs;
        const decorative = a.alt === "" || a.role === "presentation" || a["aria-hidden"] === "true";
        if (a.alt === undefined && !decorative) problems.push(`${path}: <img src=${a.src}>`);
      }
    }
    assert.deepEqual(problems, [], `images with no alt at all:\n${problems.join("\n")}`);
  });

  test("decorative SVG is hidden from screen readers rather than read aloud", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const ids = idsIn(html);
      for (const el of elements(html, ["svg"])) {
        const a = el.attrs;
        const hidden = a["aria-hidden"] === "true" || a.role === "presentation" || a.focusable === "false";
        const named = a["aria-label"]?.trim() || a.role === "img";
        const insideNamedControl = el.ancestors.some((n) => n === "button" || n === "a");
        if (!hidden && !named && !insideNamedControl) {
          problems.push(`${path}: <svg class=${a.class || "?"}>`);
        }
      }
    }
    assert.deepEqual(problems, [], `SVG neither hidden nor named:\n${problems.join("\n")}`);
  });
});

describe("structure a screen reader navigates by", () => {
  test("every page declares a language", async () => {
    for (const { path, html } of await allPages()) {
      assert.match(html, /<html[^>]+lang=/i, `${path} has no lang; a screen reader guesses the voice`);
    }
  });

  test("every page has exactly one h1", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const h1s = elements(html, ["h1"]);
      if (h1s.length !== 1) problems.push(`${path}: ${h1s.length} h1 elements`);
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("heading levels do not skip", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const levels = elements(html, ["h1", "h2", "h3", "h4", "h5", "h6"])
        .map((el) => Number(el.name[1]));
      for (let i = 1; i < levels.length; i += 1) {
        if (levels[i] > levels[i - 1] + 1) {
          problems.push(`${path}: h${levels[i - 1]} followed by h${levels[i]}`);
        }
      }
    }
    assert.deepEqual(problems, [], `skipped heading levels:\n${problems.join("\n")}`);
  });

  test("each page has a main landmark", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      const mains = elements(html, ["main"]).length
        + elements(html, ["div", "section"]).filter((el) => el.attrs.role === "main").length;
      if (mains !== 1) problems.push(`${path}: ${mains} main landmarks`);
    }
    assert.deepEqual(problems, [], `${problems.join("\n")}\n(a main landmark is how "skip to content" works)`);
  });

  test("repeated navigation is labelled, so it can be skipped", async () => {
    for (const { path, html } of await allPages()) {
      const navs = elements(html, ["nav"]);
      if (navs.length <= 1) continue;
      const unnamed = navs.filter((el) => !el.attrs["aria-label"] && !el.attrs["aria-labelledby"]);
      assert.equal(unnamed.length, 0,
        `${path}: ${unnamed.length} of ${navs.length} nav landmarks are unlabelled, so they are all "navigation"`);
    }
  });
});

describe("keyboard", () => {
  test("nothing takes a positive tabindex", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      for (const el of elements(html, ["a", "button", "input", "select", "textarea", "div", "span"])) {
        const t = Number(el.attrs.tabindex);
        if (Number.isFinite(t) && t > 0) problems.push(`${path}: <${el.name} tabindex=${t}>`);
      }
    }
    assert.deepEqual(problems, [],
      `a positive tabindex reorders the whole page for keyboard users:\n${problems.join("\n")}`);
  });

  test("anything given a click handler role is reachable by keyboard", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      for (const el of elements(html, ["div", "span", "li"])) {
        const role = el.attrs.role;
        if (!["button", "link", "checkbox", "tab", "menuitem"].includes(role)) continue;
        if (el.attrs.tabindex === undefined) {
          problems.push(`${path}: <${el.name} role=${role}> with no tabindex — mouse only`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });
});

describe("tables, which is most of this application", () => {
  test("every data table has header cells", async () => {
    const problems = [];
    for (const { path, html } of await allPages()) {
      for (const el of elements(html, ["table"])) {
        const inner = textOf(html, el);
        if (!inner) continue;
        /* A table used for layout is allowed to have no headers, but it has to
           say so. Otherwise a screen reader announces "table, 3 columns" and
           reads coordinates for what is really a short list. */
        if (el.attrs.role === "presentation" || el.attrs.role === "none") continue;
        const slice = html.slice(el.start, el.start + 6000);
        if (!/<th[\s>]/i.test(slice)) {
          problems.push(`${path}: a table with no <th> and no role=presentation`
            + " — every cell reads without its column");
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });
});
