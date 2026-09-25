/* F15  The second factor.

   Enrolment is two steps on purpose. A secret is generated and shown, and
   nothing is enforced until the person proves a code from it works. Enabling
   on the strength of "I scanned it" locks out everybody who scanned the wrong
   QR code, mistyped the manual key, or had their phone's clock wrong — and the
   person locked out is the administrator, which is exactly who cannot be
   helped by another administrator.

   Recovery codes exist for the same reason. Without them the failure mode of
   two-factor authentication is a changed phone and a support request nobody
   can satisfy. They are shown once, hashed at rest like passwords, and struck
   off as they are used. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, humanStamp } from "../lib/dates.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, raw, attr } from "../lib/render.js";
import { appPage, publicPage, notice } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { seal, tryOpen, sealingAvailable, sha256 } from "../lib/crypto.js";
import { hashPassword, verifyPassword, markSessionElevated, hasSecondFactor, landingFor } from "../lib/auth.js";
import { check, clear, clientIp } from "../lib/ratelimit.js";
import {
  generateSecret, verify as verifyTotp, provisioningUri,
  generateRecoveryCodes, normaliseRecoveryCode,
} from "../lib/totp.js";
import { qrSvg } from "../lib/qr.js";

export function registerTwoFactor(router) {
  /* --- the challenge, for a session that has a password but no second factor */

  router.get("/app/2fa", async (ctx) => {
    if (!hasSecondFactor(ctx.staff)) return redirect(ctx.res, landingFor(ctx.staff));
    if (ctx.staff.totp_at) return redirect(ctx.res, landingFor(ctx.staff));
    sendHtml(ctx.res, challengePage({
      csrf: ctx.csrf, error: ctx.query.e, next: ctx.query.next, staff: ctx.staff,
    }));
  });

  router.post("/app/2fa", async (ctx) => {
    if (!hasSecondFactor(ctx.staff)) return redirect(ctx.res, landingFor(ctx.staff));

    /* The same limiter as sign-in, keyed the same way. A six-digit code is a
       million possibilities and a window of three steps — without a limit that
       is guessable in an afternoon. */
    const key = `${clientIp(ctx.req)}|${ctx.staff.id}|2fa`;
    const gate = await check("signin", key);
    if (!gate.allowed) {
      return redirect(ctx.res, `/app/2fa?e=${encodeURIComponent(
        `Too many attempts. Wait ${gate.retryAfterMinutes} minutes.`)}`);
    }

    const next = safeNext(ctx.fields.next, ctx.staff);
    const submitted = String(ctx.fields.code || "");

    /* A recovery code, for the person whose phone is in a taxi somewhere. */
    if (submitted.replace(/[^A-Za-z0-9]/g, "").length === 10) {
      const used = await consumeRecoveryCode(ctx.staff.id, submitted);
      if (used) {
        await clear("signin", key);
        await markSessionElevated(ctx.staff.session_id);
        const left = await countRecoveryCodes(ctx.staff.id);
        return redirect(ctx.res, `${next}?m=${encodeURIComponent(
          `Recovery code used. ${left} left — generate new ones from your account page.`)}`);
      }
    }

    const secret = openSecret(ctx.staff);
    if (!secret) {
      /* The secret cannot be read — an encryption key was rotated or lost.
         Better to say so than to refuse a correct code forever. */
      return redirect(ctx.res, `/app/2fa?e=${encodeURIComponent(
        "We cannot read your authenticator settings. Use a recovery code, or ask an administrator.")}`);
    }

    const usedSteps = ctx.staff.totp_last_step != null ? [Number(ctx.staff.totp_last_step)] : [];
    const step = verifyTotp(secret, submitted, { usedSteps });

    if (step === null) {
      return redirect(ctx.res, `/app/2fa?e=${encodeURIComponent(
        "That code is not right, or has already been used.")}${next !== "/app" ? `&next=${encodeURIComponent(next)}` : ""}`);
    }

    await tx(async () => {
      /* Recorded against the person, not the session: the attack that matters
         is somebody replaying a code they watched into their own browser. */
      await run("UPDATE staff SET totp_last_step = ? WHERE id = ?", step, ctx.staff.id);
      await markSessionElevated(ctx.staff.session_id);
    });
    await clear("signin", key);
    redirect(ctx.res, next);
  });

  /* --- enrolment ---------------------------------------------------------- */

  router.get("/app/account/2fa", async (ctx) => {
    const cid = ctx.staff.company_id;
    const enrolled = hasSecondFactor(ctx.staff);
    const pending = !enrolled && ctx.staff.totp_secret_enc ? openSecret(ctx.staff) : null;
    const left = enrolled ? await countRecoveryCodes(ctx.staff.id) : 0;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "account", counts: await navCounts(cid),
      title: "Two-factor authentication",
      subtitle: enrolled ? "On" : ctx.query.required ? "Required by your company" : "Off",
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.required && !enrolled ? notice("warn", "Your company requires this",
          "Set it up to carry on. It takes a minute and needs an authenticator app on your phone.") : ""}
        ${sealingAvailable() ? "" : notice("danger", "Encryption is not configured",
          "An authenticator secret cannot be stored safely until encryption is set up. Two-factor authentication is unavailable until then.")}

        ${enrolled
          ? enrolledPanel({ csrf: ctx.csrf, staff: ctx.staff, left })
          : pending
          ? confirmPanel({ csrf: ctx.csrf, staff: ctx.staff, secret: pending, error: ctx.query.e })
          : startPanel({ csrf: ctx.csrf })}`,
    }));
  });

  /* Generates a secret and stores it unconfirmed. Nothing is enforced until a
     code from it is proved to work. */
  router.post("/app/account/2fa/start", async (ctx) => {
    if (!sealingAvailable()) {
      throw new BadRequest("Encryption is not configured, so a secret cannot be stored safely.");
    }
    if (hasSecondFactor(ctx.staff)) return redirect(ctx.res, "/app/account/2fa");

    await update("staff", ctx.staff.id, {
      totp_secret_enc: seal(generateSecret()),
      totp_confirmed_at: null,
    });
    redirect(ctx.res, "/app/account/2fa");
  });

  router.post("/app/account/2fa/confirm", async (ctx) => {
    if (hasSecondFactor(ctx.staff)) return redirect(ctx.res, "/app/account/2fa");
    const secret = openSecret(ctx.staff);
    if (!secret) throw new BadRequest("Start again — there is no pending secret to confirm.");

    const step = verifyTotp(secret, String(ctx.fields.code || ""));
    if (step === null) {
      return redirect(ctx.res, `/app/account/2fa?e=${encodeURIComponent(
        "That code is not right. Check your phone's clock is correct, and try the next one.")}`);
    }

    /* Recovery codes are generated here rather than at `start`, so a person
       who abandons enrolment halfway does not walk away believing they have
       working recovery codes for a factor that was never enabled. */
    const codes = generateRecoveryCodes(10);
    await tx(async () => {
      await update("staff", ctx.staff.id, {
        totp_confirmed_at: stamp(), totp_last_step: step,
      });
      await run("DELETE FROM staff_recovery_code WHERE staff_id = ?", ctx.staff.id);
      for (const code of codes) {
        await insert("staff_recovery_code", {
          id: id(), staff_id: ctx.staff.id,
          code_hash: hashRecovery(code), created_at: stamp(),
        });
      }
      await markSessionElevated(ctx.staff.session_id);
    });

    sendHtml(ctx.res, recoveryCodesPage({ codes, staff: ctx.staff }));
  });

  router.post("/app/account/2fa/regenerate", async (ctx) => {
    if (!hasSecondFactor(ctx.staff)) throw new BadRequest("Two-factor authentication is not on.");
    if (!verifyPassword(String(ctx.fields.password || ""), ctx.staff.password_hash)) {
      return redirect(ctx.res, `/app/account/2fa?m=${encodeURIComponent("That password is not right.")}`);
    }
    const codes = generateRecoveryCodes(10);
    await tx(async () => {
      await run("DELETE FROM staff_recovery_code WHERE staff_id = ?", ctx.staff.id);
      for (const code of codes) {
        await insert("staff_recovery_code", {
          id: id(), staff_id: ctx.staff.id,
          code_hash: hashRecovery(code), created_at: stamp(),
        });
      }
    });
    sendHtml(ctx.res, recoveryCodesPage({ codes, staff: ctx.staff, regenerated: true }));
  });

  router.post("/app/account/2fa/disable", async (ctx) => {
    /* The password again. Turning off the second factor from an already-open
       session is exactly what somebody who found an unlocked laptop would do. */
    if (!verifyPassword(String(ctx.fields.password || ""), ctx.staff.password_hash)) {
      return redirect(ctx.res, `/app/account/2fa?m=${encodeURIComponent("That password is not right.")}`);
    }
    const company = await one("SELECT require_2fa FROM company WHERE id = ?", ctx.staff.company_id);
    if (company.require_2fa) {
      return redirect(ctx.res, `/app/account/2fa?m=${encodeURIComponent(
        "Your company requires two-factor authentication, so it cannot be turned off.")}`);
    }

    await tx(async () => {
      await update("staff", ctx.staff.id, {
        totp_secret_enc: null, totp_confirmed_at: null, totp_last_step: null,
      });
      await run("DELETE FROM staff_recovery_code WHERE staff_id = ?", ctx.staff.id);
    });
    redirect(ctx.res, `/app/account/2fa?m=${encodeURIComponent("Two-factor authentication is off.")}`);
  });

  /* --- the company-wide requirement --------------------------------------- */

  router.post("/app/company/require-2fa", async (ctx) => {
    const cid = ctx.staff.company_id;
    const on = ctx.fields.require === "yes";

    if (on && !hasSecondFactor(ctx.staff)) {
      /* Requiring it while not having it yourself locks you out on the next
         request. Enrol first. */
      return redirect(ctx.res, `/app/account/2fa?required=1&m=${encodeURIComponent(
        "Set it up for yourself first — otherwise you are locked out the moment you turn it on.")}`);
    }

    await update("company", cid, { require_2fa: on ? 1 : 0 });
    redirect(ctx.res, `/app/company?m=${encodeURIComponent(on
      ? "Everyone will be asked to set up two-factor authentication next time they sign in."
      : "Two-factor authentication is now optional.")}`);
  });
}

/* --- helpers -------------------------------------------------------------- */

function openSecret(staff) {
  return staff.totp_secret_enc ? tryOpen(staff.totp_secret_enc) : null;
}

/* Hashed rather than stored. A recovery code is a password that bypasses the
   second factor, so it is treated like one. */
function hashRecovery(code) {
  return hashPassword(normaliseRecoveryCode(code));
}

async function consumeRecoveryCode(staffId, submitted) {
  const normalised = normaliseRecoveryCode(submitted);
  const rows = await all(
    "SELECT * FROM staff_recovery_code WHERE staff_id = ? AND used_at IS NULL", staffId);
  for (const row of rows) {
    if (verifyPassword(normalised, row.code_hash)) {
      await run("UPDATE staff_recovery_code SET used_at = ? WHERE id = ?", stamp(), row.id);
      return true;
    }
  }
  return false;
}

async function countRecoveryCodes(staffId) {
  const row = await get(
    "SELECT COUNT(*)::int AS n FROM staff_recovery_code WHERE staff_id = ? AND used_at IS NULL", staffId);
  return Number(row?.n || 0);
}

/* `staff` so the fallback is somewhere this person can actually open. "/app"
   is the company's queue and a technician has no capability for it, so the
   default used to answer a correct 2FA code with a 403. */
function safeNext(value, staff = null) {
  const v = String(value || "");
  if (v.startsWith("/app") && !v.startsWith("//")) return v;
  return staff ? landingFor(staff) : "/app";
}

/* --- views ---------------------------------------------------------------- */

function challengePage({ csrf, error, next, staff }) {
  return publicPage({
    company: { name: staff.company_name },
    title: "Two-factor authentication",
    heading: "One more step",
    lede: "Enter the six-digit code from your authenticator app.",
    body: html`
      ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
      <div class="panel">
        <div class="panel__body">
          <form method="post" action="/app/2fa" class="formgrid">
            <input type="hidden" name="_csrf" value="${csrf}" />
            ${next ? html`<input type="hidden" name="next" value="${next}" />` : ""}
            <div class="field">
              <label for="code">Code</label>
              <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                     required autofocus maxlength="14"
                     style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.125rem;letter-spacing:0.15em" />
              <span class="field__help">Or a recovery code, if your phone is not to hand.</span>
            </div>
            <button class="pill solid" type="submit">Continue</button>
          </form>
        </div>
        <div class="panel__foot">
          Signed in as ${staff.email}. <a href="/app/sign-out">Not you?</a>
        </div>
      </div>`,
  });
}

function startPanel({ csrf }) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Turn it on</h2></div>
      <div class="panel__body">
        <p class="lede" style="margin:0 0 1rem">
          A password can be guessed, reused or phished. A second factor means somebody
          who has your password still cannot sign in as you. You will need an
          authenticator app — Google Authenticator, 1Password, Authy and most password
          managers all work.
        </p>
        <form method="post" action="/app/account/2fa/start">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <button class="pill solid" type="submit">Set it up</button>
        </form>
      </div>
    </div>`;
}

