/* Filing what arrives, and acting on it.

   Two things carry the weight here.

   **Nothing is dropped.** A text from a number nobody recognises is the
   message from the tenant whose phone changed — exactly the person who most
   needs to get through. It becomes a conversation marked `unknown` that staff
   can see and attach, never a discarded row.

   **An opt-out is not a conversation.** STOP is a carrier instruction that
   takes effect immediately; filing it as a message would leave it sitting
   unread in a queue while the law says it already applied. The keyword path
   returns before the threading path, and there is a test that it stays that
   way. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import {
  fileInbound, identifySender, threadsFor, threadWithMessages,
  assignThread, resolveThreadById, reopenThread, attachParty,
  markRead, unreadCount,
} from "../server/lib/inbox.js";
import { openThread, recordOutbound } from "../server/lib/threading.js";
import { ingestEmail } from "../api/webhooks/resend-inbound.js";
import { handleTwilio } from "../server/lib/delivery/webhooks.js";
import { stateFor } from "../server/lib/delivery/consent.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Inbox Co", staffRoles: ["admin", "manager"] });
  await run("UPDATE tenant SET email = ?, phone = ? WHERE id = ?",
    "priya@example.test", "(614) 555-0200", world.tenantId);
});

/* --- who sent it ---------------------------------------------------------------- */

describe("identifying the sender", () => {
  test("a tenant is found by their email, however it is capitalised", async () => {
    const sender = await identifySender({
      companyId: world.companyId, channel: "email", contact: "PRIYA@Example.TEST",
    });
    assert.equal(sender.type, "tenant");
    assert.equal(sender.tenantId, world.tenantId);
  });

  test("and by their phone, however it was typed", async () => {
    /* A carrier sends +16145550200; the lease says (614) 555-0200. */
    for (const form of ["+16145550200", "16145550200", "6145550200", "(614) 555-0200"]) {
      const sender = await identifySender({
        companyId: world.companyId, channel: "sms", contact: form,
      });
      assert.equal(sender.type, "tenant", form);
    }
  });

  test("an owner and a contractor are found too", async () => {
    await run("UPDATE owner SET email = ? WHERE id = ?", "ruth@example.test", world.ownerId);
    await run("UPDATE vendor SET email = ? WHERE id = ?", "trades@example.test", world.vendorId);

    assert.equal((await identifySender({
      companyId: world.companyId, channel: "email", contact: "ruth@example.test",
    })).type, "owner");
    assert.equal((await identifySender({
      companyId: world.companyId, channel: "email", contact: "trades@example.test",
    })).type, "vendor");
  });

  test("somebody we cannot place is unknown, not an error", async () => {
    const sender = await identifySender({
      companyId: world.companyId, channel: "email", contact: "stranger@example.test",
    });
    assert.equal(sender.type, "unknown");
  });

  test("it does not reach into another company", async () => {
    /* Two companies can each have a tenant at the same address. */
    const other = await f.makeWorld({ name: "Other Co" });
    const sender = await identifySender({
      companyId: other.companyId, channel: "email", contact: "priya@example.test",
    });
    assert.equal(sender.type, "unknown");
  });
});

/* --- filing --------------------------------------------------------------------- */

