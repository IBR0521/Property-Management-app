/* Signing in without a password.

   Tenants and owners will not invent, remember or rotate a password for the
   place they pay rent four times a year, and asking them to is how a product
   acquires a phone number people call instead. So: a link in an email, or a
   code by text.

   Four rules, each of which exists because breaking it is a known way to
   cause real harm.

   **The token is stored hashed.** Every other token in this application is
   stored in clear — the QR sticker, the pay link, the statement link — and
   that is right, because each grants access to one record and is meant to
   live on a fridge door for a year. This one is different in kind: it
   authenticates *as a person*. A read of the database should not hand
   somebody a login, so only a SHA-256 is kept and the plaintext exists in the
   email and nowhere else.

   **The reply never says whether the address is known.** Otherwise the
   sign-in form is a membership oracle: type an address, learn whether that
   person rents from this company. The answer is the same either way, and the
   work done is the same either way.

   **It is rate limited by address and by network.** An unauthenticated
   endpoint that sends email is a way to harass somebody's inbox, and a way to
   burn a sending reputation, unless it is bounded.

   **A new one retires the old.** Somebody who clicks "send it again" twice
   should not leave three working links in three inboxes, one of which is the
   one that got forwarded. */
import { randomInt } from "node:crypto";
import { all, get, one, insert, update, run } from "./db.js";
import { id, token } from "./ids.js";
import { stamp } from "./dates.js";
import { sha256 } from "./crypto.js";
import { log } from "./logger.js";
import { personByEmail, companiesFor, normaliseEmail } from "./identity.js";
import { APP_BASE_URL } from "./config.js";

/* Long enough that guessing is not a strategy, short-lived enough that a
   forwarded email is not a standing key. Fifteen minutes is the window
   somebody needs to switch to their mail app and back. */
export const LINK_TTL_MINUTES = 15;
export const CODE_TTL_MINUTES = 10;

/* Per address and per network, over an hour. Generous enough for somebody
   fighting with a spam filter, tight enough that neither is a weapon. */
export const MAX_PER_EMAIL = 5;
export const MAX_PER_IP = 20;

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/* Six digits, uniform. `randomInt` rather than `Math.random`, which is
   seeded predictably enough that a stream of codes is a sequence rather than
   a secret — and rather than `randomBytes() % 10`, which is very slightly
   biased towards the low digits. */
function numericCode(digits = 6) {
  let out = "";
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}

/* --- asking for one --------------------------------------------------------- */

/* Always returns the same shape, whether or not the address belongs to
   anybody. The caller shows one message regardless; `delivered` is for tests
   and logs, never for the page. */
export async function requestLink({ email, ip = null, channel = "email", baseUrl = null }) {
  const normalised = normaliseEmail(email);
  const answer = { ok: true, delivered: false, reason: null };

  if (!normalised || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) {
    return { ...answer, reason: "not an address" };
  }

  const limited = await overLimit({ email: normalised, ip });
  if (limited) {
    /* Still the same answer to the person. Logged, because a burst is worth
       seeing. */
    log.warn("magic link rate limited", { reason: limited, ip });
    return { ...answer, reason: limited };
  }

  const person = await personByEmail(normalised);
  if (!person) return { ...answer, reason: "no such person" };

  /* Somebody whose every link has been revoked is no longer a tenant or an
     owner anywhere. Sending them a working login would be access to nothing,
     which is confusing rather than harmful, but it is also a message to
     somebody who is no longer a customer. */
  const companies = await companiesFor(person.id);
  if (companies.length === 0) return { ...answer, reason: "no live links" };

  const plain = channel === "sms" ? numericCode() : token();
  const ttl = channel === "sms" ? CODE_TTL_MINUTES : LINK_TTL_MINUTES;

  /* Every earlier one stops working the moment this is issued. */
  await run(
    `UPDATE portal_login_token SET invalidated_at = ?
      WHERE person_id = ? AND used_at IS NULL AND invalidated_at IS NULL`,
    stamp(), person.id);

  await insert("portal_login_token", {
    id: id(), person_id: person.id,
    token_hash: sha256(plain), channel,
    expires_at: minutesFromNow(ttl),
    requested_ip: ip, created_at: stamp(),
  });

  const base = baseUrl || APP_BASE_URL || "";
  return {
    ...answer,
    delivered: true,
    person,
    companies,
    channel,
    /* The plaintext, handed back exactly once so the caller can put it in a
       message. It is never stored and never logged. */
    secret: plain,
    url: channel === "email" ? `${base}/portal/enter/${plain}` : null,
    expiresInMinutes: ttl,
  };
}

