/* The applicant's consent, as a record rather than a checkbox.

   ## Why it is frozen

   What matters when somebody asks about this in a year is not that a box was
   ticked. It is **what the person was shown when they ticked it** — which
   agency was named, what they were told would be looked at, and what it would
   be used for. So the wording is stored verbatim with a hash over it, the way
   a signed lease document is, and an altered record stops matching.

   ## Why the agency is named in the wording

   A consent that does not say who will see the file is not consent to
   anything in particular. The FTC's guidance for landlords is that a separate
   signed authorisation naming the screening company is the standard to meet,
   and every provider's own contract requires consent besides. So the wording
   is built from the company's actual agency, and it cannot be built at all
   until they have said who that is.

   ## Withdrawn, not deleted

   Somebody consenting and later changing their mind is part of the record.
   Deleting the row would leave a report that was pulled with no visible basis
   for having pulled it, which is worse for everyone including the applicant. */
import { all, get, one, insert, run } from "../db.js";
import { id } from "../ids.js";
import { stamp } from "../dates.js";
import { sha256 } from "../crypto.js";

export class ConsentRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsentRefused";
  }
}

/* The exact words. Built rather than stored, so that a company changing its
   agency changes what the next applicant is shown — and so that what a given
   applicant saw is whatever was frozen onto their own row.

   Deliberately plain. Somebody is agreeing to have their credit file looked
   at; the sentence that says so should be a sentence they can read. */
export function consentWording({ companyName, agency }) {
  if (!agency?.name) {
    throw new ConsentRefused(
      "This company has not said which screening agency it uses, so there is nothing "
      + "to name in the consent. Set it in Setup before screening anybody.");
  }

  return [
    `${companyName} would like to obtain a tenant screening report about you in order to `
      + "decide whether to rent to you. This is the only thing it will be used for.",
    "",
    `The report will be obtained from ${agency.name}`
      + `${agency.address ? `, ${agency.address}` : ""}`
      + `${agency.phone ? `, telephone ${agency.phone}` : ""}.`,
    "",
    "It may contain your credit history, your rental history, and public records. "
      + `${agency.name} does not decide whether you are accepted — ${companyName} does, `
      + "against written criteria that are applied to every applicant.",
    "",
    "If you are turned down, or offered different terms, because of something in the "
      + "report, you will be told so in writing, told who supplied it, and told how to "
      + "get a free copy and dispute anything in it that is wrong.",
    "",
    "By typing your name below you are agreeing to this report being obtained.",
  ].join("\n");
}

/* Returns the consent row. `typedName` is what the applicant actually typed,
   kept verbatim — it is their mark, and correcting it would be forging it. */
export async function recordConsent({
  companyId, applicationId, providerKey, agency, companyName,
  typedName, ip = null, userAgent = null, now = stamp,
}) {
  const typed = String(typedName || "").trim();
  if (typed.length < 2) {
    throw new ConsentRefused("Type your full name to agree.");
  }

  const wording = consentWording({ companyName, agency });
  const at = now();
  const consentId = id();

  await insert("screening_consent", {
    id: consentId, company_id: companyId, application_id: applicationId,
    provider: providerKey, provider_name: agency.name,
    wording, wording_hash: sha256(wording),
    typed_name: typed, ip, user_agent: userAgent,
    consented_at: at, created_at: at,
  });

  return await one("SELECT * FROM screening_consent WHERE id = ?", consentId);
}

/* The consent in force for an application, if there is one. */
export async function activeConsent(applicationId) {
  return await get(
    `SELECT * FROM screening_consent
      WHERE application_id = ? AND withdrawn_at IS NULL
      ORDER BY consented_at DESC LIMIT 1`, applicationId);
}

export async function consentHistory(applicationId) {
  return await all(
    "SELECT * FROM screening_consent WHERE application_id = ? ORDER BY consented_at DESC",
    applicationId);
}

export async function withdrawConsent({ applicationId, at = stamp() }) {
  const consent = await activeConsent(applicationId);
  if (!consent) return null;
  await run("UPDATE screening_consent SET withdrawn_at = ? WHERE id = ?", at, consent.id);
  return await one("SELECT * FROM screening_consent WHERE id = ?", consent.id);
}

/* Whether the record still says what it said. A stored hash that no longer
   matches its wording means the row has been altered, and a consent that
   cannot be shown to be unaltered is not worth much. */
export function intact(consent) {
  return Boolean(consent) && sha256(consent.wording) === consent.wording_hash;
}
