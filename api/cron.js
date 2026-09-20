/* The scheduler, as a cron target.

   A serverless function does not stay alive, so setInterval cannot drive the
   compliance clocks and the delinquency ladder. Vercel Cron calls this instead
   — see the schedule in vercel.json.

   Every job the tick runs is idempotent, so a missed run catches up on the
   next one and a double run changes nothing. */
import { tick } from "../server/lib/scheduler.js";
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
    const result = await tick("cron");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), ...result }));
  } catch (err) {
    console.error("[cron] tick failed", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
