/* The screen a property manager uses to turn tenant payments on.

   Until this existed, the connection, the fee model and the payment blocks
   could only be set with a database client — which made them settings nobody
   could actually change, and made the whole tenant-facing half unreachable.

   The test that matters most here is the OAuth state check. Without it,
   anybody could hand a signed-in manager a link that attaches *their* Stripe
   account to the manager's company, and every rent payment after that would
   settle into a stranger's bank. It is a one-line check and a total loss if
   it is missing, which is the profile of a thing that should be tested. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, monthKey, today } from "../server/lib/dates.js";

let app, world, staff;

/* Stripe, replaced at the socket, so the real Connect module is under test. */
const calls = [];
let reply = {};
let restoreFetch = null;

function installFakeFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!/^https:\/\/(api|connect)\.stripe\.com/.test(href)) return real(url, init);

    calls.push({ href, account: init.headers?.["stripe-account"] });

    if (href.includes("/oauth/token")) {
      if (reply.oauthError) {
        return json({ error_description: reply.oauthError }, 400);
      }
      return json({ stripe_user_id: reply.accountId || "acct_connected_1" });
    }
    if (href.includes("/accounts/")) {
      if (reply.accountError) return json({ error: { message: reply.accountError } }, 402);
      return json({
        id: reply.accountId || "acct_connected_1",
        charges_enabled: reply.chargesEnabled ?? true,
        payouts_enabled: reply.payoutsEnabled ?? true,
        details_submitted: true,
        requirements: { currently_due: reply.due || [], past_due: [] },
      });
    }
    return json({});
  };
  return () => { globalThis.fetch = real; };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const page = async (path) => {
  const { res, body } = await staff.text(path);
  return { status: res.status, body, res };
};
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
  restoreFetch = installFakeFetch();
});
after(async () => { restoreFetch?.(); await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  calls.length = 0;
  reply = {};
  world = await f.makeWorld({ name: "Settings Co", staffRoles: ["admin", "leasing"] });
  staff = client(app.origin);
  const res = await staff.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
});

/* --- reaching the screen --------------------------------------------------- */

describe("who can open it", () => {
  test("an unconnected company is told what is missing, not shown a broken form", async () => {
    const res = await page("/app/payments");
    assert.equal(res.status, 200);
    assert.match(res.body, /Not connected/);
    assert.match(res.body, /Connect with Stripe/);
  });

  test("it says plainly where the money goes", async () => {
    /* The single most important sentence on the page, and the reason the
       whole design is shaped the way it is. */
    const res = await page("/app/payments");
    assert.match(res.body, /never passes through us/i);
  });

  test("a leasing account cannot see it", async () => {
    /* Leasing has no money capability at all: not the ledger, not the bank,
       and not the account rent settles into. */
    const other = client(app.origin);
    await other.signIn(world.staff.leasing.email, f.PASSWORD);
    const res = await other.get("/app/payments");
    assert.equal(res.status, 403);
  });

  test("and it is not shown a door it cannot open", async () => {
    const other = client(app.origin);
    await other.signIn(world.staff.leasing.email, f.PASSWORD);
    const { body } = await other.text("/app");
    assert.ok(!body.includes("/app/payments"), "the nav hides what the gate would refuse");
  });

  test("signed out, it is not reachable at all", async () => {
    const anon = client(app.origin);
    const res = await anon.get("/app/payments");
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /sign-in/);
  });
});

/* --- connecting ------------------------------------------------------------ */

