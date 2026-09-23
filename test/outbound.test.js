/* Outbound webhooks.

   Two things here are worth more than the rest of the file.

   **The address check.** A webhook URL is a request this application makes
   on somebody else's instruction, from inside our network — server-side
   request forgery with a form in front of it, and the interesting target is
   169.254.169.254, where a cloud host keeps the credentials for itself. The
   classifier is asserted address by address, including the forms that get
   through a naive check: IPv4 mapped into IPv6, NAT64, and a name that
   resolves to a public address *and* to loopback.

   **Delivery honesty.** A delivery that did not arrive must never read as
   though it did, and a retry must be the same delivery rather than a new
   one — a receiver that de-duplicates on the id would otherwise process the
   same event twice. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import {
  classify, checkUrl, resolveAndCheck, sign, verify, signedHeaders, newSecret, WebhookRefused,
} from "../server/lib/webhooks/sign.js";
import { emit, EVENTS, EVENT_NAMES, wants } from "../server/lib/webhooks/events.js";
import { attempt, sendDue, BACKOFF, DISABLE_AFTER } from "../server/lib/webhooks/send.js";

let world;

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });
beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Hooks Co" });
});

async function endpoint(fields = {}) {
  const row = {
    id: id(), company_id: world.companyId,
    url: "https://hooks.example.com/in", secret: newSecret(),
    events: JSON.stringify([]), active: 1, created_at: stamp(),
    ...fields,
  };
  await insert("webhook_endpoint", row);
  return await get("SELECT * FROM webhook_endpoint WHERE id = ?", row.id);
}

async function delivery(endpointId, payload = '{"type":"test"}') {
  const row = {
    id: id(), company_id: world.companyId, endpoint_id: endpointId,
    event: "work_order.raised", payload, status: "pending", attempts: 0,
    next_attempt_at: stamp(), created_at: stamp(),
  };
  await insert("webhook_delivery", row);
  return await get("SELECT * FROM webhook_delivery WHERE id = ?", row.id);
}

/* A lookup that answers whatever the test says, so the address rules can be
   exercised without depending on the internet or on a DNS server. */
const answers = (...addresses) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

/* --- where it may go --------------------------------------------------------- */

describe("the address check", () => {
  const BLOCKED = [
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "a private range"],
    ["172.16.5.4", "a private range"],
    ["192.168.0.1", "a private range"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "the unspecified range"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "the unspecified address"],
    ["fc00::1", "a unique local address"],
    ["fd00:1234::1", "a unique local address"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
  ];

  for (const [address, why] of BLOCKED) {
    test(`${address} is ${why}`, () => {
      const verdict = classify(address);
      assert.ok(verdict, `${address} was not recognised as an address at all`);
      assert.equal(verdict.public, false);
      assert.match(verdict.why, new RegExp(why.split(" ")[0], "i"));
    });
  }

  test("an IPv4 address wearing an IPv6 hat is still that address", () => {
    /* ::ffff:127.0.0.1 is the form that gets through a check which treats
       IPv6 as opaque. */
    assert.equal(classify("::ffff:127.0.0.1").public, false);
    assert.equal(classify("::ffff:7f00:1").public, false);
    assert.equal(classify("::ffff:169.254.169.254").public, false);
    assert.equal(classify("::ffff:a00:1").public, false, "10.0.0.1 in hex");
  });

  test("NAT64 is a way round every other rule, so it is refused", () => {
    assert.equal(classify("64:ff9b::7f00:1").public, false);
  });

  test("ordinary public addresses are not caught", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1",
      "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(classify(address).public, true, `${address} should be allowed`);
    }
  });

  test("a hostname is resolved and every answer has to be public", async () => {
    const ok = await resolveAndCheck("hooks.example.com", { lookup: answers("93.184.216.34") });
    assert.equal(ok[0].address, "93.184.216.34");

    /* The interesting case: a name that answers with something reasonable
       and something not. One bad answer is a name whose owner is trying
       something. */
    await assert.rejects(
      () => resolveAndCheck("mixed.example.com",
        { lookup: answers("93.184.216.34", "127.0.0.1") }),
      /127\.0\.0\.1/);
  });

  test("a name that does not resolve is refused rather than attempted", async () => {
    await assert.rejects(
      () => resolveAndCheck("nope.invalid", {
        lookup: async () => { const e = new Error("not found"); e.code = "ENOTFOUND"; throw e; } }),
      WebhookRefused);
  });

  test("the URL itself has to be https, with no credentials in it", () => {
    assert.equal(checkUrl("http://hooks.example.com/in").ok, false);
    assert.match(checkUrl("http://hooks.example.com/in").reason, /has to be https/);
    assert.equal(checkUrl("https://user:pw@hooks.example.com/in").ok, false);
    assert.equal(checkUrl("not a url").ok, false);
    assert.equal(checkUrl("https://hooks.example.com/in").ok, true);
  });

  test("a literal private address in the URL is caught before DNS is involved", () => {
    const res = checkUrl("https://169.254.169.254/latest/meta-data/");
    assert.equal(res.ok, false);
    assert.match(res.reason, /link-local/);
    assert.equal(checkUrl("https://[::1]/in").ok, false);
  });
});

