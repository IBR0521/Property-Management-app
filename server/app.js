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
import { ready, NotFound, run } from "./lib/db.js";
import { newRequestId, forRequest } from "./lib/logger.js";
import { captureError } from "./lib/errors.js";
import { DATABASE_URL, DATABASE_CA_CERT, BLOB_READ_WRITE_TOKEN, configSummary } from "./lib/config.js";
import { createRouter } from "./lib/router.js";
import { withCounting } from "./lib/dev/querycount.js";
import { serveFromRoot, serveUpload } from "./lib/static.js";
import { currentPerson } from "./lib/magiclink.js";
import { currentStaff, can, requiredCapability, roleLabel, secondFactorRedirect, landingFor } from "./lib/auth.js";
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
import { registerMessages } from "./features/messages.js";
import { registerSignup } from "./features/signup.js";
import { registerStaff } from "./features/staff.js";
import { registerTwoFactor } from "./features/twofactor.js";
import { registerCompany } from "./features/company.js";
import { registerBilling, companyIsReadOnly, readOnlyExempt } from "./features/billing.js";
import { registerPlatform, activeImpersonation, impersonationForbids } from "./features/platform.js";
import { registerPayments } from "./features/payments.js";
import { registerPayouts } from "./features/payouts.js";
import { registerPortal } from "./features/portal.js";
import { registerPortalTenant, registerPortalTenantSelfService } from "./features/portal-tenant.js";
import { registerPortalOwner } from "./features/portal-owner.js";
import { registerInbox } from "./features/inbox.js";
import { registerPwa } from "./features/pwa.js";
import { registerPush } from "./features/push.js";
import { registerTech } from "./features/tech.js";
import { registerReports } from "./features/reports.js";
import { registerImport } from "./features/import.js";
import { registerExport } from "./features/export.js";
import { registerApi } from "./features/api.js";
import { registerApiKeys } from "./features/apikeys.js";
import { registerWebhooks } from "./features/hooks.js";
import { registerScreening } from "./features/screening.js";
import { registerScreeningSetup } from "./features/screeningsetup.js";
import { registerDeposits } from "./features/deposits.js";
import { registerInspections } from "./features/inspections.js";
import { registerPublicListings } from "./features/publiclistings.js";

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
registerMessages(router);
registerSignup(router);
registerStaff(router);
registerTwoFactor(router);
registerCompany(router);
registerBilling(router);
registerPlatform(router);
registerPayments(router);
registerPayouts(router);
registerPortal(router);
registerPortalTenant(router);
registerPortalTenantSelfService(router);
registerPortalOwner(router);
registerInbox(router);
registerPwa(router);
registerPush(router);
registerTech(router);
registerReports(router);
registerImport(router);
registerExport(router);
registerApi(router);
registerApiKeys(router);
registerWebhooks(router);
registerScreening(router);
registerScreeningSetup(router);
registerDeposits(router);
registerInspections(router);
registerPublicListings(router);

/* Routes that need a signed-in staff member. Everything under /app except the
   sign-in pages, which register themselves as public. */
/* The pages under /app that a person who cannot sign in has to be able to
   reach. Forgetting a password and following the link that fixes it are both
   done by somebody with no session, so gating them behind one would be a
   locked door with the key inside. */
const PUBLIC_APP_PATHS = new Set(["/app/sign-in", "/app/sign-out", "/app/forgot"]);
const PUBLIC_APP_PREFIXES = ["/app/reset/"];

/* Routes that read nothing, and so must not start depending on the database
   being reachable just because everything around them does.

   `/offline` is the page a handset falls back to when it has no connection.
   Making the page that exists for a broken state require a working database
   would be a fine joke and a real regression. `/sw.js` is the service worker,
   which is also the only way to *remove* a service worker from a device
   nobody is holding — it has to be servable when the rest is not. */
const NO_DATABASE_PATHS = new Set(["/offline", "/sw.js"]);

/* Reachable without a portal session: the sign-in form itself, the page that
   confirms a link was sent, and signing out. `/portal/enter/:token` is public
   too and handled by prefix, because the token in it is the credential. */
const PUBLIC_PORTAL_PATHS = new Set([
  "/portal", "/portal/sign-in", "/portal/sent", "/portal/sign-out", "/portal/code",
]);

/* Exported for the test suite, which asserts properties over every registered
   route. Nothing in the application reads it. */
export function registeredRoutes() {
  return router.list();
}

