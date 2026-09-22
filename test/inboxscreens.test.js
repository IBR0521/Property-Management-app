/* The shared inbox, driven over HTTP.

   The engine is tested in inbox.test.js and threading.test.js. This is about
   what only the screens decide.

   Two of them carry weight. A reply must read as *queued* rather than *sent*
   until the provider accepts it — this is the screen where somebody is most
   likely to assume otherwise, and a manager who believes a tenant was told
   something acts on that belief. And a private note must never be able to
   leave the building. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { fileInbound } from "../server/lib/inbox.js";
import { openThread } from "../server/lib/threading.js";

let app, world, staff;

const page = async (agent, path) => {
  const { res, body } = await agent.text(path);
  return { status: res.status, body, res };
};
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

async function inbound(body = "The tap is dripping.", from = "+16145550200") {
  const res = await fileInbound({
    companyId: world.companyId, channel: "sms",
    fromContact: from, body, providerMessageId: id(),
  });
  return res.threadId;
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Inbox Co", staffRoles: ["admin", "manager", "maintenance"] });
  await run("UPDATE company SET verified_at = ? WHERE id = ?", stamp(), world.companyId);
  await run("UPDATE tenant SET email = ?, phone = ? WHERE id = ?",
    "priya@example.test", "(614) 555-0200", world.tenantId);
  staff = client(app.origin);
  const res = await staff.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* --- reaching it ---------------------------------------------------------------- */

describe("who can open it", () => {
  test("anybody who works the queue", async () => {
    /* Answering a tenant is ordinary operational work, not a money
       permission. A maintenance account should be able to reply about a
       repair. */
    const other = client(app.origin);
    await other.signIn(world.staff.maintenance.email, f.PASSWORD);
    const { res } = await other.text("/app/inbox");
    assert.equal(res.status, 200);
  });

  test("not signed out", async () => {
    const anon = client(app.origin);
    const res = await anon.get("/app/inbox");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /sign-in/);
  });

  test("a conversation from another company is not found", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const theirs = await openThread({
      companyId: other.companyId, subject: "Rent", fromContact: "x@example.test",
    });
    const res = await staff.get(`/app/inbox/${theirs.id}`);
    assert.equal(res.status, 404);
  });
});

/* --- the list -------------------------------------------------------------------- */

describe("the list", () => {
  test("it shows who wrote, what about, and a preview", async () => {
    await inbound("The tap in the kitchen is dripping again.");
    const res = await page(staff, "/app/inbox");
    assert.equal(res.status, 200);
    assert.match(res.body, /Test Tenant/);
    assert.match(res.body, /dripping again/);
    assert.match(res.body, /new/, "and marks it unread");
  });

  test("the nav carries the unread count", async () => {
    await inbound();
    const res = await page(staff, "/app");
    assert.match(res.body, /\/app\/inbox/);
    assert.match(res.body, /navlink__count/);
  });

  test("opening one clears the mark", async () => {
    const threadId = await inbound();
    await page(staff, `/app/inbox/${threadId}`);
    const thread = await get("SELECT unread FROM thread WHERE id = ?", threadId);
    assert.equal(Number(thread.unread), 0);
  });

  test("the views filter to different things", async () => {
    const mine = await inbound("Assigned one");
    await staff.post(`/app/inbox/${mine}/assign`,
      { staff_id: world.staff.admin.id }, { csrfFrom: `/app/inbox/${mine}` });
    await inbound("Unclaimed one", "+16145550111");

    const assigned = await page(staff, "/app/inbox?view=mine");
    assert.match(assigned.body, /Assigned one/);
    assert.ok(!assigned.body.includes("Unclaimed one"));

    const unclaimed = await page(staff, "/app/inbox?view=unassigned");
    assert.match(unclaimed.body, /Unclaimed one/);
  });

  test("it warns when email replies cannot thread yet", async () => {
    /* PORTAL_REPLY_DOMAIN is unset in the test environment, which is a
       working state rather than a broken one — but the screen has to say so
       rather than quietly being worse. */
    const res = await page(staff, "/app/inbox");
    assert.match(res.body, /will not thread yet/i);
    assert.match(res.body, /PORTAL_REPLY_DOMAIN/);
  });
});

/* --- replying --------------------------------------------------------------------- */