function confirmPanel({ csrf, staff, secret, error }) {
  const uri = provisioningUri({
    secret, account: staff.email, issuer: staff.company_name || "Property operations",
  });
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>Scan this</h2></div>
      <div class="panel__body">
        <div class="grid grid--2" style="align-items:start">
          <div>${raw(qrSvg(uri, { size: 180, label: "Authenticator setup code" }))}</div>
          <div>
            <p class="lede" style="margin:0 0 0.75rem">
              Scan with your authenticator app, or type this key in by hand:
            </p>
            <span class="longval">${secret.replace(/(.{4})/g, "$1 ").trim()}</span>
            <p class="lede" style="margin:1rem 0 0">
              Then enter the six-digit code it shows, to prove it is working. Nothing
              changes until you do — if the code never matches, you have lost nothing.
            </p>
          </div>
        </div>

        <form method="post" action="/app/account/2fa/confirm" class="formgrid" style="margin-top:1.25rem">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field" style="max-width:14rem">
            <label for="code">Code from your app</label>
            <input id="code" name="code" type="text" inputmode="numeric" required maxlength="7"
                   autocomplete="one-time-code"
                   style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.125rem;letter-spacing:0.15em" />
          </div>
          <button class="pill solid" type="submit">Confirm and turn on</button>
        </form>
      </div>
    </div>`;
}

function enrolledPanel({ csrf, staff, left }) {
  return html`
    ${notice("ok", "Two-factor authentication is on",
      `Set up ${humanStamp(staff.totp_confirmed_at)}. You will be asked for a code each time you sign in.`)}

    ${left <= 3 ? notice("warn", `${left} recovery code${left === 1 ? "" : "s"} left`,
      "Generate a new set before you run out — without one, a lost phone means a locked account.") : ""}

    <div class="panel">
      <div class="panel__head"><h2>Recovery codes</h2><p>${left} unused</p></div>
      <div class="panel__body">
        <p class="lede" style="margin:0 0 0.875rem">
          Each one works once, in place of your phone. Generating a new set replaces
          every old one immediately.
        </p>
        <form method="post" action="/app/account/2fa/regenerate" class="filterbar" style="padding:0;border:0">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field" style="min-width:12rem">
            <label for="rp">Your password</label>
            <input id="rp" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button class="pill outline sm" type="submit">Generate new codes</button>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head"><h2>Turn it off</h2></div>
      <div class="panel__body">
        <form method="post" action="/app/account/2fa/disable" class="filterbar" style="padding:0;border:0">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field" style="min-width:12rem">
            <label for="dp">Your password</label>
            <input id="dp" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button class="pill outline sm" type="submit">Turn off</button>
        </form>
        <span class="field__help" style="display:block;margin-top:0.5rem">
          The password is asked for again because turning this off from an already-open
          session is the first thing somebody who found your laptop would do.
        </span>
      </div>
    </div>`;
}

function recoveryCodesPage({ codes, staff, regenerated = false }) {
  return publicPage({
    company: { name: staff.company_name },
    title: "Your recovery codes",
    heading: regenerated ? "New recovery codes" : "Two-factor authentication is on",
    lede: "Save these somewhere safe. They are shown once and cannot be shown again.",
    body: html`
      ${notice("warn", "This is the only time you will see these",
        "Each one works once, in place of your phone. Print them, or put them in a password manager.")}
      <div class="panel">
        <div class="panel__body">
          <div class="grid grid--2">
            ${codes.map((code) => html`<span class="longval" style="text-align:center">${code}</span>`)}
          </div>
        </div>
        <div class="panel__foot">
          ${regenerated ? "Your previous codes no longer work. " : ""}
          <a href="/app">Continue to the app</a>
        </div>
      </div>`,
  });
}
