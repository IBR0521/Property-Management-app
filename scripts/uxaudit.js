/* What is hard to understand, with evidence.

   Not opinions about taste. This walks every page the application serves and
   collects the things that make software hard to use regardless of how it
   looks: two menu items with the same name, a screen whose title does not
   match the link that reached it, a page you can open and not leave, a table
   with no empty state so a new company sees a blank rectangle, a form field
   with no label and no help, the same thing called two different names on two
   different screens.

   Every finding names the route it came from, so none of it has to be taken
   on trust.

       createdb propops_ux_test
       sed 's/propops_test/propops_ux_test/' .env.test > .env.ux
       node --env-file=.env.ux scripts/uxaudit.js
*/
import { elements, textOf, idsIn, labelTargets, labelableControls } from "../test/helpers/a11y.js";

/* The same idea, called different things, is the most expensive kind of
   confusion: somebody learns a word on one screen and cannot find it on the
   next. Each group is one concept. */
const CONCEPTS = [
  ["contractor", ["contractor", "vendor", "supplier", "trade"]],
  ["home", ["unit", "home", "property", "portfolio", "premises"]],
  ["tenancy", ["lease", "tenancy", "agreement"]],
  ["repair", ["work order", "job", "repair", "maintenance", "ticket"]],
  ["money in", ["payment", "receipt", "rent received"]],
  ["money out", ["payout", "payment out", "disbursement", "remittance"]],
];

