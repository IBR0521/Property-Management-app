/* Which conversation does this belong to?

   The rest of messaging is storage. This is the part where a mistake shows
   one tenant another tenant's correspondence, so most of what is below is
   about the resolver *refusing* to match rather than managing to.

   The rule that earns the most attention is the one that does not exist:
   subject lines are never used. "Re: Rent" from two different tenants is two
   conversations, and merging them is invisible until somebody notices they
   can read a stranger's mail. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import {
  resolveThread, openThread, recordInbound, recordOutbound,
  replyAddress, tokenFromAddress, tokenFromAny, cleanSubject,
  messageIdFor, CONTINUES_WITHIN_DAYS,
} from "../server/lib/threading.js";

let world;

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function threadWith({ email = null, phone = null, state = "open", lastAt = stamp() } = {}) {
  const t = await openThread({
    companyId: world.companyId, subject: "Rent",
    channel: phone ? "sms" : "email",
    fromContact: phone || email, state,
  });
  await run("UPDATE thread SET last_message_at = ? WHERE id = ?", lastAt, t.id);
  return await get("SELECT * FROM thread WHERE id = ?", t.id);
}

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Inbox Co" });
});

/* --- the rule that is not there ----------------------------------------------- */

describe("subject lines", () => {
  test("two tenants writing 'Re: Rent' get two conversations", async () => {
    /* The disclosure this whole file exists to prevent. */
    const mine = await threadWith({ email: "priya@example.test" });

    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "someone.else@example.test",
      toContacts: ["office@leafridge.test"],
      subject: "Re: Rent",
    });

    assert.equal(thread, null, "no match");
    assert.equal(rule, "new");
    assert.notEqual(thread?.id, mine.id);
  });

  test("an identical subject from the same address still matches on the address, not the subject", async () => {
    /* Proving the match came from rule 3 rather than the subject. */
    const mine = await threadWith({ email: "priya@example.test" });
    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test", toContacts: [],
      subject: "something completely different",
    });
    assert.equal(thread.id, mine.id);
    assert.equal(rule, "same-contact", "matched on who, not on what it is called");
  });

  test("the resolver never reads a subject", () => {
    /* A source-level assertion, because the risk is somebody adding it later
       as an apparently helpful improvement — and because the damage would be
       invisible until a tenant mentioned reading a stranger's mail.

       `subject` is accepted as a parameter, so a new thread can be *named*
       after it. What must never happen is the body using it to find an
       existing one, so the parameter list and the comments are removed and
       the word must then be absent entirely. */
    const src = readFileSync(new URL("../server/lib/threading.js", import.meta.url), "utf8");
    const whole = src.slice(
      src.indexOf("export async function resolveThread"),
      src.indexOf("export async function openThread"));

    const body = whole
      .slice(whole.indexOf("}) {"))                 // past the parameter list
      .replace(/\/\*[\s\S]*?\*\//g, "")            // past the comments
      .replace(/\/\/[^\n]*/g, "");

    assert.ok(!/\bsubject\b/i.test(body),
      "resolveThread's body mentions a subject; it must not be used to find a thread");
  });
});

/* --- rule 1: the reply token ---------------------------------------------------- */

describe("a reply token", () => {
  test("it is pulled out of an address however the provider reports it", () => {
    const tok = "abcdefghijklmnopqrstuvwxyz123456";
    for (const form of [
      `reply+${tok}@mail.test`,
      `"Leafridge" <reply+${tok}@mail.test>`,
      ` reply+${tok}@mail.test `,
    ]) {
      assert.equal(tokenFromAddress(form), tok, form);
    }
  });

  test("something that is not one is not one", () => {
    for (const bad of [
      "office@mail.test", "reply@mail.test", "reply+short@mail.test",
      "notreply+abcdefghijklmnopqrstuvwxyz123456@mail.test", "", null,
    ]) {
      assert.equal(tokenFromAddress(bad), null, String(bad));
    }
  });

  test("it is found across To, Cc and the envelope", () => {
    const tok = "abcdefghijklmnopqrstuvwxyz123456";
    assert.equal(tokenFromAny(["office@mail.test", `reply+${tok}@mail.test`]), tok);
    assert.equal(tokenFromAny(["a@b.test", "c@d.test"]), null);
  });

  test("it wins over everything else", async () => {
    /* Even when the sender's address points at a different conversation:
       the token is certain and the address is a guess. */
    const decoy = await threadWith({ email: "priya@example.test" });
    const real = await threadWith({ email: "someone@example.test" });

    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test",
      toContacts: [`reply+${real.reply_token}@mail.test`],
    });
    assert.equal(thread.id, real.id);
    assert.equal(rule, "reply-token");
  });

  test("it resolves even when the company is not yet known", async () => {
    /* The token carries its own company, which is the point: an inbound
       email from an address nobody recognises still lands correctly. */
    const t = await threadWith({ email: "priya@example.test" });
    const { thread, rule } = await resolveThread({
      companyId: null, channel: "email",
      fromContact: "stranger@example.test",
      toContacts: [`reply+${t.reply_token}@mail.test`],
    });
    assert.equal(thread.id, t.id);
    assert.equal(rule, "reply-token");
  });

  test("a token nobody issued does not match anything", async () => {
    await threadWith({ email: "priya@example.test" });
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "stranger@example.test",
      toContacts: ["reply+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@mail.test"],
    });
    assert.equal(thread, null, "falls through rather than pretending");
  });

  test("the reply address is only offered when a domain is configured", async () => {
    /* Unset is a working state: threading falls back to headers and address
       matching. Inventing an address on a domain we do not own would bounce. */
    const t = await threadWith({ email: "priya@example.test" });
    assert.equal(replyAddress(t), null, "no PORTAL_REPLY_DOMAIN in the test env");
    assert.equal(replyAddress(null), null);
  });
});

