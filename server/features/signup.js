/* F13  Signing up, and the first hour afterwards.

   Two decisions shape this file.

   **A company and its first administrator are created together, in one
   transaction.** A company with nobody who can sign in is an orphan row, and a
   staff member with no company cannot be scoped to anything — every query in
   this codebase is keyed on `company_id`. Half of this pair is not a usable
   state, so it is not a reachable one.

   **The company is real immediately, and unverified.** The alternative is to
   hold the signup in limbo until somebody clicks a link in an email, which
   loses real customers to spam folders and to people who signed up on a phone
   and read mail on a laptop. So they sign in and start working straight away.
   What is withheld is sending on their behalf: an unverified company cannot
   mail its owners and tenants, because that is the part where getting the
   address wrong makes us the ones sending mail to a stranger.

   The onboarding checklist is stored rather than derived because some of its
   steps are decisions rather than records — "we have tested delivery" is not
   visible in any table. Steps that *are* derivable are derived, so ticking a
   box can never disagree with the data. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id, token } from "../lib/ids.js";
import { stamp, humanStamp } from "../lib/dates.js";
import { hashPassword, startSession } from "../lib/auth.js";
import { sendHtml, redirect, BadRequest, isHttps } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { publicPage, notice } from "../views/layout.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { uniqueSlug, slugProblem } from "../lib/slug.js";
import { companyCount } from "../lib/tenancy.js";
import { queueMessage } from "../lib/outbox.js";
import { log } from "../lib/logger.js";

const MIN_PASSWORD = 12;
const VERIFY_VALID_HOURS = 72;

/* The checklist, in the order a real firm would do them. Each step says how to
   tell whether it is done: `derive` reads the database, `manual` is a fact
   only a person can assert. */
export const ONBOARDING_STEPS = [
  {
    key: "company", label: "Confirm your company details",
    hint: "Legal name, address and the number tenants should call.",
    href: "/app/company",
    derive: async (cid) => {
      const c = await get("SELECT legal_name, phone FROM company WHERE id = ?", cid);
      return Boolean(c?.legal_name && c?.phone);
    },
  },
  {
    key: "owner", label: "Add your first owner",
    hint: "A building has to belong to somebody.",
    href: "/app/owners/new",
    derive: async (cid) => Boolean(await get("SELECT id FROM owner WHERE company_id = ? LIMIT 1", cid)),
  },
  {
    key: "property", label: "Add your first building",
    hint: "Then its apartments, and the QR codes print themselves.",
    href: "/app/portfolio/new",
    derive: async (cid) => Boolean(await get("SELECT id FROM unit WHERE company_id = ? LIMIT 1", cid)),
  },
  {
    key: "verify", label: "Verify your email address",
    hint: "Until this is done we will not send mail on your behalf.",
    href: "/app/company",
    derive: async (cid) => Boolean((await get("SELECT verified_at FROM company WHERE id = ?", cid))?.verified_at),
  },
  {
    key: "delivery", label: "Send yourself a test message",
    hint: "So you find out delivery works before a tenant does.",
    href: "/app/setup",
    manual: true,
  },
  {
    key: "billing", label: "Start your subscription",
    hint: "Your trial runs until then; nothing is charged before you choose a plan.",
    href: "/app/billing",
    manual: true,
  },
];

export async function onboardingState(companyId) {
  const company = await get("SELECT onboarding FROM company WHERE id = ?", companyId);
  let manual = {};
  try { manual = JSON.parse(company?.onboarding || "{}"); } catch { manual = {}; }

  /* A seeded or migrated company is not asked to do onboarding it finished
     before this feature existed. */
  if (manual.seeded) return { complete: true, steps: [], done: 0, total: 0 };

  const steps = [];
  for (const step of ONBOARDING_STEPS) {
    const done = step.manual
      ? Boolean(manual[step.key])
      : await step.derive(companyId);
    steps.push({ ...step, done });
  }
  const done = steps.filter((s) => s.done).length;
  return { complete: done === steps.length, steps, done, total: steps.length };
}

export async function markOnboardingStep(companyId, key, value = true) {
  const company = await one("SELECT onboarding FROM company WHERE id = ?", companyId);
  let state = {};
  try { state = JSON.parse(company.onboarding || "{}"); } catch { state = {}; }
  state[key] = value;
  await update("company", companyId, { onboarding: JSON.stringify(state) });
}

