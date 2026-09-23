/* What a company has decided about screening.

   One setting row holding one object, because these are read together on
   every screen that touches screening and a row each would be four queries
   to answer one question. */
import { putSetting, readSetting } from "../settings.js";
import { DEFAULT_PROVIDER, PROVIDER_KEYS } from "./providers.js";

const KEY = "screening";

/* Ninety days after the decision.

   A tenant screening report holds somebody's credit file, their addresses and
   possibly their criminal history. It is the worst thing this database would
   ever hold, and the shortest useful retention is worth more than any amount
   of care elsewhere. Ninety days covers the period in which a decision might
   be questioned and an applicant might dispute what was in the report; longer
   than that is keeping it because deleting is effort. */
export const DEFAULT_RETENTION_DAYS = 90;

/* The ceiling is a judgement rather than a rule, and it is here so that
   "keep it for ever" is not a value somebody can type into a box. */
export const MAX_RETENTION_DAYS = 730;

export async function screeningSettings(companyId) {
  const saved = (await readSetting(companyId, KEY)) || {};
  return {
    provider: PROVIDER_KEYS.includes(saved.provider) ? saved.provider : DEFAULT_PROVIDER,
    retentionDays: clampDays(saved.retentionDays),
    agency: {
      name: String(saved.agency?.name || "").trim(),
      address: String(saved.agency?.address || "").trim(),
      phone: String(saved.agency?.phone || "").trim(),
    },
  };
}

export async function saveScreeningSettings(companyId, next) {
  const current = await screeningSettings(companyId);
  await putSetting(companyId, KEY, {
    provider: PROVIDER_KEYS.includes(next.provider) ? next.provider : current.provider,
    retentionDays: clampDays(next.retentionDays ?? current.retentionDays),
    agency: {
      name: String(next.agency?.name ?? current.agency.name).trim(),
      address: String(next.agency?.address ?? current.agency.address).trim(),
      phone: String(next.agency?.phone ?? current.agency.phone).trim(),
    },
  });
  return await screeningSettings(companyId);
}

function clampDays(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(n, MAX_RETENTION_DAYS);
}