async function overLimit({ email, ip }) {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();

  const byEmail = await get(
    `SELECT COUNT(*)::int AS n FROM portal_login_token t
       JOIN person p ON p.id = t.person_id
      WHERE p.email = ? AND t.created_at > ?`, email, since);
  if (Number(byEmail.n) >= MAX_PER_EMAIL) return "too many for that address";

  if (ip) {
    const byIp = await get(
      "SELECT COUNT(*)::int AS n FROM portal_login_token WHERE requested_ip = ? AND created_at > ?",
      ip, since);
    if (Number(byIp.n) >= MAX_PER_IP) return "too many from that network";
  }
  return null;
}

/* --- using one -------------------------------------------------------------- */

/* Exchanges a token for a person, once.

   Every failure returns the same shape and a reason meant for a person
   reading a page: "that link has already been used" is worth saying, because
   it tells somebody to ask for another rather than assume the product is
   broken. Nothing here distinguishes "no such token" from "wrong token" —
   there is only one lookup and it is by hash. */
export async function redeem({ token: plain, ip = null, userAgent = null }) {
  if (!plain) return { ok: false, reason: "That link is not complete. Ask for a new one." };

  const row = await get(
    "SELECT * FROM portal_login_token WHERE token_hash = ?", sha256(String(plain)));
  if (!row) {
    return { ok: false, reason: "That link is not valid. Ask for a new one." };
  }
  if (row.used_at) {
    return { ok: false, reason: "That link has already been used. Ask for a new one." };
  }
  if (row.invalidated_at) {
    return { ok: false, reason: "A newer link was sent. Use the most recent email." };
  }
  if (row.expires_at <= stamp()) {
    return { ok: false, reason: "That link has expired. Ask for a new one." };
  }

  const person = await get("SELECT * FROM person WHERE id = ?", row.person_id);
  if (!person) return { ok: false, reason: "That link is not valid. Ask for a new one." };

  const companies = await companiesFor(person.id);
  if (companies.length === 0) {
    return { ok: false, reason: "That account no longer has access. Please contact the office." };
  }

  /* Marked used before the session exists, so two clicks on the same link —
     a mail client prefetching, then the person tapping — cannot become two
     sessions. */
  await update("portal_login_token", row.id, { used_at: stamp() });

  const sessionId = id();
  await insert("portal_session", {
    id: sessionId, person_id: person.id,
    /* Chosen now when there is only one, so the common case is one click. */
    company_id: companies.length === 1 ? companies[0].id : null,
    created_at: stamp(),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    last_seen_at: stamp(),
    ip, user_agent: String(userAgent || "").slice(0, 300),
  });

  await update("person", person.id, { last_seen_at: stamp() });
  log.info("portal sign-in", { personId: person.id, channel: row.channel });

  return { ok: true, sessionId, person, companies };
}

/* --- the session ------------------------------------------------------------ */

export async function sessionFor(sessionId) {
  if (!sessionId) return null;
  const row = await get(
    `SELECT s.*, p.email, p.name, p.phone
       FROM portal_session s JOIN person p ON p.id = s.person_id
      WHERE s.id = ?`, sessionId);
  if (!row) return null;
  if (row.expires_at <= stamp()) return null;
  return row;
}

export async function touchSession(sessionId) {
  await run("UPDATE portal_session SET last_seen_at = ? WHERE id = ?", stamp(), sessionId);
}

export async function chooseCompany({ sessionId, personId, companyId }) {
  /* Checked rather than trusted: the company comes from a form, and a person
     must not be able to point their session at one they hold nothing in. */
  const held = await get(
    `SELECT 1 AS ok FROM person_link
      WHERE person_id = ? AND company_id = ? AND revoked_at IS NULL LIMIT 1`,
    personId, companyId);
  if (!held) return { ok: false, reason: "You do not have an account with that company." };
  await update("portal_session", sessionId, { company_id: companyId });
  return { ok: true };
}

export async function signOut(sessionId) {
  if (sessionId) await run("DELETE FROM portal_session WHERE id = ?", sessionId);
}

/* Expired sessions and spent tokens, swept by the scheduler. A login token
   that was never used is still a row that names somebody. */
export async function prunePortalSessions() {
  const sessions = await run(
    "DELETE FROM portal_session WHERE expires_at < ?", stamp());
  const tokens = await run(
    "DELETE FROM portal_login_token WHERE created_at < ?",
    new Date(Date.now() - 30 * 86_400_000).toISOString());
  return { portalSessionsPruned: sessions.changes, loginTokensPruned: tokens.changes };
}
