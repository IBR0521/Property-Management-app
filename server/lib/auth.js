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

export function startSession(res, staffId, { secure = false } = {}) {
  const sid = id() + randomBytes(16).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  run(
    "INSERT INTO session (id, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    sid, staffId, now.toISOString(), expires.toISOString()
  );
  setCookie(res, SESSION_COOKIE, sid, { expires, secure });
  return sid;
}

export function endSession(req, res) {
  const sid = cookies(req)[SESSION_COOKIE];
  if (sid) run("DELETE FROM session WHERE id = ?", sid);
  clearCookie(res, SESSION_COOKIE);
}

export function currentStaff(req) {
  const sid = cookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = get(
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
export function pruneSessions() {
  const r = run("DELETE FROM session WHERE expires_at <= ?", new Date().toISOString());
  return r.changes;
}

/* --- tokenised access ----------------------------------------------------- */

/* Tenants, owners and applicants never get an account. They get a long random
   URL scoped to exactly one record, which is the only way these links are
   ever actually opened. Each lookup is scoped by token AND by the table, so a
   work-order token cannot be replayed against an owner statement. */
export function byToken(table, tokenColumn, tokenValue, extra = "") {
  if (!tokenValue || tokenValue.length < 20) return null;
  return get(`SELECT * FROM ${table} WHERE ${tokenColumn} = ? ${extra}`, tokenValue) || null;
}

export function staffList(companyId) {
  return all("SELECT id, name, email, role, active FROM staff WHERE company_id = ? ORDER BY name", companyId);
}