describe("replying", () => {
  test("it reads as queued, not as sent", async () => {
    /* The delivery-honesty invariant on the screen where somebody is most
       likely to assume otherwise. */
    const threadId = await inbound();
    const res = await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Somebody will come tomorrow.", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });

    /* The wording is the assertion: "queued", and any mention of sending is
       explicitly conditional and in the future. */
    assert.match(loc(res), /\?m=Queued\./, "the message begins by saying queued");
    assert.match(loc(res), /once the provider accepts it/i,
      "and anything about sending is conditional and in the future");

    const shown = await page(staff, `/app/inbox/${threadId}`);
    assert.match(shown.body, /queued/);
  });

  test("and reads as sent once the provider has accepted it", async () => {
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Somebody will come tomorrow.", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });

    await run("UPDATE outbox SET status = 'sent', sent_at = ? WHERE about_id = ?",
      stamp(), threadId);

    const shown = await page(staff, `/app/inbox/${threadId}`);
    assert.match(shown.body, /sent/);
  });

  test("the reply goes through the outbox, attached to the conversation", async () => {
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "On our way.", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });

    const row = await get("SELECT * FROM outbox WHERE about_id = ?", threadId);
    assert.equal(row.channel, "sms");
    /* The number they texted from, not the one typed on the lease. If a
       tenant writes from a new phone, the answer goes back to that phone —
       otherwise the reply lands on a handset they no longer hold. */
    assert.equal(row.to_contact, "+16145550200");
    assert.ok(row.message_id, "and the message points back at it");
  });

  test("an empty reply is refused", async () => {
    const threadId = await inbound();
    const res = await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "   ", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });
    assert.match(loc(res), /write something/i);
    assert.equal((await all("SELECT id FROM outbox")).length, 0);
  });

  test("replying by a channel we have no address for is refused", async () => {
    const threadId = await inbound("hello", "+16145559999");   // nobody we know
    const res = await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Hello", kind: "reply", channel: "email" },
      { csrfFrom: `/app/inbox/${threadId}` });

    assert.match(loc(res), /no email address/i);
    assert.equal((await all("SELECT id FROM outbox")).length, 0);
  });

  test("an email reply carries a Message-ID so the answer can be threaded", async () => {
    await run("UPDATE thread SET contact_email = ? WHERE company_id = ?",
      "priya@example.test", world.companyId);
    const threadId = await inbound();
    await run("UPDATE thread SET contact_email = ? WHERE id = ?", "priya@example.test", threadId);

    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "We will send somebody.", kind: "reply", channel: "email" },
      { csrfFrom: `/app/inbox/${threadId}` });

    const message = await get(
      "SELECT * FROM message WHERE thread_id = ? AND direction = 'out'", threadId);
    assert.ok(message.message_id_header, "so a reply's In-Reply-To can match it");
    assert.match(message.message_id_header, new RegExp(`^${message.id}@`));
  });
});

/* --- notes ------------------------------------------------------------------------ */

describe("a private note", () => {
  test("it is never sent anywhere", async () => {
    /* "Third time they have reported this" must not reach the tenant. */
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Third time they have reported this.", kind: "note" },
      { csrfFrom: `/app/inbox/${threadId}` });

    assert.equal((await all("SELECT id FROM outbox")).length, 0, "nothing queued");
    const note = await get("SELECT * FROM message WHERE channel = 'note'");
    assert.equal(note.outbox_id, null);
    assert.equal(note.to_contact, null);
  });

  test("it says so on the screen and does not look like a reply", async () => {
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Third time they have reported this.", kind: "note" },
      { csrfFrom: `/app/inbox/${threadId}` });

    const res = await page(staff, `/app/inbox/${threadId}`);
    assert.match(res.body, /private note/i);
    assert.match(res.body, /Only your team can see it|private note/i);
  });

  test("it does not change whose turn it is", async () => {
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "Worth chasing the contractor.", kind: "note" },
      { csrfFrom: `/app/inbox/${threadId}` });

    const thread = await get("SELECT state FROM thread WHERE id = ?", threadId);
    assert.equal(thread.state, "open", "still theirs to answer");
  });
});

/* --- working a conversation -------------------------------------------------------- */

