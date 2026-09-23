/* The adverse action notice.

   ## When it is required

   Whenever information in a consumer report contributes to turning somebody
   down, or to offering them worse terms — **even if it was a minor factor**.
   That is the test the FTC sets, and it is not the same as "the report is why
   we said no". So the decision screen asks the question in those words rather
   than trying to work it out.

   ## What it has to contain

   Four things, and they are not negotiable:

     1. the name, address and telephone number of the agency that supplied the
        report;
     2. a statement that the agency did not make the decision and cannot give
        the reasons for it;
     3. the person's right to dispute the accuracy or completeness of anything
        the agency furnished, and to a free copy of the report if they ask
        within 60 days;
     4. where a credit score influenced the decision: the score, its source,
        the date it was created, the range, and the key negative factors in
        order of importance.

   Numbers 1 to 3 are built in and cannot be edited away: they are produced
   here, from the record, and a template that omits them still gets them.
   Number 4 is only present when a score was used, and it is typed by the
   person who read the report — which is also the only place in this system a
   score is ever written down.

   ## Why the template still has to be approved

   Everything above is the required *content*. The covering wording around it
   is the company's, and anything a particular state adds on top is their
   counsel's. So this renders through the same `notice_template` machinery as
   every other notice, and an unapproved template cannot be sent — the same
   rule that stops an improvised eviction notice going out. */
import { all, get, one, insert, run } from "../db.js";
import { id } from "../ids.js";
import { stamp, humanStamp } from "../dates.js";
import { compile } from "../template.js";

export const TEMPLATE_KEY = "adverse_action";

export class AdverseActionRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "AdverseActionRefused";
  }
}

/* The wording a company starts from. Ships unapproved, and says why in its
   own first line so that whoever opens it knows before they read it. */
export const STARTING_TEMPLATE = [
  "{{applicant_name}}",
  "",
  "Thank you for your application for {{property}}.",
  "",
  "We are not able to go ahead with it on this occasion. Information in a tenant",
  "screening report about you was part of that decision.",
  "",
  "{{required_notice}}",
  "",
  "If you would like to talk to us about it, please get in touch.",
  "",
  "{{company_name}}",
].join("\n");

/* The part that is required, built from the record and never from a template.

   It is inserted as `{{required_notice}}`, and if a template does not use
   that token it is appended anyway — because a notice missing these
   paragraphs is not a notice, and a company's editor is not the place that
   decision gets made. */
export function requiredNotice({ agency, score = null }) {
  const lines = [];

  lines.push(
    `The report was supplied by ${agency.name}`
    + `${agency.address ? `, ${agency.address}` : ""}`
    + `${agency.phone ? `, telephone ${agency.phone}` : ""}.`);
  lines.push("");
  lines.push(
    `${agency.name} did not make the decision not to go ahead, and cannot give you the `
    + "reasons for it.");
  lines.push("");
  lines.push(
    "You have the right to dispute the accuracy or completeness of any information "
    + `${agency.name} gave us, directly with them. You also have the right to a free `
    + "copy of the report if you ask them for it within 60 days of this notice.");

  if (score && String(score.score || "").trim()) {
    lines.push("");
    lines.push("A credit score was used in the decision.");
    lines.push(`  Score: ${score.score}`);
    if (score.source) lines.push(`  Supplied by: ${score.source}`);
    if (score.date) lines.push(`  Created on: ${score.date}`);
    if (score.range) lines.push(`  Possible range: ${score.range}`);
    if (score.factors) {
      lines.push("  The key factors that adversely affected it, most important first:");
      for (const factor of splitFactors(score.factors)) lines.push(`    - ${factor}`);
    }
  }

  return lines.join("\n");
}

export function splitFactors(value) {
  return String(value || "")
    .split(/[\n;]+/)
    .map((f) => f.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(Boolean);
}

/* Renders the notice without sending it, so the screen can show a person
   exactly what will go out before they agree to send it. */
export function renderNotice({ template, application, company, agency, score, property }) {
  const required = requiredNotice({ agency, score });

  const vars = {
    applicant_name: application.applicant_name || "",
    company_name: company.name || "",
    property: property || "the property you applied for",
    date: humanStamp(stamp()),
    agency_name: agency.name,
    agency_address: agency.address || "",
    agency_phone: agency.phone || "",
    required_notice: required,
  };

  const body = String(template?.body || STARTING_TEMPLATE);
  const { text, missing } = compile(body, vars);

  /* Belt and braces. A company can edit its template to anything, including
     something that drops the token — and the notice would then be missing
     the three paragraphs the law requires, silently. */
  const text2 = text.includes(required) ? text : `${text}\n\n${required}`;

  return { text: text2, missing: missing.filter((m) => m !== "required_notice") };
}

/* Writes the notice and queues it. Returns the row.

   The outbox is what decides whether it was sent — this record carries the
   outbox id rather than a `sent_at` of its own, so nothing here can claim a
   delivery the delivery system did not make. */
export async function recordAdverseAction({
  companyId, application, company, agency, score = null, property = null,
  contributed = true, by, channel = "email", now = stamp,
}) {
  if (!agency?.name) {
    throw new AdverseActionRefused(
      "The notice has to name the agency that supplied the report, with its address and "
      + "telephone number. Set them in Setup before recording this decision.");
  }

  const template = await get(
    "SELECT * FROM notice_template WHERE company_id = ? AND key = ?", companyId, TEMPLATE_KEY);
  if (!template) {
    throw new AdverseActionRefused(
      "There is no adverse action template for this company. Add one in Setup — it needs "
      + "your solicitor's eye before the first one goes out.");
  }
  if (!template.approved_at) {
    throw new AdverseActionRefused(
      "The adverse action template has not been approved. An unapproved template is never "
      + "sent, for the same reason an unapproved eviction notice is not.");
  }

  const { text } = renderNotice({ template, application, company, agency, score, property });
  const at = now();
  const noticeId = id();
  const to = application.email || null;

  let outboxId = null;
  if (to && channel === "email") {
    outboxId = id();
    await insert("outbox", {
      id: outboxId, company_id: companyId, channel: "email", to_contact: to,
      subject: "About your application",
      body: text,
      about_type: "adverse_action", about_id: noticeId,
      status: "queued", kind: "transactional", queued_at: at,
    });
  }

  await insert("adverse_action", {
    id: noticeId, company_id: companyId, application_id: application.id,
    agency_name: agency.name, agency_address: agency.address || null,
    agency_phone: agency.phone || null,
    score: score?.score || null, score_source: score?.source || null,
    score_date: score?.date || null, score_range: score?.range || null,
    score_factors: score?.factors || null,
    contributed: contributed ? 1 : 0,
    rendered_body: text, template_key: TEMPLATE_KEY,
    channel, to_contact: to, outbox_id: outboxId,
    created_by: by, created_at: at,
  });

  return await one("SELECT * FROM adverse_action WHERE id = ?", noticeId);
}

export async function adverseActionsFor(applicationId) {
  return await all(
    "SELECT * FROM adverse_action WHERE application_id = ? ORDER BY created_at DESC",
    applicationId);
}

/* Whether this decision needed a notice and has not got one. Asked by the
   application screen, so a decline made on a report is visibly incomplete
   until the notice exists rather than quietly non-compliant. */
export async function noticeOutstanding(application) {
  if (application.status !== "declined") return false;
  const screened = await get(
    `SELECT id FROM screening_request
      WHERE application_id = ? AND status = 'received' LIMIT 1`, application.id);
  if (!screened) return false;
  const notice = await get(
    "SELECT id FROM adverse_action WHERE application_id = ? LIMIT 1", application.id);
  return !notice;
}