/* --- the signature ------------------------------------------------------------ */

describe("signing", () => {
  const secret = "whsec_" + Buffer.from("a-test-secret-of-some-length").toString("base64");

  test("it is HMAC-SHA256 over id.timestamp.body, base64, v1-tagged", () => {
    const expected = "v1," + createHmac("sha256",
      Buffer.from(secret.replace("whsec_", ""), "base64"))
      .update("del_1.1700000000.{\"a\":1}", "utf8").digest("base64");
    assert.equal(
      sign({ id: "del_1", timestamp: 1700000000, body: '{"a":1}', secret }),
      expected);
  });

  test("the id is in the signed material, so a capture cannot be replayed as another delivery", () => {
    const a = sign({ id: "del_1", timestamp: 1700000000, body: "{}", secret });
    const b = sign({ id: "del_2", timestamp: 1700000000, body: "{}", secret });
    assert.notEqual(a, b);
  });

  test("a receiver following the specification accepts it", () => {
    const now = () => 1700000000_000;
    const headers = signedHeaders({ id: "del_1", timestamp: 1700000000, body: "{}", secret });
    const ok = verify({
      id: headers["webhook-id"], timestamp: headers["webhook-timestamp"],
      body: "{}", secret, header: headers["webhook-signature"], now });
    assert.equal(ok.ok, true);
  });

  test("and refuses a changed body, a changed id, or an old timestamp", () => {
    const now = () => 1700000000_000;
    const headers = signedHeaders({ id: "del_1", timestamp: 1700000000, body: "{}", secret });
    const base = { secret, header: headers["webhook-signature"], now, timestamp: 1700000000 };

    assert.equal(verify({ ...base, id: "del_1", body: '{"a":1}' }).ok, false);
    assert.equal(verify({ ...base, id: "del_2", body: "{}" }).ok, false);
    assert.equal(verify({ ...base, id: "del_1", body: "{}",
      now: () => 1700000000_000 + 3600_000 }).ok, false, "an hour later is outside the tolerance");
  });

  test("a secret is generated per endpoint, so one can be rotated alone", () => {
    assert.notEqual(newSecret(), newSecret());
    assert.match(newSecret(), /^whsec_/);
  });
});

/* --- queuing ------------------------------------------------------------------ */

