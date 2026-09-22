/* The two things a tenant does for themselves.

   Both are shaped by one restraint: the application records what the tenant
   told it and does not decide on their behalf. It does not read a PDF and
   declare somebody insured, and it does not infer from a changed phone number
   whether they want to be texted on it.

   The consent case is the one worth the most attention. Consent is keyed by
   the number rather than by the person, so a new number arrives with no record
   of its own — which the sender treats as permission. Left alone, that means
   changing your phone silently undoes an opt-out. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { insert } from "../server/lib/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { id } from "../server/lib/ids.js";
import { stamp, today, addDays } from "../server/lib/dates.js";
import { linkTenant, personByEmail } from "../server/lib/identity.js";
import { requestLink } from "../server/lib/magiclink.js";
import { stateFor, record } from "../server/lib/delivery/consent.js";

const EMAIL = "priya@example.test";

let app, world;

const page = async (agent, path) => {
  const { res, body } = await agent.text(path);
  return { status: res.status, body, res };
};
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

async function signIn(email = EMAIL) {
  const agent = client(app.origin);
  const link = await requestLink({ email, ip: "1.1.1.1", baseUrl: app.origin });
  assert.equal(link.delivered, true);
  await agent.get(`/portal/enter/${link.secret}`);
  return agent;
}

async function tenantOf(email = EMAIL) {
  await run("UPDATE tenant SET email = ?, phone = ? WHERE id = ?",
    email, "(614) 555-0200", world.tenantId);
  await linkTenant({ tenantId: world.tenantId });
  return await personByEmail(email);
}

/* A multipart POST, which the ordinary form helper does not do. */
async function upload(agent, path, fields, file) {
  const csrf = await agent.csrf(`/portal/renting/${world.leaseId}/insurance`);
  const boundary = "----portaltest" + id();
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "utf8"));

  push(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n`);
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  if (file) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`);
    parts.push(file.bytes);
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);

  return await agent.raw(path, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
}

/* Real magic bytes, because storeUpload sniffs rather than trusting the
   declared type. */
const A_PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n", "ascii"),
  Buffer.alloc(200, 0x20),
]);
const NOT_A_PDF = Buffer.from("<?php echo 'hello'; ?>".padEnd(200, " "), "ascii");

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Portal Co" });
  await run("UPDATE company SET verified_at = ? WHERE id = ?", stamp(), world.companyId);
});

/* --- renters insurance --------------------------------------------------------- */

