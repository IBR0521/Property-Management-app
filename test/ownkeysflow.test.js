/* A property company that brought its own Stripe and PayPal keys.

   There is no platform processor account in this test, and no real one is
   called. A stand-in holds the money the way those accounts would: it only
   accepts the company's key, and its balance is what the company's books
   say the processor is holding. Trust cash stays empty, because the money
   has not reached the bank. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { freshDatabase, truncateAll, closeDb, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { signWebhook } from "../server/lib/stripe.js";
import handler from "../api/webhooks/stripe-rent.js";

const STRIPE_KEY = "sk_test_harborcompanykey";
const WEBHOOK_SECRET = "whsec_harborwebhooksecret";
const PAYPAL_ID = "HarborClientId";
const PAYPAL_SECRET = "HarborSecretKey";
const RENT = 145000;
const AHEAD = 20000;

let app;
let restoreFetch;
const calls = [];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFakeProcessor() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({
      href,
      method: init.method || "GET",
      authorization: init.headers?.authorization || "",
      account: init.headers?.["stripe-account"],
      body: init.body ? String(init.body) : "",
    });
    if (href === "https://api.stripe.com/v1/account") {
      return json(200, {
        id: "acct_harbor", charges_enabled: true, payouts_enabled: true,
        requirements: { currently_due: [], past_due: [] },
      });
    }
    if (href === "https://api.stripe.com/v1/checkout/sessions") {
      return json(200, { id: "cs_harbor_1", url: "https://checkout.stripe.com/c/pay/cs_harbor_1" });
    }
    if (href === "https://api-m.sandbox.paypal.com/v1/oauth2/token") {
      return json(200, { access_token: "paypal-sandbox-token" });
    }
    if (href === "https://api-m.sandbox.paypal.com/v2/checkout/orders") {
      return json(201, {
        id: "ORDERHARBOR",
        links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDERHARBOR" }],
      });
    }
    if (href === "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDERHARBOR/capture") {
      return json(201, { id: "ORDERHARBOR", status: "COMPLETED" });
    }
    return real(url, init);
  };
  return () => { globalThis.fetch = real; };
}

async function postWebhook(companyId, event, secret) {
  const rawBody = JSON.stringify(event);
  const req = Readable.from([rawBody]);
  req.method = "POST";
  req.url = `/api/webhooks/stripe-rent?company=${companyId}`;
  req.headers = { "stripe-signature": signWebhook({ rawBody, secret }) };
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) { resolve({ status: this.statusCode, body: body ? String(body) : "" }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function book(companyId, code) {
  const row = await get(
    `SELECT COALESCE(SUM(s.debit_cents - s.credit_cents), 0)::bigint AS c
       FROM journal_split s JOIN account a ON a.id = s.account_id
       JOIN journal j ON j.id = s.journal_id
      WHERE j.company_id = ? AND a.code = ?`,
    companyId, code);
  return Number(row.c);
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  restoreFetch = installFakeProcessor();
});

after(async () => {
  restoreFetch?.();
  await app?.close();
  await closeDb();
});

test("rent lands in the company's own processor balance", async () => {
  const world = await f.makeWorld({ name: "Harbor Property" });
  await run("UPDATE lease SET rent_cents = ? WHERE id = ?", RENT, world.leaseId);
  const lease = await get("SELECT pay_token FROM lease WHERE id = ?", world.leaseId);

  const staff = client(app.origin);
  const signedIn = await staff.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(signedIn.signedIn, true);

  const settings = await staff.text("/app/payments");
  assert.match(settings.body, /Stripe secret key/);
  assert.match(settings.body, /PayPal client id/);

  const savedStripe = await staff.post("/app/payments/stripe-key", {
    secret: STRIPE_KEY, webhook: WEBHOOK_SECRET,
  }, { csrfFrom: "/app/payments" });
  const stripePage = await staff.follow(savedStripe);
  assert.match(stripePage.body, /Stripe key saved/);
  assert.match(stripePage.body, new RegExp(`/api/webhooks/stripe-rent\\?company=${world.companyId}`));

  const savedPayPal = await staff.post("/app/payments/paypal", {
    client_id: PAYPAL_ID, secret: PAYPAL_SECRET,
  }, { csrfFrom: "/app/payments" });
  const paypalPage = await staff.follow(savedPayPal);
  assert.match(paypalPage.body, /PayPal connected/);
  assert.match(paypalPage.body, /Sandbox payments/);

  const stored = await get(
    "SELECT stripe_secret_sealed, stripe_account_id, paypal_client_id FROM company WHERE id = ?",
    world.companyId);
  assert.equal(stored.stripe_account_id, "acct_harbor");
  assert.equal(stored.paypal_client_id, PAYPAL_ID);
  assert.notEqual(stored.stripe_secret_sealed, STRIPE_KEY);
  assert.match(stored.stripe_secret_sealed, /^v1\./);

  const tenant = client(app.origin);
  const pay = await tenant.text(`/pay/${lease.pay_token}`);
  assert.match(pay.body, /Bank account/);
  assert.match(pay.body, /value="paypal"/);
  assert.match(pay.body, /never hold the money/i);
  assert.ok(!/name="card/.test(pay.body));

  const ach = await tenant.post(`/pay/${lease.pay_token}`, { amount: "1450.00", kind: "ach" });
  assert.equal(ach.status, 303);
  assert.match(ach.headers.get("location"), /^https:\/\/checkout\.stripe\.com\//);

  const checkout = calls.find((c) => c.href.endsWith("/checkout/sessions"));
  assert.equal(checkout.authorization, `Bearer ${STRIPE_KEY}`);
  assert.equal(checkout.account, undefined);
  const charged = new URLSearchParams(checkout.body);
  assert.equal(charged.get("line_items[0][price_data][unit_amount]"), String(RENT));
  assert.equal(charged.has("application_fee_amount"), false);

  const payment = await get(
    "SELECT * FROM tenant_payment WHERE lease_id = ? AND kind = 'ach'", world.leaseId);
  const authorised = await postWebhook(world.companyId, {
    id: "evt_harbor_auth",
    type: "checkout.session.completed",
    data: { object: { metadata: { payment_id: payment.id }, payment_status: "unpaid" } },
  }, WEBHOOK_SECRET);
  assert.equal(authorised.status, 200);
  assert.equal((await get("SELECT status FROM tenant_payment WHERE id = ?", payment.id)).status, "processing");
  assert.equal(await book(world.companyId, "1020"), 0, "an authorised bank debit is not money yet");

  const forged = await postWebhook(world.companyId, {
    id: "evt_harbor_forged",
    type: "checkout.session.async_payment_succeeded",
    data: { object: { metadata: { payment_id: payment.id } } },
  }, "whsec_somebodyelse");
  assert.equal(forged.status, 401);
  assert.equal((await get("SELECT status FROM tenant_payment WHERE id = ?", payment.id)).status, "processing");

  const cleared = await postWebhook(world.companyId, {
    id: "evt_harbor_paid",
    type: "checkout.session.async_payment_succeeded",
    data: { object: { metadata: { payment_id: payment.id } } },
  }, WEBHOOK_SECRET);
  assert.equal(cleared.status, 200);
  assert.match(cleared.body, /settled/);

  const achRow = await get("SELECT status, amount_cents, fee_cents FROM tenant_payment WHERE id = ?", payment.id);
  assert.equal(achRow.status, "succeeded");
  assert.equal(Number(achRow.amount_cents), RENT);
  assert.equal(Number(achRow.fee_cents), 500, "ACH is capped at $5");
  const stripeHeld = RENT - 500;
  assert.equal(await book(world.companyId, "1020"), stripeHeld);
  assert.equal(await book(world.companyId, "1010"), 0, "nothing has reached the bank, and nothing reached us");

  const paypal = await tenant.post(`/pay/${lease.pay_token}`, { amount: "200.00", kind: "paypal" });
  assert.equal(paypal.status, 303);
  assert.match(paypal.headers.get("location"), /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=ORDERHARBOR/);
  const basic = `Basic ${Buffer.from(`${PAYPAL_ID}:${PAYPAL_SECRET}`).toString("base64")}`;
  const tokenCalls = calls.filter((c) => c.href.endsWith("/v1/oauth2/token"));
  assert.ok(tokenCalls.length >= 1);
  for (const call of tokenCalls) assert.equal(call.authorization, basic);
  const order = calls.find((c) => c.href.endsWith("/v2/checkout/orders"));
  assert.equal(order.authorization, "Bearer paypal-sandbox-token");
  assert.equal(JSON.parse(order.body).purchase_units[0].amount.value, "200.00");
  assert.ok(!calls.some((c) => c.href.startsWith("https://api-m.paypal.com/")),
    "sandbox keys must not talk to the live PayPal host");

  const back = await tenant.get(`/pay/${lease.pay_token}/paypal?token=ORDERHARBOR`);
  assert.equal(back.status, 303);
  assert.match(decodeURIComponent(back.headers.get("location")), /Payment received/);
  const paypalRow = await get(
    "SELECT status, amount_cents, fee_cents FROM tenant_payment WHERE lease_id = ? AND kind = 'paypal'",
    world.leaseId);
  assert.equal(paypalRow.status, "succeeded");
  assert.equal(Number(paypalRow.fee_cents), 0);
  assert.equal(await book(world.companyId, "1020"), stripeHeld + AHEAD);
  assert.equal(await book(world.companyId, "1010"), 0);

  const history = await tenant.text(`/pay/${lease.pay_token}`);
  assert.match(history.body, /\$1,450\.00/);
  assert.match(history.body, /\$200\.00/);
  assert.match(history.body, /Paid/);
});
