/* Configuration, read once and validated at boot.

   Fourteen environment variables were read from fourteen scattered
   `process.env` lookups, four of them in two or three files each. That is
   tolerable right up until one file defaults a missing value and another
   throws on it, and the app half-works in a way nobody can reproduce.

   Two rules here.

   Validate shape, not just presence. `APP_ENCRYPTION_KEY` being set is not the
   same as it decoding to 32 bytes, and the difference only shows up when
   somebody tries to seal a bank token months later.

   Fail at boot, loudly, with the fix in the message. A missing variable that
   surfaces as a 500 on one page at 4pm costs far more than a process that
   refuses to start. */
import { Buffer } from "node:buffer";

const problems = [];
const warnings = [];

const raw = (name) => {
  const v = process.env[name];
  return v == null || v === "" ? null : String(v).trim();
};

/* --- where we are --------------------------------------------------------- */

export const NODE_ENV = raw("NODE_ENV") || "development";
export const IS_TEST = NODE_ENV === "test";
/* Vercel sets both; AWS_LAMBDA_FUNCTION_NAME is the one that survives in some
   runtimes where VERCEL does not. Either means "no local disk, no long-lived
   process". */
export const IS_SERVERLESS = Boolean(raw("VERCEL") || raw("AWS_LAMBDA_FUNCTION_NAME"));
export const APP_ENV = raw("APP_ENV") || (IS_SERVERLESS ? "production" : "development");

/* --- database ------------------------------------------------------------- */

/* Tests run against their own database and must never be able to reach the
   real one. Two independent guards: the test URL is a different variable, and
   it is rejected if it is the same string as the production one. Somebody will
   eventually paste the wrong value in, and the cost of that mistake is the
   entire dataset. */
function resolveDatabaseUrl() {
  if (IS_TEST) {
    const test = raw("TEST_DATABASE_URL");
    if (!test) {
      problems.push(
        "TEST_DATABASE_URL is not set, and NODE_ENV=test.\n" +
        "    Point it at a throwaway database — the suite drops and rebuilds its schema.\n" +
        "    Local:  postgresql://localhost:5432/propops_test");
      return null;
    }
    if (test === raw("DATABASE_URL")) {
      problems.push(
        "TEST_DATABASE_URL is identical to DATABASE_URL.\n" +
        "    Refusing to run: the suite drops the public schema on whatever it is given.");
      return null;
    }
    return test;
  }

  const url = raw("DATABASE_URL");
  if (!url) {
    problems.push(
      "DATABASE_URL is not set.\n" +
      "    Supabase -> Project Settings -> Database -> Connection string -> Transaction pooler.");
    return null;
  }
  /* Port 5432 is the direct connection. It works locally and exhausts its
     connection limit within minutes of a serverless deploy, by which time the
     cause is hours behind you. A warning rather than an error, because a local
     Postgres on 5432 is exactly right. */
  if (IS_SERVERLESS && /:5432\//.test(url)) {
    warnings.push(
      "DATABASE_URL points at port 5432 (direct) while running serverless. " +
      "Use the transaction pooler on 6543, or connections will be exhausted under load.");
  }
  return url;
}

export const DATABASE_URL = resolveDatabaseUrl();
export const DATABASE_CA_CERT = raw("DATABASE_CA_CERT");
export const PG_POOL_MAX = Number(raw("PG_POOL_MAX") || 4);

/* --- secrets -------------------------------------------------------------- */

/* Accepts base64 or hex so that whatever a secret manager emits can be pasted
   in. Checked here so a bad key is a boot failure rather than a decryption
   failure the first time somebody links a bank account. */
