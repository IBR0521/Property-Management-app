/* Getting into the portal, and choosing which company you are looking at.

   The tenant and owner pages live next door; this is the door itself.

   The design constraint that shapes every screen here: **nothing tells you
   whether an address is known.** Type any address and you are told a link is
   on its way. That is deliberately unhelpful and it is the only honest
   answer — the alternative turns this form into a way to ask "does this
   person rent from you", which is somebody's home address.

   The existing tokenised links are untouched and keep working. A tenant who
   has a bookmarked `/pay/:token` never has to see this page at all. */
import { all, get, one } from "../lib/db.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { portalPage, publicPage, notice, empty, PORTAL_MANIFEST } from "../views/layout.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { IS_SERVERLESS } from "../lib/config.js";
import { queueMessage } from "../lib/outbox.js";
import { log } from "../lib/logger.js";
import {
  requestLink, redeem, chooseCompany, signOut,
  setPortalCookie, clearPortalCookie, touchSession,
} from "../lib/magiclink.js";
import { companiesFor, rolesIn } from "../lib/identity.js";

/* The same words whatever happened, because the words are the disclosure. */
const SENT = "If that address is on an account, a sign-in link is on its way. "
  + "It lasts fifteen minutes.";

export function registerPortal(router) {
  /* --- the door ------------------------------------------------------------ */

  router.get("/portal", async (ctx) => {
    if (ctx.person?.companyId) return redirect(ctx.res, "/portal/home");
    if (ctx.person) return redirect(ctx.res, "/portal/choose");
    return redirect(ctx.res, "/portal/sign-in");
  });

  router.get("/portal/sign-in", async (ctx) => {
    if (ctx.person) return redirect(ctx.res, "/portal");

    sendHtml(ctx.res, publicPage({
      install: PORTAL_MANIFEST,
      title: "Sign in",
      heading: "Your account",
      lede: "Rent, repairs and documents for the place you rent — or the property you own.",
      body: html`
        ${ctx.query.e ? notice("warn", null, ctx.query.e) : ""}
        <div class="panel">
          <div class="panel__body">
            <form method="post" action="/portal/sign-in" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              ${ctx.query.next ? html`<input type="hidden" name="next" value="${ctx.query.next}" />` : ""}
              <div class="field">
                <label for="email">Your email address</label>
                <input id="email" name="email" type="email" autocomplete="email"
                       inputmode="email" required autofocus />
                <span class="field__help">
                  The one your landlord or managing agent has on file. We will send you a
                  link — there is no password to remember.
                </span>
              </div>
              <div class="btnrow">
                <button class="pill solid" type="submit">Email me a link</button>
              </div>
            </form>
          </div>
          <div class="panel__foot">
            Already have a link to pay rent or read a statement? It still works — you do
            not need an account to use it.
          </div>
        </div>`,
    }));
  });

  router.post("/portal/sign-in", async (ctx) => {
    const ip = clientIp(ctx.req);

    /* Two limits, and this is the outer one. The inner limit in magiclink.js
       counts tokens actually issued; this one counts attempts, so a script
       pointed at a thousand addresses is stopped before it can learn which of
       them exist from the timing. */
    const gate = await check("portal", ip);
    if (!gate.allowed) {
      return redirect(ctx.res, `/portal/sent?m=${encodeURIComponent(SENT)}`);
    }

    const email = String(ctx.fields.email || "");
    const base = `${ctx.url.protocol}//${ctx.url.host}`;
    const res = await requestLink({ email, ip, baseUrl: base });

    if (res.delivered) {
      /* Through the outbox, so the delivery-honesty rule holds here too: if
         no provider is wired, the message queues and says so rather than the
         page claiming an email was sent. */
      /* Transactional, which the consent rules already understand: somebody
         who unsubscribed from rent reminders can still get into their own
         account, and a hard-bounced address still receives nothing. No
         special case needed here — the existing rule is the right one. */
      await queueMessage({
        companyId: res.companies[0].id,
        channel: "email",
        to: res.person.email,
        subject: `Sign in to ${res.companies[0].name}`,
        body: signInEmail({ person: res.person, companies: res.companies, url: res.url }),
        kind: "transactional",
        aboutType: "person", aboutId: res.person.id,
      });
    }

    return redirect(ctx.res, `/portal/sent?m=${encodeURIComponent(SENT)}`);
  });

  router.get("/portal/sent", async (ctx) => {
    sendHtml(ctx.res, publicPage({
      install: PORTAL_MANIFEST,
      title: "Check your email",
      heading: "Check your email",
      body: html`
        ${notice("ok", null, ctx.query.m || SENT)}
        <div class="panel">
          <div class="panel__body">
            ${empty("Nothing arrived?",
              html`Look in your spam folder first. If it is not there, the address may not
                   be the one your managing agent has on file — call them and they can
                   check. <a href="/portal/sign-in">Try a different address</a>.`)}
          </div>
        </div>`,
    }));
  });

  /* --- coming back from the email ------------------------------------------ */

  /* Public by prefix: the token in the URL is the credential. */
  router.get("/portal/enter/:token", async (ctx) => {
    const res = await redeem({
      token: ctx.params.token,
      ip: clientIp(ctx.req),
      userAgent: ctx.req.headers["user-agent"],
    });

    if (!res.ok) {
      return redirect(ctx.res, `/portal/sign-in?e=${encodeURIComponent(res.reason)}`);
    }

    setPortalCookie(ctx.res, res.sessionId, { secure: IS_SERVERLESS });
    return redirect(ctx.res, res.companies.length === 1 ? "/portal/home" : "/portal/choose");
  });

  /* --- which company ------------------------------------------------------- */

  router.get("/portal/choose", async (ctx) => {
    const companies = await companiesFor(ctx.person.personId);

    /* Nothing at all. Either every link was revoked while they were signed
       in, or the address was unlinked between the email and the click. They
       land here because losing the last link also clears the company on the
       session — so this, rather than `/portal/home`, is where that has to be
       explained. An empty picker is the worst possible answer. */
    if (companies.length === 0) {
      return sendHtml(ctx.res, portalPage({
        title: "No access", heading: "This account has no records",
        person: ctx.person,
        body: html`
          ${notice("warn", "Nothing is linked to this address any more",
            "If you have moved out recently that is expected. If you think it is wrong, "
            + "contact your managing agent and they can check what address they hold for you.")}
          <div class="panel">
            <div class="panel__body">
              ${empty("Signed in as " + (ctx.person.email || ""),
                html`<a class="pill outline sm" href="/portal/sign-out">Sign out</a>`)}
            </div>
          </div>`,
      }));
    }

    /* One company and nothing to choose: never make somebody click through a
       list of one. */
    if (companies.length === 1) {
      await chooseCompany({
        sessionId: ctx.person.sessionId, personId: ctx.person.personId,
        companyId: companies[0].id,
      });
      return redirect(ctx.res, "/portal/home");
    }

    sendHtml(ctx.res, portalPage({
      title: "Choose", heading: "Which account?",
      lede: "You have an account with more than one managing agent. They are kept separate.",
      person: ctx.person,
      body: html`
        ${ctx.query.e ? notice("warn", null, ctx.query.e) : ""}
        <div class="panel">
          <div class="panel__body panel__body--flush">
            ${companies.map((c) => html`
              <form method="post" action="/portal/choose" class="rowlink">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <input type="hidden" name="company_id" value="${c.id}" />
                <button type="submit" class="rowlink__btn"
                        style="display:flex;width:100%;justify-content:space-between;align-items:center;
                               gap:1rem;padding:1rem 1.25rem;background:none;border:0;
                               border-bottom:1px solid var(--line);text-align:left;cursor:pointer">
                  <span>
                    <b style="display:block">${c.name}</b>
                    <span class="cellsub">
                      ${[c.tenancies ? `${c.tenancies} tenanc${c.tenancies === 1 ? "y" : "ies"}` : null,
                         c.portfolios ? `${c.portfolios} propert${c.portfolios === 1 ? "y" : "ies"} owned` : null]
                        .filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span class="pill outline sm">Open</span>
                </button>
              </form>`)}
          </div>
        </div>`,
    }));
  });

  router.post("/portal/choose", async (ctx) => {
    const res = await chooseCompany({
      sessionId: ctx.person.sessionId,
      personId: ctx.person.personId,
      companyId: String(ctx.fields.company_id || ""),
    });
    if (!res.ok) return redirect(ctx.res, `/portal/choose?e=${encodeURIComponent(res.reason)}`);
    return redirect(ctx.res, "/portal/home");
  });

  /* --- the landing ---------------------------------------------------------- */

  /* Where a person goes after signing in, decided by what they hold rather
     than by a role on their account. Somebody who rents and also owns sees
     both; somebody who only rents never sees an owner tab exist. */
  router.get("/portal/home", async (ctx) => {
    const roles = await rolesIn(ctx.person.personId, ctx.person.companyId);
    await touchSession(ctx.person.sessionId);

    if (roles.isTenant && !roles.isOwner) return redirect(ctx.res, "/portal/home/renting");
    if (roles.isOwner && !roles.isTenant) return redirect(ctx.res, "/portal/home/owning");

    if (!roles.isTenant && !roles.isOwner) {
      /* Every link revoked while they were signed in. */
      return sendHtml(ctx.res, portalPage({
        title: "No access", heading: "This account has no records",
        person: ctx.person, company: ctx.person.company,
        body: notice("warn", "Nothing is linked to this address any more",
          html`If you think that is wrong, contact
               ${ctx.person.company?.name || "your managing agent"}
               ${ctx.person.company?.phone
                 ? html`on <a href="tel:${ctx.person.company.phone}">${ctx.person.company.phone}</a>` : ""}.`),
      }));
    }

    /* Both. Offer the choice rather than guessing, because the two are
       genuinely different errands. */
    return sendHtml(ctx.res, portalPage({
      title: "Your account", heading: "Your account",
      lede: `With ${ctx.person.company.name}`,
      person: ctx.person, company: ctx.person.company,
      tabs: portalTabs(roles), active: null,
      body: html`
        <div class="panel">
          <div class="panel__body">
            ${empty("You rent, and you also own",
              html`Two different things, kept apart.
                   <span style="display:block;margin-top:0.75rem">
                     <a class="pill solid sm" href="/portal/home/renting">Where you rent</a>
                     <a class="pill outline sm" href="/portal/home/owning">What you own</a>
                   </span>`)}
          </div>
        </div>`,
    }));
  });

  /* --- leaving -------------------------------------------------------------- */

  router.get("/portal/sign-out", async (ctx) => {
    if (ctx.person) await signOut(ctx.person.sessionId);
    clearPortalCookie(ctx.res);
    return redirect(ctx.res, "/portal/sign-in?e=" + encodeURIComponent("You are signed out."));
  });
}

/* Shown only where a person holds both roles. The shell hides the bar
   entirely when there is one tab, because a single tab is furniture. */
export function portalTabs(roles) {
  const items = [];
  if (roles.isTenant) items.push({ key: "renting", href: "/portal/home/renting", label: "Where you rent" });
  if (roles.isOwner) items.push({ key: "owning", href: "/portal/home/owning", label: "What you own" });
  return items;
}

function signInEmail({ person, companies, url }) {
  const who = companies.length === 1
    ? companies[0].name
    : `${companies.length} managing agents`;
  return [
    person.name ? `Hello ${person.name},` : "Hello,",
    "",
    `Here is your link to sign in to your account with ${who}.`,
    "",
    url,
    "",
    "It works once and lasts fifteen minutes. If you did not ask for it you can",
    "ignore this message — nobody can get in without the link.",
  ].join("\n");
}
