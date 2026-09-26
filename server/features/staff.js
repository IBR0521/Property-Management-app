/* F14  The people who work here.

   Adding somebody to software that holds other people's money is not "type a
   password for them and read it out". It is a link only they can use, that
   expires, and that carries the role the person inviting them chose.

   The staff row is not created until the invitation is accepted. A row that
   exists but cannot sign in looks exactly like a deactivated colleague, and an
   administrator auditing who has access needs those to be different things.

   Deactivation, not deletion. A staff member's name is on work orders, ledger
   entries and audit rows going back years; deleting them would either orphan
   that history or rewrite it, and both are worse than an inactive row. */
import { all, get, one, insert, update, run, tx } from "../lib/db.js";
import { id, token } from "../lib/ids.js";
import { stamp, human, humanStamp } from "../lib/dates.js";
import { hashPassword, startSession, roleLabel, capabilitiesFor } from "../lib/auth.js";
import { sendHtml, redirect, BadRequest, isHttps } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, publicPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { queueMessage } from "../lib/outbox.js";
import { deliverQueued } from "../lib/scheduler.js";
import { check, clientIp } from "../lib/ratelimit.js";

const INVITE_VALID_DAYS = 14;

async function inviteResult(queued, email) {
  if (!queued) {
    return `Invitation saved for ${email}. Confirm this company's email on Company before mail can leave. The link is in the list below.`;
  }
  const sent = await deliverQueued(queued);
  if (sent.ok) return `Invitation sent to ${email}.`;
  return `Invitation saved for ${email}, but it did not go out — ${sent.reason}. The link is in the list below.`;
}
const MIN_PASSWORD = 12;

const ROLES = ["admin", "manager", "accountant", "leasing", "maintenance", "technician"];

const ROLE_HINT = {
  admin: "Everything, including staff and billing.",
  manager: "Everything operational and financial. Not billing or staff.",
  accountant: "The books and the bank. No dispatch.",
  leasing: "Applications, listings and lease documents. No money.",
  maintenance: "The repair queue and contractors. No money.",
  technician: "Only the jobs assigned to them. Nothing else.",
};