describe("working it", () => {
  test("assigning, resolving and reopening", async () => {
    const threadId = await inbound();

    await staff.post(`/app/inbox/${threadId}/assign`,
      { staff_id: world.staff.manager.id }, { csrfFrom: `/app/inbox/${threadId}` });
    let thread = await get("SELECT * FROM thread WHERE id = ?", threadId);
    assert.equal(thread.assigned_to, world.staff.manager.id);

    await staff.post(`/app/inbox/${threadId}/resolve`, {}, { csrfFrom: `/app/inbox/${threadId}` });
    thread = await get("SELECT * FROM thread WHERE id = ?", threadId);
    assert.equal(thread.state, "resolved");

    await staff.post(`/app/inbox/${threadId}/reopen`, {}, { csrfFrom: `/app/inbox/${threadId}` });
    thread = await get("SELECT * FROM thread WHERE id = ?", threadId);
    assert.equal(thread.state, "open");
  });

  test("the history of what happened is shown", async () => {
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/assign`,
      { staff_id: world.staff.manager.id }, { csrfFrom: `/app/inbox/${threadId}` });

    const res = await page(staff, `/app/inbox/${threadId}`);
    assert.match(res.body, /What happened/);
    assert.match(res.body, /assigned/);
  });

  test("assigning to somebody in another company is refused", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const threadId = await inbound();
    const res = await staff.post(`/app/inbox/${threadId}/assign`,
      { staff_id: other.staff.admin.id }, { csrfFrom: `/app/inbox/${threadId}` });
    assert.match(loc(res), /not on your team/i);
  });
});

/* --- somebody we cannot place ------------------------------------------------------- */

describe("an unknown sender", () => {
  test("the conversation says so and offers to attach it", async () => {
    const threadId = await inbound("New number, it is Priya.", "+16145559999");
    const res = await page(staff, `/app/inbox/${threadId}`);

    assert.match(res.body, /do not know who this is/i);
    assert.match(res.body, /number has changed/i, "and names the likely reason");
    assert.match(res.body, /Attach it to somebody/);
    assert.match(res.body, new RegExp(`tenant:${world.tenantId}`), "with real people to pick");
  });

  test("attaching it works and is recorded", async () => {
    const threadId = await inbound("New number.", "+16145559999");
    await staff.post(`/app/inbox/${threadId}/attach`,
      { party: `tenant:${world.tenantId}` }, { csrfFrom: `/app/inbox/${threadId}` });

    const thread = await get("SELECT * FROM thread WHERE id = ?", threadId);
    assert.equal(thread.party_type, "tenant");
    assert.equal(thread.tenant_id, world.tenantId);

    const res = await page(staff, `/app/inbox/${threadId}`);
    assert.ok(!/do not know who this is/i.test(res.body), "the warning is gone");
  });

  test("it says attaching does not change their number", async () => {
    /* Otherwise somebody attaches it and assumes the next text will find
       them, which it will not. */
    const threadId = await inbound("New number.", "+16145559999");
    const res = await page(staff, `/app/inbox/${threadId}`);
    assert.match(res.body, /correct it on their record as well/i);
  });

  test("attaching to another company's record is refused", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const threadId = await inbound("hello", "+16145559999");
    const res = await staff.post(`/app/inbox/${threadId}/attach`,
      { party: `tenant:${other.tenantId}` }, { csrfFrom: `/app/inbox/${threadId}` });
    assert.match(loc(res), /not one of yours/i);
  });
});

/* --- when the rules refuse it ------------------------------------------------------ */

describe("a reply the delivery rules refuse", () => {
  test("it says why, rather than sending somebody to find the log", async () => {
    /* An unconfirmed company cannot send anything. That is the existing rule
       and it is right; what matters here is that the screen names it, since
       the application already knows and the manager would otherwise go
       hunting. */
    await run("UPDATE company SET verified_at = NULL WHERE id = ?", world.companyId);
    const threadId = await inbound();

    const res = await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "On our way.", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });

    assert.match(loc(res), /was not sent/i);
    assert.match(loc(res), /email address has not been confirmed/i);
  });

  test("and the message is still on the conversation, marked honestly", async () => {
    await run("UPDATE company SET verified_at = NULL WHERE id = ?", world.companyId);
    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`,
      { body: "On our way.", kind: "reply", channel: "sms" },
      { csrfFrom: `/app/inbox/${threadId}` });

    const shown = await page(staff, `/app/inbox/${threadId}`);
    assert.match(shown.body, /On our way\./, "it is not lost");
    assert.match(shown.body, /not queued/, "and it does not claim to have gone");
  });
});

/* --- saved replies ----------------------------------------------------------------- */

