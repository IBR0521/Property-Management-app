/* When to try again, and when to stop.

   Five attempts over about twelve hours, then the message is dead and a person
   has to look at it.

     attempt 1 fails -> wait 1 minute
     attempt 2 fails -> wait 5 minutes
     attempt 3 fails -> wait 25 minutes
     attempt 4 fails -> wait 2 hours
     attempt 5 fails -> dead

   The shape matters more than the numbers. The first retry is fast because
   most failures are a provider blipping for a few seconds. The later ones are
   slow because if it is still failing after half an hour it is not a blip, and
   hammering a provider that is rate-limiting you is how a temporary problem
   becomes a suspended account.

   There is a terminus on purpose. A queue that retries forever looks healthy
   while quietly containing a message that will never send, and the one thing
   worse than a failed notice is a failed notice nobody noticed. */

export const MAX_ATTEMPTS = 5;

const BACKOFF_MINUTES = [1, 5, 25, 120];

/* `attemptsSoFar` is the count including the one that just failed. Returns null
   when there is no next attempt, which the caller reads as dead. */
export function nextAttemptAt(attemptsSoFar, now = new Date()) {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null;
  const minutes = BACKOFF_MINUTES[Math.min(attemptsSoFar - 1, BACKOFF_MINUTES.length - 1)];
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export function isDead(attemptsSoFar) {
  return attemptsSoFar >= MAX_ATTEMPTS;
}

/* A permanent rejection skips the schedule entirely. Retrying "that is not a
   mobile number" four more times produces four more identical errors and
   buries the ones worth reading. */
export function outcomeFor({ ok, retryable }, attemptsSoFar, now = new Date()) {
  if (ok) return { status: "sent", nextAttemptAt: null };
  if (!retryable) return { status: "dead", nextAttemptAt: null, permanent: true };
  const next = nextAttemptAt(attemptsSoFar, now);
  return next
    ? { status: "queued", nextAttemptAt: next }
    : { status: "dead", nextAttemptAt: null, exhausted: true };
}