describe("what gets queued", () => {
  test("one delivery per endpoint that wants the event", async () => {
    const wantsAll = await endpoint();
    const wantsOne = await endpoint({ events: JSON.stringify(["payment.recorded"]) });

    const made = await emit({
      companyId: world.companyId, event: "work_order.raised", data: { work_order: { id: "x" } } });
    assert.equal(made.length, 1, "only the endpoint that wants it");
    assert.equal(made[0].endpointId, wantsAll.id);
    assert.ok(wantsOne.id);
  });

  test("no endpoints means nothing queued, and no error", async () => {
    const made = await emit({ companyId: world.companyId, event: "payment.recorded", data: {} });
    assert.deepEqual(made, []);
  });

  test("an endpoint that is off gets nothing", async () => {
    await endpoint({ active: 0, disabled_at: stamp(), disabled_why: "it kept failing" });
    const made = await emit({ companyId: world.companyId, event: "work_order.raised", data: {} });
    assert.deepEqual(made, []);
  });

  test("an empty event list means all of them, including ones added later", () => {
    assert.equal(wants("[]", "work_order.raised"), true);
    assert.equal(wants(JSON.stringify(["payment.recorded"]), "work_order.raised"), false);
    assert.equal(wants(JSON.stringify(["payment.recorded"]), "payment.recorded"), true);
  });

  test("an event nobody declared cannot be emitted", async () => {
    await assert.rejects(
      () => emit({ companyId: world.companyId, event: "made.up", data: {} }),
      /no event called/);
  });

  test("the body is frozen when it fires", async () => {
    const e = await endpoint();
    await emit({
      companyId: world.companyId, event: "work_order.raised",
      data: { work_order: { id: "wo_1", summary: "Tap dripping" } } });

    const row = await get("SELECT * FROM webhook_delivery WHERE endpoint_id = ?", e.id);
    const body = JSON.parse(row.payload);
    assert.equal(body.type, "work_order.raised");
    assert.equal(body.data.work_order.summary, "Tap dripping");
    assert.ok(body.created_at);
  });
});

/* --- what the rest of the application queues ---------------------------------- */

describe("the events the application actually fires", () => {
  test("raising a work order queues one, in the same transaction", async () => {
    await endpoint();
    const { raiseWorkOrder } = await import("../server/lib/workorders.js");
    const raised = await raiseWorkOrder({
      companyId: world.companyId, unitId: world.unitId,
      category: "plumbing", summary: "Tap dripping", channel: "api", alertOnCall: false });

    const row = await get(
      "SELECT * FROM webhook_delivery WHERE event = 'work_order.raised'");
    assert.ok(row, "either the work order exists and the webhook is queued, or neither");
    const body = JSON.parse(row.payload);
    assert.equal(body.data.work_order.id, raised.workOrderId);
    assert.equal(body.data.work_order.summary, "Tap dripping");
  });

  test("a rent payment queues one, from the single writer of owner money", async () => {
    await endpoint();
    const { postMoney } = await import("../server/lib/ledger.js");
    const posted = await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "rent_payment", amountCents: 145000, memo: "June" });

    const row = await get("SELECT * FROM webhook_delivery WHERE event = 'payment.recorded'");
    assert.ok(row);
    const body = JSON.parse(row.payload);
    assert.equal(body.data.journal.id, posted.journalId);
    const net = body.data.journal.splits.reduce(
      (n, s) => n + s.debit_cents - s.credit_cents, 0);
    assert.equal(net, 0, "the payload carries the real posting");
  });

  test("a deposit does not — only the events that were declared", async () => {
    await endpoint();
    const { postMoney } = await import("../server/lib/ledger.js");
    await postMoney({
      companyId: world.companyId, ownerId: world.ownerId, leaseId: world.leaseId,
      date: "2026-06-01", kind: "deposit_held", amountCents: 90000, memo: "deposit" });
    assert.equal((await all("SELECT id FROM webhook_delivery")).length, 0);
  });

  test("every declared event says what it is and what it carries", () => {
    for (const name of EVENT_NAMES) {
      assert.ok(EVENTS[name].describes.length > 20, `${name} needs a real description`);
      assert.ok(EVENTS[name].payload.length > 10, `${name} needs to say what is in it`);
    }
  });
});

/* --- sending ------------------------------------------------------------------ */