describe("sending in a policy", () => {
  beforeEach(async () => {
    await run("UPDATE lease SET insurance_required = 1, insurance_min_liability_cents = 10000000 WHERE id = ?",
      world.leaseId);
    await tenantOf();
  });

  test("the page says what the lease asks for", async () => {
    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}/insurance`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Nothing on file/);
    assert.match(res.body, /\$100,000\.00/, "the minimum from the lease, not one we invented");
  });

  test("a policy is recorded as sent in, not as accepted", async () => {
    /* The restraint that matters: reading a PDF and declaring somebody
       insured would be the application asserting a legal fact it cannot
       check. A person confirms. */
    const agent = await signIn();
    const res = await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", policy_no: "BM-4471",
      expires_on: addDays(today(), 300), liability: "100000.00",
    }, { name: "policy.pdf", type: "application/pdf", bytes: A_PDF });

    assert.equal(res.status, 303);
    assert.match(loc(res), /with the office/i);

    const row = await get("SELECT * FROM renters_insurance WHERE lease_id = ?", world.leaseId);
    assert.equal(row.status, "pending", "not accepted by the machine");
    assert.equal(row.uploaded_by, "tenant");
    assert.equal(row.carrier, "Buckeye Mutual");
    assert.equal(Number(row.liability_cents), 10000000);
    assert.ok(row.doc_path);
  });

  test("and the page says a person still has to look at it", async () => {
    const agent = await signIn();
    await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", expires_on: addDays(today(), 300),
    }, { name: "policy.pdf", type: "application/pdf", bytes: A_PDF });

    const res = await page(agent, `/portal/renting/${world.leaseId}/insurance`);
    assert.match(res.body, /With the office/);
    assert.match(res.body, /Nobody has confirmed it yet/);
  });

  test("an expiry in the past is refused", async () => {
    const agent = await signIn();
    const res = await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", expires_on: "2020-01-01",
    }, { name: "policy.pdf", type: "application/pdf", bytes: A_PDF });

    assert.match(loc(res), /already passed/i);
    assert.equal((await all("SELECT id FROM renters_insurance")).length, 0);
  });

  test("no document is refused, because the date alone proves nothing", async () => {
    const agent = await signIn();
    const res = await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", expires_on: addDays(today(), 300),
    }, null);
    assert.match(loc(res), /attach the certificate/i);
  });

  test("something that is not a document is refused on its bytes, not its name", async () => {
    /* A browser will label anything application/pdf. */
    const agent = await signIn();
    const res = await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", expires_on: addDays(today(), 300),
    }, { name: "policy.pdf", type: "application/pdf", bytes: NOT_A_PDF });

    assert.match(loc(res), /not a readable image or PDF/i);
    assert.equal((await all("SELECT id FROM renters_insurance")).length, 0);
  });

  test("a newer policy supersedes the old one rather than deleting it", async () => {
    /* "Was this tenant insured last March" needs the one that was current
       then, not only the one current now. */
    const agent = await signIn();
    for (const carrier of ["First Insurer", "Second Insurer"]) {
      await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
        carrier, expires_on: addDays(today(), 300),
      }, { name: "policy.pdf", type: "application/pdf", bytes: A_PDF });
    }

    const rows = await all(
      "SELECT carrier, status FROM renters_insurance WHERE lease_id = ? ORDER BY uploaded_at", world.leaseId);
    assert.equal(rows.length, 2, "both kept");
    assert.equal(rows[0].status, "superseded");
    assert.equal(rows[1].status, "pending");
  });

  test("a tenancy that is not theirs is not a place to upload", async () => {
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "9" });
    const { leaseId: strangerLease } = await f.makeLease(world.companyId, second);

    const agent = await signIn();
    const res = await agent.get(`/portal/renting/${strangerLease}/insurance`);
    assert.equal(res.status, 404);
  });

  test("a lease that does not require it says so rather than nagging", async () => {
    await run("UPDATE lease SET insurance_required = 0 WHERE id = ?", world.leaseId);
    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}/insurance`);
    assert.match(res.body, /does not require this/i);
  });

  test("the nudge on the home page appears only when it is required and missing", async () => {
    const agent = await signIn();
    let res = await page(agent, "/portal/home/renting");
    assert.match(res.body, /requires renters insurance/i);

    await upload(agent, `/portal/renting/${world.leaseId}/insurance`, {
      carrier: "Buckeye Mutual", expires_on: addDays(today(), 300),
    }, { name: "policy.pdf", type: "application/pdf", bytes: A_PDF });

    res = await page(agent, "/portal/home/renting");
    assert.ok(!/requires renters insurance/i.test(res.body), "and stops once something is on file");
  });

  test("an expired policy is not treated as cover", async () => {
    await insert("renters_insurance", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      carrier: "Lapsed Mutual", expires_on: "2024-01-01", status: "accepted",
      uploaded_by: "tenant", uploaded_at: stamp(), created_at: stamp(),
    });

    const agent = await signIn();
    const res = await page(agent, "/portal/home/renting");
    assert.match(res.body, /requires renters insurance/i, "expired is not on file");
  });

  test("a rejection is shown with the reason", async () => {
    /* "Rejected" with no reason produces a phone call. */
    await insert("renters_insurance", {
      id: id(), company_id: world.companyId, lease_id: world.leaseId,
      carrier: "Buckeye Mutual", expires_on: addDays(today(), 300),
      status: "rejected", review_note: "The cover is $25,000; your lease asks for $100,000.",
      uploaded_by: "tenant", uploaded_at: stamp(), created_at: stamp(),
    });

    const agent = await signIn();
    const res = await page(agent, `/portal/renting/${world.leaseId}/insurance`);
    assert.match(res.body, /rejected/);
    assert.match(res.body, /asks for \$100,000/);
  });
});

/* --- contact details ------------------------------------------------------------ */

