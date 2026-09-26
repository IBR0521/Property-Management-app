/* Subscription billing, and what a lapsed one does.

   Two things matter more than the rest. Read-only has to mean read-only —
   every write refused, every read still working — because the alternative is
   either a customer who can quietly keep using an unpaid account or one whose
   data appears to have vanished. And a webhook has to be believed only when it
   is signed, then acted on exactly once, because Stripe delivers at least once
   and replays for days. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_signature_checks";

const { freshDatabase, truncateAll, closeDb, all, get, run } = await import("./helpers/db.js");
const { startApp, client } = await import("./helpers/http.js");
const f = await import("./helpers/factories.js");
const { verifyWebhookSignature, signWebhook, encode, SIGNATURE_TOLERANCE_SECONDS } =
  await import("../server/lib/stripe.js");
const { applyStripeEvent, applyDodoEvent, subscriptionFor, companyIsReadOnly, readOnlyExempt } =
  await import("../server/features/billing.js");
const { verifyWebhookSignature: verifyDodo, signWebhook: signDodo } =
  await import("../server/lib/dodo.js");
const { isWorking, monthlyCents, PER_DOOR_CENTS, describeStatus } =
  await import("../server/lib/plans.js");

const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let app, world;

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Billing Co" });
});

describe("the bill is the door count", () => {
  test("one door is the rate, and twenty-five doors are twenty-five times that", () => {
    assert.equal(PER_DOOR_CENTS, 200);
    assert.equal(monthlyCents(0), 0);
    assert.equal(monthlyCents(1), 200);
    assert.equal(monthlyCents(25), 25 * 200);
    assert.equal(monthlyCents(26), 26 * 200);
  });

  test("the bill does not know how much rent was collected", () => {
    /* The function takes a door count and nothing else. A busier month of
       rent is the same bill as a quiet one. */
    assert.equal(monthlyCents(10), 10 * PER_DOOR_CENTS);
  });
});

describe("what counts as still working", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  test("a live trial works", () => {
    assert.equal(isWorking({ status: "trialing", trial_ends_at: "2026-06-20T00:00:00Z" }, now), true);
  });

  test("an expired trial does not", () => {
    assert.equal(isWorking({ status: "trialing", trial_ends_at: "2026-06-01T00:00:00Z" }, now), false);
  });

  test("a failed payment still works while the card is retried", () => {
    /* An expired card is not a departed customer, and locking a manager out
       of their emergency queue over the first retry is the worse failure. */
    assert.equal(isWorking({ status: "past_due" }, now), true);
  });

  test("cancelled and unpaid do not", () => {
    assert.equal(isWorking({ status: "canceled" }, now), false);
    assert.equal(isWorking({ status: "unpaid" }, now), false);
  });

  test("no subscription row at all does not lock anybody out", () => {
    assert.equal(isWorking(null, now), true);
  });
});