export function registerSignup(router) {
  router.get("/signup", async (ctx) => {
    if (ctx.staff) return redirect(ctx.res, "/app");
    sendHtml(ctx.res, signupPage({ csrf: ctx.csrf, error: ctx.query.e, values: ctx.query }));
  });

  router.post("/signup", async (ctx) => {
    /* An open signup form creates rows in somebody else's database. Tighter
       than sign-in because a legitimate person does this once. */
    const gate = await check("signup", clientIp(ctx.req));
    if (!gate.allowed) {
      return sendHtml(ctx.res, "Too many signups from this connection. Try again later.", 429);
    }

    const f = ctx.fields;
    const companyName = String(f.company_name || "").trim();
    const name = String(f.name || "").trim();
    const email = String(f.email || "").trim().toLowerCase();
    const password = String(f.password || "");

    const back = (message) => {
      const q = new URLSearchParams({
        e: message, company_name: companyName, name, email,
      });
      return redirect(ctx.res, `/signup?${q}`);
    };

    if (companyName.length < 2) return back("What is your company called?");
    if (name.length < 2) return back("What is your name?");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back("That email address does not look right.");
    if (password.length < MIN_PASSWORD) {
      return back(`Use at least ${MIN_PASSWORD} characters. Length is what makes a password hard to guess.`);
    }

    /* Addresses are unique per company, not globally — the same person may
       legitimately be staff at two management firms. What is refused is the
       same address twice inside one company, and that cannot happen here
       because the company is new. */

    const companyId = id();
    const staffId = id();
    const verifyToken = token();

    try {
      await tx(async () => {
        await insert("company", {
          id: companyId, name: companyName,
          slug: await uniqueSlug(companyName),
          phone: String(f.phone || "").trim() || null,
          emergency_phone: String(f.phone || "").trim() || null,
          timezone: String(f.timezone || "America/New_York"),
          onboarding: "{}", created_at: stamp(),
        });

        await insert("staff", {
          id: staffId, company_id: companyId, name, email,
          password_hash: hashPassword(password),
          role: "admin", active: 1, created_at: stamp(),
        });

        await insert("email_verification", {
          id: id(), company_id: companyId, staff_id: staffId, email,
          token: verifyToken,
          expires_at: new Date(Date.now() + VERIFY_VALID_HOURS * 3600_000).toISOString(),
          created_at: stamp(),
        });
      });
    } catch (err) {
      log.error("signup failed", { err });
      return back("We could not create the account. Try again, and tell us if it keeps happening.");
    }

    /* Queued, not sent inside the request. A slow provider must not make
       signup look broken, and the address is unverified by definition — this
       is the message that verifies it. */
    const base = `${ctx.url.protocol}//${ctx.url.host}`;
    await queueMessage({
      companyId, channel: "email", to: email,
      subject: "Confirm your email address",
      body: `${name},\n\nConfirm this address to finish setting up ${companyName}:\n\n`
        + `${base}/verify/${verifyToken}\n\n`
        + `The link works for ${VERIFY_VALID_HOURS} hours. Until it is used we will not send `
        + `email to your owners or tenants on your behalf.\n`,
      kind: "transactional",
      aboutType: "email_verification", aboutId: staffId,
      /* Bypasses the unverified-company block, because this is the message
         that lifts it. Without the exception a new company could never
         verify — the classic deadlock. */
      allowUnverified: true,
    });

    await startSession(ctx.res, staffId, { secure: isHttps(ctx.req) });
    redirect(ctx.res, "/app?m=" + encodeURIComponent(
      `Welcome. We have sent a confirmation link to ${email}.`));
  });

  /* Verification. A GET, because it is a link in an email and email clients
     cannot POST. That makes it safe to prefetch, which is why the token is
     single-use and says so rather than erroring on the second visit. */
  router.get("/verify/:tok", async (ctx) => {
    const row = await get(
      "SELECT * FROM email_verification WHERE token = ?", ctx.params.tok);

    if (!row) {
      return sendHtml(ctx.res, verifyResultPage({
        ok: false,
        title: "That link is not one of ours",
        detail: "Check you copied the whole thing, or ask for a new one from Setup.",
      }), 404);
    }
    if (row.used_at) {
      /* Not an error. A mail client prefetching the link, or the person
         clicking twice, should be told the good news again. */
      return sendHtml(ctx.res, verifyResultPage({
        ok: true,
        title: "Already confirmed",
        detail: `This address was confirmed ${humanStamp(row.used_at)}.`,
      }));
    }
    if (row.expires_at < stamp()) {
      return sendHtml(ctx.res, verifyResultPage({
        ok: false,
        title: "That link has expired",
        detail: `Confirmation links last ${VERIFY_VALID_HOURS} hours. Ask for a new one from Setup.`,
      }), 410);
    }

    await tx(async () => {
      await run("UPDATE email_verification SET used_at = ? WHERE id = ?", stamp(), row.id);
      await run(
        "UPDATE company SET verified_at = COALESCE(verified_at, ?) WHERE id = ?",
        stamp(), row.company_id);
    });

    const company = await get("SELECT name FROM company WHERE id = ?", row.company_id);
    sendHtml(ctx.res, verifyResultPage({
      ok: true,
      title: "Email confirmed",
      detail: `${company?.name || "Your company"} can now send email to owners and tenants.`,
      cta: "/app",
    }));
  });

  /* Ask for another one. Rate limited on the same bucket as signup, because
     it sends mail to an address somebody typed. */
  router.post("/app/verify/resend", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    if (company.verified_at) {
      return redirect(ctx.res, "/app/setup?m=" + encodeURIComponent("That address is already confirmed."));
    }

    const gate = await check("signup", `${clientIp(ctx.req)}|resend`);
    if (!gate.allowed) {
      return redirect(ctx.res, "/app/setup?m=" + encodeURIComponent("Too many requests. Try again shortly."));
    }

    const fresh = token();
    await insert("email_verification", {
      id: id(), company_id: cid, staff_id: ctx.staff.id, email: ctx.staff.email,
      token: fresh,
      expires_at: new Date(Date.now() + VERIFY_VALID_HOURS * 3600_000).toISOString(),
      created_at: stamp(),
    });

    const base = `${ctx.url.protocol}//${ctx.url.host}`;
    await queueMessage({
      companyId: cid, channel: "email", to: ctx.staff.email,
      subject: "Confirm your email address",
      body: `Confirm this address for ${company.name}:\n\n${base}/verify/${fresh}\n`,
      kind: "transactional", aboutType: "email_verification", aboutId: ctx.staff.id,
      allowUnverified: true,
    });

    redirect(ctx.res, "/app/setup?m=" + encodeURIComponent(`Sent to ${ctx.staff.email}.`));
  });

  /* Ticking a step that only a person can assert. */
  router.post("/app/onboarding/:key", async (ctx) => {
    const step = ONBOARDING_STEPS.find((s) => s.key === ctx.params.key && s.manual);
    if (!step) throw new BadRequest("That is not a step you can tick by hand.");
    await markOnboardingStep(ctx.staff.company_id, step.key, true);
    redirect(ctx.res, "/app");
  });
}

