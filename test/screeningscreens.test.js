/* The screening screens.

   The applicant's half is the part that matters most: they are being asked to
   let somebody read their credit file, and the page has to say who, what for,
   and what happens if it goes against them — before they type their name, not
   in a paragraph afterwards. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import { startApp, client } from "./helpers/http.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id, token } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { saveScreeningSettings, screeningSettings } from "../server/lib/screening/settings.js";
import { TEMPLATE_KEY, STARTING_TEMPLATE } from "../server/lib/screening/adverse.js";
import { activeConsent } from "../server/lib/screening/consent.js";

let app, world, agent, applicant;

const AGENCY = {
  name: "Example Screening Services, Inc.",
  address: "PO Box 100, Anytown, OH 43201",
  phone: "(555) 010-0100",
};

before(async () => {
  await freshDatabase();
  await truncateAll();
  app = await startApp();
});
after(async () => { await app.close(); await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Screens Co", staffRoles: ["admin", "technician"] });
  agent = client(app.origin);
  const res = await agent.signIn(world.staff.admin.email, f.PASSWORD);
  assert.equal(res.signedIn, true);
  applicant = client(app.origin);
});

async function application(fields = {}) {
  const appId = id();
  await insert("application", {
    id: appId, company_id: world.companyId, unit_id: world.unitId,
    applicant_name: "Ravi Bhatt", email: "ravi@example.test", phone: "614-555-0110",
    status: "received", received_at: stamp(), token: token(),
    ...fields,
  });
  return await get("SELECT * FROM application WHERE id = ?", appId);
}

const setUpAgency = () => saveScreeningSettings(world.companyId, { agency: AGENCY });

/* --- setup ---------------------------------------------------------------------- */

describe("setting screening up", () => {
  test("the page says the platform is not a reporting agency, and why", async () => {
    const { body } = await agent.text("/app/setup/screening");
    assert.match(body, /bring your own screening account/i);
    assert.match(body, /on-site inspection/i);
    assert.match(body, /does not pull credit files/i);
  });

  test("the agency details save, because the notice cannot be written without them",
    async () => {
      const res = await agent.post("/app/setup/screening", {
        provider: "manual",
        agency_name: AGENCY.name, agency_address: AGENCY.address, agency_phone: AGENCY.phone,
        retention_days: "45",
      }, { csrfFrom: "/app/setup/screening" });
      assert.equal(res.status, 303);

      const settings = await screeningSettings(world.companyId);
      assert.deepEqual(settings.agency, AGENCY);
      assert.equal(settings.retentionDays, 45);
    });

  test("once they are there the page shows exactly what gets added to the notice",
    async () => {
      await setUpAgency();
      const { body } = await agent.text("/app/setup/screening");
      assert.match(body, /did not make the decision/);
      assert.match(body, /within 60 days/);
      assert.match(body, /Score: 712/, "including the score paragraph, so they can see it");
      assert.match(body, /there is no score field on an application/);
    });

  test("the starting template arrives unapproved, and says so", async () => {
    const res = await agent.post("/app/setup/screening/template", {},
      { csrfFrom: "/app/setup/screening" });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location")), /unapproved/);

    const tpl = await get(
      "SELECT * FROM notice_template WHERE company_id = ? AND key = ?",
      world.companyId, TEMPLATE_KEY);
    assert.ok(tpl);
    assert.equal(tpl.approved_at, null);
    assert.equal(tpl.body, STARTING_TEMPLATE);
  });

  test("and adding it twice does not overwrite what a solicitor edited", async () => {
    await agent.post("/app/setup/screening/template", {}, { csrfFrom: "/app/setup/screening" });
    await run("UPDATE notice_template SET body = ? WHERE company_id = ? AND key = ?",
      "Carefully reviewed wording.", world.companyId, TEMPLATE_KEY);

    await agent.post("/app/setup/screening/template", {}, { csrfFrom: "/app/setup/screening" });
    const tpl = await get(
      "SELECT body FROM notice_template WHERE company_id = ? AND key = ?",
      world.companyId, TEMPLATE_KEY);
    assert.equal(tpl.body, "Carefully reviewed wording.");
  });

  test("a technician cannot reach it", async () => {
    const tech = client(app.origin);
    await tech.signIn(world.staff.technician.email, f.PASSWORD);
    assert.equal((await tech.get("/app/setup/screening")).status, 403);
  });

  test("it is linked from setup", async () => {
    const { body } = await agent.text("/app/setup");
    assert.match(body, /\/app\/setup\/screening/);
  });
});

/* --- the applicant -------------------------------------------------------------- */