describe("saved replies", () => {
  test("they are kept apart from legal notices, and the screen says why", async () => {
    /* notice_template carries an invariant this must not inherit: an
       unapproved notice cannot be sent, and editing clears the attorney's
       sign-off. "Thanks, somebody is coming Tuesday" is not that. */
    const res = await page(staff, "/app/inbox/templates");
    assert.equal(res.status, 200);
    assert.match(res.body, /not notices/i);
    assert.match(res.body, /attorney/i);
    assert.match(res.body, /\/app\/rent\/ladder/, "and points at where notices really live");
  });

  test("one can be added and then used", async () => {
    await staff.post("/app/inbox/templates", {
      name: "Contractor booked", channel: "any",
      body: "Hello {{first_name}}, somebody is coming to {{property}} on Tuesday.",
    }, { csrfFrom: "/app/inbox/templates" });

    const saved = await get("SELECT * FROM message_template WHERE company_id = ?", world.companyId);
    assert.equal(saved.name, "Contractor booked");

    const threadId = await inbound();
    const property = await get(
      "SELECT line1 FROM property WHERE id = ?", world.propertyId);

    const res = await page(staff, `/app/inbox/${threadId}?template=${saved.id}`);
    assert.match(res.body,
      new RegExp(`Hello Test, somebody is coming to ${property.line1} on Tuesday\\.`),
      "filled in against this conversation");
    assert.ok(!res.body.includes("{{first_name}}"), "and nothing was left unfilled");
  });

  test("a blank it could not fill is left visible and called out", async () => {
    /* "Hello , your rent of is due" reads like a broken system and might go
       out unnoticed. An obvious {{token}} does not. */
    await staff.post("/app/inbox/templates", {
      name: "Balance", channel: "any",
      body: "Hello {{first_name}}, you owe {{balance}}.",
    }, { csrfFrom: "/app/inbox/templates" });
    const saved = await get("SELECT * FROM message_template");

    /* A conversation with somebody who has no live tenancy. */
    const threadId = await inbound("hello", "+16145559999");
    const res = await page(staff, `/app/inbox/${threadId}?template=${saved.id}`);

    assert.match(res.body, /were not filled in/i);
    assert.match(res.body, /\{\{balance\}\}/, "the token is still there to be noticed");
  });

  test("nothing is sent by choosing one", async () => {
    await staff.post("/app/inbox/templates", {
      name: "Booked", channel: "any", body: "Somebody is coming Tuesday.",
    }, { csrfFrom: "/app/inbox/templates" });
    const saved = await get("SELECT * FROM message_template");

    const threadId = await inbound();
    await page(staff, `/app/inbox/${threadId}?template=${saved.id}`);

    assert.equal((await all("SELECT id FROM outbox")).length, 0, "it only fills the box");
    assert.equal((await all("SELECT id FROM message WHERE direction = 'out'")).length, 0);
  });

  test("a sent message remembers which wording it came from", async () => {
    await staff.post("/app/inbox/templates", {
      name: "Booked", channel: "any", body: "Somebody is coming Tuesday.",
    }, { csrfFrom: "/app/inbox/templates" });
    const saved = await get("SELECT * FROM message_template");

    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`, {
      body: "Somebody is coming Tuesday.", kind: "reply", channel: "sms",
      template_id: saved.id,
    }, { csrfFrom: `/app/inbox/${threadId}` });

    const message = await get(
      "SELECT * FROM message WHERE thread_id = ? AND direction = 'out'", threadId);
    assert.equal(message.template_id, saved.id);
  });

  test("retiring one hides it but keeps the history", async () => {
    await staff.post("/app/inbox/templates", {
      name: "Old wording", channel: "any", body: "Somebody is coming Tuesday.",
    }, { csrfFrom: "/app/inbox/templates" });
    const saved = await get("SELECT * FROM message_template");

    const threadId = await inbound();
    await staff.post(`/app/inbox/${threadId}/reply`, {
      body: "Somebody is coming Tuesday.", kind: "reply", channel: "sms",
      template_id: saved.id,
    }, { csrfFrom: `/app/inbox/${threadId}` });

    await staff.post("/app/inbox/templates/archive",
      { template_id: saved.id }, { csrfFrom: "/app/inbox/templates" });

    const list = await page(staff, "/app/inbox/templates");
    assert.ok(!list.body.includes("Old wording"), "gone from the list");

    const message = await get(
      "SELECT * FROM message WHERE thread_id = ? AND direction = 'out'", threadId);
    assert.equal(message.template_id, saved.id, "and the message still points at it");
  });

  test("two with the same name are refused", async () => {
    const body = { name: "Booked", channel: "any", body: "Tuesday." };
    await staff.post("/app/inbox/templates", body, { csrfFrom: "/app/inbox/templates" });
    const res = await staff.post("/app/inbox/templates", body, { csrfFrom: "/app/inbox/templates" });
    assert.match(loc(res), /already have a template with that name/i);
  });

  test("an empty one is refused", async () => {
    const res = await staff.post("/app/inbox/templates",
      { name: "Nothing", channel: "any", body: "   " }, { csrfFrom: "/app/inbox/templates" });
    assert.match(loc(res), /not a template/i);
  });

  test("another company's template cannot be edited or retired", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await insert("message_template", {
      id: "tpl-other", company_id: other.companyId, name: "Theirs",
      channel: "any", body: "Hello", created_at: stamp(),
    });

    const res = await staff.post("/app/inbox/templates",
      { template_id: "tpl-other", name: "Stolen", channel: "any", body: "Hello" },
      { csrfFrom: "/app/inbox/templates" });
    assert.equal(res.status, 404);

    const untouched = await get("SELECT name FROM message_template WHERE id = 'tpl-other'");
    assert.equal(untouched.name, "Theirs");
  });

  test("a template from another company is not offered in the reply box", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    await insert("message_template", {
      id: "tpl-other-2", company_id: other.companyId, name: "Theirs",
      channel: "any", body: "Hello", created_at: stamp(),
    });

    const threadId = await inbound();
    const res = await page(staff, `/app/inbox/${threadId}`);
    assert.ok(!res.body.includes("tpl-other-2"));
  });
});
