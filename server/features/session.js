/* Staff sign-in. */
import { get } from "../lib/db.js";
import { verifyPassword, startSession, endSession } from "../lib/auth.js";
import { sendHtml, redirect } from "../lib/http.js";
import { check, clear, clientIp } from "../lib/ratelimit.js";
import { signInPage } from "../views/layout.js";

export function registerAuthRoutes(router) {
  router.get("/app/sign-in", async (ctx) => {
    if (ctx.staff) return redirect(ctx.res, "/app");
    /* Branding only. With several companies there is no way to know whose
       sign-in page this is until credentials arrive, so it shows the product
       rather than guessing a customer's name at them. */
    const { soleCompany } = await import("../lib/tenancy.js");
    const company = await soleCompany();
    sendHtml(ctx.res, signInPage({
      company,
      csrf: ctx.csrf,
      next: typeof ctx.query.next === "string" && ctx.query.next.startsWith("/app") ? ctx.query.next : null,
      error: ctx.query.e ? decodeURIComponent(ctx.query.e) : null,
    }));
  });

  router.post("/app/sign-in", async (ctx) => {
    const email = String(ctx.fields.email || "").trim().toLowerCase();
    const password = String(ctx.fields.password || "");

    /* Without this a password is simply brute-forceable. Keyed on address AND
       email so one noisy client cannot lock a colleague out, and so trying a
       thousand passwords against one account is what actually gets stopped. */
    const gate = await check("signin", `${clientIp(ctx.req)}|${email}`);
    if (!gate.allowed) {
      return redirect(ctx.res, `/app/sign-in?e=${encodeURIComponent(
        `Too many attempts. Wait ${gate.retryAfterMinutes} minutes and try again.`)}`);
    }
    const staff = await get(
      "SELECT * FROM staff WHERE lower(email) = ? AND active = 1", email
    );

    // One message for both cases: a different error for "no such user" tells
    // an attacker which addresses exist.
    if (!staff || !verifyPassword(password, staff.password_hash)) {
      return redirect(ctx.res, `/app/sign-in?e=${encodeURIComponent("That email and password do not match.")}`);
    }

    // A legitimate user who fumbled the password should not stay throttled.
    await clear("signin", `${clientIp(ctx.req)}|${email}`);
    await startSession(ctx.res, staff.id, { secure: ctx.url.protocol === "https:" });
    const next = typeof ctx.fields.next === "string" && ctx.fields.next.startsWith("/app") ? ctx.fields.next : "/app";
    redirect(ctx.res, next);
  });

  router.post("/app/sign-out", async (ctx) => {
    await endSession(ctx.req, ctx.res);
    redirect(ctx.res, "/app/sign-in");
  });
}
