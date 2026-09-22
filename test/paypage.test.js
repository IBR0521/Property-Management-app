/* The page a tenant actually opens, and the instruction they leave behind.

   Two things are being defended here.

   The page takes money from a real person, so it is driven over HTTP rather
   than by calling functions: the token, the form, the refusals, the redirect
   to Stripe. A rule that holds in a unit test and not on the page is a rule
   that does not hold.

   And autopay is a standing instruction to debit somebody's bank account
   without asking again. The tests that matter are the ones about *not*
   charging: over the tenant's ceiling, on a blocked lease, twice in a month,
   when nothing is owed. Charging correctly is the easy half. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, monthKey, dueDateFor, addDays } from "../server/lib/dates.js";
import {
  runAutopay, enrolAutopay, cancelAutopay, autopayDueToday,
  settlePayment, balanceFor,
} from "../server/lib/payments.js";
import { applyConnectEvent } from "../server/features/payments.js";

const RENT = 145000;

let app, world, payToken, anon;

/* Stripe, replaced at the socket rather than at a parameter.

   The HTTP tests below go through the real router, the real feature and the
   real Connect module, so there is nowhere to pass a fake in. Replacing
   `fetch` keeps every one of those layers under test — including the form
   encoding and the `Stripe-Account` header, which is the header that decides
   whose money this is. */
const stripeCalls = [];
let stripeReply = null;

function installFakeFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.startsWith("https://api.stripe.com")) return real(url, init);

    const body = new URLSearchParams(String(init.body || ""));
    stripeCalls.push({
      url: href, account: init.headers?.["stripe-account"],
      idempotencyKey: init.headers?.["idempotency-key"],
      body: Object.fromEntries(body.entries()),
    });

    if (stripeReply?.error) {
      return new Response(JSON.stringify({ error: { message: stripeReply.error, code: stripeReply.code } }),
        { status: 402, headers: { "content-type": "application/json" } });
    }
    const n = stripeCalls.length;
    return new Response(JSON.stringify({
      id: href.includes("/checkout/sessions") ? `cs_test_${n}` : `pi_test_${n}`,
      url: "https://checkout.stripe.com/c/pay/cs_test",
      status: "processing",
      payment_intent: null,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => { globalThis.fetch = real; };
}

let restoreFetch = null;

/* The client hands back a native Response, so the body is a stream and the
   headers are a Headers object. These two keep the assertions about the page
   rather than about that. */
async function page(path) {
  const { res, body } = await anon.text(path);
  return { status: res.status, body, res };
}
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

function fakeStripe(over = {}) {
  const calls = { checkout: [], intents: [] };
  return {
    calls,
    async createCheckoutSession(args) {
      calls.checkout.push(args);
      if (over.checkoutFails) throw new Error(over.checkoutFails);
      return { id: `cs_test_${calls.checkout.length}`, url: "https://checkout.stripe.com/c/pay/cs_test", payment_intent: null };
    },
    async createPaymentIntent(args) {
      calls.intents.push(args);
      if (over.intentFails) {
        const err = new Error(over.intentFails);
        err.stripeCode = over.code;
        throw err;
      }
      return { id: `pi_test_${calls.intents.length}`, status: "processing" };
    },
  };
}

async function connectCompany(patch = {}) {
  await run(
    `UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1,
            accept_ach = 1, accept_card = ?, ach_fee_model = 'absorb'
      WHERE id = ?`,
    "acct_test", patch.card ? 1 : 0, world.companyId);
}

async function savedMethod({ mandate = true } = {}) {
  const mid = id();
  await insert("tenant_payment_method", {
    id: mid, company_id: world.companyId, lease_id: world.leaseId,
    kind: "ach", stripe_payment_method_id: `pm_${mid.slice(-8)}`,
    label: "Bank account", last4: "6789", status: "active",
    mandate_accepted_at: mandate ? stamp() : null,
    created_at: stamp(),
  });
  return mid;
}

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  restoreFetch = installFakeFetch();
});
after(async () => { restoreFetch?.(); await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Pay Co" });
  await run("UPDATE lease SET rent_cents = ?, rent_due_day = 1 WHERE id = ?", RENT, world.leaseId);
  const lease = await get("SELECT pay_token FROM lease WHERE id = ?", world.leaseId);
  payToken = lease.pay_token;
  anon = client(app.origin);
  stripeCalls.length = 0;
  stripeReply = null;
  await connectCompany();
});

