/* The shared inbox.

   One list for the whole company rather than a mailbox each, because the
   question a property manager actually has is "what has come in that nobody
   has answered", and that question does not have an owner until somebody
   claims it.

   Two things here are load-bearing.

   **Replies go through the outbox.** The inbox never says a message was sent;
   it shows what the outbox says about it. A reply reads as *queued* until the
   provider accepts it, which is the delivery-honesty invariant applied to the
   one screen where somebody is most likely to assume otherwise.

   **A note is not a message.** "Third time they have reported this" belongs
   on the conversation and must never leave the building. Notes have their own
   channel, no outbox row, and are drawn differently. */
import { all, get, one, run } from "../lib/db.js";
import { human, humanStamp, stamp } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { queueMessage, sendingBlockedReason } from "../lib/outbox.js";
import { PORTAL_REPLY_DOMAIN } from "../lib/config.js";
import {
  threadsFor, threadWithMessages, markRead, assignThread,
  resolveThreadById, reopenThread, attachParty,
} from "../lib/inbox.js";
import { recordOutbound, replyAddress, messageIdFor } from "../lib/threading.js";

const INBOX_TABS = [
  { key: "open", href: "/app/inbox", label: "Open" },
  { key: "mine", href: "/app/inbox?view=mine", label: "Mine" },
  { key: "unassigned", href: "/app/inbox?view=unassigned", label: "Unclaimed" },
  { key: "resolved", href: "/app/inbox?view=resolved", label: "Resolved" },
];

const STATE_TONE = { open: "warn", waiting: "", resolved: "ok" };
const CHANNEL_LABEL = { email: "Email", sms: "Text", portal: "Portal", note: "Note" };

