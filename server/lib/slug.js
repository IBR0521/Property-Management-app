/* Public handles for companies.

   A slug ends up in a URL that gets printed on a QR sticker and bookmarked, so
   it has to be stable, unambiguous when read aloud, and impossible to confuse
   with a path segment the router already owns.

   Two properties matter more than prettiness. It must not collide — "Smith
   Properties" is not a rare name — and it must not be able to shadow an
   existing route, because a company called "app" owning /c/app is harmless but
   a company that could claim /app is not. */
import { get } from "./db.js";

/* Words the router or the product already means something by. A company may
   still be called any of these; it just gets a suffixed handle. */
const RESERVED = new Set([
  "app", "api", "admin", "signup", "signin", "sign-in", "sign-out", "health",
  "report", "apply", "assets", "app-assets", "uploads", "feeds", "sign",
  "c", "t", "a", "o", "r", "platform", "billing", "support", "help",
  "www", "mail", "static", "public", "new", "edit", "delete",
]);

export function slugify(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")                    // fold accents rather than drop the word
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");                  // slicing can leave a trailing hyphen
  return base;
}

/* Finds a handle nobody else holds. Tries the plain form, then -2, -3, and so
   on. The loop is bounded: at some point the name is the problem, and a random
   suffix is better than spinning. */
export async function uniqueSlug(name, { excludeCompanyId = null } = {}) {
  let base = slugify(name);
  if (!base || RESERVED.has(base)) base = base ? `${base}-co` : "company";

  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (RESERVED.has(candidate)) continue;
    const taken = await get(
      "SELECT id FROM company WHERE slug = ? AND (?::text IS NULL OR id <> ?)",
      candidate, excludeCompanyId, excludeCompanyId);
    if (!taken) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Whether a handle somebody typed is one we would ever issue. Used by the
   settings screen, so a company changing its handle cannot claim a route. */
export function slugProblem(candidate) {
  const v = String(candidate || "").trim().toLowerCase();
  if (!v) return "A web address is required.";
  if (v.length < 2) return "Too short — use at least two characters.";
  if (v.length > 48) return "Too long — 48 characters at most.";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v)) {
    return "Use lower-case letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (v.includes("--")) return "Two hyphens in a row is hard to read aloud.";
  if (RESERVED.has(v)) return `"${v}" is reserved by the application.`;
  return null;
}

export { RESERVED };
