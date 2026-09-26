/* Rate limiting.

   Counts attempts in a rolling window, in the database rather than in memory,
   because a serverless process does not survive between requests and an
   in-memory counter would enforce nothing.

   Deliberately fail-open: if the limiter itself errors, the request proceeds.
   A database hiccup should not lock everyone out of their own sign-in page,
   and the failure is logged rather than swallowed. */
import { all, run, get } from "./db.js";
import { id } from "./ids.js";

export const LIMITS = {
  // Sign-in is the one that matters: without this a password is brute-forceable.
  signin: { max: 8, windowMinutes: 15 },
  // Public forms: generous enough for a real block of flats, tight enough
  // that nobody scripts thousands of work orders.
  report: { max: 12, windowMinutes: 60 },
  apply: { max: 8, windowMinutes: 60 },
  /* An open signup form creates rows in somebody else's database, and a
     legitimate person does this once. */
  signup: { max: 5, windowMinutes: 60 },
  /* A signed-in person asking for their own confirmation again. The public
     signup cap is wrong here: a failed send used to burn one of five tries
     and then lock the button for an hour. */
  confirm: { max: 20, windowMinutes: 60 },
  /* The pay link is public and every post creates a Stripe session. Generous
     enough for somebody who mistypes an amount twice and comes back, tight
     enough that the link cannot be used to run up API calls. */
  pay: { max: 10, windowMinutes: 30 },
  /* Enquiries from a public listing page. The first page this application
     serves to strangers at scale — everything public before it was behind a
     token somebody was given, and a listing is meant to be found. Generous
     enough for a family enquiring about four flats on the same road, tight
     enough that the form is not a way to post into somebody's inbox all
     afternoon. */
  enquiry: { max: 10, windowMinutes: 60 },
  /* Portal sign-in attempts, counted per network before any lookup happens.
     The inner limit in magiclink.js counts links actually issued; this one
     counts tries, so a script pointed at a thousand addresses is stopped
     before the difference in work done could leak which of them exist. */
  portal: { max: 30, windowMinutes: 60 },
};

/* Best-effort client address. Vercel and most proxies set x-forwarded-for;
   the first entry is the client, the rest are proxies. */
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/* Returns { allowed, remaining, retryAfterMinutes }. Records the attempt when
   it is allowed, so a caller that is already over the limit does not extend
   its own lockout by hammering. */
export async function check(bucket, subject) {
  const limit = LIMITS[bucket];
  if (!limit) return { allowed: true, remaining: Infinity };

  const since = new Date(Date.now() - limit.windowMinutes * 60_000).toISOString();
  try {
    const row = await get(
      "SELECT COUNT(*) n FROM rate_hit WHERE bucket = ? AND subject = ? AND at > ?",
      bucket, subject, since
    );
    const used = Number(row?.n || 0);
    if (used >= limit.max) {
      return { allowed: false, remaining: 0, retryAfterMinutes: limit.windowMinutes };
    }
    await run(
      "INSERT INTO rate_hit (id, bucket, subject, at) VALUES (?, ?, ?, ?)",
      id(), bucket, subject, new Date().toISOString()
    );
    return { allowed: true, remaining: limit.max - used - 1 };
  } catch (err) {
    console.error("[ratelimit] check failed, allowing request", err.message);
    return { allowed: true, remaining: Infinity };
  }
}

/* Called after a successful sign-in so a legitimate user who fumbled their
   password a few times does not stay throttled. */
export async function clear(bucket, subject) {
  try {
    await run("DELETE FROM rate_hit WHERE bucket = ? AND subject = ?", bucket, subject);
  } catch { /* housekeeping only */ }
}

/* Old rows are noise; the scheduler drops them. */
export async function prune() {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const r = await run("DELETE FROM rate_hit WHERE at < ?", cutoff);
  return r.changes;
}