/* --- reaching the page ----------------------------------------------------- */

describe("the link", () => {
  test("the token is the whole credential — no account, no password", async () => {
    const res = await page(`/pay/${payToken}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Pay your rent/);
    assert.match(res.body, /Pay Co/);
  });

  test("a token that is not a lease is a 404, not a hint", async () => {
    const res = await page("/pay/not-a-real-token-at-all");
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes("Pay Co"), "a wrong token does not name a company");
  });

  test("one company's token does not open another's lease", async () => {
    /* The token names a lease and the lease names its company, in that order.
       Choosing a company first and looking for the token inside it is the bug
       that made every sticker outside the first company fail. */
    const other = await f.makeWorld({ name: "Other Co" });
    const otherLease = await get("SELECT pay_token FROM lease WHERE id = ?", other.leaseId);

    const res = await page(`/pay/${otherLease.pay_token}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Other Co/);
    assert.ok(!res.body.includes("Pay Co"), "it opened the wrong company's lease");
  });

  test("it shows what is owed, from the ledger", async () => {
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /\$1,450\.00/);
    assert.match(res.body, /Still owing/);
  });

  test("a payment in flight is shown and deducted, so nobody pays twice", async () => {
    await insert("tenant_payment", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      unit_id: world.unitId, kind: "ach", amount_cents: RENT, charged_cents: RENT,
      period: monthKey(today()), status: "processing",
      initiated_by: "tenant", created_at: stamp(),
    });
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /on its way/i);
    assert.match(res.body, /Nothing owing/);
  });

  test("it works without JavaScript", async () => {
    /* A page that takes somebody's money is the wrong place to require it. */
    const res = await page(`/pay/${payToken}`);
    assert.ok(!/<script/i.test(res.body), "no script tag on the payment page");
    assert.match(res.body, /<form method="post"/);
  });
});

/* --- what the page refuses ------------------------------------------------- */

describe("when it will not take a payment", () => {
  test("a blocked lease shows the company's own words, and no pay button", async () => {
    await run(
      `UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ? WHERE id = ?`,
      "We are holding an eviction filing. Please call the office on (614) 555-0100.",
      world.leaseId);

    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /call the office on \(614\) 555-0100/);
    assert.ok(!res.body.includes("Continue to pay"), "the button is gone, not just disabled");
  });

  test("and posting to it anyway is refused", async () => {
    /* The button being absent is not a control; this is. The token is taken
       from the page *before* the block, so what is being tested is the
       server-side check rather than the missing form. */
    const csrf = await anon.csrf(`/pay/${payToken}`);
    await run("UPDATE lease SET payments_blocked = 1 WHERE id = ?", world.leaseId);
    const res = await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" }, { csrf });
    assert.equal(res.status, 303);
    assert.match(loc(res), /contact the office/i);
    assert.equal((await all("SELECT id FROM tenant_payment")).length, 0);
  });

  test("no connected account means the page says so instead of failing later", async () => {
    await run("UPDATE company SET stripe_account_id = NULL WHERE id = ?", world.companyId);
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /not set up yet/i);
    assert.ok(!res.body.includes("Continue to pay"));
  });

  test("a card payment is refused when the company does not offer cards", async () => {
    const res = await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "card" });
    assert.match(loc(res), /not available/i);
  });

  test("a mistyped amount cannot become a five-figure debit", async () => {
    const res = await anon.post(`/pay/${payToken}`, { amount: "1450000.00", kind: "ach" });
    assert.match(loc(res), /call the office/i);
    assert.equal((await all("SELECT id FROM tenant_payment")).length, 0);
  });

  test("zero is refused", async () => {
    const res = await anon.post(`/pay/${payToken}`, { amount: "0", kind: "ach" });
    assert.match(loc(res), /enter the amount/i);
  });
});

/* --- the fee, before they authorise ---------------------------------------- */

