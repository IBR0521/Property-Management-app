/* Which company a public page belongs to.

   Staff pages know: the session says so. Public pages have no session, and
   until now they answered the question with `SELECT * FROM company LIMIT 1` —
   correct for one company, and wrong in a specific way for two. A tenant
   scanning their own QR sticker was shown a different company's name and told
   their address was not one we manage, because the lookup was scoped to the
   first company and found nothing.

   There are three ways a public request can name its company, and they are
   tried in order of how much they prove.

   **A token.** Six of the eight public entry points carry one — a work order,
   an application, an owner approval, a statement, a signing link, a QR
   sticker. Each identifies exactly one record, and a record belongs to exactly
   one company. This is the strongest answer available and needs nothing in the
   URL.

   **A slug.** `/c/leafridge/report`. For the two entry points that carry no
   token: an address typed by hand, and the application form.

   **Being the only one.** With a single company in the database there is no
   ambiguity, and refusing to answer would break every existing link and the
   entire development setup. With more than one this returns nothing, because
   guessing is what the old code did. */
import { get, all } from "./db.js";

/* Sticker tokens are globally unique, so the company comes from the unit and
   the caller does not have to know it first. That inversion is the fix: the
   old code chose a company and then looked for the token inside it. */
export async function companyForUnitToken(token) {
  const t = String(token || "");
  if (t.length < 8 || t.length > 64) return null;
  const row = await get(
    `SELECT c.* FROM unit u
       JOIN company c ON c.id = u.company_id
      WHERE u.report_token = ?`, t);
  return row || null;
}

/* The same inversion for any other tokenised record. `table` is never taken
   from user input — every call site passes a literal. */
export async function companyForToken(table, column, token) {
  const t = String(token || "");
  if (t.length < 20) return null;           // real tokens are 32 bytes
  const row = await get(
    `SELECT c.* FROM ${table} x JOIN company c ON c.id = x.company_id
      WHERE x.${column} = ?`, t);
  return row || null;
}

export async function companyBySlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  return await get("SELECT * FROM company WHERE slug = ?", s) || null;
}

/* The single-company fallback, and the reason it is safe.

   It answers only when there is exactly one company, which is the development
   setup and the first customer. The moment a second exists it returns null and
   the caller must ask — silently picking is the bug this module exists to
   remove. */
export async function soleCompany() {
  const rows = await all("SELECT * FROM company LIMIT 2");
  return rows.length === 1 ? rows[0] : null;
}

export async function companyCount() {
  const row = await get("SELECT COUNT(*)::int AS n FROM company");
  return Number(row?.n || 0);
}

/* The resolver public handlers call.

   `tokenLookup` is an async function the caller supplies when its route has a
   token — it knows which table that token belongs to and this module should
   not guess. Returns the company, or null with a reason the caller can render.

   A company that has not verified its email is still returned. Its public
   pages work; what is withheld is sending on its behalf, which is enforced
   where messages are produced rather than here. Refusing to render a repair
   form because an administrator has not clicked a link would punish the wrong
   person. */
export async function resolvePublicCompany(ctx, { tokenLookup = null } = {}) {
  if (tokenLookup) {
    const byToken = await tokenLookup();
    if (byToken) return { company: byToken, via: "token" };
  }

  if (ctx.params?.slug) {
    const bySlug = await companyBySlug(ctx.params.slug);
    if (bySlug) return { company: bySlug, via: "slug" };
    return { company: null, reason: "unknown-slug" };
  }

  const only = await soleCompany();
  if (only) return { company: only, via: "sole" };

  return { company: null, reason: (await companyCount()) === 0 ? "none" : "ambiguous" };
}

/* Where a public link for this company should point. One place, so the QR
   sheet, the application link and anything printed agree. */
export function publicPath(company, path) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return company?.slug ? `/c/${company.slug}${clean}` : clean;
}
