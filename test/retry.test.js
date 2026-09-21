/* Retry, backoff, dead-lettering and consent.

   All driven by an injected clock and a fake provider, so there is no sleeping
   and no network. A timing test that actually waits twelve hours is a test
   nobody runs. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { nextAttemptAt, isDead, outcomeFor, MAX_ATTEMPTS } from "../server/lib/delivery/retry.js";
import { normalise, classifyInbound, record, blockedReason } from "../server/lib/delivery/consent.js";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";

describe("the backoff schedule", () => {
  const T0 = new Date("2026-06-01T12:00:00.000Z");
  const minutesAfter = (iso) => Math.round((new Date(iso) - T0) / 60000);

  test("the first retry is soon, and later ones are not", () => {
    assert.equal(minutesAfter(nextAttemptAt(1, T0)), 1);
    assert.equal(minutesAfter(nextAttemptAt(2, T0)), 5);
    assert.equal(minutesAfter(nextAttemptAt(3, T0)), 25);
    assert.equal(minutesAfter(nextAttemptAt(4, T0)), 120);
  });

  test("there is a terminus", () => {
    assert.equal(nextAttemptAt(MAX_ATTEMPTS, T0), null);
    assert.equal(isDead(MAX_ATTEMPTS), true);
    assert.equal(isDead(MAX_ATTEMPTS - 1), false);
  });

  test("a permanent rejection skips the schedule entirely", () => {
    const o = outcomeFor({ ok: false, retryable: false }, 1, T0);
    assert.equal(o.status, "dead");
    assert.equal(o.permanent, true);
    assert.equal(o.nextAttemptAt, null,
      "retrying a wrong number four more times buries the errors worth reading");
  });

  test("a retryable failure is rescheduled until the attempts run out", () => {
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      const o = outcomeFor({ ok: false, retryable: true }, n, T0);
      assert.equal(o.status, "queued");
      assert.ok(o.nextAttemptAt);
    }
    const last = outcomeFor({ ok: false, retryable: true }, MAX_ATTEMPTS, T0);
    assert.equal(last.status, "dead");
    assert.equal(last.exhausted, true);
  });

  test("success clears the schedule", () => {
    const o = outcomeFor({ ok: true }, 1, T0);
    assert.equal(o.status, "sent");
    assert.equal(o.nextAttemptAt, null);
  });
});

describe("consent", () => {
  let companyId;

  before(async () => {
    await freshDatabase();
    await truncateAll();
    companyId = await f.makeCompany("Consent Co");
  });

  test("addresses are normalised so one person is one row", () => {
    assert.equal(normalise("email", "  Bob@Example.COM "), "bob@example.com");
    assert.equal(normalise("sms", "(614) 555-0142"), "6145550142");
    assert.equal(normalise("sms", "+1 614 555 0142"), "+16145550142");
  });

  test("STOP is recognised, and a sentence containing it is not", () => {
    assert.equal(classifyInbound("STOP"), "stop");
    assert.equal(classifyInbound(" stop "), "stop");
    assert.equal(classifyInbound("UNSUBSCRIBE"), "stop");
    assert.equal(classifyInbound("START"), "start");
    assert.equal(classifyInbound("HELP"), "help");
    assert.equal(classifyInbound("please stop the leaking tap"), null,
      "treating this as an opt-out would cut a tenant off from their own repair updates");
    assert.equal(classifyInbound("the heating stopped working"), null);
  });

  test("a granted address is never blocked", async () => {
    await record(companyId, "sms", "6145550001", "granted", "test");
    assert.equal(await blockedReason(companyId, "sms", "6145550001"), null);
  });

  test("STOP blocks SMS absolutely, transactional or not", async () => {
    await record(companyId, "sms", "6145550002", "revoked", "inbound STOP");
    assert.match(await blockedReason(companyId, "sms", "6145550002", "transactional"), /STOP/);
    assert.match(await blockedReason(companyId, "sms", "6145550002", "informational"), /STOP/);
  });

  test("an email unsubscribe stops marketing but not a rent notice", async () => {
    await record(companyId, "email", "t@example.com", "revoked", "unsubscribe link");
    assert.match(await blockedReason(companyId, "email", "t@example.com", "informational"), /unsubscribed/);
    assert.equal(await blockedReason(companyId, "email", "t@example.com", "transactional"), null,
      "a tenant cannot unsubscribe from being told their lease is ending");
  });

  test("a hard bounce blocks everything, including transactional", async () => {
    await record(companyId, "email", "gone@example.com", "bounced", "provider webhook");
    assert.match(await blockedReason(companyId, "email", "gone@example.com", "transactional"), /bounce/);
  });

  test("consent is scoped to the company that was given it", async () => {
    const other = await f.makeCompany("Other Co");
    await record(companyId, "sms", "6145550003", "revoked", "inbound STOP");
    assert.match(await blockedReason(companyId, "sms", "6145550003"), /STOP/);
    assert.equal(await blockedReason(other, "sms", "6145550003"), null,
      "opting out of one manager's texts is not opting out of another's");
  });

  test("a later state replaces the earlier one rather than duplicating it", async () => {
    await record(companyId, "sms", "6145550004", "revoked", "inbound STOP");
    await record(companyId, "sms", "6145550004", "granted", "inbound START");
    const rows = await all(
      "SELECT state FROM contact_consent WHERE company_id = ? AND contact = ?", companyId, "6145550004");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "granted");
  });
});

describe("the drainer", () => {
  let companyId;

  before(async () => {
    await freshDatabase();
    await truncateAll();
    companyId = await f.makeCompany("Drain Co");
  });

  /* A clock that can be wound forward, so twelve hours of backoff take
     microseconds. */
  function clockFrom(iso) {
    let t = new Date(iso);
    return { now: () => t, advance: (min) => { t = new Date(t.getTime() + min * 60000); } };
  }

  async function queue(overrides = {}) {
    const { insert } = await import("../server/lib/db.js");
    const { id } = await import("../server/lib/ids.js");
    const rowId = id();
    await insert("outbox", {
      id: rowId, company_id: companyId, channel: "email",
      to_contact: "someone@example.com", subject: "Test", body: "Body",
      status: "queued", queued_at: new Date("2026-06-01T11:00:00Z").toISOString(),
      ...overrides,
    });
    return rowId;
  }

  test("when delivery is off, the drainer touches nothing", async () => {
    await run("DELETE FROM outbox");
    const rowId = await queue();
    const { drainOutbox } = await import("../server/lib/scheduler.js");
    let called = 0;
    const res = await drainOutbox({
      mode: "off",
      now: () => new Date("2026-06-01T12:00:00Z"),
      send: async () => { called++; return { ok: true }; },
    });
    assert.equal(called, 0, "off must not reach a provider at all");
    assert.deepEqual(res, { sent: 0, failed: 0, dead: 0, suppressed: 0 });
    const row = await get("SELECT status, attempts FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "queued", "the message stays queued and honest");
    assert.equal(Number(row.attempts), 0);
  });

  test("a successful send records the provider's message id", async () => {
    await run("DELETE FROM outbox");
    const rowId = await queue();
    const { drainOutbox } = await import("../server/lib/scheduler.js");
    const clock = clockFrom("2026-06-01T12:00:00Z");

    const res = await drainOutbox({
      mode: "log", now: clock.now,
      send: async () => ({ ok: true, providerMessageId: "prov-123", provider: "fake" }),
    });

    assert.equal(res.sent, 1);
    const row = await get("SELECT * FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "sent");
    assert.equal(row.provider_message_id, "prov-123");
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.next_attempt_at, null);
  });

  test("a retryable failure is rescheduled, not retried on the next tick", async () => {
    await run("DELETE FROM outbox");
    const rowId = await queue();
    const { drainOutbox } = await import("../server/lib/scheduler.js");
    const clock = clockFrom("2026-06-01T12:00:00Z");
    const failing = async () => ({ ok: false, error: "provider 503", retryable: true, provider: "fake" });

    const first = await drainOutbox({ mode: "log", now: clock.now, send: failing });
    assert.equal(first.failed, 1);

    const row = await get("SELECT * FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "queued");
    assert.equal(row.last_error, "provider 503");
    assert.equal(new Date(row.next_attempt_at).toISOString(), "2026-06-01T12:01:00.000Z");

    /* Immediately draining again must do nothing: the message is not due, and
       hammering a provider that is rate-limiting you is how a blip becomes a
       suspension. */
    let calls = 0;
    const second = await drainOutbox({
      mode: "log", now: clock.now,
      send: async () => { calls++; return { ok: true, provider: "fake" }; },
    });
    assert.equal(calls, 0, "a message inside its backoff window must not be attempted");
    assert.equal(second.sent, 0);

    // Once the window passes, it goes again.
    clock.advance(2);
    const third = await drainOutbox({ mode: "log", now: clock.now, send: async () => ({ ok: true, provider: "fake" }) });
    assert.equal(third.sent, 1);
  });

  test("five failures dead-letter the message", async () => {
    await run("DELETE FROM outbox");
    const rowId = await queue();
    const { drainOutbox } = await import("../server/lib/scheduler.js");
    const clock = clockFrom("2026-06-01T12:00:00Z");
    const failing = async () => ({ ok: false, error: "provider down", retryable: true, provider: "fake" });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await drainOutbox({ mode: "log", now: clock.now, send: failing });
      clock.advance(24 * 60);       // well past any backoff
    }

    const row = await get("SELECT * FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "dead", "a queue that retries forever is a queue nobody reads");
    assert.equal(Number(row.attempts), MAX_ATTEMPTS);
    assert.ok(row.failed_at);
    assert.equal(row.next_attempt_at, null);
  });

  test("a permanent rejection dies on the first attempt", async () => {
    await run("DELETE FROM outbox");
    const rowId = await queue();
    const { drainOutbox } = await import("../server/lib/scheduler.js");
    const res = await drainOutbox({
      mode: "log", now: () => new Date("2026-06-01T12:00:00Z"),
      send: async () => ({ ok: false, error: "not a mobile number", retryable: false, provider: "fake" }),
    });
    assert.equal(res.dead, 1);
    const row = await get("SELECT * FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "dead");
    assert.equal(Number(row.attempts), 1);
  });

  test("a suppressed message is recorded as suppressed, not as a failure", async () => {
    await run("DELETE FROM outbox");
    await run("DELETE FROM contact_consent");
    const rowId = await queue({ channel: "sms", to_contact: "6145559999" });
    await record(companyId, "sms", "6145559999", "revoked", "inbound STOP");

    const { drainOutbox } = await import("../server/lib/scheduler.js");
    const { deliver } = await import("../server/lib/delivery/index.js");
    const res = await drainOutbox({ mode: "log", now: () => new Date("2026-06-01T12:00:00Z"), send: deliver });

    assert.equal(res.suppressed, 1);
    assert.equal(res.dead, 0);
    assert.equal(res.failed, 0);
    const row = await get("SELECT * FROM outbox WHERE id = ?", rowId);
    assert.equal(row.status, "suppressed");
    assert.match(row.last_error, /STOP/);
  });
});

/* The pool is shared across every describe in this file, so it is closed once,
   here, rather than by whichever block happens to finish first. */
after(async () => { await closeDb(); });