/* Every request runs inside a counting context when a test has turned one on,
   and returns straight through otherwise. See lib/dev/querycount.js for why
   the load test measures queries rather than milliseconds. */
export async function handle(req, res) {
  /* The count cannot be a response header: by the time it is known the
     response has gone. So the counting context keeps the last one, and a
     load test running in the same process reads it after the fetch
     resolves. Nothing is added to any response path for a dev-only number. */
  return withCounting(() => handleRequest(req, res), { label: `${req.method} ${req.url}` });
}

async function handleRequest(req, res) {

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
  /* Hoisted for the same reason as the two above: the catch needs it, and
     inside the try it would be out of scope exactly when it is wanted. */
  let ctx = null;

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
      if (path === "/privacy" || path === "/terms") {
        if (serveFromRoot(res, path.slice(1) + ".html")) return;
        return sendText(res, "Not found", 404);
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

    /* The schema is brought up to date before anything reads it.

       Every other deployed entry point does this — the cron, the five
       webhooks, the listings feed — and this one, which serves every page a
       person will ever open, did not. It was the only one that mattered: on
       Vercel nothing else runs, so a deploy that added migrations left the
       application answering from an old schema until the 09:00 cron happened
       to fire. Not a crash, which is the worrying part. Queries that still
       parse against the old columns simply return the old answers.

       It sits after the static branch and after /health deliberately. An asset
       needs no database, and /health has to be able to report an unreachable
       one rather than fail trying to migrate it — which is the moment you most
       want to read it. And it is inside the try, so a database that cannot be
       reached is rendered by the handler below rather than escaping as a bare
       stack trace with no request id in it.

       Cheap once there is nothing to do: one SELECT against schema_migration,
       cached per instance thereafter. */
    if (!NO_DATABASE_PATHS.has(path)) await ready();

    /* --- routing --------------------------------------------------------- */
    const hit = router.match(req.method, path);
    if (!hit) {
      /* An API answers in JSON even when the answer is "there is nothing
         here". A client that parses every response has to parse this one
         too, and handing it `Not found` as text/plain is how an integration
         reports "unexpected token N" instead of a 404. */
      const underApi = path === "/api" || path.startsWith("/api/");
      const others = router.methodsFor(path);
      if (others.length) {
        if (underApi) {
          res.setHeader("Allow", others.join(", "));
          return sendJson(res, {
            error: { type: "invalid_request",
              message: `That path answers ${others.join(" and ")}, not ${req.method}.` },
            request_id: requestId,
          }, 405);
        }
        res.writeHead(405, { Allow: others.join(", "), "Content-Type": "text/plain" });
        return res.end("Method not allowed");
      }
      if (underApi) {
        return sendJson(res, {
          error: { type: "not_found", message: "There is no such endpoint." },
          request_id: requestId,
        }, 404);
      }
      return sendText(res, "Not found", 404);
    }

    routePattern = hit.pattern;

    ctx = {
      req, res, url, path,
      requestId,
      log: forRequest(requestId, { method: req.method, path }),
      params: hit.params,
      query: Object.fromEntries(url.searchParams),
      staff: null,
      person: null,
      fields: {},
      files: [],
      csrf: null,
      flash: url.searchParams.get("m") || null,
    };

    /* Prefix matching on "/app" alone also catches /apply and /application —
       the guard has to be the segment, not the string. */
    const isAppRoute = path === "/app" || path.startsWith("/app/");

    /* The portal: tenants and owners, signed in as a person rather than as a
       member of staff. A separate branch beside the staff one rather than a
       widened version of it, for the same reason the sessions are separate
       tables — the two actors carry different things, and the gate that
       cannot confuse them is the gate that never has to remember not to. */
    const isPortalRoute = path === "/portal" || path.startsWith("/portal/");

    /* The public API. Neither of the two branches below applies to it: a
       caller is a key rather than a session, and every route it has
       authenticates through the one door in features/api.js. */
    const isApiRoute = path === "/api" || path.startsWith("/api/");

    const publicApp = PUBLIC_APP_PATHS.has(path)
      || PUBLIC_APP_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (isAppRoute && !publicApp) {
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

      /* A session with a password but no second factor is half authenticated.
         Checked here, before the capability gate, for the same reason the
         capability gate is here: a handler that has to remember is a handler
         that eventually does not. */
      const elevate = secondFactorRedirect(ctx.staff, path);
      if (elevate) {
        if (req.method !== "GET") {
          /* A POST cannot be replayed after the detour, so it is refused
             rather than silently dropped on the way to a login page. */
          return sendHtml(res, errorPage(403, "Your session needs a second factor before it can change anything. Sign in again.", null, ctx.staff), 403);
        }
        return redirect(res, elevate);
      }

      /* A borrowed view is read-only, and cannot be used to take over an
         account. Checked before everything else it could otherwise bypass. */
      ctx.impersonation = await activeImpersonation(ctx.staff);
      /* Carried on ctx.staff, which every page already receives, so the banner
         reaches all of them without threading a new argument through forty
         call sites — and so a page added later cannot forget it. */
      ctx.staff.impersonation = ctx.impersonation;
      if (ctx.impersonation) {
        const forbidden = impersonationForbids(path, req.method);
        if (forbidden) {
          ctx.log.warn("impersonation refused", {
            impersonationId: ctx.impersonation.id, forbidden, path, method: req.method,
          });
          return sendHtml(res, errorPage(403, "This is a read-only support session. It cannot change anything, alter an "
            + "account, or touch billing.", null, ctx.staff), 403);
        }
        /* Counted rather than recorded path by path: a support session should
           not become a second copy of the customer's data. */
        await run("UPDATE impersonation SET pages_viewed = pages_viewed + 1 WHERE id = ?",
          ctx.impersonation.id);
      }

      /* A lapsed subscription makes a company read-only: every screen loads,
         every report runs, nothing is deleted — and writes are refused with a
         way to fix it. Checked here rather than in handlers, because a rule
         each handler must remember is one that a handler will not. */
      if (req.method === "POST" && !readOnlyExempt(path) && await companyIsReadOnly(ctx.staff.company_id)) {
        ctx.log.warn("write refused, subscription lapsed", { companyId: ctx.staff.company_id });
        return sendHtml(res, errorPage(402, "Your subscription has lapsed, so this account is read-only. Everything is still here and "
          + "nothing has been deleted — start a plan on the billing page and you can carry on.", null, ctx.staff), 402);
      }

      const needed = requiredCapability(path, req.method);
      if (needed && !can(ctx.staff, needed)) {
        console.warn(`[403] ${req.method} ${path} — ${ctx.staff.email} (${ctx.staff.role}) lacks ${needed}`);
        return sendHtml(res, errorPage(403, `Your account is a ${roleLabel(ctx.staff.role).toLowerCase()} account, which does not have access to this. ` +
          `If you need it, an administrator can change your role.`, null, ctx.staff), 403);
      }
    } else if (isAppRoute) {
      ctx.staff = await currentStaff(req);
    }

    if (isPortalRoute) {
      ctx.person = await currentPerson(req);

      if (!ctx.person && !PUBLIC_PORTAL_PATHS.has(path) && !path.startsWith("/portal/enter/")) {
        const back = encodeURIComponent(url.pathname + url.search);
        return redirect(res, `/portal/sign-in?next=${back}`);
      }

      /* Signed in, but not yet looking at a company. A person with links in
         two companies has to pick one before any record is readable, because
         every portal query is scoped by the chosen company and a query with
         no company is a query with no boundary. */
      if (ctx.person && !ctx.person.companyId
          && !PUBLIC_PORTAL_PATHS.has(path) && path !== "/portal/choose") {
        return redirect(res, "/portal/choose");
      }

      /* There is no capability table here on purpose. A person's authority is
         the set of records they hold, which is a question about rows rather
         than about roles, so it is asked per record by `leaseIfHeld` and its
         siblings rather than answered once by a name. */
      if (ctx.person) actor = { companyId: ctx.person.companyId, personId: ctx.person.personId };
    }

    if (req.method === "POST") {
      const parsed = await parseRequestBody(req);
      ctx.fields = parsed.fields || {};
      ctx.files = parsed.files || [];
      /* Every state-changing request is checked, including the public tenant
         form: without it, any site could post work orders into the queue.

         Except the API, and the reason is the whole reason CSRF exists. A
         cookie is ambient — a browser attaches it to a request the person did
         not mean to make, which is what a forged POST exploits. An
         `Authorization` header is not ambient: nothing attaches it for you,
         so there is nothing to forge. A token here would be a ritual, and a
         ritual is how the reason gets forgotten and then applied somewhere it
         does not hold. */
      if (!isApiRoute && !checkCsrf(req, ctx.fields)) {
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
      : unreachableDatabase(err)
      ? "This deployment cannot reach its database, so no page that needs one can " +
        "load. Nothing you did caused it and nothing you typed was saved. " +
        "Whoever administers it can see the exact reason at /health."
      : "Something went wrong at our end. Try again, or call us if it keeps happening.";

    /* Under /api the answer is JSON whatever the request asked for, and in
       the shape every other API error uses — a client should not have to
       handle two error formats depending on how far the request got before it
       failed. An unparseable JSON body fails here rather than in a handler,
       and that is exactly the case an integrator hits first. */
    const underApi = path === "/api" || path.startsWith("/api/");
    if (underApi) {
      const type = status === 400 ? "invalid_request"
        : status === 401 ? "unauthenticated"
        : status === 403 ? "forbidden"
        : status === 404 ? "not_found"
        : status === 413 ? "invalid_request"
        : "server_error";
      return sendJson(res, { error: { type, message: safe }, request_id: requestId }, status);
    }

    const wantsJson = (req.headers.accept || "").includes("application/json");
    if (wantsJson) return sendJson(res, { error: safe, requestId }, status);
    /* The way back has to be somewhere this person can actually open. "/app"
       is the company queue, so for a technician the "back to the app" link
       on a 403 led to another 403. */
    sendHtml(res, errorPage(status, safe, requestId, ctx?.staff), status);
  }
}

/* Is this the database being unreachable, rather than a fault in a page?

   Worth telling apart, because the two need opposite things from the reader.
   A broken page is ours to fix and there is nothing they can do. A database
   the deployment cannot reach is almost always one wrong environment variable,
   and the person looking at the screen is very often the only person who can
   change it — so "Something went wrong at our end" is the one answer that
   helps nobody.

   The cost of not doing this was measured: a connection string pasted with
   Supabase's `[YOUR-PASSWORD]` placeholder still in it produced "Something
   broke" on every page, while /health had the exact reason all along. Nothing
   led from one to the other.

   Matched on the driver's own vocabulary. It does not use error codes for the
   pre-authentication failures — ENOTFOUND, a refused port, a rejected
   password all arrive as a PostgresError carrying text — so the text is what
   there is to match on. A false negative just falls back to the generic line,
   which is what happens today. */
function unreachableDatabase(err) {
  const name = err && err.name ? String(err.name) : "";
  if (!/^(Postgres|Connection)/.test(name) && err?.code === undefined) return false;
  const text = `${err?.code || ""} ${err?.message || ""}`;
  /* `database "x" does not exist` is spelled out rather than matching a bare
     "does not exist", which is also how Postgres reports a missing column or
     table — and that is a fault in our SQL, not an unreachable database.
     Labelling a code bug as an outage would send the reader to check
     environment variables that are perfectly fine. */
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|CONNECT_TIMEOUT|CONNECTION_(CLOSED|ENDED|DESTROYED|REFUSED)|password authentication failed|no pg_hba\.conf entry|too many clients|role .* does not exist|database .* does not exist|SASL|Tenant or user not found|tenant\/user/i
    .test(text);
}

/* What actually went wrong, rather than one word for every 403.

   Every refusal used to be headed "Expired". That is right for a form whose
   token has gone stale and wrong for everything else — and the everything
   else is the common case. Somebody who may not open a page was told their
   session had run out, so they signed in again and got the same page: the
   cause was wrong and the remedy it implied did not work.

   The message already says which it is; this only has to agree with it. */
function headingFor(status, message) {
  if (status === 404) return "Not found";
  if (/cannot reach its database/.test(String(message || ""))) {
    return "The database is not reachable";
  }
  if (status !== 403) return "Something broke";
  const m = String(message || "").toLowerCase();
  if (/expired|reload|go back/.test(m)) return "This form expired";
  if (/sign in|signed in|session/.test(m)) return "Please sign in again";
  return "You do not have access to this";
}

function errorPage(status, message, requestId, staff = null) {
  const esc = (v) => String(v).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const safe = esc(message);
  /* Only on a server fault. A 404 needs no reference number, and printing one
     on every expired form trains people to ignore it. */
  const ref = status >= 500 && requestId
    ? `<p style="margin-top:1rem;font-size:0.75rem;color:var(--ink-soft)">Reference <code>${esc(requestId)}</code> — quote this if you contact us.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css"></head><body><div class="pub" style="max-width:30rem"><h1>${headingFor(status, message)}</h1><p class="lede">${safe}</p>${ref}<p style="margin-top:1.5rem"><a class="pill solid" href="${staff ? landingFor(staff) : "/app"}">Back to the app</a></p></div></body></html>`;
}