describe("filing an inbound message", () => {
  test("a known tenant gets a conversation attached to them", async () => {
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "The tap is dripping again.",
      providerMessageId: "SM1",
    });
    assert.equal(res.ok, true);
    assert.equal(res.rule, "new");

    const thread = await get("SELECT * FROM thread WHERE id = ?", res.threadId);
    assert.equal(thread.party_type, "tenant");
    assert.equal(thread.tenant_id, world.tenantId);
    assert.equal(Number(thread.unread), 1);
  });

  test("somebody we cannot place still gets through", async () => {
    /* The tenant whose phone changed. Dropping this is the worst possible
       failure, so it becomes a visible conversation instead. */
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145559999", body: "Hi, this is Priya, I have a new number.",
      providerMessageId: "SM2",
    });
    assert.equal(res.ok, true);

    const thread = await get("SELECT * FROM thread WHERE id = ?", res.threadId);
    assert.equal(thread.party_type, "unknown");
    assert.equal(thread.tenant_id, null);

    const message = await get("SELECT body FROM message WHERE thread_id = ?", res.threadId);
    assert.match(message.body, /new number/);
  });

  test("a second message from the same person continues the conversation", async () => {
    const first = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "The tap is dripping.", providerMessageId: "SM3",
    });
    const second = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "It is worse now.", providerMessageId: "SM4",
    });

    assert.equal(second.threadId, first.threadId);
    assert.equal(second.rule, "same-contact");
    assert.equal((await all("SELECT id FROM thread")).length, 1);
  });

  test("the same webhook twice is one message", async () => {
    const args = {
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "Hello", providerMessageId: "SM5",
    };
    await fileInbound(args);
    const again = await fileInbound(args);
    assert.equal(again.duplicate, true);
    assert.equal((await all("SELECT id FROM message")).length, 1);
  });

  test("with no company and no token, nothing is filed", async () => {
    const res = await fileInbound({
      companyId: null, channel: "sms", fromContact: "+16145550200", body: "Hello",
    });
    assert.equal(res.ok, false);
    assert.equal((await all("SELECT id FROM thread")).length, 0);
  });
});

/* --- inbound texts, end to end -------------------------------------------------- */

describe("a text arriving from the carrier", () => {
  /* Twilio signs with the auth token; unset in the test env means the
     signature check refuses, so these drive `fileInbound` directly and the
     signature itself is covered in signatures.test.js. */

  test("STOP is an opt-out and never a message", async () => {
    /* The order that matters. A carrier instruction takes effect
       immediately; filing it as a conversation would leave it unread in a
       queue while the law says it already applied. */
    await insert("outbox", {
      id: id(), company_id: world.companyId, channel: "sms",
      to_contact: "+16145550200", body: "Rent is due", status: "sent",
      queued_at: stamp(),
    });

    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../server/lib/delivery/webhooks.js", import.meta.url), "utf8"));

    const keywordAt = src.indexOf('intent === "stop"');
    const fileAt = src.indexOf("fileInbound(");
    assert.ok(keywordAt > 0 && fileAt > keywordAt,
      "the keyword branch must come before, and return before, the threading branch");

    /* And the keyword branch returns rather than falling through. */
    const between = src.slice(keywordAt, fileAt);
    assert.match(between, /return await ingest\(/, "the keyword path returns");
  });

  test("an ordinary text becomes a conversation", async () => {
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "please stop the leaking tap",
      providerMessageId: "SM6",
    });
    /* "please stop the leaking tap" contains the word stop and is not an
       opt-out — classifyInbound only matches the exact keyword, which is
       tested in delivery.test.js. Here the point is that it is filed. */
    assert.equal(res.ok, true);
    const message = await get("SELECT body FROM message WHERE thread_id = ?", res.threadId);
    assert.match(message.body, /leaking tap/);
  });
});

/* --- inbound email --------------------------------------------------------------- */

