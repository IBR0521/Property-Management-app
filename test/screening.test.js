/* Tenant screening.

   The rule this whole feature is shaped around is the oldest one in the
   application: **no automated applicant scoring, and no automated decision.**
   A screening report has a number on the front of it and numbers want to be
   sorted, so the first test in this file is the structural one — there is no
   score column anywhere an application can be filtered by, and if somebody
   adds one this fails.

   After that: consent is a frozen record and nothing may be ordered without
   one, the adverse action notice carries the four elements the law requires
   and cannot be sent from an unapproved template, and a report is deleted on
   the company's own schedule while everything that makes the decision
   defensible stays. */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, truncateAll, closeDb, all, get, run } from "./helpers/db.js";
import * as f from "./helpers/factories.js";
import { insert } from "../server/lib/db.js";
import { id } from "../server/lib/ids.js";
import { stamp } from "../server/lib/dates.js";
import { sha256 } from "../server/lib/crypto.js";
import { token } from "../server/lib/ids.js";
import { saveScreeningSettings, screeningSettings, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS }
  from "../server/lib/screening/settings.js";
import { agencyFor, provider, PROVIDER_KEYS } from "../server/lib/screening/providers.js";
import {
  consentWording, recordConsent, activeConsent, withdrawConsent, intact, ConsentRefused,
} from "../server/lib/screening/consent.js";
import {
  orderScreening, recordReport, cancelScreening, screeningFor, ScreeningRefused,
} from "../server/lib/screening/requests.js";
import {
  requiredNotice, renderNotice, recordAdverseAction, noticeOutstanding, splitFactors,
  AdverseActionRefused, STARTING_TEMPLATE, TEMPLATE_KEY,
} from "../server/lib/screening/adverse.js";
import { sweepScreeningReports, deleteReport } from "../server/lib/screening/retain.js";

let world, company;

const AGENCY = {
  name: "Example Screening Services, Inc.",
  address: "PO Box 100, Anytown, OH 43201",
  phone: "(555) 010-0100",
};

before(async () => { await freshDatabase(); await truncateAll(); });
after(async () => { await closeDb(); });

