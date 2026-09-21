/* Local development server.

   Vercel does not run this — it imports the handler from server/app.js via
   api/index.js. This exists so the app runs offline against a SQLite file with
   the scheduler on a timer, exactly as it did before the move to serverless. */
import { createServer } from "node:http";
import { handle } from "./app.js";
import { startScheduler } from "./lib/scheduler.js";
import { get } from "./lib/db.js";
import { PORT, DATABASE_URL, assertConfig } from "./lib/config.js";



assertConfig();

createServer(handle).listen(PORT, async () => {
  const company = await get("SELECT name FROM company LIMIT 1");
  console.log(`\n  Property operations`);
  console.log(`  ${company ? company.name : "no company yet — run: npm run seed"}`);
  console.log(`  http://localhost:${PORT}/app   (back office)`);
  console.log(`  http://localhost:${PORT}/      (marketing site)`);
  console.log(`  db: ${redactUrl(DATABASE_URL)}\n`);

  // In serverless this is a cron hitting /api/cron instead; see vercel.json.
  startScheduler().catch((err) => console.error("[scheduler] failed to start", err));
});

/* The boot banner printed the connection string verbatim, password and all,
   into the terminal and therefore into any scrollback, screen share or CI log
   that captured it. The host is the useful part; the credential never was. */
function redactUrl(url) {
  if (!url) return "not configured";
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "configured";
  }
}
