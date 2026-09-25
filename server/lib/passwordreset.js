/* Getting back in after forgetting a password.

   ## The answer is the same either way

   `request()` returns the same thing whether or not the address belongs to
   anybody. A form that said "no account with that email" would be a way of
   asking which addresses are staff at a company — and the people most likely
   to ask are not the ones who forgot a password.

   So the screen says "if that address belongs to an account, a link is on its
   way" and means it literally: nothing is sent when it does not.

   ## The token is never stored

   Only its hash. A reset table that leaked would otherwise be a list of live
   keys to accounts. The link carries the secret; the row can only recognise
   it.

   ## Single use, one hour

   Long enough to read an email, short enough that a link left sitting in an
   inbox is not a standing key. Completing a reset marks the row used and
   signs every other session out, because a person resetting a password is
   quite often a person who thinks somebody else has been in. */
import { all, get, one, insert, run } from "./db.js";
import { id, token } from "./ids.js";
import { stamp, today } from "./dates.js";
import { sha256 } from "./crypto.js";
import { hashPassword } from "./auth.js";
import { log } from "./logger.js";

const LIFETIME_MS = 60 * 60 * 1000;

export class ResetRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ResetRefused";
  }
}

const normalise = (email) => String(email || "").trim().toLowerCase();

/* Always the same answer. `link` is present only when there was somebody to
   send it to, and only the caller that queues the email ever sees it. */
export async function request({ email, ip = null, baseUrl = null }) {
  const address = normalise(email);
  const answer = { ok: true, sent: false, link: null, staff: null };
  if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return answer;

  const staff = await get(
    `SELECT s.*, c.name AS company_name FROM staff s
       JOIN company c ON c.id = s.company_id
      WHERE lower(s.email) = ? AND s.active = 1`, address);
  if (!staff) {
    /* Logged, not answered. A burst of these is worth seeing. */
    log.info("password reset asked for an address with no account", { ip });
    return answer;
  }

  /* Any earlier link stops working. Two live links to one account is one more
     than anybody needs. */
  await run("UPDATE password_reset SET used_at = ? WHERE staff_id = ? AND used_at IS NULL",
    stamp(), staff.id);

  const secret = token();
  await insert("password_reset", {
    id: id(), staff_id: staff.id, token_hash: sha256(secret),
    expires_at: new Date(Date.now() + LIFETIME_MS).toISOString(),
    requested_ip: ip, created_at: stamp(),
  });

  return {
    ok: true, sent: true, staff,
    link: `${baseUrl || ""}/app/reset/${secret}`,
  };
}

/* Whether a link is still good, without spending it. */
export async function check(secret) {
  if (!secret) return { ok: false, why: "That link is not one of ours." };
  const row = await get(
    "SELECT * FROM password_reset WHERE token_hash = ?", sha256(String(secret)));
  if (!row) return { ok: false, why: "That link is not one of ours." };
  if (row.used_at) {
    return { ok: false, why: "That link has already been used. Ask for a new one." };
  }
  if (row.expires_at <= stamp()) {
    return { ok: false, why: "That link has expired. Ask for a new one." };
  }
  const staff = await get("SELECT * FROM staff WHERE id = ? AND active = 1", row.staff_id);
  if (!staff) return { ok: false, why: "That account is no longer active." };
  return { ok: true, row, staff };
}

export async function complete({ secret, password, confirm }) {
  const found = await check(secret);
  if (!found.ok) throw new ResetRefused(found.why);

  const next = String(password || "");
  if (next.length < 12) {
    throw new ResetRefused("Use at least twelve characters. Length is what makes a password hard to guess.");
  }
  if (next !== String(confirm || "")) {
    throw new ResetRefused("The two passwords do not match.");
  }

  await run("UPDATE staff SET password_hash = ? WHERE id = ?",
    hashPassword(next), found.staff.id);
  await run("UPDATE password_reset SET used_at = ? WHERE id = ?", stamp(), found.row.id);

  /* Every other session, gone. Somebody resetting a password is often
     somebody who believes another person has been in their account, and
     leaving those sessions alive would defeat the whole exercise. */
  await run("DELETE FROM session WHERE staff_id = ?", found.staff.id);

  log.info("password reset completed", { staffId: found.staff.id });
  return { ok: true, staff: found.staff };
}