describe("what the applicant sees", () => {
  test("before agreeing: who, what for, and what happens if it goes against them",
    async () => {
      await setUpAgency();
      const a = await application();
      const { body } = await applicant.text(`/a/${a.token}/consent`);

      assert.match(body, /Example Screening Services/, "who will see the file");
      assert.match(body, /PO Box 100/);
      assert.match(body, /decide whether to rent to you/, "what it is for");
      assert.match(body, /only thing it will be used for/);
      assert.match(body, /free copy and dispute/, "and what happens if they are turned down");
      assert.match(body, /Type your full name to agree/);
    });

  test("typing a name records it, frozen", async () => {
    await setUpAgency();
    const a = await application();
    const res = await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });
    assert.equal(res.status, 303);

    const consent = await activeConsent(a.id);
    assert.ok(consent);
    assert.equal(consent.typed_name, "Ravi Bhatt");
    assert.equal(consent.provider_name, AGENCY.name);
    assert.ok(consent.ip, "where from, because a signature with no circumstances is thin");
  });

  test("afterwards they can read back exactly what they agreed to", async () => {
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });

    const { body } = await applicant.text(`/a/${a.token}/consent`);
    assert.match(body, /You have already agreed/);
    assert.match(body, /Example Screening Services/);
    assert.match(body, /Ravi Bhatt/);
    assert.match(body, /withdraw/i);
  });

  test("they can withdraw, and are told what that does and does not undo", async () => {
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });

    const res = await applicant.post(`/a/${a.token}/consent/withdraw`, {},
      { csrfFrom: `/a/${a.token}/consent` });
    assert.equal(res.status, 303);
    assert.equal(await activeConsent(a.id), undefined);
    assert.match(decodeURIComponent(res.headers.get("location")), /withdrawn/);
  });

  test("with no agency set, nothing is asked of them", async () => {
    const a = await application();
    const { body } = await applicant.text(`/a/${a.token}/consent`);
    assert.match(body, /Not ready yet/);
    assert.doesNotMatch(body, /Type your full name/,
      "asking somebody to consent to an unnamed agency is asking for nothing in particular");
  });

  test("agreeing twice does not make a second record", async () => {
    await setUpAgency();
    const a = await application();
    const post = () => applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });
    await post();
    await post();
    assert.equal(
      (await all("SELECT id FROM screening_consent WHERE application_id = ?", a.id)).length, 1);
  });
});

/* --- the panel ------------------------------------------------------------------ */