describe("delivering", () => {
  /* A sender that records what it was asked to do, so the headers and the
     pinning can be asserted without a network. */
  function recorder(reply = { status: 200, body: "ok" }) {
    const calls = [];
    const send = async (args) => {
      calls.push(args);
      if (typeof reply === "function") return reply(args, calls.length);
      return reply;
    };
    return { send, calls };
  }

  const publicLookup = answers("93.184.216.34");

  test("a 2xx is delivered, and the endpoint's failure count resets", async () => {
    const e = await endpoint({ consecutive_failures: 3 });
    const d = await delivery(e.id);
    const { send, calls } = recorder();

    const out = await attempt(d, { send, lookup: publicLookup });
    assert.equal(out.status, "delivered");
    assert.equal(out.attempts, 1);
    assert.equal(out.response_status, 200);
    assert.ok(out.delivered_at);

    const after = await get("SELECT * FROM webhook_endpoint WHERE id = ?", e.id);
    assert.equal(Number(after.consecutive_failures), 0);
    assert.ok(after.last_success_at);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pinned.address, "93.184.216.34",
      "the connection has to go to the address that was checked");
  });

  test("the request carries the three headers, signed with that endpoint's secret", async () => {
    const e = await endpoint();
    const d = await delivery(e.id, '{"hello":"there"}');
    const { send, calls } = recorder();
    await attempt(d, { send, lookup: publicLookup });

    const headers = calls[0].headers;
    assert.equal(headers["webhook-id"], d.id);
    assert.ok(Number(headers["webhook-timestamp"]) > 0);

    const check = verify({
      id: headers["webhook-id"], timestamp: headers["webhook-timestamp"],
      body: '{"hello":"there"}', secret: e.secret, header: headers["webhook-signature"] });
    assert.equal(check.ok, true, "a receiver with the secret must be able to verify it");

    const wrong = verify({
      id: headers["webhook-id"], timestamp: headers["webhook-timestamp"],
      body: '{"hello":"there"}', secret: newSecret(), header: headers["webhook-signature"] });
    assert.equal(wrong.ok, false, "and one with a different secret must not");
  });

  test("a 500 is retried, with the backoff the screen promises", async () => {
    const e = await endpoint();
    const d = await delivery(e.id);
    const { send } = recorder({ status: 503, body: "down" });

    const now = () => new Date("2026-06-01T10:00:00.000Z");
    const out = await attempt(d, { send, lookup: publicLookup, now });
    assert.equal(out.status, "pending");
    assert.equal(out.attempts, 1);
    assert.equal(out.response_status, 503);
    assert.equal(out.next_attempt_at,
      new Date(now().getTime() + BACKOFF[1] * 60_000).toISOString());
  });

  test("a 404 stops, because retrying a refusal for six hours helps nobody", async () => {
    const e = await endpoint();
    const d = await delivery(e.id);
    const { send } = recorder({ status: 404, body: "no such handler" });

    const out = await attempt(d, { send, lookup: publicLookup });
    assert.equal(out.status, "failed");
    assert.equal(out.next_attempt_at, null);
    assert.match(out.error, /refusal rather than a wobble/);
  });

  test("a 429 is a wobble, not a refusal", async () => {
    const e = await endpoint();
    const d = await delivery(e.id);
    const { send } = recorder({ status: 429, body: "slow down" });
    const out = await attempt(d, { send, lookup: publicLookup });
    assert.equal(out.status, "pending");
  });

  test("it gives up after the last backoff, and says it did", async () => {
    const e = await endpoint();
    let d = await delivery(e.id);
    const { send } = recorder({ status: 500, body: "" });

    for (let i = 0; i < BACKOFF.length; i++) {
      d = await attempt(d, { send, lookup: publicLookup });
    }
    assert.equal(d.status, "dead");
    assert.equal(d.attempts, BACKOFF.length);
    assert.match(d.error, /out of attempts/);
  });

  test("a private address blocks the delivery and turns the endpoint off at once",
    async () => {
      const e = await endpoint({ url: "https://inside.example.com/in" });
      const d = await delivery(e.id);
      const { send, calls } = recorder();

      const out = await attempt(d, { send, lookup: answers("169.254.169.254") });
      assert.equal(out.status, "blocked");
      assert.equal(calls.length, 0, "nothing was sent");
      assert.match(out.error, /link-local/);

      const after = await get("SELECT * FROM webhook_endpoint WHERE id = ?", e.id);
      assert.equal(Number(after.active), 0);
      assert.ok(after.disabled_at);
      assert.match(after.disabled_why, /link-local/,
        "a URL that cannot be sent to will be exactly as wrong in six hours");
    });

  test("the check happens at send time, not only when the URL was saved", async () => {
    /* The URL was fine when it was added. The name now answers with an
       address inside the network, which is the whole attack. */
    const e = await endpoint({ url: "https://was-fine.example.com/in" });
    const d = await delivery(e.id);
    const { send, calls } = recorder();

    const out = await attempt(d, { send, lookup: answers("10.0.0.5") });
    assert.equal(out.status, "blocked");
    assert.equal(calls.length, 0);
  });

  test("an endpoint that keeps failing turns itself off", async () => {
    const e = await endpoint({ consecutive_failures: DISABLE_AFTER - 1 });
    const d = await delivery(e.id);
    const { send } = recorder({ status: 500, body: "" });

    await attempt(d, { send, lookup: publicLookup });
    const after = await get("SELECT * FROM webhook_endpoint WHERE id = ?", e.id);
    assert.equal(Number(after.active), 0);
    assert.match(after.disabled_why, /in a row failed/);
  });

  test("a network error is retried rather than treated as a refusal", async () => {
    const e = await endpoint();
    const d = await delivery(e.id);
    const send = async () => { throw new Error("no answer within 10s"); };
    const out = await attempt(d, { send, lookup: publicLookup });
    assert.equal(out.status, "pending");
    assert.match(out.error, /no answer/);
  });

  test("removing an endpoint takes its queued deliveries with it", async () => {
    const e = await endpoint();
    await delivery(e.id);
    await run("DELETE FROM webhook_endpoint WHERE id = ?", e.id);
    assert.equal((await all("SELECT id FROM webhook_delivery")).length, 0,
      "the screen says anything still queued goes with it, so it has to");
  });

  test("a delivery whose endpoint vanished mid-run fails rather than throwing", async () => {
    /* The scheduler reads a page of deliveries and then works through them.
       An endpoint removed in between leaves it holding a row that no longer
       has anywhere to go, and one bad row must not stop the rest of the run. */
    const e = await endpoint();
    const d = await delivery(e.id);
    await run("DELETE FROM webhook_endpoint WHERE id = ?", e.id);

    const out = await attempt(d);
    assert.equal(out.status, "failed");
    assert.match(out.error, /endpoint was deleted/);
  });
});

/* --- the run ------------------------------------------------------------------ */

describe("the scheduler's pass", () => {
  test("it takes what is due and leaves what is not", async () => {
    const e = await endpoint();
    const due = await delivery(e.id);
    const later = await delivery(e.id);
    await run("UPDATE webhook_delivery SET next_attempt_at = ? WHERE id = ?",
      "2099-01-01T00:00:00.000Z", later.id);

    const out = await sendDue({
      send: async () => ({ status: 200, body: "ok" }),
      lookup: answers("93.184.216.34"),
    });
    assert.equal(out.webhooksAttempted, 1);
    assert.equal(out.webhooksDelivered, 1);

    const untouched = await get("SELECT * FROM webhook_delivery WHERE id = ?", later.id);
    assert.equal(untouched.status, "pending");
    assert.equal(Number(untouched.attempts), 0);
    assert.ok(due.id);
  });

  test("a delivered one is not sent twice", async () => {
    const e = await endpoint();
    await delivery(e.id);
    const opts = {
      send: async () => ({ status: 200, body: "ok" }), lookup: answers("93.184.216.34") };
    await sendDue(opts);
    const second = await sendDue(opts);
    assert.equal(second.webhooksAttempted, 0);
  });
});
