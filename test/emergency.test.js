import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";

let app, world;
before(async () => {
  await freshDatabase(); await truncateAll();
  app = await startApp();
  world = await f.makeWorld({ name: "Emergency Path Co" });
});
after(async () => { await app.close(); await closeDb(); });
beforeEach(async () => { await run("DELETE FROM outbox"); });

async function reportEmergency() {
  const c = client(app.origin);
  const csrf = await c.csrf(`/report?u=${world.reportToken}&category=plumbing`);
  const res = await c.post("/report", {
    unit_token: world.reportToken, category: "plumbing", closest: "flooding",
    summary: "Water pouring through the ceiling", phone: "6145550142", name: "Tenant",
  }, { csrf });
  return { res, body: await res.text() };
}

describe("the emergency alert leaves during the request", () => {
  test("with delivery off, the tenant still gets the stop card and the failure is recorded", async () => {
    const { res, body } = await reportEmergency();
    assert.equal(res.status, 200);
    assert.match(body, /call us now|do not wait/i,
      "the stop card is the guarantee and must appear whatever the provider did");

    const wo = await get("SELECT id FROM work_order ORDER BY created_at DESC LIMIT 1");
    const sms = await get(
      "SELECT * FROM outbox WHERE about_id = ? AND channel = 'sms'", wo.id);
    assert.ok(sms, "the attempt is recorded either way");
    assert.equal(sms.status, "queued", "delivery is off, so it honestly stayed queued");

    const events = await all(
      "SELECT note FROM work_order_event WHERE work_order_id = ? AND kind = 'note'", wo.id);
    assert.ok(events.some((e) => /DID NOT SEND/.test(e.note)),
      "a manager must be able to see the on-call number was not reached");
  });

  test("the alert is never left queued for a later drain to send stale", async () => {
    /* A retry in half an hour is not an emergency alert, and a queued row
       would let tomorrow's drain send an hours-old EMERGENCY. */
    const { sendNow } = await import("../server/lib/delivery/now.js");
    const res = await sendNow({
      companyId: world.companyId, channel: "sms", to: "+16145550911",
      subject: "EMERGENCY", body: "test", aboutType: "work_order_emergency", aboutId: "x",
      mode: "log",
      send: async () => ({ ok: false, error: "provider down", retryable: true, provider: "fake" }),
    });
    assert.equal(res.ok, false);
    const row = await get("SELECT status, next_attempt_at FROM outbox WHERE id = ?", res.outboxId);
    assert.equal(row.status, "dead");
    assert.equal(row.next_attempt_at, null);
  });

  test("a provider that hangs does not hold the tenant's response open", async () => {
    const { sendNow } = await import("../server/lib/delivery/now.js");
    const started = Date.now();
    const res = await sendNow({
      companyId: world.companyId, channel: "sms", to: "+16145550911",
      subject: "EMERGENCY", body: "test", mode: "log",
      send: () => new Promise(() => {}),        // never resolves
    });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.ok(elapsed < 7000, `timed out in ${elapsed}ms, must be ~5s`);
    assert.match(res.reason, /no answer from provider/);
  });

  test("a successful send records the provider id", async () => {
    const { sendNow } = await import("../server/lib/delivery/now.js");
    const res = await sendNow({
      companyId: world.companyId, channel: "sms", to: "+16145550911",
      subject: "EMERGENCY", body: "test", mode: "log",
      send: async () => ({ ok: true, providerMessageId: "SM_ok", provider: "fake" }),
    });
    assert.equal(res.ok, true);
    const row = await get("SELECT status, provider_message_id FROM outbox WHERE id = ?", res.outboxId);
    assert.equal(row.status, "sent");
    assert.equal(row.provider_message_id, "SM_ok");
  });
});
