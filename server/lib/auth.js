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
    `SELECT s.*, c.name AS company_name, c.emergency_phone, c.phone AS company_phone,
            c.slug AS company_slug, c.require_2fa, c.verified_at AS company_verified_at,
            sess.id AS session_id, sess.totp_at, sess.impersonation_id
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
  "maintenance.work", // triage, dispatch, close out, the whole queue
  "maintenance.own",  // only the jobs assigned to me
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
    "queue.view", "property.view", "property.edit", "maintenance.work", "maintenance.own",
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
    "queue.view", "property.view", "maintenance.work", "maintenance.own", "vendor.manage",
  ]),

  /* The person in the van, not the coordinator at the desk. They see the jobs
     assigned to them and the addresses those jobs are at, and nothing else —
     not the rest of the queue, not the portfolio, not a tenant they are not
     visiting.

     `property.view` used to be in here and contradicted every word of that:
     it gates /app/portfolio and /app/compliance, which is the whole portfolio
     and every deadline in it. Nothing the technician's own screen does needs
     it — /app/jobs is gated on maintenance.own, and the job's address comes
     from the job. Removed when Phase 5 built the view this role exists for,
     which is the first time anybody looked. */
  technician: new Set([
    "maintenance.own",
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

/* Where somebody lands when nothing else has said where to go.

   "/app" is the company's queue and needs `queue.view`. A technician does not
   have it, and never should — so signing in on a phone showed them a 403 as
   the very first screen of the product. Found by signing in as one.

   Ordered most useful first, and the last entry needs no capability at all,
   so this always answers with somewhere they can actually open. */
const LANDINGS = [
  ["/app", "queue.view"],
  ["/app/jobs", "maintenance.own"],
  ["/app/account", null],
];

export function landingFor(staff) {
  for (const [path, capability] of LANDINGS) {
    if (!capability || can(staff, capability)) return path;
  }
  return "/app/account";
}

export function roleLabel(role) {
  return {
    admin: "Administrator", manager: "Property manager", accountant: "Accountant",
    leasing: "Leasing agent", maintenance: "Maintenance", technician: "Technician",
  }[role] || role;
}

/* --- the routing gate -----------------------------------------------------

   Ordered longest-prefix-first and matched on path segments, so /app/rent
   never matches /app/rental-something. Enforced in app.js before any handler
   runs: a handler that forgets to check is the normal way an authorisation
   model fails, so handlers are not asked to check. */
const ROUTE_CAPABILITY = [
  /* The dashboard is the entire company's queue. Without this entry it needed
     no capability at all, so a technician — who should see only their own
     jobs — could read every open matter in the company. */
  ["/app", "queue.view"],
  ["/app/jobs", "maintenance.own"],
  ["/app/account", null],
  ["/app/accounting", "money.view"],
  ["/app/banking", "bank.link"],
  ["/app/owners", "money.view"],
  ["/app/deposits", "money.view"],
  ["/app/payments", "money.view"],
  ["/app/payouts", "money.view"],
  ["/app/rent", "money.view"],
  ["/app/vendors/1099", "money.view"],
  ["/app/vendors/invoices", "money.view"],
  ["/app/vendors", "vendor.manage"],
  ["/app/leases", "leasing.work"],
  ["/app/listings", "leasing.work"],
  ["/app/applications", "leasing.work"],
  ["/app/inbox", "queue.view"],
  /* The outbox: every message to every tenant and owner, with its body, and
     the buttons that discard or re-send them. Same omission as /app/company —
     it had no entry, so the person in the van could read the company's
     correspondence and drop a rent notice out of the queue. */
  ["/app/messages", "queue.view"],
  ["/app/maintenance", "maintenance.work"],
  ["/app/turns", "maintenance.work"],
  ["/app/compliance", "property.view"],
  /* Signed in is enough to reach the section; which reports appear, and
     which may be opened, is decided per report.

     This application enforces authorisation once at this gate, and that is
     right almost everywhere. It cannot be right here: the capability depends
     on which report, so a single entry would have to be either the loosest of
     them — handing a leasing agent the balance sheet — or the strictest,
     hiding the rent roll from the person whose job it is. Same shape as the
     portal and the technician's view: the authority belongs to the record. */
  ["/app/reports", null],
  ["/app/portfolio", "property.view"],
  ["/app/setup", "settings.manage"],
  ["/app/staff", "staff.manage"],
  /* The sidebar has claimed these need `settings.manage` since they were
     built, and the gate had no entry for any of them — so the nav hid the
     links and the paths were open to anyone signed in. A technician typing
     /app/company could rename the company, change the emergency number, and
     change the public handle that every printed QR sticker points at.

     The comment above the nav says the routing gate is the enforcement and
     the nav only stops showing people doors that will not open. That was
     true of every other entry and not of these three. A test now holds the
     two tables against each other, because the drift is silent in exactly
     one direction: hiding a link nobody can open is invisible, and so is
     leaving open a path nobody is shown. */
  ["/app/company", "settings.manage"],
  ["/app/billing", "settings.manage"],
];

/* Write paths need more than read paths on the same prefix. Checked in
   addition to the table above, not instead of it. */
const WRITE_CAPABILITY = [
  ["/app/accounting", "money.write"],
  ["/app/banking", "money.write"],
  ["/app/rent", "money.write"],
  ["/app/owners", "money.write"],
  /* Settling a return posts a journal and pays somebody's deposit back. */
  ["/app/deposits", "money.write"],
  /* Connecting a payment account, changing who bears a fee, and putting a
     lease on cash-only are all decisions about money, not about settings. */
  ["/app/payments", "money.write"],
  /* Releasing a run posts journals and commits cheque numbers. */
  ["/app/payouts", "money.write"],
  ["/app/vendors/invoices", "money.write"],
  ["/app/portfolio", "property.edit"],
];

function longestMatch(table, path) {
  let best = null;
  for (const [prefix, capability] of table) {
    if (capability === null && (path === prefix || path.startsWith(prefix + "/"))) {
      // An explicit "signed in is enough", overriding a broader prefix above.
      if (!best || prefix.length > best[0].length) best = [prefix, null];
      continue;
    }
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

/* --- the second factor ----------------------------------------------------

   A session is created the moment a password checks out, but it is only half
   authenticated until a second factor is presented. Keeping it as one session
   rather than a separate "pending" object means there is one thing to expire,
   one cookie, and no window where a half-finished login is a row nobody owns.

   Two questions, deliberately separate. Whether this person *has* a second
   factor, and whether *this session* has presented it. */
export function hasSecondFactor(staff) {
  return Boolean(staff?.totp_confirmed_at);
}

export function sessionIsElevated(staff) {
  return Boolean(staff?.totp_at);
}

/* What the gate should do about it. Returns a path to send them to, or null
   when they may proceed.

   Enrolment comes before the challenge: a company that has just turned on
   mandatory 2FA has staff who do not have it yet, and bouncing them to a
   challenge they cannot answer would lock out everyone at once. */
export function secondFactorRedirect(staff, path) {
  if (!staff) return null;
  // The pages that exist to resolve this must not themselves require it.
  if (path.startsWith("/app/2fa") || path.startsWith("/app/account/2fa") || path === "/app/sign-out") {
    return null;
  }
  if (hasSecondFactor(staff)) {
    return sessionIsElevated(staff) ? null : "/app/2fa";
  }
  if (staff.require_2fa) return "/app/account/2fa?required=1";
  return null;
}

export async function markSessionElevated(sessionId) {
  await run("UPDATE session SET totp_at = ? WHERE id = ?", new Date().toISOString(), sessionId);
}

/* Every active staff row with this address, across companies.

   The same person may legitimately work for two management firms — staff is
   unique on (company_id, email), not on email — and sign-in used to take
   whichever row came back first. That is the same class of bug as the public
   pages taking the first company. */
export async function staffByEmail(email) {
  return await all(
    `SELECT s.*, c.name AS company_name, c.slug AS company_slug
       FROM staff s JOIN company c ON c.id = s.company_id
      WHERE lower(s.email) = lower(?) AND s.active = 1
      ORDER BY c.name`, String(email || ""));
}