describe("connecting an account", () => {
  async function startConnect() {
    const res = await staff.post("/app/payments/connect", {}, { csrfFrom: "/app/payments" });
    const url = new URL(res.headers.get("location"));
    return { res, url, state: url.searchParams.get("state") };
  }

  test("it sends the manager to Stripe with a state we generated", async () => {
    const { res, url, state } = await startConnect();
    assert.equal(res.status, 303);
    assert.equal(url.origin + url.pathname, "https://connect.stripe.com/oauth/authorize");
    assert.equal(url.searchParams.get("scope"), "read_write");
    assert.ok(state && state.length >= 16, "a guessable state is no state at all");

    const stored = await get(
      "SELECT value FROM setting WHERE company_id = ? AND key = 'stripe_connect_state'", world.companyId);
    assert.ok(stored, "and it is remembered so the return leg can be checked");
  });

  test("the round trip stores the account and reads back what it can do", async () => {
    const { state } = await startConnect();
    const res = await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    assert.equal(res.status, 303);
    assert.match(loc(res), /connected/i);

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.stripe_account_id, "acct_connected_1");
    assert.equal(Number(company.stripe_charges_enabled), 1);
    assert.ok(company.stripe_checked_at);
  });

  test("a forged state is refused, so nobody can attach their account to your company", async () => {
    /* The attack this stops: a link is handed to a signed-in manager, they
       click it, and from then on their tenants' rent settles into somebody
       else's bank. */
    await startConnect();
    const res = await staff.get("/app/payments/connected?code=ac_123&state=attacker-chosen-value");
    assert.match(loc(res), /did not match/i);

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.stripe_account_id, null, "nothing was attached");
  });

  test("a state with no request behind it is refused", async () => {
    const res = await staff.get("/app/payments/connected?code=ac_123&state=whatever");
    assert.match(loc(res), /did not match/i);
  });

  test("a state is single use", async () => {
    const { state } = await startConnect();
    await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    await run("UPDATE company SET stripe_account_id = NULL WHERE id = ?", world.companyId);

    const again = await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    assert.match(loc(again), /did not match/i, "replaying the callback does not reconnect");
  });

  test("a state left in a browser tab for a week expires", async () => {
    const { state } = await startConnect();
    await run(
      `UPDATE setting SET value = ? WHERE company_id = ? AND key = 'stripe_connect_state'`,
      JSON.stringify({ state, at: "2020-01-01T00:00:00.000Z", by: world.staff.admin.id }),
      world.companyId);

    const res = await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    assert.match(loc(res), /expired/i);
  });

  test("Stripe refusing the exchange is reported, not swallowed", async () => {
    const { state } = await startConnect();
    reply.oauthError = "The authorization code has already been used.";
    const res = await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    assert.match(loc(res), /already been used/);
  });

  test("the manager cancelling on Stripe's page is not an error page", async () => {
    const res = await staff.get(
      "/app/payments/connected?error=access_denied&error_description=The%20user%20denied%20your%20request");
    assert.match(loc(res), /denied/i);
  });

  test("one Stripe account cannot serve two companies", async () => {
    /* Otherwise one company's rent settles into another's bank, and the
       webhook cannot tell whose payment it is looking at. */
    const other = await f.makeWorld({ name: "Other Co" });
    await run("UPDATE company SET stripe_account_id = ? WHERE id = ?", "acct_connected_1", other.companyId);

    const { state } = await startConnect();
    const res = await staff.get(`/app/payments/connected?code=ac_123&state=${state}`);
    assert.match(loc(res), /already connected to another company/i);

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.stripe_account_id, null);
  });
});

/* --- what the screen says about a connected account ------------------------ */

describe("reporting what the account can do", () => {
  async function connect(patch = {}) {
    await run(
      `UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = ?,
              stripe_payouts_enabled = ?, stripe_requirements = ?, stripe_checked_at = ?
        WHERE id = ?`,
      "acct_connected_1", patch.charges ?? 1, patch.payouts ?? 1,
      JSON.stringify(patch.due || []), stamp(), world.companyId);
  }

  test("ready is reported as ready", async () => {
    await connect();
    const res = await page("/app/payments");
    assert.match(res.body, /Ready to take payments/);
  });

  test("outstanding requirements are named", async () => {
    await connect({ charges: 0, due: ["individual.verification.document"] });
    const res = await page("/app/payments");
    assert.match(res.body, /Stripe needs something from you/);
    assert.match(res.body, /individual\.verification\.document/);
  });

  test("under review with nothing due says so, rather than listing nothing", async () => {
    /* The common and confusing case a day after connecting: charges are off,
       the requirements list is empty, and nothing the manager does will speed
       it up. A screen that shows an empty list here looks broken. */
    await connect({ charges: 0, due: [] });
    const res = await page("/app/payments");
    assert.match(res.body, /still reviewing/i);
    assert.match(res.body, /nothing you do will speed it up/i);
  });

  test("checking again re-reads it from Stripe rather than trusting the stored value", async () => {
    await connect({ charges: 1 });
    reply.chargesEnabled = false;
    reply.due = ["company.tax_id"];

    await staff.post("/app/payments/refresh", {}, { csrfFrom: "/app/payments" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(Number(company.stripe_charges_enabled), 0, "a document rejected weeks later shows up here");
    assert.match(company.stripe_requirements, /company\.tax_id/);
  });

  test("the check carries the Stripe-Account header", async () => {
    /* Without it the call is made as the platform and answers about us. */
    await connect();
    await staff.post("/app/payments/refresh", {}, { csrfFrom: "/app/payments" });
    const accountCall = calls.find((c) => c.href.includes("/accounts/"));
    assert.equal(accountCall.account, "acct_connected_1");
  });

  test("Stripe being unreachable is reported, not shown as a healthy account", async () => {
    await connect();
    reply.accountError = "Stripe is temporarily unavailable.";
    const res = await staff.post("/app/payments/refresh", {}, { csrfFrom: "/app/payments" });
    assert.match(loc(res), /could not be reached/i);
  });
});

/* --- disconnecting --------------------------------------------------------- */

describe("disconnecting", () => {
  beforeEach(async () => {
    await run("UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1 WHERE id = ?",
      "acct_connected_1", world.companyId);
  });

  test("it clears the connection and stops online payment", async () => {
    const res = await staff.post("/app/payments/disconnect", {}, { csrfFrom: "/app/payments" });
    assert.match(loc(res), /no longer pay online/i);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.stripe_account_id, null);
    assert.equal(Number(company.stripe_charges_enabled), 0);
  });

  test("but not while money is still clearing", async () => {
    /* A payment in flight settles against the account it was created on.
       Forgetting the id would leave the webhook unable to find the company
       the money belongs to. */
    await insert("tenant_payment", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      kind: "ach", amount_cents: 145000, charged_cents: 145000,
      period: monthKey(today()), status: "processing",
      initiated_by: "tenant", created_at: stamp(),
    });

    const res = await staff.post("/app/payments/disconnect", {}, { csrfFrom: "/app/payments" });
    assert.match(loc(res), /still clearing/i);
    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.stripe_account_id, "acct_connected_1", "still connected");
  });
});