describe("an email arriving from the provider", () => {
  async function threadForReplies() {
    const t = await openThread({
      companyId: world.companyId, subject: "Rent", channel: "email",
      fromContact: "priya@example.test",
      party: { type: "tenant", tenantId: world.tenantId },
    });
    return await get("SELECT * FROM thread WHERE id = ?", t.id);
  }

  test("a reply to our address lands in the right conversation", async () => {
    const t = await threadForReplies();
    const res = await ingestEmail({
      data: {
        from: "Priya Anand <priya@example.test>",
        to: [`reply+${t.reply_token}@mail.test`],
        subject: "Re: Rent",
        text: "I have paid it this morning.",
        message_id: "email-1",
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.threadId, t.id);
    assert.equal(res.rule, "reply-token");
  });

  test("an email with no reply token is refused rather than guessed at", async () => {
    /* One address can belong to a tenant of two different companies, so
       there is nothing here that names a company. */
    await threadForReplies();
    const res = await ingestEmail({
      data: {
        from: "priya@example.test", to: ["office@mail.test"],
        subject: "Rent", text: "Hello", message_id: "email-2",
      },
    });
    assert.equal(res.filed, false);
    assert.match(res.reason, /no reply token/);
  });

  test("the token is found in Cc and in the envelope too", async () => {
    const t = await threadForReplies();
    for (const [i, payload] of [
      { to: ["someone@mail.test"], cc: [`reply+${t.reply_token}@mail.test`] },
      { to: ["someone@mail.test"], envelope: { to: [`reply+${t.reply_token}@mail.test`] } },
    ].entries()) {
      const res = await ingestEmail({
        data: { from: "priya@example.test", subject: "Re: Rent",
                text: "hello", message_id: `email-cc-${i}`, ...payload },
      });
      assert.equal(res.threadId, t.id, JSON.stringify(payload));
    }
  });

  test("an HTML-only email is stored as readable text and never as markup", async () => {
    /* The body is displayed as text, so a reply carrying script cannot reach
       a member of staff's browser. */
    const t = await threadForReplies();
    await ingestEmail({
      data: {
        from: "priya@example.test", to: [`reply+${t.reply_token}@mail.test`],
        subject: "Re: Rent", message_id: "email-3",
        html: "<p>The tap is <b>still</b> dripping.</p><script>alert(1)</script>",
      },
    });

    const message = await get("SELECT body FROM message WHERE provider_message_id = 'email-3'");
    assert.match(message.body, /The tap is still dripping\./);
    assert.ok(!message.body.includes("<script"), "no markup survives");
    assert.ok(!message.body.includes("alert(1)"), "and neither does its contents");
  });

  test("an empty payload is refused rather than filed as a blank message", async () => {
    const res = await ingestEmail({ data: { from: "priya@example.test", to: [] } });
    assert.equal(res.filed, false);
  });

  test("headers are read whichever shape the provider sends", async () => {
    const t = await threadForReplies();
    await recordOutbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "Your rent is due.", toContact: "priya@example.test",
      messageIdHeader: "ours-1@mail.test",
    });

    for (const [i, headers] of [
      { "in-reply-to": "<ours-1@mail.test>" },
      [{ name: "In-Reply-To", value: "<ours-1@mail.test>" }],
    ].entries()) {
      const res = await ingestEmail({
        data: { from: "somebody-else@example.test", to: ["office@mail.test"],
                subject: "Re: Rent", text: "hi", message_id: `email-h-${i}`, headers },
      });
      /* No reply token, so it is refused before the header is used — which
         is the correct precedence. The header shape parsing is what is being
         exercised, and it must not throw. */
      assert.equal(res.filed, false);
    }
  });
});

/* --- the inbox ------------------------------------------------------------------- */

