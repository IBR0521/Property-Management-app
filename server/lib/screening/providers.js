/* Screening providers, and what a real one would have to do.

   ## Why there is only one, and why it is the manual one

   Pulling a consumer report means credentialing with the bureau — an
   application, supporting documents, and since November 2015 an on-site
   inspection of physical business premises by all three. A platform in the
   middle is a **reseller**: it carries a consumer reporting agency's own
   obligation to follow "reasonable procedures to assure maximum possible
   accuracy" toward every applicant whose file passes through it, and it has
   to establish identity and permissible purpose for every end-user landlord
   separately.

   None of that is code. So the company brings their own screening account,
   and `manual` is not a placeholder — it is the correct implementation for a
   company that screens on somebody else's site, which is nearly all of them.

   ## What a real provider has to implement

   Four things, and the fourth is the one that is easy to skip:

     order(...)     send the applicant to the provider and record the request
     status(...)    ask whether a report is ready
     report(...)    fetch it, or a link to it
     describe()     who the agency IS — the legal name, the postal address
                    and the telephone number

   `describe()` exists because an adverse action notice is **required** to
   name the agency that supplied the report, with its address and telephone
   number, and to say that the agency did not make the decision. A provider
   that cannot answer that question cannot be used lawfully, so it is part of
   the interface rather than something the notice screen asks a person to
   remember. */

export const PROVIDERS = {
  manual: {
    key: "manual",
    label: "We run it ourselves",
    /* Filled in by the company: with the manual provider, the agency is
       whoever they actually use. */
    needsAgencyDetails: true,
    summary:
      "You screen wherever you screen today — TransUnion SmartMove, RentPrep, "
      + "your local agency — and record the outcome here. The applicant's "
      + "consent, the report, the decision and the adverse action notice all "
      + "live in one place, which is what matters when somebody asks about a "
      + "decision in a year's time.",
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = "manual";

export function provider(key) {
  return PROVIDERS[String(key || DEFAULT_PROVIDER)] || PROVIDERS[DEFAULT_PROVIDER];
}

/* The agency, as it has to appear on an adverse action notice.

   For `manual` this is the company's own setting, because the company knows
   who they used and we do not. A real provider would answer from its own
   `describe()`, and the shape is the same either way so the notice does not
   have to care which it was. */
export function agencyFor({ providerKey, settings }) {
  const spec = provider(providerKey);
  if (!spec.needsAgencyDetails) return spec.agency || null;

  const agency = settings?.agency || {};
  const name = String(agency.name || "").trim();
  if (!name) return null;

  return {
    name,
    address: String(agency.address || "").trim() || null,
    phone: String(agency.phone || "").trim() || null,
  };
}
