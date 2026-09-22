/* Stripe Connect: the money is never ours.

   One header decides that. `Stripe-Account` on every call is what makes a
   charge belong to the property manager rather than to the platform, and a
   call that omits it would be made as us — which for a charge means us
   receiving somebody's rent.

   So the tests here are mostly about what must *not* appear: no application
   fee, no destination charge, no call without an account. Those are the
   parameters that would quietly turn an orchestrator into a custodian, and
   none of them is the kind of thing anybody notices in review. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/propops_test";
process.env.DATABASE_URL = "postgresql://unused:unused@example.invalid:6543/unused";
process.env.STRIPE_SECRET_KEY = "sk_test_connect";
process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test_client";
process.env.APP_BASE_URL = "https://app.example.com";

const connect = await import("../server/lib/connect.js");

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function stub(responder = () => ({ status: 200, json: { id: "pi_1" } })) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const { status = 200, json = {} } = responder({ url: String(url), opts }) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

const form = (i = 0) => new URLSearchParams(calls[i].opts.body);

describe("every call names the connected account", () => {
  test("the header is present on a payment", async () => {
    stub();
    await connect.createPaymentIntent({ accountId: "acct_123", amountCents: 145000 });
    assert.equal(calls[0].opts.headers["stripe-account"], "acct_123",
      "without this the charge is the platform's, and so is the money");
  });

  test("a call without an account is refused rather than made as us", async () => {
    stub();
    await assert.rejects(
      () => connect.createPaymentIntent({ accountId: null, amountCents: 145000 }),
      /connected account id is required/);
    assert.equal(calls.length, 0, "and no request is sent at all");
  });

  test("customers and setup intents are on their account too", async () => {
    stub(() => ({ status: 200, json: { id: "cus_1" } }));
    await connect.createCustomer({ accountId: "acct_9", name: "Tenant" });
    await connect.createSetupIntent({ accountId: "acct_9", customerId: "cus_1" });
    for (const call of calls) {
      assert.equal(call.opts.headers["stripe-account"], "acct_9");
    }
  });
});

describe("the platform takes no cut", () => {
  test("no application fee is sent on a payment", async () => {
    stub();
    await connect.createPaymentIntent({
      accountId: "acct_123", amountCents: 145000, description: "June rent",
    });
    const body = form();
    assert.equal(body.has("application_fee_amount"), false,
      "this product charges a subscription; skimming each rent payment is what it exists to be unlike");
    assert.equal(body.has("application_fee_percent"), false);
  });

  test("no destination charge, which would route funds through us first", async () => {
    stub();
    await connect.createPaymentIntent({ accountId: "acct_123", amountCents: 145000 });
    const body = form();
    assert.equal(body.has("transfer_data[destination]"), false);
    assert.equal(body.has("on_behalf_of"), false,
      "a direct charge on their account means the money is already theirs");
  });

  test("no fee parameter appears anywhere in the source", () => {
    /* The test that survives a future edit. A reviewer will not notice one
       added parameter; this will. */
    const src = readFileSync(new URL("../server/lib/connect.js", import.meta.url), "utf8");
    for (const forbidden of ["application_fee", "transfer_data", "on_behalf_of"]) {
      const used = new RegExp(`${forbidden}\\s*:`).test(src);
      assert.equal(used, false, `${forbidden} would make the platform a custodian`);
    }
    assert.deepEqual(connect.PLATFORM_FEE_PARAMETERS, []);
  });
});

describe("the payment itself", () => {
  test("amounts are integers and the currency is explicit", async () => {
    stub();
    await connect.createPaymentIntent({ accountId: "acct_1", amountCents: 145000.4 });
    const body = form();
    assert.equal(body.get("amount"), "145000", "rounded, never a fraction of a cent");
    assert.equal(body.get("currency"), "usd");
  });

  test("an autopay charge says nobody is present", async () => {
    /* A bank challenge with nobody there to answer it hangs. Saying so up
       front makes it fail cleanly and be retried with the tenant present. */
    stub();
    await connect.createPaymentIntent({
      accountId: "acct_1", amountCents: 145000, offSession: true, paymentMethodId: "pm_1",
    });
    assert.equal(form().get("off_session"), "true");
  });

  test("a tenant-present charge does not", async () => {
    stub();
    await connect.createPaymentIntent({ accountId: "acct_1", amountCents: 145000 });
    assert.equal(form().get("off_session"), "false");
  });

  test("an idempotency key is sent when given, so a retry is not a second charge", async () => {
    stub();
    await connect.createPaymentIntent({
      accountId: "acct_1", amountCents: 145000, idempotencyKey: "pay:lease1:2026-06",
    });
    assert.equal(calls[0].opts.headers["idempotency-key"], "pay:lease1:2026-06");
  });

  test("metadata carries what the webhook will need to find this again", async () => {
    stub();
    await connect.createPaymentIntent({
      accountId: "acct_1", amountCents: 145000,
      metadata: { lease_id: "lease_1", payment_id: "tp_1", company_id: "co_1" },
    });
    const body = form();
    assert.equal(body.get("metadata[lease_id]"), "lease_1");
    assert.equal(body.get("metadata[payment_id]"), "tp_1");
  });
});

describe("connecting an account", () => {
  test("the authorize URL carries state, so a link cannot attach somebody else's account", () => {
    const url = connect.authorizeUrl({ state: "abc123", email: "manager@firm.test" });
    assert.match(url, /^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
    assert.match(url, /client_id=ca_test_client/);
    assert.match(url, /state=abc123/);
    assert.match(url, /scope=read_write/);
    assert.ok(url.includes(encodeURIComponent("https://app.example.com/app/payments/connected")));
  });

  test("status is read from Stripe rather than assumed", async () => {
    stub(() => ({ status: 200, json: {
      id: "acct_1", charges_enabled: false, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: ["individual.verification.document"], past_due: [], disabled_reason: "requirements.past_due" },
      business_profile: { name: "Leafridge" },
    } }));

    const status = await connect.accountStatus("acct_1");
    assert.equal(status.chargesEnabled, false,
      "a connected account can exist and still not be able to take a payment");
    assert.deepEqual(status.requirements, ["individual.verification.document"]);
    assert.equal(status.businessName, "Leafridge");
  });

  test("requirements from both lists are merged without duplicates", async () => {
    stub(() => ({ status: 200, json: {
      id: "acct_1", charges_enabled: true, payouts_enabled: true,
      requirements: { currently_due: ["external_account"], past_due: ["external_account", "tos_acceptance.date"] },
    } }));
    const status = await connect.accountStatus("acct_1");
    assert.deepEqual(status.requirements.sort(), ["external_account", "tos_acceptance.date"]);
  });

  test("a refused exchange throws rather than returning half an account", async () => {
    stub(() => ({ status: 400, json: { error_description: "This authorization code has already been used." } }));
    await assert.rejects(() => connect.exchangeCode("ac_used"), /already been used/);
  });
});
