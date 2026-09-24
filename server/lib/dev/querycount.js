/* Counting the queries one request issues.

   ## Why queries and not milliseconds

   A load test that reports wall time reports the machine it ran on. Mine
   against local Postgres is not Vercel against Supabase's transaction pooler,
   and a number that cannot be compared is a number nobody acts on.

   The count is different. A page that issues four hundred queries is broken
   on any machine, and an N+1 is an N+1 whether the database is in the next
   process or the next state. So the load test asserts a **budget per screen**
   — a number that cannot grow quietly — and reports the timings beside it as
   context rather than as the test.

   ## Off unless asked

   `enable()` is called by a test and by nothing else. While it is off,
   `withCounting` returns the function's own result and `record` does nothing,
   so the cost in production is one branch per query. */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();
let on = false;

export function enable() { on = true; }
export function disable() { on = false; }
export const enabled = () => on;

/* The last context that finished, so a caller outside the request can read
   what it cost. A load test runs in the same process as the server it is
   measuring and cannot see into the request's own context; this is how it
   gets the number without a response header nobody else needs. */
let last = null;
export const lastCounted = () => last;

/* Runs `fn` with a fresh log. Returns whatever it returns; the log is read
   through `counted()` from inside, or through `lastCounted()` after. */
export function withCounting(fn, { label = null } = {}) {
  if (!on) return fn();
  const log = { queries: [], label };
  const done = () => { last = log; };
  try {
    const value = store.run(log, fn);
    if (value && typeof value.then === "function") {
      return value.then(
        (v) => { done(); return v; },
        (e) => { done(); throw e; });
    }
    done();
    return value;
  } catch (err) {
    done();
    throw err;
  }
}

/* A log the caller owns, for measuring something that is not a request. */
export async function measure(fn) {
  if (!on) enable();
  const log = { queries: [] };
  const value = await store.run(log, fn);
  return { value, queries: log.queries };
}

export function record(sql, ms) {
  if (!on) return;
  const log = store.getStore();
  if (!log) return;
  /* The shape rather than the text: a thousand `SELECT ... WHERE id = $1`
     with different ids are one problem, not a thousand. */
  log.queries.push({ sql: shape(sql), ms });
}

export function counted() {
  return on ? store.getStore()?.queries || null : null;
}

/* Collapses a statement to what is worth grouping on: no literals, no
   whitespace runs, and short enough to read in a failure message. */
export function shape(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .replace(/'[^']*'/g, "'?'")
    .replace(/\$\d+/g, "$?")
    .trim()
    .slice(0, 160);
}

/* The same query issued many times in one request, which is the shape of an
   N+1 and the only thing this module exists to find. */
export function repeats(queries, { atLeast = 5 } = {}) {
  const counts = new Map();
  for (const q of queries) counts.set(q.sql, (counts.get(q.sql) || 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= atLeast)
    .sort((a, b) => b[1] - a[1])
    .map(([sql, n]) => ({ sql, n }));
}