describe("a lapsed subscription is read-only, not deleted", () => {
  async function lapse(companyId) {
    const sub = await subscriptionFor(companyId);
    await run("UPDATE subscription SET status = 'canceled' WHERE id = ?", sub.id);
  }

  test("every read still works", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await lapse(world.companyId);

    for (const path of ["/app", "/app/portfolio", "/app/accounting", "/app/maintenance", "/app/billing"]) {
      assert.equal((await c.get(path)).status, 200, `${path} must still load`);
    }
  });

  test("writes are refused, with a way to fix it", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    await lapse(world.companyId);

    const res = await c.post("/app/portfolio/new",
      { line1: "1 Nowhere", city: "Columbus", owner_id: world.ownerId },
      { csrfFrom: "/app/portfolio" });

    assert.equal(res.status, 402, "payment required, not forbidden and not a crash");
    const body = await res.text();
    assert.match(body, /read-only/i);
    assert.match(body, /nothing has been deleted/i,
      "the message has to answer the question somebody actually has");
  });

  test("nothing is deleted", async () => {
    const before = await all("SELECT id FROM unit WHERE company_id = ?", world.companyId);
    await lapse(world.companyId);
    const after = await all("SELECT id FROM unit WHERE company_id = ?", world.companyId);
    assert.deepEqual(after.map((u) => u.id), before.map((u) => u.id));
  });

  test("paying is still possible while read-only", async () => {
    /* The obvious trap: blocking writes so thoroughly that the customer
       cannot start the subscription that would unblock them. */
    assert.equal(readOnlyExempt("/app/billing"), true);
    assert.equal(readOnlyExempt("/app/billing/choose"), true);
    assert.equal(readOnlyExempt("/app/sign-out"), true);
    assert.equal(readOnlyExempt("/app/portfolio/new"), false);
  });

  test("a working subscription writes normally", async () => {
    const c = client(app.origin);
    await c.signIn(world.staff.admin.email, f.PASSWORD);
    const res = await c.post("/app/portfolio/new",
      { line1: "2 Somewhere", city: "Columbus", state: "OH", owner_id: world.ownerId, kind: "single" },
      { csrfFrom: "/app/portfolio/new" });
    assert.equal(res.status, 303);
    assert.equal(await companyIsReadOnly(world.companyId), false);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });

  test("a correctly signed request is accepted", () => {
    const header = signWebhook({ rawBody: body, secret: SECRET });
    assert.equal(verifyWebhookSignature({ rawBody: body, header, secret: SECRET }).ok, true);
  });

  test("a tampered body is rejected", () => {
    const header = signWebhook({ rawBody: body, secret: SECRET });
    const tampered = body.replace("invoice.paid", "invoice.payment_failed");
    assert.equal(verifyWebhookSignature({ rawBody: tampered, header, secret: SECRET }).ok, false);
  });

  test("another secret is rejected", () => {
    const header = signWebhook({ rawBody: body, secret: "whsec_something_else_entirely" });
    assert.equal(verifyWebhookSignature({ rawBody: body, header, secret: SECRET }).ok, false);
  });

  test("an old signature is rejected", () => {
    const old = Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 10;
    const header = signWebhook({ rawBody: body, secret: SECRET, timestamp: old });
    const r = verifyWebhookSignature({ rawBody: body, header, secret: SECRET });
    assert.equal(r.ok, false);
    assert.match(r.reason, /tolerance/);
  });

  test("several signatures are accepted for key rotation", () => {
    const good = signWebhook({ rawBody: body, secret: SECRET });
    const [t, v1] = good.split(",");
    const header = `${t},v1=00000000000000000000000000000000,${v1.replace("v1=", "v1=")}`;
    assert.equal(verifyWebhookSignature({ rawBody: body, header, secret: SECRET }).ok, true);
  });

  test("no secret configured fails closed", () => {
    const header = signWebhook({ rawBody: body, secret: SECRET });
    const r = verifyWebhookSignature({ rawBody: body, header, secret: null });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no webhook secret/);
  });
});

describe("what the events do", () => {
  test("a completed checkout records the Stripe ids", async () => {
    await applyStripeEvent({
      id: "evt_a", type: "checkout.session.completed",
      data: { object: {
        customer: "cus_1", subscription: "sub_1",
        metadata: { company_id: world.companyId, plan_key: "growth" },
      } },
    });
    const sub = await subscriptionFor(world.companyId);
    assert.equal(sub.stripe_customer_id, "cus_1");
    assert.equal(sub.stripe_subscription_id, "sub_1");
    assert.equal(sub.plan_key, "growth");
  });

  test("a cancellation makes the company read-only without touching its data", async () => {
    await applyStripeEvent({
      id: "evt_b", type: "customer.subscription.created",
      data: { object: { id: "sub_2", customer: "cus_2", status: "active",
        metadata: { company_id: world.companyId } } },
    });
    assert.equal(await companyIsReadOnly(world.companyId), false);

    await applyStripeEvent({
      id: "evt_c", type: "customer.subscription.deleted",
      data: { object: { id: "sub_2", customer: "cus_2",
        metadata: { company_id: world.companyId } } },
    });
    assert.equal(await companyIsReadOnly(world.companyId), true);
    assert.ok((await all("SELECT id FROM unit WHERE company_id = ?", world.companyId)).length > 0);
  });

  test("a failed payment does not lock anybody out", async () => {
    await applyStripeEvent({
      id: "evt_d", type: "invoice.payment_failed",
      data: { object: { customer: "cus_3", metadata: { company_id: world.companyId } } },
    });
    const sub = await subscriptionFor(world.companyId);
    assert.equal(sub.status, "past_due");
    assert.equal(await companyIsReadOnly(world.companyId), false,
      "an expired card is not a departed customer");
  });

  test("an unrecognised status is treated as working, not as a lockout", async () => {
    /* A status we have not seen is far more likely to be a new Stripe state
       than a customer who stopped paying. */
    await applyStripeEvent({
      id: "evt_e", type: "customer.subscription.updated",
      data: { object: { id: "sub_5", customer: "cus_5", status: "some_new_state",
        metadata: { company_id: world.companyId } } },
    });
    assert.equal(await companyIsReadOnly(world.companyId), false);
  });

  test("an event naming no company we know changes nothing", async () => {
    const result = await applyStripeEvent({
      id: "evt_f", type: "invoice.paid",
      data: { object: { customer: "cus_unknown" } },
    });
    assert.match(result.outcome, /no company/);
  });
});

