/* API keys: issuing them, checking them, and what they are allowed to do.

   ## One authorisation model, not two

   The tempting design is a permission system for the API beside the one the
   screens use. That is how a product ends up with two answers to "may this
   caller do this" and no way to tell which is right.

   There is one answer here. A key belongs to a member of staff, and what it
   may do is **the intersection of its scopes with that person's role**,
   resolved from the current `staff` row on every request. Narrowing somebody
   to a leasing account narrows their keys in the same moment; deactivating
   them stops their keys. A key that outlives the authority it was issued
   under is the failure this shape exists to prevent.

   Scopes can only take away. A key with `money:write` held by somebody whose
   role has no `money.write` can do nothing with it — which is the right way
   round, because the alternative is an API that is a privilege escalation
   with documentation.

   ## The key itself

       pmk_<keyId>_<secret>

   The prefix is decoration: distinctive enough that a leaked key is
   recognisable in a log or by a secret scanner, and deliberately not used for
   lookup, so changing it when the product has a name of its own does not
   invalidate every key already issued. The id is the row; the secret is 32
   bytes from the system's random source, stored only as a SHA-256.

   Shown once, at creation. "We can show it to you again" means "we have it",
   and the day a database leaks is the day that matters. */
import { all, get, one, run, insert } from "../db.js";
import { id, token } from "../ids.js";
import { stamp } from "../dates.js";
import { sha256, hashesMatch } from "../crypto.js";
import { can } from "../auth.js";
import { SCOPES } from "./scopes.js";

/* Re-exported so a caller that has the keys module does not also need the
   vocabulary module. The vocabulary lives apart so the specification can be
   built without a database. */
export { SCOPES, SCOPE_NAMES } from "./scopes.js";

const PREFIX = "pmk";


/* --- issuing ---------------------------------------------------------------- */

/* Returns `{ key, record }`. `key` is the only time the secret exists outside
   the caller's hands, and nothing here keeps it. */
export async function issueKey({ companyId, staffId, name, scopes = [], createdBy = null }) {
  const clean = [...new Set(scopes)].filter((s) => SCOPES[s]);
  if (!clean.length) throw new Error("A key with no scopes can do nothing. Choose at least one.");

  const label = String(name || "").trim();
  if (!label) throw new Error("A key needs a name, so it can be recognised later.");

  const keyId = id();
  const secret = token();
  const key = `${PREFIX}_${keyId}_${secret}`;

  await insert("api_key", {
    id: keyId, company_id: companyId, staff_id: staffId,
    name: label,
    secret_hash: sha256(secret),
    /* The tail rather than the head: the head is the row id, which is already
       visible. The last six characters are what somebody reads off a config
       file to check they are looking at the right key. */
    hint: secret.slice(-6),
    scopes: JSON.stringify(clean),
    created_by: createdBy, created_at: stamp(),
  });

  return { key, record: await one("SELECT * FROM api_key WHERE id = ?", keyId) };
}

export async function revokeKey({ companyId, keyId, by = null }) {
  const key = await one(
    "SELECT * FROM api_key WHERE id = ? AND company_id = ?", keyId, companyId);
  if (key.revoked_at) return key;
  await run("UPDATE api_key SET revoked_at = ?, revoked_by = ? WHERE id = ?",
    stamp(), by, keyId);
  return await one("SELECT * FROM api_key WHERE id = ?", keyId);
}

export async function keysFor(companyId) {
  const rows = await all(
    `SELECT k.*, s.name AS staff_name, s.role AS staff_role, s.active AS staff_active
       FROM api_key k
       JOIN staff s ON s.id = k.staff_id
      WHERE k.company_id = ?
      ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`, companyId);
  return rows.map((k) => ({ ...k, scopes: parseScopes(k.scopes) }));
}

/* --- checking --------------------------------------------------------------- */

/* Every refusal is the same shape, and the `reason` never reaches the caller
   in more detail than "this key is not usable" — telling an unauthenticated
   caller *why* is telling them which half they got right. It is logged. */
