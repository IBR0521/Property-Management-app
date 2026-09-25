/* Every page, every surface, and the flows that cross them.

   The page-at-a-time audit in `uxaudit.js` covers the navigation. This covers
   the rest: all 99 back-office pages including the detail screens, both
   portals, all 28 public pages, and then the multi-step journeys — because a
   product is used in sequences, and a page-at-a-time check cannot see a step
   that leaves somebody with nowhere to go.

       node --env-file=.env.ux scripts/uxfull.js
*/
import { elements, textOf, idsIn, labelTargets, labelableControls } from "../test/helpers/a11y.js";

const findings = [];
const say = (severity, area, what, where, detail) =>
  findings.push({ severity, area, what, where, detail });

/* Words that tell somebody what to do next rather than only what is absent. */
const GUIDES = /add your first|get started|begin by|create one|set one up|nothing yet|none yet|no .{1,24} yet|invite|import/i;

function checkPage({ surface, route, at, body, status, contentType }) {
  if (status !== 200 || !body) return null;
  /* A PDF, an XML feed and a service worker have no headings and should not
     be asked for one. Only pages a person reads are judged here. */
  if (!/text\/html/.test(contentType || "")) return null;

  const h1s = elements(body, ["h1"]);
  const h1 = h1s.map((e) => textOf(body, e))[0] || null;
  const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const text = body.replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  /* A page with no heading is a page you cannot name. */
  if (!h1) {
    say("high", "orientation", "The page has no heading", route,
      "Nothing on it says where you are. Browser tab aside, a person landing "
      + "here from a link has no title to read.");
  }
  if (h1s.length > 1) {
    say("medium", "orientation", `${h1s.length} top-level headings`, route,
      "More than one thing claims to be the name of the page.");
  }

  /* A table with only its headings, and nothing saying why. */
  const tables = elements(body, ["table"]);
  for (const t of tables) {
    const slice = body.slice(t.start, t.end + 30000);
    const rows = (slice.match(/<tr[\s>]/g) || []).length;
    if (rows <= 1 && !GUIDES.test(text) && !/class="empty"/.test(body)) {
      say("high", "empty states", "A table with no rows and nothing said about it", route,
        "Column headings over a blank rectangle.");
      break;
    }
  }

  /* Empty, and silent about what would fill it. */
  if (/class="empty"/.test(body) && !GUIDES.test(text)) {
    say("medium", "empty states", "An empty state that does not say what to do next", route,
      "It says there is nothing here. It does not say what puts something here.");
  }

  /* Buttons whose text is a verb with no object. */
  for (const el of elements(body, ["a", "button"])) {
    const label = textOf(body, el).trim();
    if (!label) continue;
    if (/^(open|view|go|edit|manage|details?|more|here|click)$/i.test(label)) {
      say("medium", "labels", `A control labelled only "${label}"`, route,
        "The word is a verb with nothing after it. What it opens has to be "
        + "guessed from where it sits.");
      break;
    }
  }

  /* Forms asking for things with no explanation. */
  const targets = labelTargets(body);
  const controls = labelableControls(body);
  let unhelped = 0;
  for (const c of controls) {
    const labelled = (c.attrs.id && targets.has(c.attrs.id))
      || c.attrs["aria-label"] || c.ancestors.includes("label");
    if (!labelled) continue;
    if (!/field__help/.test(body.slice(c.start, c.start + 700))) unhelped += 1;
  }
  if (controls.length >= 4 && unhelped === controls.length) {
    say("medium", "guidance", `All ${unhelped} fields here carry no help text`, route,
      "Every label names its field and none says what it is for.");
  }

  /* A destructive control with nothing between it and the act. */
  for (const el of elements(body, ["button"])) {
    const label = textOf(body, el).trim().toLowerCase();
    /* Irreversible, or outward-facing and irreversible. "Send" alone is not
       — a test email is not a thing anybody regrets — so it is not here. */
    if (!/\b(delete|remove|revoke|void|discard|wipe|cancel this)\b/.test(label)) continue;
    const form = body.slice(Math.max(0, el.start - 2500), el.end);
    if (!/confirm|are you sure|type .{1,30} to|cannot be undone|onsubmit/i.test(form)) {
      say("medium", "destructive", `"${textOf(body, el).trim()}" acts with nothing in between`, route,
        "No confirmation, and nothing saying whether it can be undone.");
      break;
    }
  }

  return { surface, route, at, h1, title, bytes: body.length,
    rows: (body.match(/<tr[\s>]/g) || []).length, words: text.split(" ").length };
}