export function registerStaff(router) {
  /* --- the public acceptance page ---------------------------------------- */

  /* Registered before the /app routes, like every other tokenised page: the
     person accepting has no account yet, so this cannot sit behind a session. */
  router.get("/join/:tok", async (ctx) => {
    const invite = await loadInvite(ctx.params.tok);
    if (!invite.ok) return sendHtml(ctx.res, invitePage(invite), invite.status);
    sendHtml(ctx.res, invitePage({ ...invite, csrf: ctx.csrf, error: ctx.query.e }));
  });

  router.post("/join/:tok", async (ctx) => {
    const gate = await check("signup", clientIp(ctx.req));
    if (!gate.allowed) return sendHtml(ctx.res, "Too many attempts. Try again later.", 429);

    const invite = await loadInvite(ctx.params.tok);
    if (!invite.ok) return sendHtml(ctx.res, invitePage(invite), invite.status);

    const name = String(ctx.fields.name || invite.row.name || "").trim();
    const password = String(ctx.fields.password || "");
    const back = (m) => redirect(ctx.res, `/join/${ctx.params.tok}?e=${encodeURIComponent(m)}`);

    if (name.length < 2) return back("What should colleagues call you?");
    if (password.length < MIN_PASSWORD) {
      return back(`Use at least ${MIN_PASSWORD} characters. Length is what makes a password hard to guess.`);
    }

    /* The same address may legitimately be staff at two companies, so this is
       scoped rather than global. What it stops is a second seat for somebody
       who already has one here. */
    const existing = await get(
      "SELECT id FROM staff WHERE company_id = ? AND lower(email) = lower(?)",
      invite.row.company_id, invite.row.email);
    if (existing) return back("Somebody with that address already works here. Try signing in.");

    const staffId = id();
    await tx(async () => {
      await insert("staff", {
        id: staffId, company_id: invite.row.company_id,
        name, email: invite.row.email.toLowerCase(),
        password_hash: hashPassword(password),
        /* From the invitation, never from the form: the person accepting does
           not get to choose how much access they receive. */
        role: invite.row.role,
        active: 1, created_at: stamp(),
      });
      await run("UPDATE staff_invite SET accepted_at = ? WHERE id = ?", stamp(), invite.row.id);
    });

    await startSession(ctx.res, staffId, { secure: isHttps(ctx.req) });
    redirect(ctx.res, "/app?m=" + encodeURIComponent(`Welcome to ${invite.company.name}.`));
  });

  /* --- staff administration ---------------------------------------------- */

  router.get("/app/staff", async (ctx) => {
    const cid = ctx.staff.company_id;
    const people = await all(
      "SELECT * FROM staff WHERE company_id = ? ORDER BY active DESC, name", cid);
    const invites = await all(
      `SELECT * FROM staff_invite
        WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`, cid);
    const origin = `${ctx.url.protocol}//${ctx.url.host}`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "staff", counts: await navCounts(cid),
      title: "Your team", subtitle: `${people.filter((p) => p.active).length} active`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        <div class="panel"><div class="panel__body panel__body--flush">
          <div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Name</th><th>Role</th><th class="shrink">2FA</th><th class="shrink">State</th><th class="shrink"></th></tr></thead>
            <tbody>${people.map((p) => html`
              <tr>
                <td>${p.name}<span class="cellsub">${p.email}</span></td>
                <td>
                  ${p.id === ctx.staff.id
                    ? html`${roleLabel(p.role)}<span class="cellsub">you</span>`
                    : html`<form method="post" action="/app/staff/${p.id}/role" class="filterbar" style="padding:0;border:0;gap:0.375rem">
                        <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                        <div class="field" style="min-width:8rem">
                          <select name="role">
                            ${ROLES.map((r) => html`<option value="${r}"${attr("selected", p.role === r)}>${roleLabel(r)}</option>`)}
                          </select>
                        </div>
                        <button class="pill outline sm" type="submit">Save</button>
                      </form>`}
                </td>
                <td class="shrink">${p.totp_confirmed_at
                  ? html`<span class="chip" data-tone="ok">on</span>`
                  : html`<span class="chip">off</span>`}</td>
                <td class="shrink">${p.active
                  ? html`<span class="chip" data-tone="ok">active</span>`
                  : html`<span class="chip" data-tone="danger">deactivated</span>`}</td>
                <td class="shrink">
                  ${p.id === ctx.staff.id ? "" : html`
                    <form method="post" action="/app/staff/${p.id}/${p.active ? "deactivate" : "reactivate"}">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <button class="pill outline sm" type="submit">${p.active ? "Deactivate" : "Reactivate"}</button>
                    </form>`}
                </td>
              </tr>`)}</tbody>
          </table></div>
        </div></div>

        ${invites.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Waiting to accept</h2><p>${invites.length}</p></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap tablewrap--narrow"><table class="data">
                <tbody>${invites.map((i) => {
                  const expired = i.expires_at < stamp();
                  return html`
                  <tr>
                    <td>${i.email}<span class="cellsub">${roleLabel(i.role)} · invited ${humanStamp(i.created_at)}</span>
                      <span class="longval" style="margin-top:0.5rem">${origin}/join/${i.token}</span></td>
                    <td class="shrink">${expired
                      ? html`<span class="chip" data-tone="danger">expired</span>`
                      : html`<span class="chip" data-tone="warn">pending</span>`}</td>
                    <td class="shrink">
                      <div class="btnrow">
                        <form method="post" action="/app/staff/invite/${i.id}/resend">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <button class="pill outline sm" type="submit">Resend</button>
                        </form>
                        <form method="post" action="/app/staff/invite/${i.id}/revoke">
                          <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                          <button class="pill outline sm" type="submit"
                                  aria-label="Revoke the invitation to ${i.email}"
                                  title="The link stops working. You can invite them again.">Revoke</button>
                        </form>
                      </div>
                    </td>
                  </tr>`;
                })}</tbody>
              </table></div>
            </div>
          </div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>Invite somebody</h2></div>
          <div class="panel__body">
            <form method="post" action="/app/staff/invite" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="email">Their email</label>
                  <input id="email" name="email" type="email" required maxlength="160" />
                  <span class="field__help">The invitation goes here, and it is what they
                    will sign in with. It expires if nobody uses it.</span>
                </div>
                <div class="field">
                  <label for="name">Their name <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                  <input id="name" name="name" type="text" maxlength="120" />
                </div>
              </div>
              <div class="field">
                <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">What may they do?</span>
                <div class="radioset">
                  ${ROLES.map((r) => html`
                    <label class="radiotile">
                      <input type="radio" name="role" value="${r}"${attr("checked", r === "maintenance")} required />
                      <span>${roleLabel(r)}<small>${ROLE_HINT[r]}</small></span>
                    </label>`)}
                </div>
              </div>
              <button class="pill solid" type="submit">Send invitation</button>
            </form>
          </div>
          <div class="panel__foot">
            The link works for ${INVITE_VALID_DAYS} days and can only be used once. Their role is
            fixed when you send it — they do not choose it themselves.
          </div>
        </div>`,
    }));
  });

  router.post("/app/staff/invite", async (ctx) => {
    const cid = ctx.staff.company_id;
    const email = String(ctx.fields.email || "").trim().toLowerCase();
    const role = ROLES.includes(ctx.fields.role) ? ctx.fields.role : null;
    const back = (m) => redirect(ctx.res, `/app/staff?m=${encodeURIComponent(m)}`);

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back("That email address does not look right.");
    if (!role) return back("Choose what they may do.");

    if (await get("SELECT id FROM staff WHERE company_id = ? AND lower(email) = ?", cid, email)) {
      return back("Somebody with that address already works here.");
    }

    const tok = token();
    await tx(async () => {
      /* Replace any outstanding invitation rather than leaving two live links
         to the same seat. */
      await run(
        `UPDATE staff_invite SET revoked_at = ?
          WHERE company_id = ? AND lower(email) = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        stamp(), cid, email);
      await insert("staff_invite", {
        id: id(), company_id: cid, email,
        name: String(ctx.fields.name || "").trim() || null,
        role, token: tok, invited_by: ctx.staff.id,
        expires_at: new Date(Date.now() + INVITE_VALID_DAYS * 86400_000).toISOString(),
        created_at: stamp(),
      });
    });

    const origin = `${ctx.url.protocol}//${ctx.url.host}`;
    const company = await one("SELECT name FROM company WHERE id = ?", cid);
    const queued = await queueMessage({
      companyId: cid, channel: "email", to: email,
      subject: `${ctx.staff.name} has invited you to ${company.name}`,
      body: `${ctx.staff.name} has invited you to join ${company.name} as ${roleLabel(role)}.\n\n`
        + `${origin}/join/${tok}\n\nThe link works for ${INVITE_VALID_DAYS} days.\n`,
      kind: "transactional", aboutType: "staff_invite", aboutId: tok,
    });

    back(await inviteResult(queued, email));
  });

  router.post("/app/staff/invite/:id/resend", async (ctx) => {
    const cid = ctx.staff.company_id;
    const invite = await one(
      "SELECT * FROM staff_invite WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (invite.accepted_at) throw new BadRequest("That invitation has already been accepted.");

    /* A fresh expiry, keeping the same link — the person may already have the
       old email open, and invalidating it would be a worse experience than a
       link that quietly still works. */
    await update("staff_invite", invite.id, {
      expires_at: new Date(Date.now() + INVITE_VALID_DAYS * 86400_000).toISOString(),
      revoked_at: null,
    });

    const origin = `${ctx.url.protocol}//${ctx.url.host}`;
    const company = await one("SELECT name FROM company WHERE id = ?", cid);
    const queued = await queueMessage({
      companyId: cid, channel: "email", to: invite.email,
      subject: `Reminder: join ${company.name}`,
      body: `Your invitation to ${company.name} is still open:\n\n${origin}/join/${invite.token}\n`,
      kind: "transactional", aboutType: "staff_invite", aboutId: invite.token,
    });
    redirect(ctx.res, `/app/staff?m=${encodeURIComponent(await inviteResult(queued, invite.email))}`);
  });

  router.post("/app/staff/invite/:id/revoke", async (ctx) => {
    const cid = ctx.staff.company_id;
    const invite = await one(
      "SELECT * FROM staff_invite WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    await update("staff_invite", invite.id, { revoked_at: stamp() });
    redirect(ctx.res, `/app/staff?m=${encodeURIComponent("Invitation revoked. The link no longer works.")}`);
  });

  router.post("/app/staff/:id/role", async (ctx) => {
    const cid = ctx.staff.company_id;
    const person = await one("SELECT * FROM staff WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const role = ROLES.includes(ctx.fields.role) ? ctx.fields.role : null;
    if (!role) throw new BadRequest("That is not a role.");
    if (person.id === ctx.staff.id) {
      throw new BadRequest("You cannot change your own role. Ask another administrator.");
    }
    await assertNotLastAdmin(cid, person, role === "admin" ? "admin" : "other");
    await update("staff", person.id, { role });
    redirect(ctx.res, `/app/staff?m=${encodeURIComponent(`${person.name} is now ${roleLabel(role)}.`)}`);
  });

  router.post("/app/staff/:id/deactivate", async (ctx) => {
    const cid = ctx.staff.company_id;
    const person = await one("SELECT * FROM staff WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    if (person.id === ctx.staff.id) throw new BadRequest("You cannot deactivate yourself.");
    await assertNotLastAdmin(cid, person, "other");

    await tx(async () => {
      await update("staff", person.id, { active: 0 });
      /* Their sessions end now rather than whenever they happen to expire.
         Deactivating somebody who is still signed in achieves nothing. */
      await run("DELETE FROM session WHERE staff_id = ?", person.id);
    });
    redirect(ctx.res, `/app/staff?m=${encodeURIComponent(
      `${person.name} can no longer sign in. Their name stays on everything they did.`)}`);
  });

  router.post("/app/staff/:id/reactivate", async (ctx) => {
    const cid = ctx.staff.company_id;
    const person = await one("SELECT * FROM staff WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    await update("staff", person.id, { active: 1 });
    redirect(ctx.res, `/app/staff?m=${encodeURIComponent(`${person.name} can sign in again.`)}`);
  });

  /* --- the technician's screen ------------------------------------------- */

  /* Deliberately small. A technician sees the jobs assigned to them and the
     addresses those jobs are at, and nothing else. Phase 5 makes this
     phone-shaped with check-in, photos and parts; this is the honest version
     that makes the role mean something today rather than being a set of
     refusals. */
}

/* --- shared --------------------------------------------------------------- */

/* Locking every administrator out of a company is not a recoverable mistake —
   there is nobody left who can undo it, and support access is a backdoor that
   should not be the answer to a routine error. */
async function assertNotLastAdmin(companyId, person, becoming) {
  if (person.role !== "admin" || becoming === "admin") return;
  const admins = await get(
    "SELECT COUNT(*)::int AS n FROM staff WHERE company_id = ? AND role = 'admin' AND active = 1",
    companyId);
  if (Number(admins.n) <= 1) {
    throw new BadRequest(
      "This is the only administrator. Promote somebody else first, or there will be nobody who can.");
  }
}

async function loadInvite(tok) {
  const row = await get("SELECT * FROM staff_invite WHERE token = ?", String(tok || ""));
  if (!row) {
    return { ok: false, status: 404, title: "That invitation is not one of ours",
      detail: "Check the whole link was copied, or ask for a new one." };
  }
  if (row.accepted_at) {
    return { ok: false, status: 200, title: "Already accepted",
      detail: "This invitation has been used. Sign in instead.", cta: "/app/sign-in" };
  }
  if (row.revoked_at) {
    return { ok: false, status: 410, title: "That invitation was withdrawn",
      detail: "Ask whoever invited you to send another." };
  }
  if (row.expires_at < stamp()) {
    return { ok: false, status: 410, title: "That invitation has expired",
      detail: `Invitations last ${INVITE_VALID_DAYS} days. Ask for a new one.` };
  }
  const company = await get("SELECT * FROM company WHERE id = ?", row.company_id);
  return { ok: true, row, company };
}

function invitePage({ ok, row, company, csrf, error, title, detail, cta }) {
  if (!ok) {
    return publicPage({
      company: null, title, heading: title,
      body: html`
        ${notice("warn", null, detail)}
        ${cta ? html`<p style="margin-top:1.5rem"><a class="pill solid" href="${cta}">Sign in</a></p>` : ""}`,
    });
  }

  return publicPage({
    company,
    title: `Join ${company.name}`,
    heading: `Join ${company.name}`,
    lede: `You have been invited as ${roleLabel(row.role)}.`,
    body: html`
      ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
      <div class="panel">
        <div class="panel__body">
          <form method="post" action="/join/${row.token}" class="formgrid">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <div class="field">
              <label for="email">Email</label>
              <input id="email" type="email" value="${row.email}" disabled />
              <span class="field__help">The address this invitation was sent to.</span>
            </div>
            <div class="field">
              <label for="name">Your name</label>
              <input id="name" name="name" type="text" required maxlength="120"
                     value="${row.name || ""}" autocomplete="name" />
            </div>
            <div class="field">
              <label for="password">Choose a password</label>
              <input id="password" name="password" type="password" required
                     minlength="${MIN_PASSWORD}" autocomplete="new-password" />
              <span class="field__help">At least ${MIN_PASSWORD} characters.</span>
            </div>
            <button class="pill solid" type="submit">Join ${company.name}</button>
          </form>
        </div>
      </div>`,
  });
}