export async function authenticate(authorization) {
  const raw = bearer(authorization);
  if (!raw) return { ok: false, reason: "no bearer token" };

  const parts = String(raw).split("_");
  if (parts.length < 3) return { ok: false, reason: "malformed key" };
  /* The prefix is ignored on purpose (see the header) and the secret may
     itself contain underscores, being base64url. */
  const keyId = parts[1];
  const secret = parts.slice(2).join("_");
  if (!keyId || !secret) return { ok: false, reason: "malformed key" };

  const key = await get("SELECT * FROM api_key WHERE id = ?", keyId);
  if (!key) return { ok: false, reason: "no such key" };
  if (key.revoked_at) return { ok: false, reason: "revoked" };
  if (!hashesMatch(sha256(secret), key.secret_hash)) {
    return { ok: false, reason: "secret does not match" };
  }

  /* The holder, now — not as they were when the key was made. */
  const staff = await get("SELECT * FROM staff WHERE id = ?", key.staff_id);
  if (!staff) return { ok: false, reason: "the holder no longer exists" };
  if (!staff.active) return { ok: false, reason: "the holder is deactivated" };
  if (staff.company_id !== key.company_id) {
    /* Cannot happen through any path in the application; checked because a
       key that crossed companies would be the worst bug in the system. */
    return { ok: false, reason: "holder and key disagree about the company" };
  }

  return { ok: true, key: { ...key, scopes: parseScopes(key.scopes) }, staff };
}

/* What this key may do, which is what its holder may do and no more. */
export function allows(key, staff, scope) {
  if (!key || !staff || !SCOPES[scope]) return false;
  if (!key.scopes.includes(scope)) return false;
  return can(staff, SCOPES[scope].capability);
}

/* The scopes this key actually carries — the ones it names that its holder
   can still back. Shown on the key's own screen, so a key narrowed by a role
   change says so rather than failing at three in the morning. */
export function effectiveScopes(key, staff) {
  return (key.scopes || []).filter((s) => allows(key, staff, s));
}

/* --- rate limiting ----------------------------------------------------------- */

/* One row per key per window, incremented with an upsert, rather than
   `rate_hit`'s row per attempt: the cost of limiting must not grow with the
   traffic being limited.

   Fixed windows rather than rolling. A caller can spend the last of one hour
   and the first of the next back to back, which is the ordinary trade every
   fixed-window limiter makes and is not worth a sorted set to avoid. */
export const RATE = { perHour: 1000 };

export async function checkRate(keyId, { now = () => new Date(), max = RATE.perHour } = {}) {
  const window = now().toISOString().slice(0, 13);   // YYYY-MM-DDTHH
  try {
    const row = await get(
      `INSERT INTO api_rate (key_id, window_start, hits) VALUES (?, ?, 1)
       ON CONFLICT (key_id, window_start) DO UPDATE SET hits = api_rate.hits + 1
       RETURNING hits`, keyId, window);
    const hits = Number(row?.hits || 0);
    return {
      allowed: hits <= max,
      limit: max,
      remaining: Math.max(0, max - hits),
      /* Seconds to the top of the next hour, which is when this window ends. */
      retryAfter: secondsToNextHour(now()),
    };
  } catch (err) {
    /* Fail open, like the other limiter and for the same reason: a database
       hiccup must degrade into a served request, not into a customer's
       integration stopping. Logged rather than swallowed. */
    console.error("[api] rate check failed, allowing request:", err.message);
    return { allowed: true, limit: max, remaining: max, retryAfter: 0 };
  }
}

function secondsToNextHour(at) {
  const next = new Date(at);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return Math.max(1, Math.round((next - at) / 1000));
}

/* Windows nobody will read again. */
export async function pruneApiRate({ hours = 48, now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - hours * 3600_000).toISOString().slice(0, 13);
  const r = await run("DELETE FROM api_rate WHERE window_start < ?", cutoff);
  return r.changes || 0;
}

/* --- afterwards -------------------------------------------------------------- */

export async function recordUse(keyId, ip) {
  try {
    await run(
      `UPDATE api_key SET last_used_at = ?, last_used_ip = ?, calls = calls + 1
        WHERE id = ?`, stamp(), ip || null, keyId);
  } catch { /* bookkeeping must never fail a served request */ }
}

function parseScopes(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((s) => SCOPES[s]) : [];
  } catch { return []; }
}

function bearer(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : null;
}
