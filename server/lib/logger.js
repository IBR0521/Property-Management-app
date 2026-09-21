/* Logging, with a request id on every line.

   The old logs were `console.error("[500] POST /app/x", err)`. With one user
   that is enough. With many companies on one deployment it is not: two
   simultaneous failures interleave, a stack trace has no owner, and a customer
   saying "it broke around three" gives you nothing to grep for.

   Every request gets an id. It appears on every line that request produces, in
   the X-Request-Id header, and on the error page — so a person can read it out
   and it leads straight to the lines that matter.

   Two formats. A log drain wants one JSON object per line; a terminal wants
   something a human can scan. Both carry the same fields. */
import { randomBytes } from "node:crypto";
import { LOG_FORMAT, APP_ENV } from "./config.js";

const JSON_MODE = LOG_FORMAT === "json";

export function newRequestId() {
  return randomBytes(6).toString("hex");
}

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level, message, fields = {}) {
  const at = new Date().toISOString();

  if (JSON_MODE) {
    /* Errors do not survive JSON.stringify — an Error serialises to {}. Pulled
       apart by hand so a drain actually receives the message and the stack. */
    const out = { at, level, env: APP_ENV, msg: message, ...scrub(fields) };
    if (fields.err instanceof Error) {
      out.err = { name: fields.err.name, message: fields.err.message, stack: fields.err.stack };
    }
    const line = JSON.stringify(out);
    if (LEVEL_RANK[level] >= 30) console.error(line); else console.log(line);
    return;
  }

  const rid = fields.requestId ? ` ${fields.requestId}` : "";
  const extra = Object.entries(scrub(fields))
    .filter(([k]) => k !== "requestId" && k !== "err")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const head = `[${level}]${rid} ${message}${extra ? ` ${extra}` : ""}`;
  if (LEVEL_RANK[level] >= 30) console.error(head); else console.log(head);
  if (fields.err instanceof Error && fields.err.stack) console.error(fields.err.stack);
}

/* Anything that looks like a credential is dropped rather than logged. This is
   a backstop for a careless call site, not a licence to pass secrets in. */
const SECRET_KEY = /(password|secret|token|key|authorization|cookie|dsn|tin|ssn)/i;

function scrub(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "err") continue;
    if (SECRET_KEY.test(k)) { out[k] = "[redacted]"; continue; }
    out[k] = v;
  }
  return out;
}

export const log = {
  debug: (m, f) => emit("debug", m, f),
  info: (m, f) => emit("info", m, f),
  warn: (m, f) => emit("warn", m, f),
  error: (m, f) => emit("error", m, f),
};

/* A logger bound to one request, so call sites never have to remember to pass
   the id and therefore never forget to. */
export function forRequest(requestId, base = {}) {
  const bind = (level) => (message, fields = {}) =>
    emit(level, message, { requestId, ...base, ...fields });
  return { debug: bind("debug"), info: bind("info"), warn: bind("warn"), error: bind("error"), requestId };
}
