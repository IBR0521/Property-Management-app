/* How long every screen takes at size.

   The walk measures reach on a small fixture, where everything is fast
   because there is nothing to render. This signs in to the load portfolio —
   2,000 units, five years, 230,000 journals — and times the pages a person
   opens on an ordinary day.

   Wall time on this machine against local Postgres is not Vercel against
   Supabase's pooler, and the load test is right that a query budget travels
   better than a clock. This is the clock anyway, because "how fast does it
   feel" is a fair question and a query count does not answer it.

       createdb propops_walk_test
       sed 's/propops_test/propops_walk_test/' .env.test > .env.walk
       node --env-file=.env.walk scripts/loadseed.js
       node --env-file=.env.walk scripts/pagespeed.js
*/
import { performance } from "node:perf_hooks";

const PAGES = [
  "/app", "/app/portfolio", "/app/owners", "/app/inbox", "/app/accounting",
  "/app/accounting/journals", "/app/accounting/trust", "/app/rent", "/app/payments",
  "/app/payouts", "/app/deposits", "/app/vendors", "/app/listings", "/app/leases",
  "/app/reports", "/app/messages", "/app/staff", "/app/company", "/app/setup",
  "/app/reports/trial_balance", "/app/reports/balance_sheet",
  "/app/reports/profit_and_loss", "/app/reports/aged_receivables",
  "/app/reports/rent_roll", "/app/reports/trust_reconciliation",
  "/app/reports/deposits_held", "/app/reports/vacancy", "/app/reports/owner_list",
];

const RUNS = Number(process.env.RUNS || 3);

const { startApp, client } = await import("../test/helpers/http.js");
const { all, get } = await import("../server/lib/db.js");

const app = await startApp();
const staff = await get(
  "SELECT email FROM staff WHERE active = 1 ORDER BY created_at LIMIT 1");
if (!staff) { console.error("No staff. Seed the database first."); process.exit(1); }

const agent = client(app.origin);
const res = await agent.signIn(staff.email, process.env.WALK_PASSWORD || "load-test-password");
if (!res.signedIn) { console.error(`Could not sign in as ${staff.email}`); process.exit(1); }

const counts = await get(`SELECT
  (SELECT COUNT(*) FROM unit)::int AS units,
  (SELECT COUNT(*) FROM journal)::int AS journals,
  (SELECT COUNT(*) FROM journal_split)::int AS splits`);
console.log(`\n${counts.units} units, ${counts.journals} journals, ${counts.splits} splits`);
console.log(`median of ${RUNS} runs, signed in as ${staff.email}\n`);

const rows = [];
for (const path of PAGES) {
  const times = [];
  let status = 0, bytes = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    const out = await agent.text(path);
    times.push(performance.now() - t0);
    status = out.res.status;
    bytes = (out.body || "").length;
  }
  times.sort((a, b) => a - b);
  rows.push({ path, status, ms: Math.round(times[Math.floor(times.length / 2)]), bytes });
}

rows.sort((a, b) => b.ms - a.ms);
console.log("    ms  status   size  page");
for (const r of rows) {
  const flag = r.ms > 1000 ? "  <-- over a second" : "";
  console.log(`${String(r.ms).padStart(6)}  ${String(r.status).padStart(6)}  ${
    String(Math.round(r.bytes / 1024) + "K").padStart(5)}  ${r.path}${flag}`);
}
const over = rows.filter((r) => r.ms > 1000);
console.log(`\n${rows.length} pages, slowest ${rows[0].ms}ms, ${over.length} over one second`);
await app.close();
process.exit(0);