describe("your own details", () => {
  beforeEach(async () => { await tenantOf(); });

  test("the email is shown and cannot be changed here", async () => {
    /* It is the login. Changing it would move portal access to a different
       person — an account takeover with a typo. */
    const agent = await signIn();
    const res = await page(agent, "/portal/details");
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(EMAIL));
    assert.match(res.body, /cannot be changed here/i);
    assert.ok(!/name="email"/.test(res.body), "and there is no field to try it in");
  });

  test("the phone can be corrected", async () => {
    const agent = await signIn();
    await agent.post("/portal/details",
      { tenant_id: world.tenantId, phone: "(614) 555-0999", sms_ok: "on" },
      { csrfFrom: "/portal/details" });

    const tenant = await get("SELECT phone FROM tenant WHERE id = ?", world.tenantId);
    assert.equal(tenant.phone, "(614) 555-0999");
  });

  test("changing the number does not silently re-grant texts", async () => {
    /* The case this exists for. Consent is keyed by the number, so a new one
       arrives with no record and the sender would treat that as permission.
       The answer comes from the box they just ticked instead. */
    await record(world.companyId, "sms", "(614) 555-0200", "revoked", "sms_reply", "STOP");

    const agent = await signIn();
    await agent.post("/portal/details",
      { tenant_id: world.tenantId, phone: "(614) 555-0999" },   // box unticked
      { csrfFrom: "/portal/details" });

    const state = await stateFor(world.companyId, "sms", "(614) 555-0999");
    assert.equal(state.state, "revoked", "the new number inherits the decision, not the silence");
    assert.equal(state.source, "portal");
  });

  test("and ticking the box turns them back on, on the new number", async () => {
    await record(world.companyId, "sms", "(614) 555-0200", "revoked", "sms_reply", "STOP");

    const agent = await signIn();
    await agent.post("/portal/details",
      { tenant_id: world.tenantId, phone: "(614) 555-0999", sms_ok: "on" },
      { csrfFrom: "/portal/details" });

    const state = await stateFor(world.companyId, "sms", "(614) 555-0999");
    assert.equal(state.state, "granted");
  });

  test("the old number keeps whatever it had", async () => {
    /* They may be changing away from it precisely because it was somebody
       else's, and rewriting its consent would be a decision about a stranger. */
    await record(world.companyId, "sms", "(614) 555-0200", "revoked", "sms_reply", "STOP");

    const agent = await signIn();
    await agent.post("/portal/details",
      { tenant_id: world.tenantId, phone: "(614) 555-0999", sms_ok: "on" },
      { csrfFrom: "/portal/details" });

    const old = await stateFor(world.companyId, "sms", "(614) 555-0200");
    assert.equal(old.state, "revoked", "untouched");
    assert.equal(old.source, "sms_reply");
  });

  test("a STOP reply is explained rather than shown as an unticked box", async () => {
    await record(world.companyId, "sms", "(614) 555-0200", "revoked", "sms_reply", "STOP");
    const agent = await signIn();
    const res = await page(agent, "/portal/details");
    assert.match(res.body, /because you replied STOP/i);
  });

  test("somebody else's tenancy is not editable", async () => {
    /* The form carries an id; the id proves nothing. */
    const second = await f.makeUnit(world.companyId, world.propertyId, { label: "9" });
    const { tenantId: stranger } = await f.makeLease(world.companyId, second);

    const agent = await signIn();
    const res = await agent.post("/portal/details",
      { tenant_id: stranger, phone: "(614) 555-0000", sms_ok: "on" },
      { csrfFrom: "/portal/details" });

    assert.equal(res.status, 404);
    const untouched = await get("SELECT phone FROM tenant WHERE id = ?", stranger);
    assert.notEqual(untouched.phone, "(614) 555-0000");
  });

  test("clearing the phone leaves no new consent record behind", async () => {
    const agent = await signIn();
    await agent.post("/portal/details",
      { tenant_id: world.tenantId, phone: "" },
      { csrfFrom: "/portal/details" });

    const tenant = await get("SELECT phone FROM tenant WHERE id = ?", world.tenantId);
    assert.equal(tenant.phone, null);
    const rows = await all("SELECT * FROM contact_consent WHERE company_id = ?", world.companyId);
    assert.equal(rows.length, 0, "nothing to consent about");
  });
});