describe("what a Dodo event does", () => {
  const secret = Buffer.from("dodo-webhook-secret").toString("base64");

  test("a signature matches the raw body and rejects a changed one", () => {
    const rawBody = JSON.stringify({ type: "subscription.active" });
    const signed = signDodo({ rawBody, secret, id: "msg_1", timestamp: "1710000000" });
    assert.equal(verifyDodo({
      rawBody, id: signed.id, timestamp: signed.timestamp, signature: signed.signature, secret,
      now: 1710000000 * 1000,
    }).ok, true);
    assert.equal(verifyDodo({
      rawBody: rawBody + " ", id: signed.id, timestamp: signed.timestamp, signature: signed.signature, secret,
      now: 1710000000 * 1000,
    }).ok, false);
  });

  test("an active subscription is recorded and a hold does not lock the company out", async () => {
    await applyDodoEvent({
      type: "subscription.active",
      data: {
        subscription_id: "sub_d1",
        status: "active",
        customer: { customer_id: "cus_d1" },
        metadata: { company_id: world.companyId, plan_key: "starter" },
        next_billing_date: "2026-10-25T00:00:00.000Z",
      },
    });
    const sub = await subscriptionFor(world.companyId);
    assert.equal(sub.dodo_customer_id, "cus_d1");
    assert.equal(sub.dodo_subscription_id, "sub_d1");
    assert.equal(sub.plan_key, "starter");
    assert.equal(sub.status, "active");
    assert.equal(await companyIsReadOnly(world.companyId), false);

    await applyDodoEvent({
      type: "subscription.on_hold",
      data: { subscription_id: "sub_d1", customer: { customer_id: "cus_d1" } },
    });
    assert.equal((await subscriptionFor(world.companyId)).status, "past_due");
    assert.equal(await companyIsReadOnly(world.companyId), false);
  });

  test("a cancellation makes the company read-only", async () => {
    await applyDodoEvent({
      type: "subscription.cancelled",
      data: {
        subscription_id: "sub_d2",
        customer: { customer_id: "cus_d2" },
        metadata: { company_id: world.companyId },
      },
    });
    assert.equal(await companyIsReadOnly(world.companyId), true);
  });
});

describe("the Stripe request encoding", () => {
  test("nested parameters use bracket notation", () => {
    /* Stripe is form-encoded, not JSON, and this is the fiddly part. */
    const encoded = encode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }] });
    const params = new URLSearchParams(encoded);
    assert.equal(params.get("mode"), "subscription");
    assert.equal(params.get("line_items[0][price]"), "price_1");
    assert.equal(params.get("line_items[0][quantity]"), "1");
  });

  test("nulls are omitted rather than sent as the string null", () => {
    const params = new URLSearchParams(encode({ a: "x", b: null, c: undefined }));
    assert.equal(params.get("a"), "x");
    assert.equal(params.has("b"), false);
    assert.equal(params.has("c"), false);
  });
});
