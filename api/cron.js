/* The daily sweeps, as a cron target.

   A serverless function does not stay alive, so setInterval cannot drive the
   compliance clocks and the delinquency ladder. Vercel Cron calls this instead
   — see the schedule in vercel.json.

   Every job the tick runs is idempotent, so a missed run catches up on the
   next one and a double run changes nothing. */
import { tick } from "../server/lib/scheduler.js";
import { runLateFeeSweep } from "../server/lib/latefees.js";
import { ready } from "../server/lib/db.js";

export default async function handler(req, res) {
  /* Vercel signs its cron requests with CRON_SECRET. Without this check the
     endpoint is an open trigger for everyone's reminders. */
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end("unauthorized");
  }
  if (!secret && process.env.VERCEL) {
    res.statusCode = 500;
    return res.end("CRON_SECRET is not set — refusing to run an unprotected scheduler");
  }

  try {
    await ready();

    /* Two sweeps, and the second must not be lost if the first throws.

       The compliance and delinquency tick is best-effort housekeeping. The
       late-fee sweep charges people money. Running them in sequence inside one
       try block would mean a failure in the housekeeping silently skips the
       billing for a day — and a day of missed late fees is not something
       anybody notices until a tenant points it out. So each reports its own
       outcome and neither can suppress the other. */
    const result = { ok: true, at: new Date().toISOString() };

    try {
      result.scheduler = await tick("cron");
    } catch (err) {
      console.error("[cron] scheduler tick failed", err);
      result.ok = false;
      result.scheduler = { error: err.message };
    }

    try {
      result.lateFees = await runLateFeeSweep({ postedBy: "cron" });
    } catch (err) {
      console.error("[cron] late fee sweep failed", err);
      result.ok = false;
      result.lateFees = { error: err.message };
    }

    res.setHeader("Content-Type", "application/json");
    res.statusCode = result.ok ? 200 : 500;
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error("[cron] failed before any sweep ran", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