/* --- fees ------------------------------------------------------------------ */

describe("who bears the fee", () => {
  beforeEach(async () => {
    await run("UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1 WHERE id = ?",
      "acct_connected_1", world.companyId);
  });

  test("the screen previews what a tenant will actually be told", async () => {
    await run("UPDATE company SET accept_ach = 1, ach_fee_model = 'pass' WHERE id = ?", world.companyId);
    const res = await page("/app/payments");
    assert.match(res.body, /\$1,455\.00/, "rent plus the capped fee, the tenant's own wording");
  });

  test("saving changes what the tenant is charged", async () => {
    await staff.post("/app/payments/fees", {
      accept_ach: "on", ach_fee_model: "pass",
      ach_fee_bps: "80", ach_fee_cap: "5.00",
      card_fee_model: "pass", card_fee_bps: "290", card_fee_fixed: "0.30",
      ach_fee_split_percent: "50", card_fee_split_percent: "50",
    }, { csrfFrom: "/app/payments" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(company.ach_fee_model, "pass");
    assert.equal(Number(company.ach_fee_cap_cents), 500);
    assert.equal(Number(company.accept_card), 0, "an unticked box is off, not unchanged");
  });

  test("a negotiated rate is honoured, not overwritten with the published one", async () => {
    await staff.post("/app/payments/fees", {
      accept_ach: "on", ach_fee_model: "absorb",
      ach_fee_bps: "50", ach_fee_cap: "3.00",
      card_fee_model: "pass", card_fee_bps: "290", card_fee_fixed: "0.30",
      ach_fee_split_percent: "50", card_fee_split_percent: "50",
    }, { csrfFrom: "/app/payments" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(Number(company.ach_fee_bps), 50);
    assert.equal(Number(company.ach_fee_cap_cents), 300);
  });

  test("a split percentage outside 0-100 is clamped rather than stored", async () => {
    await staff.post("/app/payments/fees", {
      accept_ach: "on", ach_fee_model: "split", ach_fee_split_percent: "400",
      ach_fee_bps: "80", ach_fee_cap: "5.00",
      card_fee_model: "pass", card_fee_bps: "290", card_fee_fixed: "0.30",
      card_fee_split_percent: "-20",
    }, { csrfFrom: "/app/payments" });

    const company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
    assert.equal(Number(company.ach_fee_split_percent), 100);
    assert.equal(Number(company.card_fee_split_percent), 0);
  });

  test("turning every method off says so plainly", async () => {
    await run("UPDATE company SET accept_ach = 0, accept_card = 0 WHERE id = ?", world.companyId);
    const res = await page("/app/payments");
    assert.match(res.body, /no tenant can pay online/i);
  });

  test("surcharging is flagged for legal review rather than encoded", async () => {
    /* Card-network rules and several US states restrict it, with different
       limits for credit and debit. Fifty jurisdictions is not something to
       reconstruct from memory. */
    const res = await page("/app/payments");
    assert.match(res.body, /regulated/i);
    assert.match(res.body, /states you operate in/i);
  });
});

/* --- blocking a lease ------------------------------------------------------ */

describe("putting a home on cash only", () => {
  test("a reason is required, because the tenant reads it", async () => {
    const res = await staff.post("/app/payments/block",
      { lease_id: world.leaseId, reason: "no" }, { csrfFrom: "/app/payments" });
    assert.match(loc(res), /reason the tenant can act on/i);

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 0);
  });

  test("blocking records who did it and when", async () => {
    await staff.post("/app/payments/block", {
      lease_id: world.leaseId,
      reason: "We have filed for possession. Please call the office on (614) 555-0100.",
    }, { csrfFrom: "/app/payments" });

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 1);
    assert.match(lease.payments_blocked_reason, /filed for possession/);
    assert.equal(lease.payments_blocked_by, world.staff.admin.id);
    assert.ok(lease.payments_blocked_at);
  });

  test("and stops any standing instruction with it", async () => {
    /* Blocking the front door and leaving autopay running would debit the
       tenant during the eviction it was meant to prevent. */
    const mid = id();
    await insert("tenant_payment_method", {
      id: mid, company_id: world.companyId, lease_id: world.leaseId, kind: "ach",
      stripe_payment_method_id: "pm_1", status: "active",
      mandate_accepted_at: stamp(), created_at: stamp(),
    });
    await insert("autopay", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      payment_method_id: mid, days_before_due: 3, active: 1,
      enrolled_at: stamp(), created_at: stamp(),
    });

    await staff.post("/app/payments/block", {
      lease_id: world.leaseId,
      reason: "We have filed for possession. Please call the office.",
    }, { csrfFrom: "/app/payments" });

    const autopay = await get("SELECT * FROM autopay WHERE lease_id = ?", world.leaseId);
    assert.equal(Number(autopay.active), 0);
  });

  test("the tenant sees the company's own words on their page", async () => {
    await staff.post("/app/payments/block", {
      lease_id: world.leaseId,
      reason: "We have filed for possession. Please call the office on (614) 555-0100.",
    }, { csrfFrom: "/app/payments" });

    const lease = await get("SELECT pay_token FROM lease WHERE id = ?", world.leaseId);
    const anon = client(app.origin);
    const { body } = await anon.text(`/pay/${lease.pay_token}`);
    assert.match(body, /filed for possession/);
    assert.ok(!body.includes("Continue to pay"));
  });

  test("a blocked home is listed on the settings screen with its reason", async () => {
    await staff.post("/app/payments/block", {
      lease_id: world.leaseId, reason: "We have filed for possession. Please call the office.",
    }, { csrfFrom: "/app/payments" });

    const res = await page("/app/payments");
    assert.match(res.body, /Homes on cash only/);
    assert.match(res.body, /filed for possession/);
  });

  test("unblocking puts it back", async () => {
    await staff.post("/app/payments/block", {
      lease_id: world.leaseId, reason: "We have filed for possession. Please call the office.",
    }, { csrfFrom: "/app/payments" });
    await staff.post("/app/payments/block",
      { lease_id: world.leaseId, action: "unblock" }, { csrfFrom: "/app/payments" });

    const lease = await get("SELECT * FROM lease WHERE id = ?", world.leaseId);
    assert.equal(Number(lease.payments_blocked), 0);
    assert.equal(lease.payments_blocked_reason, null);
  });

  test("another company's lease cannot be blocked", async () => {
    const other = await f.makeWorld({ name: "Other Co" });
    const res = await staff.post("/app/payments/block",
      { lease_id: other.leaseId, reason: "Trying to reach across the tenancy boundary." },
      { csrfFrom: "/app/payments" });

    assert.equal(res.status, 404);
    const lease = await get("SELECT * FROM lease WHERE id = ?", other.leaseId);
    assert.equal(Number(lease.payments_blocked), 0);
  });
});

/* --- the claim the settings screen makes ---------------------------------- */

describe("finding a tenant's link", () => {
  test("the unit page carries it, because the settings screen says it does", async () => {
    /* Delivery honesty applied to copy: a screen that tells a manager where
       to find something is wrong if the thing is not there. */
    await run("UPDATE company SET stripe_account_id = ?, stripe_charges_enabled = 1 WHERE id = ?",
      "acct_connected_1", world.companyId);
    const settings = await page("/app/payments");
    assert.match(settings.body, /Open a unit under Properties/);

    const lease = await get("SELECT pay_token FROM lease WHERE id = ?", world.leaseId);
    const unit = await page(`/app/portfolio/u/${world.unitId}`);
    assert.match(unit.body, new RegExp(`/pay/${lease.pay_token}`), "the link is on the unit page");
  });

  test("a blocked home shows why instead of a link nobody can use", async () => {
    await staff.post("/app/payments/block", {
      lease_id: world.leaseId, reason: "We have filed for possession. Please call the office.",
    }, { csrfFrom: "/app/payments" });

    const unit = await page(`/app/portfolio/u/${world.unitId}`);
    assert.match(unit.body, /cash only/);
    assert.match(unit.body, /filed for possession/);
  });
});