export async function run() {
  const { buildFixture, resolver, fill } = await import("./walk.js");
  const fx = await buildFixture();
  const { startApp, client } = await import("../test/helpers/http.js");
  const app = await startApp();
  const { registeredRoutes } = await import("../server/app.js");
  const f = await import("../test/helpers/factories.js");

  const staff = client(app.origin);
  await staff.signIn(fx.world.staff.admin.email, f.PASSWORD);
  const res = await resolver(fx);
  const pages = [];

  const surfaceOf = (p) => p.startsWith("/app") ? "back office"
    : p.startsWith("/portal") ? "portal" : p.startsWith("/api") ? "api" : "public";

  /* --- every GET page, on every surface ----------------------------------- */
  const anon = client(app.origin);
  for (const r of registeredRoutes().filter((x) => x.method === "GET")) {
    const surface = surfaceOf(r.pattern);
    if (surface === "api") continue;
    const path = fill(r.pattern, r.keys, res);
    if (!path) continue;

    const agent = surface === "back office" ? staff : anon;
    let at = path;
    let out = await agent.text(at);
    for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(out.res.status); hop += 1) {
      at = out.res.headers.get("location");
      out = await agent.text(at);
    }
    const page = checkPage({ surface, route: r.pattern, at,
      body: out.body, status: out.res.status,
      contentType: out.res.headers.get("content-type") });
    if (page) pages.push(page);
  }

  /* --- the flows ----------------------------------------------------------- */
  /* Signed in again: the sweep above opens every GET route there is, and one
     of them ends the session it is walking with. */
  await staff.signIn(fx.world.staff.admin.email, f.PASSWORD);
  const flows = await walkFlows({ app, staff, fx, say });

  await app.close();
  return { findings, pages, flows };
}

/* A journey is a sequence, and the question at each step is the same: having
   done this, can the person see what to do next? */
async function walkFlows({ staff, fx, say }) {
  const out = [];

  const step = async (flow, label, path) => {
    let at = path;
    let { res, body } = await staff.text(at);
    /* A browser follows these. A flow that stopped at the first redirect
       would report every journey as broken at step one. */
    for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(res.status); hop += 1) {
      at = res.headers.get("location");
      ({ res, body } = await staff.text(at));
    }
    const h1 = body ? (elements(body, ["h1"]).map((e) => textOf(body, e))[0] || null) : null;
    const actions = body
      ? elements(body, ["a", "button"])
        .map((e) => textOf(body, e).trim())
        .filter((t) => t && t.length < 40)
      : [];
    out.push({ flow, label, path: at, status: res.status, h1, actions: actions.length });
    return { status: res.status, body, h1, actions };
  };

  /* Moving somebody in. */
  const f1 = "moving a tenant in";
  await step(f1, "find the home", "/app/portfolio");
  const movein = await step(f1, "the move-in form", `/app/portfolio/u/${fx.world.unitId}/movein`);
  if (movein.status === 200) {
    const fields = labelableControls(movein.body).length;
    const helped = (movein.body.match(/field__help/g) || []).length;
    if (fields > 6 && helped < fields / 2) {
      say("medium", "flows", `The move-in form asks ${fields} things and explains ${helped}`,
        "/app/portfolio/u/:id/movein",
        "It is the longest form in the product and the one most likely to be "
        + "filled in by somebody new.");
    }
  }

  /* Recording a payment. */
  const f2 = "recording a payment";
  await step(f2, "the rent screen", "/app/rent");
  const rec = await step(f2, "record one", `/app/rent/record?lease=${fx.world.leaseId}`);
  if (rec.status !== 200) {
    say("high", "flows", "Recording a payment cannot be reached from the rent screen",
      "/app/rent/record", `It answered ${rec.status}.`);
  }

  /* Closing a repair. */
  const f3 = "closing a repair";
  await step(f3, "the queue", "/app");
  await step(f3, "the job", `/app/maintenance/${fx.wo}`);

  /* Getting paid out. */
  const f4 = "paying an owner";
  await step(f4, "payments out", "/app/payouts");

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { findings: fs, pages, flows } = await run();
  const order = { high: 0, medium: 1, low: 2 };
  fs.sort((a, b) => order[a.severity] - order[b.severity]);

  const bySurface = {};
  for (const p of pages) bySurface[p.surface] = (bySurface[p.surface] || 0) + 1;
  console.log(`\npages audited: ${JSON.stringify(bySurface)}  total ${pages.length}`);
  console.log(`findings: ${fs.length}\n`);

  const seen = new Map();
  for (const f of fs) {
    const key = `${f.area}|${f.what}`;
    if (!seen.has(key)) seen.set(key, { ...f, routes: [] });
    seen.get(key).routes.push(f.where);
  }
  let area = null;
  for (const f of seen.values()) {
    if (f.area !== area) { console.log(`\n--- ${f.area} ---`); area = f.area; }
    console.log(`[${f.severity}] ${f.what}  (${f.routes.length} page${f.routes.length === 1 ? "" : "s"})`);
    console.log(`        ${f.routes.slice(0, 6).join(", ")}${f.routes.length > 6 ? ", …" : ""}`);
  }

  console.log("\n--- flows ---");
  let flow = null;
  for (const s of flows) {
    if (s.flow !== flow) { console.log(`\n  ${s.flow}`); flow = s.flow; }
    console.log(`    ${String(s.status).padEnd(4)} ${String(s.actions).padStart(3)} actions  ${s.label}  ${s.h1 || "(no heading)"}`);
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/ux-full.json", JSON.stringify({ findings: fs, pages, flows }, null, 2));
  process.exit(0);
}