export function registerInbox(router) {
  /* --- the list ------------------------------------------------------------ */

  router.get("/app/inbox", async (ctx) => {
    const cid = ctx.staff.company_id;
    const view = String(ctx.query.view || "open");
    const threads = await threadsFor(cid, { state: view, assignedTo: ctx.staff.id });

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "inbox", counts: await navCounts(cid),
      title: "Inbox", subtitle: "Everything anybody has said to you",
      body: html`
        ${tabs(INBOX_TABS, view)}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${PORTAL_REPLY_DOMAIN ? "" : notice("warn", "Replies by email will not thread yet",
          html`No reply domain is configured, so a tenant replying to one of your emails
               starts a new conversation instead of continuing this one. Texts and the
               portal are unaffected. See <code>PORTAL_REPLY_DOMAIN</code>.`)}

        <div class="panel">
          <div class="panel__head">
            <h2>${{ open: "Open", mine: "Assigned to you", unassigned: "Nobody has claimed these",
                    resolved: "Finished" }[view] || "Conversations"}</h2>
            <p>${threads.length} conversation${threads.length === 1 ? "" : "s"}</p>
          </div>
          <div class="panel__body panel__body--flush">
            ${threads.length === 0
              ? html`<div class="panel__body">${empty("Nothing here",
                  view === "open" ? "Nothing is waiting on you." : "Nothing matches this view.")}</div>`
              : html`
                <div class="tablewrap">
                  <table class="data">
                    <thead><tr><th>Who</th><th>About</th><th>Last</th><th>With</th><th>State</th></tr></thead>
                    <tbody>
                      ${threads.map((t) => html`
                        <tr${attr("style", Number(t.unread) ? "font-weight:500" : null)}>
                          <td>
                            <a href="/app/inbox/${t.id}">${t.party_name || partyLabel(t)}</a>
                            ${Number(t.unread) ? html`<span class="chip" data-tone="warn">new</span>` : ""}
                          </td>
                          <td>${t.subject || "—"}
                            ${t.preview ? html`<div class="cellsub">${preview(t.preview)}</div>` : ""}</td>
                          <td>${t.last_message_at ? humanStamp(t.last_message_at) : "—"}
                            <div class="cellsub">${t.last_direction === "in" ? "they wrote" : "you wrote"}</div></td>
                          <td>${t.assignee_name || html`<span class="cellsub">nobody</span>`}</td>
                          <td><span class="chip"${attr("data-tone", STATE_TONE[t.state])}>${t.state}</span></td>
                        </tr>`)}
                    </tbody>
                  </table>
                </div>`}
          </div>
        </div>`,
    }));
  });

  /* --- one conversation ---------------------------------------------------- */

  router.get("/app/inbox/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const found = await threadWithMessages(cid, ctx.params.id);
    if (!found) throw new NotFound("That conversation is not one of yours.");

    const { thread, messages, events } = found;
    await markRead(cid, thread.id);

    const team = await all(
      "SELECT id, name FROM staff WHERE company_id = ? AND active = 1 ORDER BY name", cid);

    /* Only loaded when it is needed. An attached conversation has nothing to
       choose from. */
    const candidates = thread.party_type === "unknown"
      ? {
          tenant: await all(
            `SELECT t.id, t.name FROM tenant t
               JOIN lease_tenant lt ON lt.tenant_id = t.id
               JOIN lease l ON l.id = lt.lease_id AND l.status = 'active'
              WHERE t.company_id = ? ORDER BY t.name LIMIT 200`, cid),
          owner: await all(
            "SELECT id, name FROM owner WHERE company_id = ? ORDER BY name LIMIT 200", cid),
          vendor: await all(
            "SELECT id, name FROM vendor WHERE company_id = ? ORDER BY name LIMIT 200", cid),
        }
      : null;
    const reachable = thread.contact_email || thread.contact_phone
      || thread.party_email || thread.party_phone;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "inbox", counts: await navCounts(cid),
      title: thread.party_name || partyLabel(thread),
      subtitle: thread.subject || "No subject",
      actions: html`
        <a class="pill outline sm" href="/app/inbox">Back to the inbox</a>
        ${thread.state === "resolved"
          ? html`<form method="post" action="/app/inbox/${thread.id}/reopen" style="display:inline">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <button class="pill outline sm" type="submit">Reopen</button>
            </form>`
          : html`<form method="post" action="/app/inbox/${thread.id}/resolve" style="display:inline">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <button class="pill solid sm" type="submit">Mark resolved</button>
            </form>`}`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${ctx.query.e ? notice("danger", null, ctx.query.e) : ""}

        ${thread.party_type === "unknown"
          ? unknownPanel({ thread, csrf: ctx.csrf, candidates })
          : ""}

        <div class="hub">
          <div class="hub__col">
            <div class="panel">
              <div class="panel__head"><h2>The conversation</h2></div>
              <div class="panel__body">
                ${messages.length === 0
                  ? empty("Nothing said yet", "Start below.")
                  : html`<div class="sig">${messages.map((m) => messageRow(m))}</div>`}
              </div>
            </div>

            ${replyPanel({ thread, csrf: ctx.csrf, reachable })}
          </div>

          <div class="hub__col">
            ${aboutPanel({ thread, team, csrf: ctx.csrf })}
            ${events.length ? historyPanel(events) : ""}
          </div>
        </div>`,
    }));
  });

  /* --- replying ------------------------------------------------------------- */

  router.post("/app/inbox/:id/reply", async (ctx) => {
    const cid = ctx.staff.company_id;
    const found = await threadWithMessages(cid, ctx.params.id);
    if (!found) throw new NotFound("That conversation is not one of yours.");
    const { thread } = found;

    const back = (q) => redirect(ctx.res, `/app/inbox/${thread.id}?${q}`);
    const body = String(ctx.fields.body || "").trim();
    if (!body) return back(`e=${encodeURIComponent("Write something first.")}`);

    /* A note stays here. No outbox row, no provider, nothing that could
       accidentally reach the other person. */
    if (String(ctx.fields.kind) === "note") {
      await recordOutbound({
        companyId: cid, thread, channel: "note", body,
        toContact: null, authorStaffId: ctx.staff.id, isNote: true,
      });
      return back(`m=${encodeURIComponent("Note added. Only your team can see it.")}`);
    }

    const channel = String(ctx.fields.channel || "email") === "sms" ? "sms" : "email";
    const to = channel === "sms"
      ? (thread.contact_phone || thread.party_phone)
      : (thread.contact_email || thread.party_email);

    if (!to) {
      return back(`e=${encodeURIComponent(
        channel === "sms"
          ? "There is no phone number on this conversation."
          : "There is no email address on this conversation.")}`);
    }

    /* Queued, not sent. The outbox decides whether it goes and the
       conversation shows what the outbox says. */
    const outboxId = await queueMessage({
      companyId: cid, channel, to,
      subject: channel === "email" ? (thread.subject || "Message") : null,
      body, kind: "transactional",
      aboutType: "thread", aboutId: thread.id,
    });

    const { messageId } = await recordOutbound({
      companyId: cid, thread, channel, body,
      subject: channel === "email" ? thread.subject : null,
      toContact: to, authorStaffId: ctx.staff.id, outboxId,
    });

    /* The Message-ID we will have sent, so a reply's In-Reply-To can be
       matched against it. */
    if (channel === "email") {
      await run("UPDATE message SET message_id_header = ? WHERE id = ?",
        messageIdFor(messageId), messageId);
    }

    if (outboxId) {
      return back(`m=${encodeURIComponent(
        "Queued. It will show as sent once the provider accepts it.")}`);
    }

    /* Refused by the delivery rules rather than lost — there is a suppressed
       outbox row with the reason on it. Saying the reason here is better than
       sending somebody off to find the message log to learn what the
       application already knows. */
    const why = await sendingBlockedReason(cid);
    return back(`e=${encodeURIComponent(
      `That was not sent: ${why || "the delivery rules refused it"}. `
      + `It is still on the conversation.`)}`);
  });

  /* --- working the conversation --------------------------------------------- */

  router.post("/app/inbox/:id/assign", async (ctx) => {
    const cid = ctx.staff.company_id;
    const res = await assignThread({
      companyId: cid, threadId: ctx.params.id,
      staffId: String(ctx.fields.staff_id || "") || null, by: ctx.staff.id,
    });
    if (!res.ok) return redirect(ctx.res, `/app/inbox/${ctx.params.id}?e=${encodeURIComponent(res.reason)}`);
    return redirect(ctx.res, `/app/inbox/${ctx.params.id}?m=${encodeURIComponent("Assigned.")}`);
  });

  router.post("/app/inbox/:id/resolve", async (ctx) => {
    await resolveThreadById({
      companyId: ctx.staff.company_id, threadId: ctx.params.id, by: ctx.staff.id,
    });
    return redirect(ctx.res, `/app/inbox?m=${encodeURIComponent("Marked resolved.")}`);
  });

  router.post("/app/inbox/:id/reopen", async (ctx) => {
    await reopenThread({
      companyId: ctx.staff.company_id, threadId: ctx.params.id, by: ctx.staff.id,
    });
    return redirect(ctx.res, `/app/inbox/${ctx.params.id}?m=${encodeURIComponent("Reopened.")}`);
  });

  router.post("/app/inbox/:id/attach", async (ctx) => {
    const cid = ctx.staff.company_id;
    const [type, recordId] = String(ctx.fields.party || "").split(":");
    const res = await attachParty({
      companyId: cid, threadId: ctx.params.id,
      party: { type, id: recordId }, by: ctx.staff.id,
    });
    if (!res.ok) return redirect(ctx.res, `/app/inbox/${ctx.params.id}?e=${encodeURIComponent(res.reason)}`);
    return redirect(ctx.res, `/app/inbox/${ctx.params.id}?m=${encodeURIComponent("Attached.")}`);
  });
}

/* --- views ------------------------------------------------------------------- */

function partyLabel(thread) {
  if (thread.contact_phone) return thread.contact_phone;
  if (thread.contact_email) return thread.contact_email;
  return "Somebody we cannot place";
}

function preview(body) {
  const line = String(body).replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function messageRow(m) {
  const mine = m.direction === "out";
  const isNote = m.channel === "note";

  return html`
    <div class="sig__row"${attr("style", isNote
      ? "background:#fffbea;border-left:3px solid #e3b341;padding-left:0.75rem"
      : null)}>
      <div class="sig__who">
        <b>${isNote ? `${m.author_name || "A colleague"} — private note`
          : mine ? (m.author_name || "Your team") : (m.from_contact || "Them")}</b>
        <span class="sig__role">${CHANNEL_LABEL[m.channel] || m.channel}</span>
      </div>
      <div style="white-space:pre-wrap;margin:0.35rem 0">${m.body}</div>
      <div class="sig__meta">
        <span>${humanStamp(m.created_at)}</span>
        ${mine && !isNote ? html`<span>${deliveryChip(m)}</span>` : ""}
      </div>
    </div>`;
}

/* What the outbox says, never an assertion of our own. */
function deliveryChip(m) {
  if (!m.outbox_id) return html`<span class="chip" data-tone="warn">not queued</span>`;
  const status = m.delivery_status || "queued";
  const tone = status === "sent" ? "ok"
    : status === "failed" || status === "dead" ? "danger" : "warn";
  return html`<span class="chip"${attr("data-tone", tone)}>${status}</span>${
    m.last_error ? html` <span class="cellsub">${m.last_error}</span>` : ""}`;
}

function replyPanel({ thread, csrf, reachable }) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Reply</h2>
        <p>Or leave a note only your team can read</p>
      </div>
      <div class="panel__body">
        ${reachable ? "" : notice("warn", "No way to reach them",
          "This conversation has no address or number on it. Attach it to a record first.")}
        <form method="post" action="/app/inbox/${thread.id}/reply" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="body">Message</label>
            <textarea id="body" name="body" rows="5" required></textarea>
          </div>

          <div class="field">
            <div class="radioset">
              <label class="radiotile">
                <input type="radio" name="kind" value="reply" checked />
                <span>Send it to them
                  <small>Goes out through the message queue. It will read as queued here
                  until the provider accepts it.</small>
                </span>
              </label>
              <label class="radiotile">
                <input type="radio" name="kind" value="note" />
                <span>Private note
                  <small>Stays on this conversation. Never sent anywhere.</small>
                </span>
              </label>
            </div>
          </div>

          <div class="field">
            <label for="channel">How</label>
            <select id="channel" name="channel">
              <option value="email"${attr("selected", !thread.contact_phone)}>Email</option>
              <option value="sms"${attr("selected", Boolean(thread.contact_phone))}>Text</option>
            </select>
          </div>

          <div class="btnrow">
            <button class="pill solid" type="submit">Send</button>
          </div>
        </form>
      </div>
    </div>`;
}

