/* What the tenant is charged.

   This arithmetic decides what leaves a real person's bank account, so the
   tests are about the edges rather than the happy path: the ACH cap, rounding
   in a split, and the identity that the amounts always reconcile. Showing a
   tenant one total and charging another is the fastest route to a chargeback,
   and a rounding bug produces exactly that, intermittently.

   Integer cents and basis points throughout. No floating point appears in any
   assertion below, because none appears in the calculation. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  processorFee, quote, describeQuote, methodAvailable, availableMethods,
} from "../server/lib/fees.js";

/* Stripe's published rates, which are the defaults. */
const COMPANY = {
  stripe_account_id: "acct_1", stripe_charges_enabled: 1,
  accept_ach: 1, accept_card: 1,
  ach_fee_bps: 80, ach_fee_cap_cents: 500,
  card_fee_bps: 290, card_fee_fixed_cents: 30,
  ach_fee_model: "absorb", card_fee_model: "pass",
  ach_fee_split_percent: 50, card_fee_split_percent: 50,
};

describe("the processor's fee", () => {
  test("ACH is a percentage until it hits the cap", () => {
    assert.equal(processorFee(COMPANY, "ach", 10000), 80, "0.8% of $100 is $0.80");
    assert.equal(processorFee(COMPANY, "ach", 50000), 400, "0.8% of $500 is $4.00");
    assert.equal(processorFee(COMPANY, "ach", 62500), 500, "0.8% of $625 is exactly the cap");
  });

  test("the cap is why rent goes on ACH", () => {
    /* 0.8% of $1,450 would be $11.60. The cap makes it $5. The same rent on a
       card costs $42.35, which is the whole argument. */
    assert.equal(processorFee(COMPANY, "ach", 145000), 500);
    assert.equal(processorFee(COMPANY, "card", 145000), 4235);
  });

  test("card is a percentage plus a fixed amount, with no cap", () => {
    assert.equal(processorFee(COMPANY, "card", 10000), 320, "2.9% of $100 plus 30c");
    assert.equal(processorFee(COMPANY, "card", 500000), 14530, "$5,000 costs $145.30");
  });

  test("zero costs nothing", () => {
    assert.equal(processorFee(COMPANY, "ach", 0), 0);
    assert.equal(processorFee(COMPANY, "card", 0), 0);
  });

  test("a company's own negotiated rate is used, not the published one", () => {
    /* A quoted fee that does not match what is charged is worse than no
       quote, and rates are negotiable at volume. */
    const negotiated = { ...COMPANY, ach_fee_bps: 50, ach_fee_cap_cents: 300 };
    assert.equal(processorFee(negotiated, "ach", 145000), 300);
  });

  test("an uncapped ACH configuration is honoured", () => {
    const uncapped = { ...COMPANY, ach_fee_cap_cents: 0 };
    assert.equal(processorFee(uncapped, "ach", 145000), 1160);
  });
});

