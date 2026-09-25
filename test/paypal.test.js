/* PayPal orders are created with the property company's own client id and
   secret. The amount the tenant approves has to be the amount we stored. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createOrder, captureOrder } from "../server/lib/paypal.js";

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function stub(steps) {
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const step = steps[n++] || steps[steps.length - 1];
    return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.json };
  };
}

describe("a PayPal order", () => {
  test("the amount is dollars with cents, from the integer we stored", async () => {
    stub([
      { status: 200, json: { access_token: "tok" } },
      { status: 201, json: { id: "ORDER1", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] } },
    ]);
    const order = await createOrder({
      clientId: "client", secret: "secret", live: false,
      amountCents: 145000, customId: "pay_1",
      returnUrl: "https://app.example.com/back", cancelUrl: "https://app.example.com/cancel",
    });
    assert.equal(order.id, "ORDER1");
    assert.match(order.url, /ORDER1/);
    const body = JSON.parse(calls[1].opts.body);
    assert.equal(body.purchase_units[0].amount.value, "1450.00");
    assert.equal(body.purchase_units[0].amount.currency_code, "USD");
    assert.equal(body.intent, "CAPTURE");
    assert.match(calls[1].url, /api-m\.sandbox\.paypal\.com/);
  });

  test("a live key talks to the live host", async () => {
    stub([
      { status: 200, json: { access_token: "tok" } },
      { status: 201, json: { id: "ORDER2", links: [{ rel: "payer-action", href: "https://www.paypal.com/checkoutnow?token=ORDER2" }] } },
    ]);
    await createOrder({
      clientId: "client", secret: "secret", live: true,
      amountCents: 100, returnUrl: "https://app.example.com/back", cancelUrl: "https://app.example.com/cancel",
    });
    assert.match(calls[0].url, /^https:\/\/api-m\.paypal\.com\//);
  });

  test("capturing an order that was already captured still counts as paid", async () => {
    stub([
      { status: 200, json: { access_token: "tok" } },
      { status: 422, json: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } },
    ]);
    const captured = await captureOrder({
      clientId: "client", secret: "secret", live: false, orderId: "ORDER1",
    });
    assert.equal(captured.status, "COMPLETED");
  });
});
