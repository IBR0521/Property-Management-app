/* Staff sessions, and the tokenised links that stand in for tenant and owner
   logins.

   Passwords use scrypt from node:crypto. No pepper, no configurable cost —
   one hard-coded cost that is slow enough to matter, because a configurable
   cost is a cost someone eventually sets to 1. */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { get, run, all } from "./db.js";
import { id } from "./ids.js";
import { cookies, setCookie, clearCookie } from "./http.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 14;
export const SESSION_COOKIE = "pops";

export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(plain, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, N, r, p, salt, key] = stored.split("$");
  const candidate = scryptSync(plain, salt, SCRYPT.keylen, {
    N: Number(N), r: Number(r), p: Number(p), keylen: SCRYPT.keylen,
  });
  const expected = Buffer.from(key, "hex");
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/* --- sessions ------------------------------------------------------------- */

export async function startSession(res, staffId, { secure = false } = {}) {
  const sid = id() + randomBytes(16).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await run(
    "INSERT INTO session (id, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    sid, staffId, now.toISOString(), expires.toISOString()
  );
  setCookie(res, SESSION_COOKIE, sid, { expires, secure });
  return sid;
}

export async function endSession(req, res) {
  const sid = cookies(req)[SESSION_COOKIE];
  if (sid) await run("DELETE FROM session WHERE id = ?", sid);
  clearCookie(res, SESSION_COOKIE);
}

export async function currentStaff(req) {
  const sid = cookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = await get(
    `SELECT s.*, c.name AS company_name, c.emergency_phone, c.phone AS company_phone
       FROM session sess
       JOIN staff s ON s.id = sess.staff_id
       JOIN company c ON c.id = s.company_id
      WHERE sess.id = ? AND sess.expires_at > ? AND s.active = 1`,
    sid, new Date().toISOString()
  );
  return row || null;
}

/* Housekeeping, called by the scheduler. */
export async function pruneSessions() {
  const r = await run("DELETE FROM session WHERE expires_at <= ?", new Date().toISOString());
  return r.changes;
}

/* --- tokenised access ----------------------------------------------------- */

/* Tenants, owners and applicants never get an account. They get a long random
   URL scoped to exactly one record, which is the only way these links are
   ever actually opened. Each lookup is scoped by token AND by the table, so a
   work-order token cannot be replayed against an owner statement. */
export async function byToken(table, tokenColumn, tokenValue, extra = "") {
  if (!tokenValue || tokenValue.length < 20) return null;
  return await get(`SELECT * FROM ${table} WHERE ${tokenColumn} = ? ${extra}`, tokenValue) || null;
}

export async function staffList(companyId) {
  return await all("SELECT id, name, email, role, active FROM staff WHERE company_id = ? ORDER BY name", companyId);
}

/* --- roles and what each one may see -------------------------------------

   The original CHECK allowed two roles because there were two jobs. A leasing
   agent showing flats and a maintenance tech closing work orders both need the
   queue, and neither has any business seeing what is in the trust account —
   which is not a comment about trust, it is how you keep a cash-handling
   allegation from being a question of somebody's word.

   Capabilities rather than role names at the call site. `role === "admin"`
   scattered through the codebase is how a new role ends up silently holding
   permissions nobody granted it; asking `can(staff, "money.view")` does not
   have that failure mode. */

export const CAPABILITIES = [
  "queue.view",       // the daily work list
  "property.view",    // units, leases, tenants
  "property.edit",    // adding and changing those records
  "maintenance.work", // triage, dispatch, close out
  "leasing.work",     // applications, listings, lease documents
  "money.view",       // rent ledgers, owner statements, cash balances, journals
  "money.write",      // post journals, record payments, pay invoices
  "bank.link",        // connect a bank, see reconciliation
  "vendor.manage",    // contractor compliance records
  "staff.manage",     // other people's accounts
  "settings.manage",  // company settings, routing rules, templates
];

const ROLE_CAPABILITIES = {
  admin: new Set(CAPABILITIES),

  manager: new Set([
    "queue.view", "property.view", "property.edit", "maintenance.work",
    "leasing.work", "money.view", "money.write", "bank.link",
    "vendor.manage", "settings.manage",
  ]),

  /* Books and banking, but not the operational side — an accountant has no
     reason to dispatch a plumber. */
  accountant: new Set([
    "queue.view", "property.view", "money.view", "money.write",
    "bank.link", "vendor.manage",
  ]),

  /* Shows units, takes applications, prepares leases. No money at all: not the
     ledger, not the bank, not an owner statement. */
  leasing: new Set([
    "queue.view", "property.view", "leasing.work",
  ]),

  /* Work orders and the contractors who do them. Can see that a job was
     approved; cannot see the cash it came out of. */
  maintenance: new Set([
    "queue.view", "property.view", "maintenance.work", "vendor.manage",
  ]),
};

export function capabilitiesFor(role) {
  return ROLE_CAPABILITIES[role] || ROLE_CAPABILITIES.leasing;
}

/* The one question every gate asks. Unknown role means the least privilege on
   offer, never the most — a typo in a role name must not open the books. */
export function can(staff, capability) {
  if (!staff || !staff.active) return false;
  return capabilitiesFor(staff.role).has(capability);
}

export function roleLabel(role) {
  return {
    admin: "Administrator", manager: "Property manager", accountant: "Accountant",
    leasing: "Leasing agent", maintenance: "Maintenance",
  }[role] || role;
}

/* --- the routing gate -----------------------------------------------------

   Ordered longest-prefix-first and matched on path segments, so /app/rent
   never matches /app/rental-something. Enforced in app.js before any handler
   runs: a handler that forgets to check is the normal way an authorisation
   model fails, so handlers are not asked to check. */
const ROUTE_CAPABILITY = [
  ["/app/accounting", "money.view"],
  ["/app/banking", "bank.link"],
  ["/app/owners", "money.view"],
  ["/app/rent", "money.view"],
  ["/app/vendors/1099", "money.view"],
  ["/app/vendors/invoices", "money.view"],
  ["/app/vendors", "vendor.manage"],
  ["/app/leases", "leasing.work"],
  ["/app/listings", "leasing.work"],
  ["/app/applications", "leasing.work"],
  ["/app/maintenance", "maintenance.work"],
  ["/app/turns", "maintenance.work"],
  ["/app/compliance", "property.view"],
  ["/app/portfolio", "property.view"],
  ["/app/setup", "settings.manage"],
  ["/app/staff", "staff.manage"],
];

/* Write paths need more than read paths on the same prefix. Checked in
   addition to the table above, not instead of it. */
const WRITE_CAPABILITY = [
  ["/app/accounting", "money.write"],
  ["/app/banking", "money.write"],
  ["/app/rent", "money.write"],
  ["/app/owners", "money.write"],
  ["/app/vendors/invoices", "money.write"],
  ["/app/portfolio", "property.edit"],
];

function longestMatch(table, path) {
  let best = null;
  for (const [prefix, capability] of table) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      if (!best || prefix.length > best[0].length) best = [prefix, capability];
    }
  }
  return best;
}

/* Returns the capability this request needs, or null if it needs none beyond
   being signed in. */
export function requiredCapability(path, method = "GET") {
  if (method === "POST") {
    const write = longestMatch(WRITE_CAPABILITY, path);
    if (write) return write[1];
  }
  const read = longestMatch(ROUTE_CAPABILITY, path);
  return read ? read[1] : null;
}