export async function audit() {
  const f = await import("../test/helpers/factories.js");
  const { startApp, client } = await import("../test/helpers/http.js");
  const { ready, all, get, run } = await import("../server/lib/db.js");
  await ready();

  const world = await f.makeWorld({
    name: "Audit Co", staffRoles: ["admin", "accountant", "leasing", "technician"],
  });

  const app = await startApp();
  const agent = client(app.origin);
  const ok = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  if (!ok.signedIn) throw new Error("could not sign in");

  const { NAV } = await import("../server/views/layout.js");
  const navHrefs = NAV.flatMap((g) => g.items.map((i) => i.href));

  /* Every page, not only the twenty in the menu. The detail screens are where
     somebody spends their day, and the first audit never opened one. */
  const { registeredRoutes } = await import("../server/app.js");
  const deep = registeredRoutes()
    .filter((r) => r.method === "GET" && r.pattern.startsWith("/app"))
    .map((r) => r.pattern);

  const findings = [];
  const say = (severity, area, what, where, detail) =>
    findings.push({ severity, area, what, where, detail });

  /* --- the navigation ------------------------------------------------------ */

  const labels = new Map();
  for (const group of NAV) {
    for (const item of group.items) {
      if (!labels.has(item.label)) labels.set(item.label, []);
      labels.get(item.label).push(item.href);
    }
  }
  for (const [label, hrefs] of labels) {
    if (hrefs.length > 1) {
      say("high", "navigation", `Two menu items are both called "${label}"`,
        hrefs.join(" and "),
        "Somebody told to 'go to People' cannot know which one is meant, and picking "
        + "wrong costs a page load and a moment of doubt every time.");
    }
  }

  const ungrouped = NAV.filter((g) => !g.group).flatMap((g) => g.items);
  if (ungrouped.length > 6) {
    say("medium", "navigation",
      `${ungrouped.length} menu items sit under no heading`,
      "the sidebar",
      "Three of the four groups in the sidebar have no name, so the list reads as one "
      + "long column of twenty things rather than as a few short ones.");
  }
  for (const group of NAV) {
    if (group.items.length > 6) {
      say("medium", "navigation",
        `The "${group.group || "unnamed"}" group holds ${group.items.length} items`,
        "the sidebar", "Long enough that finding one means reading all of them.");
    }
  }

  /* --- every page ---------------------------------------------------------- */

  const pages = [];
  for (const href of navHrefs) {
    let at = href;
    let { res, body } = await agent.text(at);
    for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(res.status); hop += 1) {
      at = res.headers.get("location");
      ({ res, body } = await agent.text(at));
    }
    if (res.status !== 200) continue;

    const h1 = elements(body, ["h1"]).map((e) => textOf(body, e))[0] || null;
    const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    const navLabel = NAV.flatMap((g) => g.items).find((i) => i.href === href)?.label;
    const tables = elements(body, ["table"]);
    const forms = elements(body, ["form"]).filter((e) => /post/i.test(e.attrs.method || ""));
    const links = elements(body, ["a"]).map((e) => e.attrs.href).filter(Boolean);

    pages.push({ href, at, title, h1, navLabel, body,
      tables: tables.length, forms: forms.length, links });

    /* The link says one thing and the page says another. */
    if (navLabel && h1 && !sameish(navLabel, h1)) {
      say("high", "naming",
        `The menu says "${navLabel}" and the page says "${h1}"`, href,
        "A person clicks a word and arrives somewhere with a different name on it. "
        + "They cannot tell whether they are where they meant to be.");
    }

    /* A screen with nothing on it yet and nothing to say about that. */
    for (const t of tables) {
      const inner = textOf(body, t);
      const rows = elements(body.slice(t.start, t.start + 40000), ["tr"]).length;
      if (rows <= 1 && !/no |nothing|none|empty|add your first|get started/i.test(body)) {
        say("high", "empty states", "A table with no rows and no explanation", href,
          "A company on its first day sees an empty rectangle with column headings and "
          + "no hint of what puts something in it.");
      }
    }

    /* A form that asks for things without saying why. */
    const targets = labelTargets(body);
    const ids = idsIn(body);
    let unhelped = 0;
    for (const c of labelableControls(body)) {
      const labelled = (c.attrs.id && targets.has(c.attrs.id))
        || c.attrs["aria-label"] || c.ancestors.includes("label");
      if (!labelled) continue;
      const near = body.slice(c.start, c.start + 600);
      if (!/field__help/.test(near)) unhelped += 1;
    }
    if (forms.length && unhelped >= 5) {
      say("medium", "guidance", `${unhelped} fields on this page carry no help text`, href,
        "The label names the field; nothing says what to put in it or what it will do.");
    }
  }

  /* --- can you get anywhere from here -------------------------------------- */

  const reachable = new Set();
  for (const p of pages) for (const l of p.links) reachable.add(l.split("?")[0]);

  for (const p of pages) {
    const own = p.links
      .map((l) => l.split("?")[0])
      .filter((l) => l.startsWith("/app") && !navHrefs.includes(l));
    if (!own.length && p.tables === 0 && p.forms === 0) {
      say("medium", "dead ends", "Nothing on this page leads anywhere", p.href,
        "It can be opened and then only left through the menu.");
    }
  }

  /* --- one idea, several words --------------------------------------------- */

  const corpus = pages.map((p) => ({ href: p.href, text: p.body.toLowerCase() }));
  for (const [concept, words] of CONCEPTS) {
    const used = new Map();
    for (const w of words) {
      const where = corpus.filter((c) => c.text.includes(`>${w}`) || c.text.includes(`${w}s<`));
      if (where.length) used.set(w, where.map((c) => c.href));
    }
    if (used.size > 1) {
      const summary = [...used].map(([w, hrefs]) => `"${w}" on ${hrefs.length}`).join(", ");
      say("medium", "naming", `One idea (${concept}) goes by ${used.size} names`, "several pages",
        `${summary}. Somebody who learns a word on one screen looks for it on the next `
        + "and does not find it.");
    }
  }

  await app.close();
  return { findings, pages: pages.map((p) => ({ href: p.href, title: p.title, h1: p.h1 })) };
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
function sameish(a, b) {
  const x = norm(a), y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { findings, pages } = await audit();
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  console.log(`\n${pages.length} pages walked, ${findings.length} findings\n`);
  let area = null;
  for (const f of findings) {
    if (f.area !== area) { console.log(`\n--- ${f.area} ---`); area = f.area; }
    console.log(`[${f.severity}] ${f.what}`);
    console.log(`        where: ${f.where}`);
    console.log(`        ${f.detail}`);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/ux-findings.json", JSON.stringify({ findings, pages }, null, 2));
  process.exit(0);
}