export const APP_ENCRYPTION_KEY = (() => {
  const v = raw("APP_ENCRYPTION_KEY");
  if (!v) return null;
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (buf.length !== 32) {
    problems.push(
      `APP_ENCRYPTION_KEY decodes to ${buf.length} bytes; it must be 32.\n` +
      `    Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
    return null;
  }
  return v;
})();

/* Required on a scheduler that anyone on the internet can reach, optional on a
   laptop where nothing can. api/cron.js used to decide this itself. */
export const CRON_SECRET = (() => {
  const v = raw("CRON_SECRET");
  if (!v && IS_SERVERLESS) {
    problems.push(
      "CRON_SECRET is not set, and this is a deployed environment.\n" +
      "    /api/cron would be an open trigger for every company's reminders.");
  }
  return v;
})();

export const BLOB_READ_WRITE_TOKEN = raw("BLOB_READ_WRITE_TOKEN");

/* --- delivery and providers ----------------------------------------------- */

/* off queues and sends nothing, log drains to the console, sandbox posts to a
   provider's test credentials which accept and discard, live actually sends.
   An unrecognised value is refused rather than defaulted: a typo here would
   otherwise read as "some mode is set" and the UI would stop warning. */
export const DELIVERY_MODE = (() => {
  const v = raw("DELIVERY_MODE") || "off";
  if (!["off", "log", "sandbox", "live"].includes(v)) {
    problems.push(
      `DELIVERY_MODE is "${v}", which is not a mode.\n` +
      `    Use one of: off, log, sandbox, live.`);
    return "off";
  }
  return v;
})();

export const EMAIL_FROM = raw("EMAIL_FROM");
export const RESEND_API_KEY = raw("RESEND_API_KEY");
export const RESEND_WEBHOOK_SECRET = raw("RESEND_WEBHOOK_SECRET");

export const TWILIO_ACCOUNT_SID = raw("TWILIO_ACCOUNT_SID");
export const TWILIO_AUTH_TOKEN = raw("TWILIO_AUTH_TOKEN");
export const TWILIO_FROM_NUMBER = raw("TWILIO_FROM_NUMBER");
export const TWILIO_MESSAGING_SERVICE_SID = raw("TWILIO_MESSAGING_SERVICE_SID");

/* Twilio signs over the full public URL, so this cannot be derived from the
   request: behind a proxy the app sees an internal host and the signature
   never matches. It is also what outbound links in messages are built from. */
export const APP_BASE_URL = (raw("APP_BASE_URL") || "").replace(/\/+$/, "") || null;

/* A mode that claims to send and cannot is the exact failure this phase
   exists to remove, so live is refused without the keys to back it. */
if (DELIVERY_MODE === "live") {
  if (!RESEND_API_KEY) {
    problems.push(
      "DELIVERY_MODE=live but RESEND_API_KEY is not set.\n" +
      "    Email would fail every attempt and dead-letter.");
  }
  if (!EMAIL_FROM) {
    problems.push("DELIVERY_MODE=live but EMAIL_FROM is not set.");
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    problems.push(
      "DELIVERY_MODE=live but Twilio is not configured.\n" +
      "    The emergency on-call alert is SMS; without it that path is silent.");
  }
  if (!APP_BASE_URL) {
    problems.push(
      "DELIVERY_MODE=live but APP_BASE_URL is not set.\n" +
      "    Twilio signs webhooks over the full URL, so verification would reject every callback.");
  }
}

export const PLAID = {
  clientId: raw("PLAID_CLIENT_ID"),
  secret: raw("PLAID_SECRET"),
  env: raw("PLAID_ENV") || "sandbox",
  webhookSecret: raw("PLAID_WEBHOOK_SECRET"),
  get configured() { return Boolean(this.clientId && this.secret); },
};

/* --- subscription billing ------------------------------------------------- */

export const STRIPE_SECRET_KEY = raw("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = raw("STRIPE_WEBHOOK_SECRET");
export const STRIPE_PUBLISHABLE_KEY = raw("STRIPE_PUBLISHABLE_KEY");

/* A price id per band, read by name so a missing one identifies itself. */
export const STRIPE_PRICES = {
  starter: raw("STRIPE_PRICE_STARTER"),
  growth: raw("STRIPE_PRICE_GROWTH"),
  professional: raw("STRIPE_PRICE_PROFESSIONAL"),
  scale: raw("STRIPE_PRICE_SCALE"),
};

/* A live secret key in a non-production environment is how a test run charges
   somebody. Refused rather than warned about. */
if (STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.startsWith("sk_live_") && APP_ENV !== "production") {
  problems.push(
    `STRIPE_SECRET_KEY is a live key but APP_ENV is "${APP_ENV}".\n` +
    "    Use a test key outside production, or a test run will charge real cards.");
}

/* --- observability -------------------------------------------------------- */

export const LOG_FORMAT = raw("LOG_FORMAT") || (IS_SERVERLESS ? "json" : "human");
export const SENTRY_DSN = raw("SENTRY_DSN");
export const PORT = Number(raw("PORT") || 4300);

/* --- the gate ------------------------------------------------------------- */

/* Called by every entry point before anything else runs. Reports every problem
   at once rather than one per restart, because fixing five variables one boot
   at a time is five times the wait for no extra information. */
export function assertConfig({ exitOnFailure = true } = {}) {
  for (const w of warnings) console.warn(`[config] warning: ${w}`);

  if (problems.length) {
    const lines = problems.map((p) => `  - ${p}`).join("\n");
    const message = `Configuration is not usable:\n\n${lines}\n`;
    if (exitOnFailure) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }
  return true;
}

export function configProblems() {
  return [...problems];
}

/* What /health and the platform admin area may show. Never a value — the point
   of a secret is that it does not appear in a response. */
export function configSummary() {
  return {
    appEnv: APP_ENV,
    nodeEnv: NODE_ENV,
    serverless: IS_SERVERLESS,
    database: DATABASE_URL ? (DATABASE_CA_CERT ? "verified-tls" : "encrypted-unverified") : "unset",
    encryption: APP_ENCRYPTION_KEY ? "configured" : "unset",
    blob: BLOB_READ_WRITE_TOKEN ? "configured" : "local-disk",
    delivery: DELIVERY_MODE,
    email: RESEND_API_KEY ? "resend" : "unset",
    sms: TWILIO_ACCOUNT_SID ? "twilio" : "unset",
    plaid: PLAID.configured ? PLAID.env : "unset",
    errorReporting: SENTRY_DSN ? "configured" : "unset",
    billing: STRIPE_SECRET_KEY
      ? (STRIPE_SECRET_KEY.startsWith("sk_live_") ? "live" : "test")
      : "unset",
  };
}