/* --- rule 2: In-Reply-To -------------------------------------------------------- */

describe("In-Reply-To", () => {
  async function sentMessage(thread, headerId) {
    await recordOutbound({
      companyId: world.companyId, thread, channel: "email",
      body: "Your rent is due.", subject: "Rent", toContact: "priya@example.test",
      messageIdHeader: headerId,
    });
  }

  test("a reply to something we sent lands in that conversation", async () => {
    const t = await threadWith({ email: "priya@example.test" });
    await sentMessage(t, "msg-1@mail.test");

    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "different@example.test", toContacts: [],
      inReplyTo: "<msg-1@mail.test>",
    });
    assert.equal(thread.id, t.id);
    assert.equal(rule, "in-reply-to");
  });

  test("angle brackets are stripped, because clients add them", async () => {
    const t = await threadWith({ email: "priya@example.test" });
    await sentMessage(t, "msg-2@mail.test");
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "x@example.test", toContacts: [], inReplyTo: "msg-2@mail.test",
    });
    assert.equal(thread.id, t.id);
  });

  test("it only matches something we actually sent", async () => {
    /* Otherwise a sender naming any Message-ID puts themselves into that
       conversation. */
    const t = await threadWith({ email: "priya@example.test" });
    await recordInbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "hello", fromContact: "priya@example.test",
      messageIdHeader: "inbound-1@elsewhere.test",
    });

    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "attacker@example.test", toContacts: [],
      inReplyTo: "<inbound-1@elsewhere.test>",
    });
    assert.equal(thread, null, "an inbound header is not a thing we sent");
    assert.equal(rule, "new");
  });

  test("it does not reach across companies", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const theirs = await openThread({
      companyId: other.companyId, subject: "Rent", fromContact: "x@example.test",
    });
    await recordOutbound({
      companyId: other.companyId, thread: theirs, channel: "email",
      body: "hello", toContact: "x@example.test", messageIdHeader: "theirs-1@mail.test",
    });

    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "x@example.test", toContacts: [], inReplyTo: "<theirs-1@mail.test>",
    });
    assert.equal(thread, null);
  });
});

/* --- rule 3: the same person, still talking -------------------------------------- */

describe("matching the sender", () => {
  test("a recent open conversation with the same address continues", async () => {
    const t = await threadWith({ email: "priya@example.test", lastAt: daysAgo(2) });
    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "PRIYA@Example.TEST", toContacts: [],
    });
    assert.equal(thread.id, t.id, "normalised before matching");
    assert.equal(rule, "same-contact");
  });

  test("a stale one does not", async () => {
    /* A leak in March and a rent increase in November are not one errand. */
    await threadWith({ email: "priya@example.test", lastAt: daysAgo(CONTINUES_WITHIN_DAYS + 5) });
    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test", toContacts: [],
    });
    assert.equal(thread, null);
    assert.equal(rule, "new");
  });

  test("a resolved one does not", async () => {
    await threadWith({ email: "priya@example.test", state: "resolved", lastAt: daysAgo(1) });
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test", toContacts: [],
    });
    assert.equal(thread, null, "a finished conversation is finished");
  });

  test("a text and an email are not the same conversation", async () => {
    /* The contact columns are separate on purpose: a phone number and an
       address are different identifiers even for one person. */
    await threadWith({ email: "priya@example.test", lastAt: daysAgo(1) });
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "sms",
      fromContact: "+16145550200", toContacts: [],
    });
    assert.equal(thread, null);
  });

  test("a number matches however it was typed", async () => {
    const t = await threadWith({ phone: "(614) 555-0200", lastAt: daysAgo(1) });
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "sms",
      fromContact: "6145550200", toContacts: [],
    });
    assert.equal(thread.id, t.id);
  });

  test("it does not reach across companies", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await openThread({
      companyId: other.companyId, subject: "Rent", fromContact: "priya@example.test",
    });
    await run("UPDATE thread SET last_message_at = ? WHERE company_id = ?", stamp(), other.companyId);

    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test", toContacts: [],
    });
    assert.equal(thread, null);
  });

  test("the most recent one wins when there are several", async () => {
    const older = await threadWith({ email: "priya@example.test", lastAt: daysAgo(10) });
    const newer = await threadWith({ email: "priya@example.test", lastAt: daysAgo(1) });
    const { thread } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "priya@example.test", toContacts: [],
    });
    assert.equal(thread.id, newer.id);
  });
});

