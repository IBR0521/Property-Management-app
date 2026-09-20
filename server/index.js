/* Entry point.
   Serves three things from one origin:
     /            the existing marketing site, untouched
     /r/... /t/... /o/... /a/...   tokenised public pages (no account)
     /app/...     the back office (staff session required)
*/
import { createServer } from "node:http";
import { migrate, get } from "./lib/db.js";
import { createRouter } from "./lib/router.js";
import { serveFromRoot, serveUpload } from "./lib/static.js";
import { currentStaff } from "./lib/auth.js";
import {
  parseRequestBody, sendHtml, sendText, sendJson, redirect,
  HttpError, csrfToken, checkCsrf, Forbidden,
} from "./lib/http.js";
import { startScheduler } from "./lib/scheduler.js";
import { registerAuthRoutes } from "./features/session.js";
import { registerQueue } from "./features/queue.js";
import { registerMaintenance } from "./features/maintenance.js";
import { registerOwners } from "./features/owners.js";
import { registerCompliance } from "./features/compliance.js";
import { registerRent } from "./features/rent.js";
import { registerTurns } from "./features/turns.js";
import { registerApplications } from "./features/applications.js";
import { registerPortfolio } from "./features/portfolio.js";
import { registerSetup } from "./features/setup.js";

migrate();

const router = createRouter();

/* Public and session routes first; /app/* handlers assume ctx.staff exists. */
registerAuthRoutes(router);
registerQueue(router);
registerMaintenance(router);
registerOwners(router);
registerCompliance(router);
registerRent(router);
registerTurns(router);
registerApplications(router);
registerPortfolio(router);
registerSetup(router);

/* Routes that need a signed-in staff member. Everything under /app except the
   sign-in pages, which register themselves as public. */
const PUBLIC_APP_PATHS = new Set(["/app/sign-in", "/app/sign-out"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    /* --- static ---------------------------------------------------------- */
    if (req.method === "GET") {
      if (path === "/") {
        // The marketing page is not part of this repository. When it is absent
        // — a fresh clone, or a deployment that only runs the app — the root
        // goes to the app rather than a bare 404.
        if (serveFromRoot(res, "index.html")) return;
        return redirect(res, "/app");
      }
      if (path.startsWith("/assets/") || path.startsWith("/app-assets/")) {
        if (serveFromRoot(res, path)) return;
        return sendText(res, "Not found", 404);
      }
      if (path.startsWith("/uploads/")) {
        // Photos are referenced from pages that already required either a
        // session or a valid token, so the filename itself is the capability.
        if (serveUpload(res, path.slice("/uploads/".length))) return;
        return sendText(res, "Not found", 404);
      }
      if (path === "/health") return sendJson(res, { ok: true, at: new Date().toISOString() });
    }

    /* --- routing --------------------------------------------------------- */
    const hit = router.match(req.method, path);
    if (!hit) {
      const others = router.methodsFor(path);
      if (others.length) {
        res.writeHead(405, { Allow: others.join(", "), "Content-Type": "text/plain" });
        return res.end("Method not allowed");
      }
      return sendText(res, "Not found", 404);
    }

    const ctx = {
      req, res, url, path,
      params: hit.params,
      query: Object.fromEntries(url.searchParams),
      staff: null,
      fields: {},
      files: [],
      csrf: null,
      flash: url.searchParams.get("m") || null,
    };

    /* Prefix matching on "/app" alone also catches /apply and /application —
       the guard has to be the segment, not the string. */
    const isAppRoute = path === "/app" || path.startsWith("/app/");

    if (isAppRoute && !PUBLIC_APP_PATHS.has(path)) {
      ctx.staff = currentStaff(req);
      if (!ctx.staff) {
        const back = encodeURIComponent(url.pathname + url.search);
        return redirect(res, `/app/sign-in?next=${back}`);
      }
    } else if (isAppRoute) {
      ctx.staff = currentStaff(req);
    }

    if (req.method === "POST") {
      const parsed = await parseRequestBody(req);
      ctx.fields = parsed.fields || {};
      ctx.files = parsed.files || [];
      /* Every state-changing request is checked, including the public tenant
         form: without it, any site could post work orders into the queue. */
      if (!checkCsrf(req, ctx.fields)) {
        throw new Forbidden("This form expired. Go back, reload the page and try again.");
      }
    }

    ctx.csrf = csrfToken(req, res);
    await hit.handler(ctx);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[500] ${req.method} ${path}`, err);
    else console.warn(`[${status}] ${req.method} ${path} — ${err.message}`);

    if (res.headersSent) return res.end();
    const wantsJson = (req.headers.accept || "").includes("application/json");
    if (wantsJson) return sendJson(res, { error: err.message }, status);
    sendHtml(res, errorPage(status, err.message), status);
  }
});

function errorPage(status, message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css"></head><body><div class="pub" style="max-width:30rem"><h1>${status === 404 ? "Not found" : status === 403 ? "Expired" : "Something broke"}</h1><p class="lede">${safe}</p><p style="margin-top:1.5rem"><a class="pill solid" href="/app">Back to the app</a></p></div></body></html>`;
}

const PORT = Number(process.env.PORT || 4300);
server.listen(PORT, () => {
  const company = get("SELECT name FROM company LIMIT 1");
  console.log(`\n  Property operations`);
  console.log(`  ${company ? company.name : "no company yet — run: npm run seed"}`);
  console.log(`  http://localhost:${PORT}/app   (back office)`);
  console.log(`  http://localhost:${PORT}/      (marketing site)`);
  console.log(`  ${router.size} routes\n`);
  startScheduler();
});
