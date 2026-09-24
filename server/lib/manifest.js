/* The installed app's name, per company.

   An installed icon said "Operations" or "Your home" — never "Leafridge".
   OPEN-ITEMS P4, and the reason it sat there is real: a manifest is fetched
   **without credentials**, so the request carries no session and the server
   cannot tell who is installing.

   The way round that is to put the identity in the URL, which is what the
   page does: it already knows the company when it renders the `<link>`, so
   it points at `/m/<slug>/app.webmanifest` instead of a single shared file.
   The manifest request then identifies itself without needing a cookie.

   Nothing secret is exposed by that. A company's name and slug are already
   public — they are on the listing page at `/c/<slug>` that managers hand to
   prospective tenants — and a manifest carries no more than a name, an icon
   and a start URL.

   A slug that matches no company falls back to the generic wording rather
   than 404ing. An install is not the moment to argue with somebody about a
   URL, and the generic manifest is exactly what they would have had before. */
import { get } from "./db.js";

const ICONS = [
  { src: "/app-assets/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/app-assets/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/app-assets/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
  { src: "/app-assets/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

const SHAPES = {
  app: {
    id: "/app", startUrl: "/app",
    genericName: "Property operations", genericShort: "Operations",
    description: "The back office: the queue, properties, repairs and money.",
    /* The company's own name, and a short form that survives being put under
       an icon. Home screens truncate at roughly a dozen characters, so a
       short name longer than that is worse than one that says nothing. */
    name: (c) => c.name,
    short: (c) => shorten(c.name),
  },
  portal: {
    id: "/portal", startUrl: "/portal",
    genericName: "Your home", genericShort: "Your home",
    description: "Rent, repairs and messages for the place you live or own.",
    /* A tenant is not installing their landlord's back office — they are
       installing the place they pay rent. The company's name belongs in it,
       but as whose it is rather than as the title. */
    name: (c) => `${c.name} — your home`,
    short: (c) => shorten(c.name),
  },
};

function shorten(name) {
  const t = String(name || "").trim();
  if (t.length <= 12) return t;
  /* The first word, if that alone will do. "Leafridge Property Management"
     becomes "Leafridge", not "Leafridge Pr". */
  const first = t.split(/\s+/)[0];
  return first.length <= 12 ? first : `${t.slice(0, 11)}…`;
}

export const manifestUrl = (kind, company) =>
  company?.slug
    ? `/m/${encodeURIComponent(company.slug)}/${kind}.webmanifest`
    : `/app-assets/${kind === "app" ? "manifest" : "portal"}.webmanifest`;

export async function buildManifest(kind, slug) {
  const shape = SHAPES[kind];
  if (!shape) return null;

  const company = slug
    ? await get("SELECT name, slug FROM company WHERE slug = ?", String(slug))
    : null;

  return {
    id: shape.id,
    name: company ? shape.name(company) : shape.genericName,
    short_name: company ? shape.short(company) : shape.genericShort,
    description: shape.description,
    start_url: shape.startUrl,
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#ffffff",
    theme_color: "#1b184e",
    icons: ICONS,
  };
}
