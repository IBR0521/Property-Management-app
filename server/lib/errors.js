/* Error reporting, over the wire, without an SDK.

   Sentry's Node SDK pulls in a dependency tree and a great deal of automatic
   instrumentation to do something that is, at bottom, one POST of newline-
   delimited JSON. The envelope format is documented and stable, so this sends
   it with fetch — consistent with how every other provider is called here.

   Unset SENTRY_DSN means this module makes no network calls at all and costs
   nothing. That is the default, and it is a legitimate way to run.

   Reporting is fire-and-forget on purpose. An error tracker being slow or down
   must never delay or fail the response the user is waiting on. */
import { SENTRY_DSN, APP_ENV } from "./config.js";
import { log } from "./logger.js";

const dsn = parseDsn(SENTRY_DSN);

/* https://<key>@<host>/<project> — the key is public by design (it is embedded
   in browser bundles) but it is still not something to print. */
function parseDsn(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) return null;
    return {
      key: u.username,
      projectId,
      endpoint: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
    };
  } catch {
    log.warn("SENTRY_DSN is not a valid DSN; error reporting is off");
    return null;
  }
}

export function reportingEnabled() {
  return Boolean(dsn);
}

/* Returns the event id so it can be shown to the user and quoted in support.
   Null when reporting is off, which callers must handle — the request id is
   the fallback identifier and always exists. */
export function captureError(err, context = {}) {
  if (!dsn) return null;

  const eventId = randomHex32();
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    environment: APP_ENV,
    server_name: undefined,
    transaction: context.route || undefined,
    tags: {
      request_id: context.requestId || undefined,
      company_id: context.companyId || undefined,
      route: context.route || undefined,
    },
    /* No email, no name, no IP. An error tracker is a third party and a tenant's
       identity is not needed to fix a stack trace. */
    user: context.staffId ? { id: context.staffId } : undefined,
    exception: {
      values: [{
        type: err?.name || "Error",
        value: String(err?.message || err),
        stacktrace: err?.stack ? { frames: parseStack(err.stack) } : undefined,
      }],
    },
  };

  const body =
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: SENTRY_DSN }) + "\n" +
    JSON.stringify({ type: "event", content_type: "application/json" }) + "\n" +
    JSON.stringify(event) + "\n";

  fetch(dsn.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth":
        `Sentry sentry_version=7, sentry_client=property-ops/1.0, sentry_key=${dsn.key}`,
    },
    body,
    signal: AbortSignal.timeout(4000),
  }).catch((e) => {
    // Never let the tracker's problems become the request's problems.
    log.warn("error report failed to send", { reason: String(e.message).slice(0, 120) });
  });

  return eventId;
}

/* Sentry orders frames oldest-first, the reverse of a Node stack. */
function parseStack(stack) {
  const frames = [];
  for (const line of String(stack).split("\n").slice(1)) {
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({
      function: m[1] || "<anonymous>",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2].includes("node_modules") && !m[2].startsWith("node:"),
    });
  }
  return frames.reverse();
}

function randomHex32() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
