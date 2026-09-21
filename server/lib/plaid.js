/* The aggregator boundary.

   Every call that leaves this building goes through here, for two reasons.
   The obvious one is that swapping Plaid for another aggregator should touch
   one file. The real one is that this is the only place an access token is
   ever unsealed, so there is exactly one place to audit for a token leaking
   into a log, an error page, or a stack trace.

   Nothing here has been run against Plaid's live API — this project has no
   Plaid credentials. The request shapes follow Plaid's documented API, but
   treat the first live call as the test. Everything that does not need Plaid
   (sealing, storage, matching, the webhook's idempotency and verification
   path) is exercised by the test suite and does not depend on this file. */

const ENVS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

export function plaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

function config() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET.");
  }
  const env = process.env.PLAID_ENV || "sandbox";
  const base = ENVS[env];
  if (!base) throw new Error(`PLAID_ENV must be one of ${Object.keys(ENVS).join(", ")}`);
  return { clientId, secret, base, env };
}

async function call(path, body) {
  const { clientId, secret, base } = config();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* Plaid's error body names the item and sometimes echoes request context.
       Only the codes are carried forward; the raw body is not, because it ends
       up in logs and occasionally in an error page. */
    const err = new Error(json.error_message || `Plaid ${path} failed (${res.status})`);
    err.plaidCode = json.error_code;
    err.plaidType = json.error_type;
    throw err;
  }
  return json;
}

/* A short-lived token the browser widget uses to start the link flow. Safe to
   send to the client; the access token it eventually yields is not. */
export async function createLinkToken({ companyId, userId, webhookUrl }) {
  return await call("/link/token/create", {
    user: { client_user_id: String(userId || companyId) },
    client_name: "Property operations",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    webhook: webhookUrl || undefined,
  });
}

/* The one-time public token from the widget becomes the long-lived access
   token. The caller seals it immediately; it is never returned anywhere else. */
export async function exchangePublicToken(publicToken) {
  return await call("/item/public_token/exchange", { public_token: publicToken });
}

export async function getAccounts(accessToken) {
  return await call("/accounts/get", { access_token: accessToken });
}

/* Cursor-based sync: asks only for what changed since last time. The cursor is
   stored per item so a resync after an outage does not re-import a year. */
export async function syncTransactions(accessToken, cursor) {
  return await call("/transactions/sync", {
    access_token: accessToken,
    cursor: cursor || undefined,
    count: 250,
  });
}

export async function webhookVerificationKey(keyId) {
  return await call("/webhook_verification_key/get", { key_id: keyId });
}