/* --- views ---------------------------------------------------------------- */

function signupPage({ csrf, error, values = {} }) {
  return publicPage({
    company: null,
    title: "Create your account",
    heading: "Set up your company",
    lede: "Two minutes. You can add buildings and staff afterwards.",
    body: html`
      ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
      <div class="panel">
        <div class="panel__body">
          <form method="post" action="/signup" class="formgrid">
            <input type="hidden" name="_csrf" value="${csrf}" />

            <div class="field">
              <label for="company_name">Company name</label>
              <input id="company_name" name="company_name" type="text" required maxlength="120"
                     value="${values.company_name || ""}" autocomplete="organization" />
              <span class="field__help">What your tenants and owners call you.</span>
            </div>

            <div class="formgrid formgrid--2">
              <div class="field">
                <label for="name">Your name</label>
                <input id="name" name="name" type="text" required maxlength="120"
                       value="${values.name || ""}" autocomplete="name" />
              </div>
              <div class="field">
                <label for="phone">Phone</label>
                <input id="phone" name="phone" type="tel" value="${values.phone || ""}" autocomplete="tel" />
                <span class="field__help">The number tenants ring in an emergency.</span>
              </div>
            </div>

            <div class="field">
              <label for="email">Your email</label>
              <input id="email" name="email" type="email" required maxlength="160"
                     value="${values.email || ""}" autocomplete="email" />
            </div>

            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required
                     minlength="${MIN_PASSWORD}" autocomplete="new-password" />
              <span class="field__help">
                At least ${MIN_PASSWORD} characters. Length beats punctuation — a phrase you will
                remember is stronger than a short word with symbols in it.
              </span>
            </div>

            <button class="pill solid" type="submit">Create account</button>
          </form>
        </div>
        <div class="panel__foot">
          Already have an account? <a href="/app/sign-in">Sign in</a>.
        </div>
      </div>`,
  });
}

function verifyResultPage({ ok, title, detail, cta }) {
  return publicPage({
    company: null,
    title,
    heading: title,
    body: html`
      ${notice(ok ? "ok" : "warn", null, detail)}
      ${cta ? html`<p style="margin-top:1.5rem"><a class="pill solid" href="${cta}">Go to your dashboard</a></p>` : ""}`,
  });
}