function aboutPanel({ thread, team, csrf }) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>This conversation</h2></div>
      <div class="panel__body">
        <dl class="dl">
          <div><dt>With</dt><dd>${thread.party_name || partyLabel(thread)}
            <div class="cellsub">${thread.party_type}</div></dd></div>
          ${thread.contact_email ? html`<div><dt>Email</dt><dd>${thread.contact_email}</dd></div>` : ""}
          ${thread.contact_phone ? html`<div><dt>Phone</dt><dd>${thread.contact_phone}</dd></div>` : ""}
          <div><dt>Started</dt><dd>${humanStamp(thread.created_at)}</dd></div>
        </dl>

        <form method="post" action="/app/inbox/${thread.id}/assign" class="formgrid"
              style="margin-top:1rem">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="staff_id">Assigned to</label>
            <select id="staff_id" name="staff_id">
              <option value="">Nobody</option>
              ${team.map((s) => html`
                <option value="${s.id}"${attr("selected", s.id === thread.assigned_to)}>${s.name}</option>`)}
            </select>
          </div>
          <div class="btnrow">
            <button class="pill outline sm" type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>`;
}

function unknownPanel({ thread, csrf, candidates }) {
  return html`
    ${notice("warn", "We do not know who this is",
      html`Somebody wrote from ${partyLabel(thread)} and it does not match a tenant, an
           owner or a contractor on file. It is here rather than discarded \u2014 it is often
           somebody whose number has changed.`)}
    <div class="panel">
      <div class="panel__head">
        <h2>Attach it to somebody</h2>
        <p>The conversation then follows them, and future messages find them too</p>
      </div>
      <div class="panel__body">
        <form method="post" action="/app/inbox/${thread.id}/attach" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="party">Who is it</label>
            <select id="party" name="party" required>
              <option value="">Choose\u2026</option>
              ${["tenant", "owner", "vendor"].map((type) => {
                const rows = candidates[type] || [];
                if (!rows.length) return "";
                return html`<optgroup label="${type === "vendor" ? "Contractors" : `${type}s`}">
                  ${rows.map((r) => html`<option value="${type}:${r.id}">${r.name}</option>`)}
                </optgroup>`;
              })}
            </select>
          </div>
          <div class="btnrow">
            <button class="pill solid sm" type="submit">Attach</button>
          </div>
        </form>
      </div>
      <div class="panel__foot">
        Attaching does not change their contact details. If this really is their new
        number, correct it on their record as well so the next message finds them.
      </div>
    </div>`;
}

function historyPanel(events) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>What happened</h2></div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <tbody>
              ${events.map((e) => html`
                <tr>
                  <td>${humanStamp(e.at)}</td>
                  <td>${e.kind}${e.detail ? html` <span class="cellsub">${e.detail}</span>` : ""}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}