describe("what the tenant is told before they commit", () => {
  test("an absorbed fee says there is no charge, rather than saying nothing", async () => {
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /no charge for paying this way/i);
  });

  test("a passed-on fee states both numbers and the total", async () => {
    await run("UPDATE company SET ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /\$1,455\.00/, "the total they will be charged");
    assert.match(res.body, /\$5\.00/, "the fee itself");
  });

  test("the wording is plain, not euphemistic", async () => {
    await run("UPDATE company SET ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const res = await page(`/pay/${payToken}`);
    const body = res.body.toLowerCase();
    assert.ok(!body.includes("convenience fee"));
    assert.ok(!body.includes("service charge"));
    assert.match(body, /processing fee/);
  });

  test("both methods are priced side by side when both are offered", async () => {
    /* The whole argument for ACH is visible only if the card fee is too. */
    await connectCompany({ card: true });
    const res = await page(`/pay/${payToken}`);
    assert.match(res.body, /Bank account/);
    assert.match(res.body, /Debit or credit card/);
    assert.match(res.body, /\$42\.35/, "2.9% + 30c on $1,450");
  });
});

/* --- the checkout ---------------------------------------------------------- */

describe("handing off to Stripe", () => {
  test("the tenant is redirected to Stripe, not asked for a bank number here", async () => {
    const res = await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    assert.equal(res.status, 303, "303 so a refresh does not repost the form");
    assert.match(res.headers.get("location"), /^https:\/\/checkout\.stripe\.com\//);
  });

  test("no field on the page ever asks for card or bank details", async () => {
    /* The PCI surface stays with Stripe because nothing here could collect it
       even by accident. */
    const res = await page(`/pay/${payToken}`);
    for (const pattern of [/name="card/i, /name="account_number/i, /name="routing/i, /autocomplete="cc-/i]) {
      assert.ok(!pattern.test(res.body), `the page has a field matching ${pattern}`);
    }
  });

  test("the payment row is created before Stripe is called, and carries the quote", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const row = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);
    assert.equal(Number(row.amount_cents), RENT);
    assert.equal(Number(row.fee_cents), 500);
    assert.equal(row.status, "pending");
    assert.ok(row.stripe_checkout_session_id);
  });

  test("nothing reaches either book at this point", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    assert.equal((await all("SELECT id FROM ledger_entry")).length, 0);
    assert.equal((await all("SELECT id FROM journal")).length, 0);
  });

  test("the return page says authorised, not paid", async () => {
    /* An ACH debit takes days. Telling somebody it is paid when the money has
       not moved is the delivery-honesty rule applied to money. */
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const row = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    const res = await page(`/pay/${payToken}/back?s=${row.stripe_checkout_session_id}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /authorised/i);
    assert.match(res.body, /two to five working days/i);
    assert.ok(!/Payment complete/.test(res.body), "it does not claim the money arrived");
  });

  test("and says paid once it actually has", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const row = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);
    await settlePayment({ paymentId: row.id });

    const res = await page(`/pay/${payToken}/back?s=${row.stripe_checkout_session_id}`);
    assert.match(res.body, /Payment complete/);
  });

  test("a session id from another lease is not honoured", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const otherLease = await get("SELECT pay_token FROM lease WHERE id = ?", other.leaseId);
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const row = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    const res = await page(`/pay/${otherLease.pay_token}/back?s=${row.stripe_checkout_session_id}`);
    assert.equal(res.status, 303, "it falls back rather than showing another tenant's payment");
  });
});

/* --- autopay: switching it on ---------------------------------------------- */

describe("turning autopay on", () => {
  test("it cannot be switched on without a saved account", async () => {
    const res = await anon.post(`/pay/${payToken}/autopay`, { max_amount: "1500.00", days_before: "3" }, { csrfFrom: `/pay/${payToken}` });
    assert.match(loc(res), /save this account/i);
    assert.equal((await all("SELECT id FROM autopay")).length, 0);
  });

  test("a ceiling is required, not optional", async () => {
    /* An unbounded instruction to take whatever is owed is what turns a rent
       rise into an overdraft. */
    await savedMethod();
    const res = await anon.post(`/pay/${payToken}/autopay`, { max_amount: "", days_before: "3" }, { csrfFrom: `/pay/${payToken}` });
    assert.match(loc(res), /the most we may take/i);
    assert.equal((await all("SELECT id FROM autopay")).length, 0);
  });

  test("a ceiling below the rent is refused as useless", async () => {
    await savedMethod();
    const res = await anon.post(`/pay/${payToken}/autopay`, { max_amount: "100.00", days_before: "3" }, { csrfFrom: `/pay/${payToken}` });
    assert.match(loc(res), /below your current rent/i);
  });

  test("with a saved account and a ceiling, it goes on", async () => {
    await savedMethod();
    const res = await anon.post(`/pay/${payToken}/autopay`, { max_amount: "1500.00", days_before: "3" }, { csrfFrom: `/pay/${payToken}` });
    assert.match(loc(res), /automatic payments are on/i);

    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.equal(Number(row.active), 1);
    assert.equal(Number(row.max_amount_cents), 150000);
    assert.equal(Number(row.days_before_due), 3);
  });

  test("a method with no recorded consent cannot back a standing instruction", async () => {
    /* Charging off-session against a method with no mandate is what an R10
       dispute is decided on. */
    const mid = await savedMethod({ mandate: false });
    const res = await enrolAutopay({
      companyId: world.companyId, leaseId: world.leaseId, paymentMethodId: mid,
      maxAmountCents: 150000,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /authorisation/i);
  });

  test("the tenant can turn it off, and the page offers that", async () => {
    await savedMethod();
    await anon.post(`/pay/${payToken}/autopay`, { max_amount: "1500.00", days_before: "3" }, { csrfFrom: `/pay/${payToken}` });

    const shown = await page(`/pay/${payToken}`);
    assert.match(shown.body, /Turn automatic payments off/);

    const res = await anon.post(`/pay/${payToken}/autopay`, { action: "cancel" }, { csrfFrom: `/pay/${payToken}` });
    assert.match(loc(res), /are off/i);
    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.equal(Number(row.active), 0);
  });
});

/* --- autopay: the run ------------------------------------------------------ */

describe("the autopay run", () => {
  /* The charge date, in the company's own timezone. */
  function chargeDay(daysBefore = 3) {
    /* Worked the same way the code does: the due date `daysBefore` ahead of
       the charge names the month being paid, which at a month boundary is
       next month rather than this one. */
    const target = addDays(today(), daysBefore);
    return addDays(dueDateFor(monthKey(target), 1), -daysBefore);
  }

  async function enrolled({ days = 3, ceiling = 150000 } = {}) {
    const mid = await savedMethod();
    await enrolAutopay({
      companyId: world.companyId, leaseId: world.leaseId, paymentMethodId: mid,
      daysBeforeDue: days, maxAmountCents: ceiling,
    });
    return await get("SELECT * FROM company WHERE id = ?", world.companyId);
  }

  test("it charges on the day, and only on the day", async () => {
    const company = await enrolled();
    const stripe = fakeStripe();

    const early = await runAutopay(company, { localToday: chargeDay(4), stripe });
    assert.equal(early.autopayCharged, 0, "not the day before the charge day");

    const onDay = await runAutopay(company, { localToday: chargeDay(3), stripe });
    assert.equal(onDay.autopayCharged, 1);

    const row = await get("SELECT * FROM tenant_payment WHERE initiated_by = 'autopay'");
    assert.equal(Number(row.amount_cents), RENT);
    assert.equal(stripe.calls.intents[0].offSession, true, "nobody is present to answer a challenge");
  });

  test("it does not charge twice in a month", async () => {
    const company = await enrolled();
    const stripe = fakeStripe();
    await runAutopay(company, { localToday: chargeDay(), stripe });
    const second = await runAutopay(company, { localToday: chargeDay(), stripe });

    assert.equal(second.autopayCharged, 0);
    assert.equal((await all("SELECT id FROM tenant_payment WHERE initiated_by = 'autopay'")).length, 1);
  });

  test("the database refuses a second autopay charge for the period regardless", async () => {
    /* Belt and braces: if the scheduler's own guard were ever wrong, the
       unique index is what stops somebody being debited twice. */
    const company = await enrolled();
    await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    const existing = await get("SELECT * FROM tenant_payment WHERE initiated_by = 'autopay'");

    await assert.rejects(() => insert("tenant_payment", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      kind: "ach", amount_cents: RENT, charged_cents: RENT,
      period: existing.period, status: "pending", initiated_by: "autopay",
      created_at: stamp(),
    }), /duplicate key/);
  });

  test("over the tenant's ceiling it charges nothing at all", async () => {
    /* Not the ceiling amount, and not the old rent. A part payment nobody
       asked for leaves them short and late at the same time, and the point of
       the ceiling is that this gets a human decision. */
    const company = await enrolled({ ceiling: 100000 });
    const stripe = fakeStripe();

    const res = await runAutopay(company, { localToday: chargeDay(), stripe });
    assert.equal(res.autopayCharged, 0);
    assert.equal(res.autopaySkipped, 1);
    assert.equal(stripe.calls.intents.length, 0, "Stripe was not called at all");

    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.match(row.last_skip_reason, /over the \$1,000\.00 limit/);
  });

  test("and the tenant is told why on their own page", async () => {
    const company = await enrolled({ ceiling: 100000 });
    await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });

    const shown = await page(`/pay/${payToken}`);
    assert.match(shown.body, /Nothing was taken last time/);
    assert.match(shown.body, /over the \$1,000\.00 limit/);
  });

  test("nothing owed means nothing taken", async () => {
    const company = await enrolled();
    const period = monthKey(today());
    await insert("tenant_payment", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      unit_id: world.unitId, owner_id: world.ownerId,
      kind: "ach", amount_cents: RENT, charged_cents: RENT,
      period, status: "pending", initiated_by: "tenant", created_at: stamp(),
    });
    const paid = await get("SELECT * FROM tenant_payment");
    await settlePayment({ paymentId: paid.id });

    const res = await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    assert.equal(res.autopayCharged, 0);
    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.match(row.last_skip_reason, /nothing was owed/i);
  });

  test("a blocked lease is not charged, and the reason is the company's", async () => {
    const company = await enrolled();
    await run(
      "UPDATE lease SET payments_blocked = 1, payments_blocked_reason = ? WHERE id = ?",
      "A payment was returned (R02). Please contact the office.", world.leaseId);

    const res = await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    assert.equal(res.autopayCharged, 0);
    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.match(row.last_skip_reason, /R02/);
  });

  test("an ended tenancy is not charged", async () => {
    const company = await enrolled();
    await run("UPDATE lease SET status = 'ended' WHERE id = ?", world.leaseId);
    const res = await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    assert.equal(res.autopayCharged, 0);
  });

  test("a cancelled enrolment is not charged", async () => {
    const company = await enrolled();
    await cancelAutopay(world.leaseId);
    const res = await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    assert.equal(res.autopayCharged, 0);
    assert.equal(res.autopaySkipped, 0, "it is not even considered");
  });

  test("a Stripe failure is recorded against the enrolment, not lost", async () => {
    const company = await enrolled();
    const stripe = fakeStripe({ intentFails: "Your bank declined the debit.", code: "account_closed" });

    const res = await runAutopay(company, { localToday: chargeDay(), stripe });
    assert.equal(res.autopayFailed, 1);
    const row = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.match(row.last_error, /declined/i);
    assert.equal(row.last_period, null, "a failed run does not claim the month");
  });

  test("one lease failing does not stop the rest of the rent roll", async () => {
    const company = await enrolled();
    const secondUnit = await f.makeUnit(world.companyId, world.propertyId, { label: "2" });
    const { leaseId: second } = await f.makeLease(world.companyId, secondUnit, { rentCents: RENT });
    const mid = id();
    await insert("tenant_payment_method", {
      id: mid, company_id: world.companyId, lease_id: second, kind: "ach",
      stripe_payment_method_id: `pm_${mid.slice(-8)}`, status: "active",
      mandate_accepted_at: stamp(), created_at: stamp(),
    });
    await enrolAutopay({
      companyId: world.companyId, leaseId: second, paymentMethodId: mid,
      daysBeforeDue: 3, maxAmountCents: 150000,
    });
    await run("UPDATE lease SET status = 'ended' WHERE id = ?", world.leaseId);

    const res = await runAutopay(company, { localToday: chargeDay(), stripe: fakeStripe() });
    assert.equal(res.autopayCharged, 1, "the healthy lease was still charged");
  });

  test("the charge date honours the lease's own due day", async () => {
    const lease = { rent_due_day: 15 };
    const period = monthKey(today());
    const { charge, due } = autopayDueToday(lease, { days_before_due: 5 }, `${period}-10`);
    assert.equal(due, `${period}-15`);
    assert.equal(charge, `${period}-10`);
  });
});

/* --- what the webhook does with a failure ---------------------------------- */

describe("a failure arriving from Stripe", () => {
  async function settledPayment() {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const row = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);
    await settlePayment({ paymentId: row.id });
    return await get("SELECT * FROM tenant_payment WHERE id = ?", row.id);
  }

  test("after settlement it is a return, and the books are corrected", async () => {
    /* The mapping is by the payment's own state rather than the event's name,
       because Stripe's exact event for an ACH return is the part of this that
       is unverified until real keys exist. */
    const payment = await settledPayment();
    const res = await applyConnectEvent({
      id: "evt_1", type: "charge.failed", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id }, failure_code: "insufficient_funds" } },
    });

    assert.match(res.outcome, /returned/);
    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(after.status, "returned");
    assert.equal(after.return_code, "R01", "Stripe's wording is mapped to the NACHA code");
    assert.ok(after.reversal_journal_id, "the journal was reversed, not deleted");
  });

  test("before settlement the same event is a plain failure", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const payment = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    await applyConnectEvent({
      id: "evt_2", type: "payment_intent.payment_failed", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id }, last_payment_error: { code: "insufficient_funds" } } },
    });

    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(after.status, "failed");
    assert.equal((await all("SELECT id FROM journal")).length, 0, "nothing to reverse");
  });

  test("a dispute is treated as an unauthorised return", async () => {
    /* R10 means the tenant told their bank they never agreed to this.
       Charging them again is how a complaint becomes a regulator's letter. */
    const payment = await settledPayment();
    await applyConnectEvent({
      id: "evt_3", type: "charge.dispute.created", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id } } },
    });

    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(after.return_code, "R10");
    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 1, "the lease goes cash-only");
  });

  test("an event for another company's account does nothing", async () => {
    const payment = await settledPayment();
    const res = await applyConnectEvent({
      id: "evt_4", type: "charge.failed", account: "acct_somebody_else",
      data: { object: { metadata: { payment_id: payment.id }, failure_code: "insufficient_funds" } },
    });
    assert.match(res.outcome, /no connected company/);
    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(after.status, "succeeded", "untouched");
  });

  test("an event type nobody handled is recorded, not swallowed", async () => {
    const res = await applyConnectEvent({
      id: "evt_5", type: "radar.early_fraud_warning.created", account: "acct_test",
      data: { object: {} },
    });
    assert.match(res.outcome, /not handled/);
  });

  test("a settlement delivered twice settles once", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const payment = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);
    const event = {
      id: "evt_6", type: "checkout.session.async_payment_succeeded", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id } } },
    };
    await applyConnectEvent(event);
    const second = await applyConnectEvent(event);

    assert.match(second.outcome, /already settled/);
    assert.equal((await all("SELECT id FROM ledger_entry WHERE kind = 'rent_payment'")).length, 1);
  });

  test("a completed checkout that has not cleared is not settled", async () => {
    /* `payment_status` is what separates a card that has moved from a bank
       debit that has only been asked for. */
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const payment = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    await applyConnectEvent({
      id: "evt_7", type: "checkout.session.completed", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id }, payment_status: "unpaid" } },
    });

    const after = await get("SELECT * FROM tenant_payment WHERE id = ?", payment.id);
    assert.equal(after.status, "processing");
    assert.equal((await all("SELECT id FROM ledger_entry")).length, 0);
  });

  test("a saved account is only kept when the tenant asked for one", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach" });
    const payment = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    await applyConnectEvent({
      id: "evt_8", type: "checkout.session.completed", account: "acct_test",
      data: { object: { metadata: { payment_id: payment.id }, payment_status: "paid" } },
    });
    assert.equal((await all("SELECT id FROM tenant_payment_method")).length, 0,
      "no payment_method on the session means they did not tick the box");
  });

  test("and when they did, the mandate is recorded with it", async () => {
    await anon.post(`/pay/${payToken}`, { amount: "1450.00", kind: "ach", save_method: "on" });
    const payment = await get("SELECT * FROM tenant_payment WHERE lease_id = ?", world.leaseId);

    await applyConnectEvent({
      id: "evt_9", type: "checkout.session.completed", account: "acct_test",
      data: { object: {
        metadata: { payment_id: payment.id }, payment_status: "paid",
        payment_intent: { payment_method: "pm_saved_1" },
      } },
    });

    const method = await get("SELECT * FROM tenant_payment_method WHERE lease_id = ?", world.leaseId);
    assert.ok(method, "the account was kept");
    assert.ok(method.mandate_accepted_at, "with the moment they agreed");
    assert.match(method.mandate_text, /until cancelled/i);
  });
});
