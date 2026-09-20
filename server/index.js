/* Local development server.

   Vercel does not run this — it imports the handler from server/app.js via
   api/index.js. This exists so the app runs offline against a SQLite file with
   the scheduler on a timer, exactly as it did before the move to serverless. */
import { createServer } from "node:http";
import { handle } from "./app.js";
import { startScheduler } from "./lib/scheduler.js";
import { get } from "./lib/db.js";

const PORT = Number(process.env.PORT || 4300);

createServer(handle).listen(PORT, async () => {
  const company = await get("SELECT name FROM company LIMIT 1");
  console.log(`\n  Property operations`);
  console.log(`  ${company ? company.name : "no company yet — run: npm run seed"}`);
  console.log(`  http://localhost:${PORT}/app   (back office)`);
  console.log(`  http://localhost:${PORT}/      (marketing site)`);
  console.log(`  db: ${process.env.DATABASE_URL || "file:data/app.db"}\n`);

  // In serverless this is a cron hitting /api/cron instead; see vercel.json.
  startScheduler().catch((err) => console.error("[scheduler] failed to start", err));
});
