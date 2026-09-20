/* Staff sign-in. */
import { get } from "../lib/db.js";
import { verifyPassword, startSession, endSession } from "../lib/auth.js";
import { sendHtml, redirect } from "../lib/http.js";
import { signInPage } from "../views/layout.js";

export function registerAuthRoutes(router) {
  router.get("/app/sign-in", (ctx) => {
    if (ctx.staff) return redirect(ctx.res, "/app");
    const company = get("SELECT name FROM company LIMIT 1");
    sendHtml(ctx.res, signInPage({
      company,
      csrf: ctx.csrf,
      next: typeof ctx.query.next === "string" && ctx.query.next.startsWith("/app") ? ctx.query.next : null,
      error: ctx.query.e ? decodeURIComponent(ctx.query.e) : null,
    }));
  });

  router.post("/app/sign-in", (ctx) => {
    const email = String(ctx.fields.email || "").trim().toLowerCase();
    const password = String(ctx.fields.password || "");
    const staff = get(
      "SELECT * FROM staff WHERE lower(email) = ? AND active = 1", email
    );

    // One message for both cases: a different error for "no such user" tells
    // an attacker which addresses exist.
    if (!staff || !verifyPassword(password, staff.password_hash)) {
      return redirect(ctx.res, `/app/sign-in?e=${encodeURIComponent("That email and password do not match.")}`);
    }

    startSession(ctx.res, staff.id, { secure: ctx.url.protocol === "https:" });
    const next = typeof ctx.fields.next === "string" && ctx.fields.next.startsWith("/app") ? ctx.fields.next : "/app";
    redirect(ctx.res, next);
  });

  router.post("/app/sign-out", (ctx) => {
    endSession(ctx.req, ctx.res);
    redirect(ctx.res, "/app/sign-in");
  });
}