beforeEach(async () => {
  await truncateAll();
  world = await f.makeWorld({ name: "Screening Co" });
  company = await get("SELECT * FROM company WHERE id = ?", world.companyId);
  await saveScreeningSettings(world.companyId, { agency: AGENCY });
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

async function consented(app) {
  const settings = await screeningSettings(world.companyId);
  return await recordConsent({
    companyId: world.companyId, applicationId: app.id,
    providerKey: settings.provider, agency: settings.agency,
    companyName: company.name, typedName: "Ravi Bhatt",
    ip: "203.0.113.5", userAgent: "a browser",
  });
}

async function approvedTemplate() {
  await run(
    `INSERT INTO notice_template (company_id, key, name, body, approved_by, approved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    world.companyId, TEMPLATE_KEY, "Adverse action", STARTING_TEMPLATE,
    "Counsel", stamp());
}

/* --- the invariant -------------------------------------------------------------- */

describe("no automated scoring, and no way to build one by accident", () => {
  test("no table has a column an applicant could be sorted or filtered by", async () => {
    /* A `score` column on an application is one commit away from
       "auto-decline below 620", and then the decision is not being made by a
       person any more. The only place a score exists is the adverse action
       notice, which is written after a decision by a human typing what they
       read — so it cannot have influenced anything. */
    const columns = await all(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%score%' OR column_name LIKE '%rating%'
               OR column_name LIKE '%rank%')
        ORDER BY table_name, column_name`);

    /* Two `rank` columns that are orderings of our own things rather than
       judgements about a person: which contractor is tried first for a
       category, and which photograph shows first on a listing. Nothing else.

       There is deliberately no exception for the adverse action notice. The
       first version of that table had five score columns, on the reasoning
       that the law requires the score to appear on the notice — and
       `invariants.test.js` failed, because it has asserted since Phase 1 that
       no score column may exist anywhere and makes no exceptions for good
       reasons. It was right: the notice is its frozen `rendered_body`, the
       score is in that prose, and a column bought only the ability to query
       by it. */
    const allowed = new Set([
      "routing_rule.rank",
      "listing_photo.rank",
    ]);

    for (const c of columns) {
      const name = `${c.table_name}.${c.column_name}`;
      assert.ok(allowed.has(name),
        `${name} looks like a score. If it is one, this feature has grown the thing it `
        + "was built not to have.");
    }
  });

  test("not even the adverse action notice has one", async () => {
    const columns = await all(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'adverse_action'
          AND column_name LIKE '%score%'`);
    assert.deepEqual(columns, [],
      "the notice is its rendered body; a score column beside it would be the one "
      + "sortable score in the system");
  });

  test("and the score still reaches the notice, which is where the law wants it",
    async () => {
      const app = await application({ status: "declined" });
      await approvedTemplate();
      const written = await recordAdverseAction({
        companyId: world.companyId, application: app, company, agency: AGENCY,
        score: { score: "640", source: AGENCY.name, date: "1 Mar 2026",
          range: "350 to 850", factors: "Serious delinquency" },
        by: "Dana",
      });
      assert.match(written.rendered_body, /Score: 640/);
      assert.match(written.rendered_body, /Possible range: 350 to 850/);
      assert.match(written.rendered_body, /- Serious delinquency/);
      assert.equal("score" in written, false, "and nowhere else");
    });

  test("the application table still has no decision field a machine could set", async () => {
    const app = await application();
    /* The decision is a status, a human's name and a required reason. Nothing
       computed. */
    assert.equal(app.decided_by, null);
    assert.equal(app.decision_reason, null);
  });
});

/* --- consent -------------------------------------------------------------------- */

describe("consent", () => {
  test("the wording names the agency, because consent to nobody is consent to nothing",
    async () => {
      const wording = consentWording({ companyName: "Screening Co", agency: AGENCY });
      assert.match(wording, /Example Screening Services/);
      assert.match(wording, /PO Box 100/);
      assert.match(wording, /\(555\) 010-0100/);
      assert.match(wording, /only thing it will be used for/);
      assert.match(wording, /does not decide whether you are accepted/);
      assert.match(wording, /free copy and dispute/);
    });

  test("with no agency set there is nothing to consent to, and it says so", () => {
    assert.throws(
      () => consentWording({ companyName: "X", agency: { name: "" } }),
      ConsentRefused);
  });

  test("it is frozen, and an altered record stops matching", async () => {
    const app = await application();
    const consent = await consented(app);

    assert.equal(intact(consent), true);
    assert.equal(consent.wording_hash, sha256(consent.wording));
    assert.equal(consent.typed_name, "Ravi Bhatt");
    assert.equal(consent.provider_name, AGENCY.name);

    await run("UPDATE screening_consent SET wording = ? WHERE id = ?",
      "You agree to anything we like.", consent.id);
    const tampered = await get("SELECT * FROM screening_consent WHERE id = ?", consent.id);
    assert.equal(intact(tampered), false,
      "what matters is what they were shown, so an altered record has to be visible");
  });

  test("a name that is not a name is refused", async () => {
    const app = await application();
    const settings = await screeningSettings(world.companyId);
    await assert.rejects(
      () => recordConsent({
        companyId: world.companyId, applicationId: app.id,
        providerKey: settings.provider, agency: settings.agency,
        companyName: company.name, typedName: " " }),
      ConsentRefused);
  });

  test("withdrawing keeps the record and stops it counting", async () => {
    const app = await application();
    await consented(app);
    assert.ok(await activeConsent(app.id));

    await withdrawConsent({ applicationId: app.id });
    assert.equal(await activeConsent(app.id), undefined);

    const rows = await all("SELECT * FROM screening_consent WHERE application_id = ?", app.id);
    assert.equal(rows.length, 1, "that somebody consented and changed their mind is the record");
    assert.ok(rows[0].withdrawn_at);
  });
});

/* --- ordering ------------------------------------------------------------------- */

describe("ordering a report", () => {
  test("nothing may be ordered without consent", async () => {
    const app = await application();
    await assert.rejects(
      () => orderScreening({
        companyId: world.companyId, application: app, providerKey: "manual", by: "staff" }),
      /has not consented/);
    assert.equal((await all("SELECT id FROM screening_request")).length, 0);
  });

  test("nor against a consent that has been altered", async () => {
    const app = await application();
    const consent = await consented(app);
    await run("UPDATE screening_consent SET typed_name = ? WHERE id = ?", "Somebody Else", consent.id);
    /* The hash is over the wording, so change the wording to break it. */
    await run("UPDATE screening_consent SET wording = ? WHERE id = ?", "altered", consent.id);

    await assert.rejects(
      () => orderScreening({
        companyId: world.companyId, application: app, providerKey: "manual", by: "staff" }),
      /has been altered/);
  });

  test("with consent it is recorded, and the application moves to screening", async () => {
    const app = await application();
    await consented(app);
    const request = await orderScreening({
      companyId: world.companyId, application: app, providerKey: "manual",
      by: "Dana", reference: "SM-1234" });

    assert.equal(request.status, "ordered");
    assert.equal(request.reference, "SM-1234");
    assert.ok(request.consent_id, "a request always points at the consent it was made under");

    const after = await get("SELECT status FROM application WHERE id = ?", app.id);
    assert.equal(after.status, "screening");
  });

  test("the database refuses a request with no consent behind it, not only the code",
    async () => {
      const app = await application();
      await assert.rejects(() => insert("screening_request", {
        id: id(), company_id: world.companyId, application_id: app.id,
        consent_id: null, provider: "manual", status: "ordered", ordered_at: stamp(),
      }), /null value|not-null/i);
    });

  test("what the report said is prose, and “received” is not enough", async () => {
    const app = await application();
    await consented(app);
    const request = await orderScreening({
      companyId: world.companyId, application: app, providerKey: "manual", by: "Dana" });

    await assert.rejects(
      () => recordReport({
        requestId: request.id, companyId: world.companyId, summary: "ok", by: "Dana" }),
      /in your own words/);

    const done = await recordReport({
      requestId: request.id, companyId: world.companyId,
      summary: "Two late payments in 2024, no judgements, addresses match.", by: "Dana" });
    assert.equal(done.status, "received");
    assert.ok(done.received_at);
  });

  test("a screening that produced a report cannot be cancelled away", async () => {
    const app = await application();
    await consented(app);
    const request = await orderScreening({
      companyId: world.companyId, application: app, providerKey: "manual", by: "Dana" });
    await recordReport({
      requestId: request.id, companyId: world.companyId,
      summary: "Nothing of concern on the report at all.", by: "Dana" });

    await assert.rejects(
      () => cancelScreening({ requestId: request.id, companyId: world.companyId }),
      /would hide that somebody's file was looked at/);
  });
});

/* --- the notice ----------------------------------------------------------------- */

describe("the adverse action notice", () => {
  test("it carries the three things it must, always", () => {
    const text = requiredNotice({ agency: AGENCY });
    assert.match(text, /Example Screening Services, Inc\./, "who supplied it");
    assert.match(text, /PO Box 100/, "and where they are");
    assert.match(text, /\(555\) 010-0100/, "and their telephone number");
    assert.match(text, /did not make the decision/, "and that they did not decide");
    assert.match(text, /cannot give you the reasons/);
    assert.match(text, /dispute the accuracy or completeness/);
    assert.match(text, /free\s+copy of the report if you ask them for it within 60 days/);
  });

  test("and the fourth when a credit score came into it", () => {
    const text = requiredNotice({
      agency: AGENCY,
      score: { score: "712", source: "Example Screening", date: "3 Mar 2026",
        range: "350 to 850", factors: "Serious delinquency\nToo many accounts" },
    });
    assert.match(text, /Score: 712/);
    assert.match(text, /Supplied by: Example Screening/);
    assert.match(text, /Created on: 3 Mar 2026/);
    assert.match(text, /Possible range: 350 to 850/);
    assert.match(text, /most important first/);
    assert.match(text, /- Serious delinquency/);
    assert.match(text, /- Too many accounts/);

    /* Order matters: the law says most important first, so the list must come
       out in the order it went in. */
    assert.ok(text.indexOf("Serious delinquency") < text.indexOf("Too many accounts"));
  });

  test("with no score, nothing is said about one", () => {
    const text = requiredNotice({ agency: AGENCY, score: null });
    assert.doesNotMatch(text, /credit score/i);
  });

  test("factors are read however somebody pasted them", () => {
    assert.deepEqual(splitFactors("1. First\n2. Second\n- Third"),
      ["First", "Second", "Third"]);
    assert.deepEqual(splitFactors("One; Two;  Three"), ["One", "Two", "Three"]);
    assert.deepEqual(splitFactors(""), []);
  });

  test("a template that drops the token still gets the required paragraphs", async () => {
    /* A company can edit its wording to anything, including something that
       loses `{{required_notice}}` — and the notice would then be missing the
       paragraphs the law requires, silently. */
    const app = await application();
    const { text } = renderNotice({
      template: { body: "Dear {{applicant_name}}, no thank you.\n\n{{company_name}}" },
      application: app, company, agency: AGENCY, score: null, property: "1 Road",
    });
    assert.match(text, /Dear Ravi Bhatt/);
    assert.match(text, /did not make the decision/,
      "a company's editor is not where that decision gets made");
  });

  test("it will not be written from an unapproved template", async () => {
    const app = await application({ status: "declined" });
    await run(
      "INSERT INTO notice_template (company_id, key, name, body) VALUES (?, ?, ?, ?)",
      world.companyId, TEMPLATE_KEY, "Adverse action", STARTING_TEMPLATE);

    await assert.rejects(
      () => recordAdverseAction({
        companyId: world.companyId, application: app, company, agency: AGENCY, by: "Dana" }),
      /has not been approved/);
    assert.equal((await all("SELECT id FROM adverse_action")).length, 0);
  });

  test("nor with no template at all", async () => {
    const app = await application({ status: "declined" });
    await assert.rejects(
      () => recordAdverseAction({
        companyId: world.companyId, application: app, company, agency: AGENCY, by: "Dana" }),
      /no adverse action template/);
  });

  test("nor without an agency to name", async () => {
    const app = await application({ status: "declined" });
    await approvedTemplate();
    await assert.rejects(
      () => recordAdverseAction({
        companyId: world.companyId, application: app, company,
        agency: { name: "" }, by: "Dana" }),
      /has to name the agency/);
  });

  test("written, it is queued through the outbox rather than claiming to be sent",
    async () => {
      const app = await application({ status: "declined" });
      await approvedTemplate();

      const written = await recordAdverseAction({
        companyId: world.companyId, application: app, company, agency: AGENCY,
        score: { score: "640", source: AGENCY.name, date: "1 Mar 2026",
          range: "350 to 850", factors: "Serious delinquency" },
        property: "1 Road, unit 1", by: "Dana",
      });

      assert.equal(written.agency_name, AGENCY.name);
      assert.equal(Number(written.contributed), 1);
      assert.match(written.rendered_body, /Ravi Bhatt/);
      assert.match(written.rendered_body, /Score: 640/);

      assert.ok(written.outbox_id, "it goes out the way every other message does");
      const queued = await get("SELECT * FROM outbox WHERE id = ?", written.outbox_id);
      assert.equal(queued.status, "queued");
      assert.equal(queued.to_contact, "ravi@example.test");
      assert.equal(queued.body, written.rendered_body,
        "what was recorded and what was queued have to be the same words");
    });

  test("an applicant with no email gets a notice that is written and not claimed sent",
    async () => {
      const app = await application({ status: "declined", email: null });
      await approvedTemplate();
      const written = await recordAdverseAction({
        companyId: world.companyId, application: app, company, agency: AGENCY, by: "Dana" });
      assert.equal(written.outbox_id, null);
      assert.ok(written.rendered_body, "it still exists, to be printed and posted");
    });

  test("a decline with a report behind it is outstanding until the notice exists", async () => {
    const app = await application();
    await consented(app);
    const request = await orderScreening({
      companyId: world.companyId, application: app, providerKey: "manual", by: "Dana" });
    await recordReport({
      requestId: request.id, companyId: world.companyId,
      summary: "Several judgements, none satisfied.", by: "Dana" });

    await run("UPDATE application SET status = 'declined', decided_at = ? WHERE id = ?",
      stamp(), app.id);
    const declined = await get("SELECT * FROM application WHERE id = ?", app.id);
    assert.equal(await noticeOutstanding(declined), true);

    await approvedTemplate();
    await recordAdverseAction({
      companyId: world.companyId, application: declined, company, agency: AGENCY, by: "Dana" });
    assert.equal(await noticeOutstanding(declined), false);
  });

  test("an approval needs no notice, and nor does a decline with no report", async () => {
    const approved = await application({ status: "approved" });
    assert.equal(await noticeOutstanding(approved), false);

    const declined = await application({ status: "declined" });
    assert.equal(await noticeOutstanding(declined), false,
      "the notice is about consumer reports, not about every rejection");
  });
});

/* --- retention ------------------------------------------------------------------ */

describe("how long a report is kept", () => {
  async function screened({ decidedAt = null } = {}) {
    const app = await application();
    await consented(app);
    const request = await orderScreening({
      companyId: world.companyId, application: app, providerKey: "manual", by: "Dana" });
    await recordReport({
      requestId: request.id, companyId: world.companyId,
      summary: "Nothing of concern, references check out.",
      file: { path: "screening/report.pdf", mime: "application/pdf", bytes: 1200 },
      by: "Dana",
    });
    if (decidedAt) {
      await run("UPDATE application SET status = 'approved', decided_at = ? WHERE id = ?",
        decidedAt, app.id);
    }
    return { app, requestId: request.id };
  }

  test("ninety days by default, and it cannot be set to for ever", async () => {
    const fresh = await f.makeWorld({ name: "Default Co" });
    assert.equal((await screeningSettings(fresh.companyId)).retentionDays,
      DEFAULT_RETENTION_DAYS);

    await saveScreeningSettings(world.companyId, { retentionDays: 99999 });
    assert.equal((await screeningSettings(world.companyId)).retentionDays, MAX_RETENTION_DAYS);

    await saveScreeningSettings(world.companyId, { retentionDays: 0 });
    assert.equal((await screeningSettings(world.companyId)).retentionDays,
      DEFAULT_RETENTION_DAYS, "zero is a typo, not an instruction");
  });

  test("the clock starts at the decision, not at the report", async () => {
    /* An application still being decided needs its report. */
    const { requestId } = await screened({ decidedAt: null });
    const removed = [];
    const out = await sweepScreeningReports({ removeFile: async (p) => removed.push(p) });
    assert.equal(out.screeningReportsDeleted, 0);
    assert.deepEqual(removed, []);

    const still = await get("SELECT * FROM screening_request WHERE id = ?", requestId);
    assert.ok(still.report_path);
  });

  test("a decided one is swept, and what makes the decision defensible stays", async () => {
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    const { app, requestId } = await screened({ decidedAt: old });

    const removed = [];
    const out = await sweepScreeningReports({ removeFile: async (p) => removed.push(p) });
    assert.equal(out.screeningReportsDeleted, 1);
    assert.deepEqual(removed, ["screening/report.pdf"]);

    const after = await get("SELECT * FROM screening_request WHERE id = ?", requestId);
    assert.equal(after.report_path, null, "the file is gone");
    assert.equal(after.report_mime, null);
    assert.ok(after.deleted_at);
    assert.match(after.deleted_why, /retention rule/);

    assert.match(after.summary, /Nothing of concern/,
      "a person's own words about what they read are not the report");
    assert.equal(after.status, "received", "that screening happened stays for ever");
    assert.ok(await activeConsent(app.id), "and so does the consent it was made under");
  });

  test("a file that cannot be deleted is not marked as deleted", async () => {
    /* The whole value of this is that "deleted" means deleted. */
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    const { requestId } = await screened({ decidedAt: old });

    const out = await sweepScreeningReports({
      removeFile: async () => { throw new Error("the store said no"); } });
    assert.equal(out.screeningReportsDeleted, 0);
    assert.equal(out.screeningReportsFailed, 1);

    const after = await get("SELECT * FROM screening_request WHERE id = ?", requestId);
    assert.ok(after.report_path, "still there, and still due");
    assert.equal(after.deleted_at, null);
  });

  test("a shorter rule sweeps sooner", async () => {
    await saveScreeningSettings(world.companyId, { retentionDays: 7 });
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    await screened({ decidedAt: old });
    const out = await sweepScreeningReports({ removeFile: async () => {} });
    assert.equal(out.screeningReportsDeleted, 1);
  });

  test("another company's reports are swept on their own rule, not ours", async () => {
    const other = await f.makeWorld({ name: "Patient Co" });
    await saveScreeningSettings(other.companyId, { retentionDays: 365, agency: AGENCY });
    await saveScreeningSettings(world.companyId, { retentionDays: 7, agency: AGENCY });

    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    await screened({ decidedAt: old });

    const out = await sweepScreeningReports({ removeFile: async () => {} });
    assert.equal(out.screeningReportsDeleted, 1, "ours, and not theirs");
    assert.ok(other.companyId);
  });
});

/* --- the provider seam ----------------------------------------------------------- */

describe("the provider", () => {
  test("there is one, it is the manual one, and it knows it needs agency details", () => {
    assert.deepEqual(PROVIDER_KEYS, ["manual"]);
    assert.equal(provider("manual").needsAgencyDetails, true);
    assert.equal(provider("nonsense").key, "manual", "an unknown provider is not a crash");
  });

  test("with no agency configured there is nothing to put on a notice", async () => {
    const fresh = await f.makeWorld({ name: "Unset Co" });
    const settings = await screeningSettings(fresh.companyId);
    assert.equal(agencyFor({ providerKey: settings.provider, settings }), null);
  });

  test("with one, it comes out in the shape the notice needs", async () => {
    const settings = await screeningSettings(world.companyId);
    assert.deepEqual(agencyFor({ providerKey: settings.provider, settings }), AGENCY);
  });
});