/* --- rule 4, and no company ------------------------------------------------------ */

describe("when nothing matches", () => {
  test("a new conversation, which is always safe", async () => {
    const { thread, rule } = await resolveThread({
      companyId: world.companyId, channel: "email",
      fromContact: "stranger@example.test", toContacts: [],
    });
    assert.equal(thread, null);
    assert.equal(rule, "new");
  });

  test("no company and no token means nothing is threaded", async () => {
    /* A message we cannot attribute is not quietly filed somewhere. */
    const { thread, rule } = await resolveThread({
      companyId: null, channel: "sms", fromContact: "+16145550000", toContacts: [],
    });
    assert.equal(thread, null);
    assert.equal(rule, "no-company");
  });
});

/* --- recording ------------------------------------------------------------------- */

describe("recording what was said", () => {
  test("the same webhook twice is one message", async () => {
    /* Providers deliver at least once; a replay must not duplicate what
       somebody said. */
    const t = await threadWith({ email: "priya@example.test" });
    const args = {
      companyId: world.companyId, thread: t, channel: "email",
      body: "The tap is still dripping.", fromContact: "priya@example.test",
      providerMessageId: "prov-1",
    };
    const first = await recordInbound(args);
    const second = await recordInbound(args);

    assert.equal(second.duplicate, true);
    assert.equal(second.messageId, first.messageId);
    assert.equal((await all("SELECT id FROM message")).length, 1);
  });

  test("an inbound message reopens a resolved conversation", async () => {
    /* Somebody who is still writing to you has not finished, whatever a
       member of staff decided. */
    const t = await threadWith({ email: "priya@example.test", state: "resolved" });
    await recordInbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "Actually it is worse now.", fromContact: "priya@example.test",
    });

    const after = await get("SELECT * FROM thread WHERE id = ?", t.id);
    assert.equal(after.state, "open");
    assert.equal(after.resolved_at, null);
    assert.equal(Number(after.unread), 1);

    const event = await get("SELECT * FROM thread_event WHERE thread_id = ?", t.id);
    assert.equal(event.kind, "reopened");
  });

  test("a reply moves it to waiting and clears the unread flag", async () => {
    const t = await threadWith({ email: "priya@example.test" });
    await recordInbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "hello", fromContact: "priya@example.test",
    });
    const mid = await get("SELECT * FROM thread WHERE id = ?", t.id);
    assert.equal(Number(mid.unread), 1);

    await recordOutbound({
      companyId: world.companyId, thread: mid, channel: "email",
      body: "We will send somebody.", toContact: "priya@example.test",
      authorStaffId: world.staff.admin.id,
    });
    const after = await get("SELECT * FROM thread WHERE id = ?", t.id);
    assert.equal(after.state, "waiting");
    assert.equal(Number(after.unread), 0);
  });

  test("a private note does not change whose turn it is", async () => {
    /* And is never something the other person could read. */
    const t = await threadWith({ email: "priya@example.test" });
    await recordInbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "hello", fromContact: "priya@example.test",
    });

    await recordOutbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "Third time they have reported this.", toContact: null,
      authorStaffId: world.staff.admin.id, isNote: true,
    });

    const after = await get("SELECT * FROM thread WHERE id = ?", t.id);
    assert.equal(after.state, "open", "still theirs to answer");
    const note = await get("SELECT * FROM message WHERE channel = 'note'");
    assert.equal(note.outbox_id, null, "a note was never sent anywhere");
  });

  test("an outbound message links its delivery record both ways", async () => {
    /* So the inbox can show what the outbox says rather than asserting that
       something was sent. */
    const t = await threadWith({ email: "priya@example.test" });
    const outboxId = id();
    await insert("outbox", {
      id: outboxId, company_id: world.companyId, channel: "email",
      to_contact: "priya@example.test", body: "hello", status: "queued",
      queued_at: stamp(),
    });

    const { messageId } = await recordOutbound({
      companyId: world.companyId, thread: t, channel: "email",
      body: "hello", toContact: "priya@example.test", outboxId,
    });

    const message = await get("SELECT * FROM message WHERE id = ?", messageId);
    assert.equal(message.outbox_id, outboxId);
    const row = await get("SELECT * FROM outbox WHERE id = ?", outboxId);
    assert.equal(row.message_id, messageId);
  });
});

/* --- tidying ---------------------------------------------------------------------- */

describe("the subject, for display only", () => {
  test("the hats come off", () => {
    assert.equal(cleanSubject("Re: Re: FW: Rent"), "Rent");
    assert.equal(cleanSubject("RE: rent"), "rent");
    assert.equal(cleanSubject("Fwd:  Leaking tap "), "Leaking tap");
  });

  test("nothing stays nothing", () => {
    for (const empty of ["", "   ", null, undefined, "Re: "]) {
      assert.equal(cleanSubject(empty), null, String(empty));
    }
  });

  test("a message id is built from the message, not from the subject", () => {
    assert.equal(messageIdFor("abc123", "mail.test"), "abc123@mail.test");
  });
});