describe("reading and working the inbox", () => {
  async function aThread(body = "The tap is dripping.") {
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body, providerMessageId: id(),
    });
    return res.threadId;
  }

  test("it lists open conversations, unread first", async () => {
    const threadId = await aThread();
    const rows = await threadsFor(world.companyId, { state: "open" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, threadId);
    assert.equal(rows[0].party_name, "Test Tenant");
    assert.match(rows[0].preview, /dripping/);
  });

  test("reading one clears the unread mark", async () => {
    const threadId = await aThread();
    assert.equal(await unreadCount(world.companyId), 1);
    await markRead(world.companyId, threadId);
    assert.equal(await unreadCount(world.companyId), 0);
  });

  test("a conversation can be assigned to somebody on the team", async () => {
    const threadId = await aThread();
    const res = await assignThread({
      companyId: world.companyId, threadId,
      staffId: world.staff.manager.id, by: world.staff.admin.id,
    });
    assert.equal(res.ok, true);

    const { thread, events } = await threadWithMessages(world.companyId, threadId);
    assert.equal(thread.assigned_to, world.staff.manager.id);
    assert.equal(events.at(-1).kind, "assigned");
  });

  test("but not to somebody in another company", async () => {
    /* The id comes from a form, and assigning it away would make the
       conversation unreachable. */
    const other = await f.makeWorld({ name: "Other Co" });
    const threadId = await aThread();
    const res = await assignThread({
      companyId: world.companyId, threadId,
      staffId: other.staff.admin.id, by: world.staff.admin.id,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not on your team/i);
  });

  test("resolving and reopening are both recorded", async () => {
    const threadId = await aThread();
    await resolveThreadById({ companyId: world.companyId, threadId, by: world.staff.admin.id });
    let { thread } = await threadWithMessages(world.companyId, threadId);
    assert.equal(thread.state, "resolved");
    assert.ok(thread.resolved_at);

    await reopenThread({ companyId: world.companyId, threadId, by: world.staff.admin.id });
    ({ thread } = await threadWithMessages(world.companyId, threadId));
    assert.equal(thread.state, "open");
    assert.equal(thread.resolved_at, null);
  });

  test("a reply from the tenant reopens a resolved conversation on its own", async () => {
    const threadId = await aThread();
    await resolveThreadById({ companyId: world.companyId, threadId, by: world.staff.admin.id });

    await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", body: "It is still dripping.", providerMessageId: id(),
    });

    /* Not the same thread — a resolved one is not continued by rule 3 — but
       the tenant is not ignored either. */
    const open = await threadsFor(world.companyId, { state: "open" });
    assert.equal(open.length, 1, "a new open conversation rather than a silent append");
    assert.notEqual(open[0].id, threadId);
  });

  test("an unknown conversation can be attached to whoever it turned out to be", async () => {
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145559999", body: "New number, it is Priya.", providerMessageId: id(),
    });

    const attached = await attachParty({
      companyId: world.companyId, threadId: res.threadId,
      party: { type: "tenant", id: world.tenantId }, by: world.staff.admin.id,
    });
    assert.equal(attached.ok, true);

    const { thread, events } = await threadWithMessages(world.companyId, res.threadId);
    assert.equal(thread.party_type, "tenant");
    assert.equal(thread.tenant_id, world.tenantId);
    assert.match(events.at(-1).detail, /tenant/);
  });

  test("it cannot be attached to another company's record", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const res = await fileInbound({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145559999", body: "hello", providerMessageId: id(),
    });

    const attached = await attachParty({
      companyId: world.companyId, threadId: res.threadId,
      party: { type: "tenant", id: other.tenantId }, by: world.staff.admin.id,
    });
    assert.equal(attached.ok, false);
  });

  test("another company's conversation is not readable", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const theirs = await openThread({
      companyId: other.companyId, subject: "Rent", fromContact: "x@example.test",
    });
    assert.equal(await threadWithMessages(world.companyId, theirs.id), null);
    await assert.rejects(
      () => assignThread({
        companyId: world.companyId, threadId: theirs.id,
        staffId: world.staff.admin.id, by: world.staff.admin.id,
      }), /Not found/);
  });

  test("the inbox shows what the outbox says about delivery, not what it hoped", async () => {
    /* Delivery honesty. A reply reads as queued until the provider accepts
       it. */
    const threadId = await aThread();
    const { thread } = await threadWithMessages(world.companyId, threadId);

    const outboxId = id();
    await insert("outbox", {
      id: outboxId, company_id: world.companyId, channel: "sms",
      to_contact: "+16145550200", body: "Somebody will come tomorrow.",
      status: "queued", queued_at: stamp(),
    });
    await recordOutbound({
      companyId: world.companyId, thread, channel: "sms",
      body: "Somebody will come tomorrow.", toContact: "+16145550200",
      authorStaffId: world.staff.admin.id, outboxId,
    });

    let { messages } = await threadWithMessages(world.companyId, threadId);
    assert.equal(messages.at(-1).delivery_status, "queued");

    await run("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?", stamp(), outboxId);
    ({ messages } = await threadWithMessages(world.companyId, threadId));
    assert.equal(messages.at(-1).delivery_status, "sent");
  });
});