describe("the panel on the application", () => {
  test("with no agency it says what is missing and where to set it", async () => {
    const a = await application();
    const { body } = await agent.text(`/app/applications/${a.id}`);
    assert.match(body, /Screening/);
    assert.match(body, /Not set up/);
    assert.match(body, /\/app\/setup\/screening/);
  });

  test("with an agency and no consent, it offers the applicant's link and nothing else",
    async () => {
      await setUpAgency();
      const a = await application();
      const { body } = await agent.text(`/app/applications/${a.id}`);
      assert.match(body, /No consent yet/);
      assert.match(body, new RegExp(`/a/${a.token}/consent`));
      assert.doesNotMatch(body, /Record that it was ordered/,
        "nothing may be ordered until they agree");
    });

  test("with consent it offers to record an order", async () => {
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });

    const { body } = await agent.text(`/app/applications/${a.id}`);
    assert.match(body, /given<\/span>/, "the consent reads as given");
    assert.match(body, /naming Example Screening Services/);
    assert.match(body, /Record that it was ordered/);
  });

  test("ordering and then recording a report walks through the screen", async () => {
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });

    await agent.post(`/app/applications/${a.id}/screening/order`,
      { reference: "SM-1234" }, { csrfFrom: `/app/applications/${a.id}` });
    const request = await get("SELECT * FROM screening_request WHERE application_id = ?", a.id);
    assert.equal(request.status, "ordered");

    let page = await agent.text(`/app/applications/${a.id}`);
    assert.match(page.body, /Ordered, waiting for the report/);
    assert.match(page.body, /What does it say/);

    await agent.post(`/app/applications/${a.id}/screening/${request.id}/report`,
      { summary: "Two late payments in 2024, no judgements, addresses match." },
      { csrfFrom: `/app/applications/${a.id}` });

    page = await agent.text(`/app/applications/${a.id}`);
    assert.match(page.body, /Two late payments in 2024/);
    assert.match(page.body, /none kept/, "no file was uploaded, and it says so");
  });

  test("ordering without consent is refused at the route, not only hidden", async () => {
    await setUpAgency();
    const a = await application();
    const res = await agent.post(`/app/applications/${a.id}/screening/order`, {},
      { csrfFrom: `/app/applications/${a.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /has not consented/);
    assert.equal((await all("SELECT id FROM screening_request")).length, 0);
  });

  test("a decline with a report behind it says the notice is required", async () => {
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });
    await agent.post(`/app/applications/${a.id}/screening/order`, {},
      { csrfFrom: `/app/applications/${a.id}` });
    const request = await get("SELECT * FROM screening_request WHERE application_id = ?", a.id);
    await agent.post(`/app/applications/${a.id}/screening/${request.id}/report`,
      { summary: "Several judgements, none of them satisfied." },
      { csrfFrom: `/app/applications/${a.id}` });

    await agent.post(`/app/applications/${a.id}/decide`,
      { status: "declined", reason: "Judgements outstanding, against the written criteria." },
      { csrfFrom: `/app/applications/${a.id}` });

    const { body } = await agent.text(`/app/applications/${a.id}`);
    assert.match(body, /needs an adverse action notice/);
    assert.match(body, /even if the report was only a minor factor/);
    assert.match(body, /Did a credit score come into it/);
  });

  test("writing the notice from the screen queues it and clears the warning", async () => {
    await setUpAgency();
    await run(
      `INSERT INTO notice_template (company_id, key, name, body, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      world.companyId, TEMPLATE_KEY, "Adverse action", STARTING_TEMPLATE, "Counsel", stamp());

    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });
    await agent.post(`/app/applications/${a.id}/screening/order`, {},
      { csrfFrom: `/app/applications/${a.id}` });
    const request = await get("SELECT * FROM screening_request WHERE application_id = ?", a.id);
    await agent.post(`/app/applications/${a.id}/screening/${request.id}/report`,
      { summary: "Several judgements, none of them satisfied." },
      { csrfFrom: `/app/applications/${a.id}` });
    await agent.post(`/app/applications/${a.id}/decide`,
      { status: "declined", reason: "Judgements outstanding." },
      { csrfFrom: `/app/applications/${a.id}` });

    const res = await agent.post(`/app/applications/${a.id}/adverse`, {
      used_score: "yes", score: "612", score_source: AGENCY.name,
      score_date: "3 Mar 2026", score_range: "350 to 850",
      score_factors: "Serious delinquency\nToo many accounts with balances",
    }, { csrfFrom: `/app/applications/${a.id}` });
    assert.equal(res.status, 303);

    const notice = await get("SELECT * FROM adverse_action WHERE application_id = ?", a.id);
    assert.ok(notice);
    assert.equal(notice.score, "612");
    assert.match(notice.rendered_body, /Serious delinquency/);
    assert.ok(notice.outbox_id);

    const { body } = await agent.text(`/app/applications/${a.id}`);
    assert.doesNotMatch(body, /needs an adverse action notice/);
    assert.match(body, /score 612 recorded on the notice/);
  });

  test("an outstanding notice is on the list, not only inside the record", async () => {
    /* A compliance obligation visible only if somebody happens to open the
       application is not much of a reminder. */
    await setUpAgency();
    const a = await application();
    await applicant.post(`/a/${a.token}/consent`,
      { typed_name: "Ravi Bhatt" }, { csrfFrom: `/a/${a.token}/consent` });
    await agent.post(`/app/applications/${a.id}/screening/order`, {},
      { csrfFrom: `/app/applications/${a.id}` });
    const request = await get("SELECT * FROM screening_request WHERE application_id = ?", a.id);
    await agent.post(`/app/applications/${a.id}/screening/${request.id}/report`,
      { summary: "Several judgements, none of them satisfied." },
      { csrfFrom: `/app/applications/${a.id}` });

    let list = await agent.text("/app/applications");
    assert.doesNotMatch(list.body, /adverse\s+action notice due/,
      "nothing is due until a decision is made");

    await agent.post(`/app/applications/${a.id}/decide`,
      { status: "declined", reason: "Judgements outstanding." },
      { csrfFrom: `/app/applications/${a.id}` });

    list = await agent.text("/app/applications");
    assert.match(list.body, /adverse\s+action notice due/);
  });

  test("saying a score was used without giving it is refused", async () => {
    await setUpAgency();
    const a = await application({ status: "declined" });
    const res = await agent.post(`/app/applications/${a.id}/adverse`,
      { used_score: "yes", score: "" }, { csrfFrom: `/app/applications/${a.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /has to carry it/);
    assert.equal((await all("SELECT id FROM adverse_action")).length, 0);
  });

  test("an unapproved template stops the notice, from the screen too", async () => {
    await setUpAgency();
    await run(
      "INSERT INTO notice_template (company_id, key, name, body) VALUES (?, ?, ?, ?)",
      world.companyId, TEMPLATE_KEY, "Adverse action", STARTING_TEMPLATE);

    const a = await application({ status: "declined" });
    const res = await agent.post(`/app/applications/${a.id}/adverse`, { used_score: "no" },
      { csrfFrom: `/app/applications/${a.id}` });
    assert.match(decodeURIComponent(res.headers.get("location")), /has not been approved/);
    assert.equal((await all("SELECT id FROM adverse_action")).length, 0);
  });
});
