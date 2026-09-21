/* The application, as a plain (req, res) handler.

   Kept separate from any server so the same code runs in both places it needs
   to: server/index.js wraps it in node:http for local development, and
   api/index.js exports it for Vercel's Node runtime, which hands functions the
   same two arguments.

   One origin serves:
     /                          the marketing site
     /report /t/ /apply /a/ /o/ tokenised public pages, no account
     /app/...                   the back office, staff session required
*/
import { ready, NotFound } from "./lib/db.js";
import { newRequestId, forRequest } from "./lib/logger.js";
import { captureError } from "./lib/errors.js";
import { DATABASE_URL, DATABASE_CA_CERT, BLOB_READ_WRITE_TOKEN, configSummary } from "./lib/config.js";
import { createRouter } from "./lib/router.js";
import { serveFromRoot, serveUpload } from "./lib/static.js";
import { currentStaff, can, requiredCapability, roleLabel } from "./lib/auth.js";
import {
  parseRequestBody, sendHtml, sendText, sendJson, redirect,
  HttpError, csrfToken, checkCsrf, Forbidden, isHttps,
} from "./lib/http.js";
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
import { registerAccount } from "./features/account.js";
import { registerAccounting } from "./features/accounting.js";
import { registerLeases } from "./features/leases.js";
import { registerBanking } from "./features/banking.js";
import { registerVendors } from "./features/vendors.js";
import { registerListings } from "./features/listings.js";

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
registerAccount(router);
registerAccounting(router);
registerLeases(router);
registerBanking(router);
registerVendors(router);
registerListings(router);

/* Routes that need a signed-in staff member. Everything under /app except the
   sign-in pages, which register themselves as public. */
const PUBLIC_APP_PATHS = new Set(["/app/sign-in", "/app/sign-out"]);

export async function handle(req, res) {

  /* Scheme from the proxy, not assumed. This was hardcoded to http://, which
     meant ctx.url.protocol never read https and the session cookie never got
     its Secure flag in production. */
  /* Before anything that can throw, so every log line and every error page
     from this request — including the ones that never reach a handler — can be
     traced to the same id. */
  const requestId = newRequestId();
  res.setHeader("X-Request-Id", requestId);

  /* Declared out here so the catch can say which route failed and for whom.
     Inside the try they would be out of scope exactly when they are wanted. */
  let routePattern = null;
  let actor = {};

  const scheme = isHttps(req) ? "https" : "http";
  const url = new URL(req.url, `${scheme}://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    /* --- static ---------------------------------------------------------- */
    if (req.method === "GET") {
      if (path === "/") {
        // Marketing page at the root. If it is not deployed — an app-only
        // install — the root goes to /app rather than a bare 404.
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
      if (path === "/health") {
        let dbOk = false, dbError = null;
        try {
          // Uses the app's own helper rather than a driver method, so this
          // check keeps working whatever the driver underneath is.
          const { get } = await import("./lib/db.js");
          const row = await get("SELECT 1 AS ok");
          dbOk = row?.ok === 1;
        } catch (err) {
          dbError = err.message;
        }
        return sendJson(res, {
          ok: dbOk,
          at: new Date().toISOString(),
          db: {
            reachable: dbOk,
            remote: Boolean(DATABASE_URL),
            // encrypted always; verified only once a CA is supplied
            tls: DATABASE_CA_CERT ? "verified" : "encrypted-unverified",
            error: dbError,
          },
          blob: Boolean(BLOB_READ_WRITE_TOKEN),
          config: configSummary(),
        }, dbOk ? 200 : 503);
      }
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

    routePattern = hit.pattern;

    const ctx = {
      req, res, url, path,
      requestId,
      log: forRequest(requestId, { method: req.method, path }),
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
      ctx.staff = await currentStaff(req);
      if (!ctx.staff) {
        const back = encodeURIComponent(url.pathname + url.search);
        return redirect(res, `/app/sign-in?next=${back}`);
      }

      /* Authorisation, once, here. Asking each handler to check its own role is
         how an authorisation model fails: the check is correct in twenty
         handlers and missing in the twenty-first, and nothing tells you which.
         A route that needs a capability its holder lacks never reaches its
         handler. */
      actor = { companyId: ctx.staff.company_id, staffId: ctx.staff.id };

      const needed = requiredCapability(path, req.method);
      if (needed && !can(ctx.staff, needed)) {
        console.warn(`[403] ${req.method} ${path} — ${ctx.staff.email} (${ctx.staff.role}) lacks ${needed}`);
        return sendHtml(res, errorPage(403,
          `Your account is a ${roleLabel(ctx.staff.role).toLowerCase()} account, which does not have access to this. ` +
          `If you need it, an administrator can change your role.`), 403);
      }
    } else if (isAppRoute) {
      ctx.staff = await currentStaff(req);
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
    /* db.one() raises NotFound when a row the URL named does not exist. That is
       a dead link, not a server fault, and reporting it as a 500 both misleads
       the visitor and buries real faults in the log. Its message is fixed
       ("Not found") and the SQL it carries stays on err.query, which is never
       rendered. */
    const status = err instanceof HttpError ? err.status
      : err instanceof NotFound ? 404
      : 500;
    const rlog = forRequest(requestId, { method: req.method, path });
    if (status >= 500) {
      rlog.error("request failed", { status, err });
      captureError(err, { requestId, route: routePattern, ...actor });
    } else {
      rlog.warn("request rejected", { status, reason: err.message });
    }

    if (res.headersSent) return res.end();

    /* Only messages this app wrote deliberately reach the visitor. Anything
       else — a driver error, a failed query — carries internals such as SQL
       fragments and table names, and is replaced with a generic line. The
       real error is already in the server log above. */
    const safe = err instanceof HttpError && status < 500
      ? err.message
      : status === 404
      ? "We could not find that. The link may be old, or the record may have been removed."
      : "Something went wrong at our end. Try again, or call us if it keeps happening.";

    const wantsJson = (req.headers.accept || "").includes("application/json");
    if (wantsJson) return sendJson(res, { error: safe, requestId }, status);
    sendHtml(res, errorPage(status, safe, requestId), status);
  }
}

function errorPage(status, message, requestId) {
  const esc = (v) => String(v).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const safe = esc(message);
  /* Only on a server fault. A 404 needs no reference number, and printing one
     on every expired form trains people to ignore it. */
  const ref = status >= 500 && requestId
    ? `<p style="margin-top:1rem;font-size:0.75rem;color:var(--ink-soft)">Reference <code>${esc(requestId)}</code> — quote this if you contact us.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css"></head><body><div class="pub" style="max-width:30rem"><h1>${status === 404 ? "Not found" : status === 403 ? "Expired" : "Something broke"}</h1><p class="lede">${safe}</p>${ref}<p style="margin-top:1.5rem"><a class="pill solid" href="/app">Back to the app</a></p></div></body></html>`;
}