describe("who bears it", () => {
  const rent = 145000;

  test("absorb charges the tenant the rent exactly", () => {
    const q = quote({ company: { ...COMPANY, ach_fee_model: "absorb" }, method: "ach", amountCents: rent });
    assert.equal(q.tenantPaysCents, rent);
    assert.equal(q.tenantFeeCents, 0);
    assert.equal(q.companyFeeCents, 500);
    assert.equal(q.companyNetCents, rent - 500);
  });

  test("pass adds the whole fee to what the tenant pays", () => {
    const q = quote({ company: { ...COMPANY, ach_fee_model: "pass" }, method: "ach", amountCents: rent });
    assert.equal(q.tenantPaysCents, rent + 500);
    assert.equal(q.tenantFeeCents, 500);
    assert.equal(q.companyFeeCents, 0);
    assert.equal(q.companyNetCents, rent, "the company nets the rent exactly");
  });

  test("split divides it, and rounds in the tenant's favour", () => {
    const company = { ...COMPANY, card_fee_model: "split", card_fee_split_percent: 50 };
    const q = quote({ company, method: "card", amountCents: 10000 });
    // Fee is 320c; half is 160c exactly.
    assert.equal(q.tenantFeeCents, 160);
    assert.equal(q.companyFeeCents, 160);
  });

  test("an odd split leaves the remainder with the company", () => {
    /* The side that chose the arrangement carries the rounding, rather than
       the tenant being charged a cent more than the configured share. */
    const company = { ...COMPANY, card_fee_model: "split", card_fee_split_percent: 33 };
    const q = quote({ company, method: "card", amountCents: 10000 });
    assert.equal(q.feeCents, 320);
    assert.equal(q.tenantFeeCents, 105, "33% of 320 is 105.6, rounded down");
    assert.equal(q.companyFeeCents, 215);
  });

  test("a split percentage outside 0-100 is clamped", () => {
    for (const [pct, expected] of [[-10, 0], [150, 320]]) {
      const company = { ...COMPANY, card_fee_model: "split", card_fee_split_percent: pct };
      const q = quote({ company, method: "card", amountCents: 10000 });
      assert.equal(q.tenantFeeCents, expected);
    }
  });

  test("the numbers always reconcile", () => {
    /* The identity that has to hold in every model, at every amount: what the
       tenant pays, minus the fee, is what the company nets. */
    for (const model of ["absorb", "pass", "split"]) {
      for (const amount of [1, 999, 10000, 145000, 999999]) {
        for (const method of ["ach", "card"]) {
          const company = {
            ...COMPANY,
            ach_fee_model: model, card_fee_model: model,
            ach_fee_split_percent: 37, card_fee_split_percent: 37,
          };
          const q = quote({ company, method, amountCents: amount });

          assert.equal(q.tenantFeeCents + q.companyFeeCents, q.feeCents,
            `${model}/${method}/${amount}: the fee is split, not invented`);
          assert.equal(q.tenantPaysCents, q.amountCents + q.tenantFeeCents,
            `${model}/${method}/${amount}: the tenant pays rent plus their share`);
          assert.equal(q.companyNetCents, q.tenantPaysCents - q.feeCents,
            `${model}/${method}/${amount}: the company nets what arrived less the fee`);
          assert.ok(Number.isInteger(q.tenantPaysCents), "cents are integers");
        }
      }
    }
  });
});

describe("what the tenant is told", () => {
  test("absorb says there is no charge, rather than saying nothing", () => {
    const q = quote({ company: { ...COMPANY, ach_fee_model: "absorb" }, method: "ach", amountCents: 145000 });
    const line = describeQuote(q);
    assert.match(line, /\$1,450\.00/);
    assert.match(line, /no charge/i);
  });

  test("pass states both numbers and the total", () => {
    const q = quote({ company: { ...COMPANY, ach_fee_model: "pass" }, method: "ach", amountCents: 145000 });
    const line = describeQuote(q);
    assert.match(line, /\$1,455\.00/, "the total they will actually be charged");
    assert.match(line, /\$1,450\.00/, "the rent");
    assert.match(line, /\$5\.00/, "the fee");
  });

  test("split says who pays the rest", () => {
    const company = { ...COMPANY, card_fee_model: "split", card_fee_split_percent: 50 };
    const q = quote({ company, method: "card", amountCents: 10000 });
    assert.match(describeQuote(q), /landlord pays the rest/i);
  });

  test("the wording is plain, not euphemistic", () => {
    /* "Convenience fee" and "service charge" are what somebody calls a fee
       they would rather you did not think about. */
    const q = quote({ company: { ...COMPANY, ach_fee_model: "pass" }, method: "ach", amountCents: 145000 });
    const line = describeQuote(q).toLowerCase();
    assert.ok(!line.includes("convenience"));
    assert.ok(!line.includes("service charge"));
    assert.match(line, /processing fee/);
  });
});

describe("which methods are offered", () => {
  test("none without a connected account", () => {
    assert.deepEqual(availableMethods({ ...COMPANY, stripe_account_id: null }), []);
  });

  test("none while the account cannot take charges", () => {
    /* A connected account can exist and still be unable to accept payments —
       identity checks outstanding, a document rejected weeks later. Showing a
       pay button then produces a failure nobody can explain. */
    assert.deepEqual(availableMethods({ ...COMPANY, stripe_charges_enabled: 0 }), []);
  });

  test("a company chooses what it offers", () => {
    assert.deepEqual(availableMethods({ ...COMPANY, accept_card: 0 }), ["ach"]);
    assert.deepEqual(availableMethods({ ...COMPANY, accept_ach: 0 }), ["card"]);
    assert.deepEqual(availableMethods(COMPANY), ["ach", "card"]);
  });

  test("card is off by default, because the fee is proportional", () => {
    /* Rent is a large amount and a card fee scales with it. A company should
       decide to offer that rather than discover it on a statement. */
    assert.equal(methodAvailable({ ...COMPANY, accept_card: 0 }, "card"), false);
  });
});
