/* The public listing pages.

   ## Why this is worth more than the feed on day one

   Syndication needs Zillow's approval and four to six weeks of their feed
   testing before it does anything. A page on the company's own address needs
   nobody's permission, and a manager with no syndication at all can send
   somebody a link.

   ## This is the first page served to strangers at scale

   Everything public before it — the repair form, the application, an owner's
   statement — was behind a token somebody was given. A listing page is meant
   to be found, which makes it the first thing worth pointing a scraper at.
   So: the enquiry form is rate limited like every other public form, and the
   index shows only what the company marked publishable, per company, so the
   page cannot be walked to enumerate a portfolio.

   ## A viewing request is a request

   Not a booking. Nothing here tells somebody a time is confirmed, because
   nothing here can confirm one — the same rule that stops the outbox claiming
   a message was sent. The enquiry lands in the inbox attached to the listing,
   and a person replies. */
import { all, get, one, insert } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, today } from "../lib/dates.js";
import { usd } from "../lib/money.js";
import { sendHtml, redirect } from "../lib/http.js";
import { buildManifest } from "../lib/manifest.js";
import { html, attr } from "../lib/render.js";
import { publicPage, notice, empty } from "../views/layout.js";
import { fileUrl } from "../lib/files.js";
import { check, clientIp } from "../lib/ratelimit.js";
import { resolvePublicCompany, publicPath } from "../lib/tenancy.js";
import { openThread, recordInbound } from "../lib/threading.js";

const PETS = {
  none: "No pets", cats: "Cats considered", dogs: "Dogs considered",
  both: "Cats and dogs considered", case_by_case: "Pets considered case by case",
};

export function registerPublicListings(router) {
  /* The installed app's name, per company.

     Public because a manifest is fetched without credentials — that is the
     whole reason the company is in the URL rather than in a session. Nothing
     here is more than a name, an icon and a start URL, and the name is
     already on the listing page this file serves. */
  router.get("/m/:slug/:kind.webmanifest", async (ctx) => {
    const manifest = await buildManifest(String(ctx.params.kind), ctx.params.slug);
    if (!manifest) return sendHtml(ctx.res, "Not found", 404);
    ctx.res.setHeader("content-type", "application/manifest+json; charset=utf-8");
    /* Short, because a company can be renamed and an installed icon that
       keeps the old name for a year is the bug this was meant to fix. */
    ctx.res.setHeader("cache-control", "public, max-age=3600");
    ctx.res.end(JSON.stringify(manifest, null, 2));
  });

  router.get("/robots.txt", async (ctx) => {
    ctx.res.setHeader("content-type", "text/plain; charset=utf-8");
    ctx.res.end(
      "User-agent: *\n"
      + "Allow: /c/\n"
      + "Allow: /listings\n"
      + "Disallow: /app\n"
      + "Disallow: /portal\n"
      + "Disallow: /api\n"
      + "Disallow: /feeds/\n"
      + "Disallow: /pay/\n"
      + "Disallow: /signup\n"
      + "\n"
      + "# Each company's vacancies are listed at /c/<company>/sitemap.xml.\n"
      + "# A single sitemap here would name every company on the platform.\n"
    );
  });

  router.get("/c/:slug/sitemap.xml", async (ctx) => {
    const company = await resolvePublicCompany(ctx);
    if (!company.company) {
      ctx.res.statusCode = 404;
      ctx.res.setHeader("content-type", "text/plain; charset=utf-8");
      return ctx.res.end("Not found");
    }
    const rows = await all(
      `SELECT id FROM listing
        WHERE company_id = ? AND status = 'active' ORDER BY rent_cents`, company.company.id);
    const urls = [absolute(ctx, publicPath(company.company, "/listings")),
      ...rows.map((l) => absolute(ctx, publicPath(company.company, `/listings/${l.id}`)))];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + urls.map((loc) => `  <url><loc>${xml(loc)}</loc></url>`).join("\n")
      + `\n</urlset>\n`;
    ctx.res.setHeader("content-type", "application/xml; charset=utf-8");
    ctx.res.end(body);
  });

  router.get("/c/:slug/listings", async (ctx) => renderIndex(ctx));
  router.get("/listings", async (ctx) => renderIndex(ctx));

  router.get("/c/:slug/listings/:id", async (ctx) => renderOne(ctx));
  router.get("/listings/:id", async (ctx) => renderOne(ctx));

  router.post("/c/:slug/listings/:id/enquire", async (ctx) => handleEnquiry(ctx));
  router.post("/listings/:id/enquire", async (ctx) => handleEnquiry(ctx));

  /* --- the index ---------------------------------------------------------- */

  async function renderIndex(ctx) {
    const { company, reason } = await resolvePublicCompany(ctx);
    if (!company) return sendHtml(ctx.res, whichCompany(reason), 404);

    const rows = await all(
      `SELECT l.*, u.label, u.beds AS unit_beds, u.baths AS unit_baths, u.sqft AS unit_sqft,
              p.line1, p.city, p.state, p.zip,
              (SELECT ph.path FROM listing_photo ph
                WHERE ph.listing_id = l.id ORDER BY ph.rank LIMIT 1) AS photo
         FROM listing l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
        WHERE l.company_id = ? AND l.status = 'active'
        ORDER BY l.rent_cents, p.line1, u.label`, company.id);

    const lede = rows.length
      ? `${rows.length} ${rows.length === 1 ? "place" : "places"} to rent right now.`
      : "Nothing is available at the moment.";
    const canonical = absolute(ctx, publicPath(company, "/listings"));

    sendHtml(ctx.res, publicPage({
      company, title: `Places to rent · ${company.name}`,
      heading: `Available from ${company.name}`,
      lede,
      index: true,
      description: `${lede} Homes from ${company.name}.`,
      canonical,
      body: html`
        ${rows.length ? html`
          <div class="grid grid--2">
            ${rows.map((l) => html`
              <div class="panel">
                ${l.photo ? html`
                  <a href="${publicPath(company, `/listings/${l.id}`)}">
                    <img src="${fileUrl(l.photo)}" alt="${l.headline}"
                         style="width:100%;height:11rem;object-fit:cover;border-radius:0.5rem 0.5rem 0 0" />
                  </a>` : ""}
                <div class="panel__body">
                  <h2 style="margin:0 0 0.35rem"><a href="${publicPath(company, `/listings/${l.id}`)}"
                    style="text-decoration:none">${l.headline}</a></h2>
                  <p class="lede" style="margin:0 0 0.5rem">${l.line1}${l.label ? `, unit ${l.label}` : ""}
                    — ${l.city}, ${l.state}</p>
                  <p style="margin:0">
                    <b>${usd(l.rent_cents)}</b> a month
                    ${l.unit_beds != null ? html` · ${l.unit_beds} bed` : ""}
                    ${l.unit_baths != null ? html` · ${l.unit_baths} bath` : ""}
                    ${l.unit_sqft ? html` · ${l.unit_sqft} sq ft` : ""}
                  </p>
                  ${l.available_date ? html`<p class="lede" style="margin:0.35rem 0 0">
                    Available ${human(l.available_date)}</p>` : ""}
                </div>
              </div>`)}
          </div>` : empty("Nothing right now",
            "Please check back, or get in touch and we will let you know.")}`,
    }));
  }

  /* --- one listing -------------------------------------------------------- */

  async function renderOne(ctx) {
    const { company, reason } = await resolvePublicCompany(ctx);
    if (!company) return sendHtml(ctx.res, whichCompany(reason), 404);

    const listing = await get(
      `SELECT l.*, u.label, u.beds AS unit_beds, u.baths AS unit_baths, u.sqft AS unit_sqft,
              p.line1, p.city, p.state, p.zip
         FROM listing l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
        WHERE l.id = ? AND l.company_id = ? AND l.status = 'active'`,
      ctx.params.id, company.id);

    /* A draft or a let place is not a 404 for the wrong reason: it is gone,
       and saying so is better than a page that looks broken. */
    if (!listing) {
      return sendHtml(ctx.res, publicPage({
        company, title: "Not available",
        heading: "That one has gone",
        lede: "It may have been let, or taken off the market.",
        body: html`<p class="lede"><a href="${publicPath(company, "/listings")}">See what else is
          available</a>.</p>`,
      }), 404);
    }

    const photos = await all(
      "SELECT * FROM listing_photo WHERE listing_id = ? ORDER BY rank", listing.id);

    const where = `${listing.line1}${listing.label ? `, unit ${listing.label}` : ""} — `
      + `${listing.city}, ${listing.state} ${listing.zip}`;
    const canonical = absolute(ctx, publicPath(company, `/listings/${listing.id}`));
    const photo = photos[0] ? absolute(ctx, fileUrl(photos[0].path)) : null;
    const description = listingBlurb(listing, where, company.name);

    sendHtml(ctx.res, publicPage({
      company, title: `${listing.headline} · ${company.name}`,
      heading: listing.headline,
      lede: where,
      index: true,
      description,
      canonical,
      image: photo,
      jsonLd: listingJson(listing, { where, canonical, photo, company }),
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}

        ${photos.length ? html`
          <div class="panel"><div class="panel__body">
            <div class="grid grid--2">
              ${photos.map((ph) => html`
                <a href="${fileUrl(ph.path)}" target="_blank">
                  <img src="${fileUrl(ph.path)}"${attr("alt", ph.caption || listing.headline)}
                       style="width:100%;height:12rem;object-fit:cover;border-radius:0.5rem" />
                </a>`)}
            </div>
          </div></div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>The place</h2></div>
          <div class="panel__body">
            <div class="tablewrap"><table class="data"><tbody>
              <tr><td>Rent</td><td class="num"><b>${usd(listing.rent_cents)}</b> a month</td></tr>
              ${listing.deposit_cents != null
                ? html`<tr><td>Deposit</td><td class="num">${usd(listing.deposit_cents)}</td></tr>` : ""}
              ${listing.available_date
                ? html`<tr><td>Available</td><td class="num">${human(listing.available_date)}</td></tr>` : ""}
              ${listing.lease_months
                ? html`<tr><td>Lease</td><td class="num">${listing.lease_months} months</td></tr>` : ""}
              ${listing.unit_beds != null
                ? html`<tr><td>Bedrooms</td><td class="num">${listing.unit_beds}</td></tr>` : ""}
              ${listing.unit_baths != null
                ? html`<tr><td>Bathrooms</td><td class="num">${listing.unit_baths}</td></tr>` : ""}
              ${listing.unit_sqft
                ? html`<tr><td>Size</td><td class="num">${listing.unit_sqft} sq ft</td></tr>` : ""}
              ${listing.pets ? html`<tr><td>Pets</td><td class="num">${PETS[listing.pets] || listing.pets}</td></tr>` : ""}
              ${listing.parking ? html`<tr><td>Parking</td><td class="num">${listing.parking}</td></tr>` : ""}
              ${listing.laundry ? html`<tr><td>Laundry</td><td class="num">${listing.laundry}</td></tr>` : ""}
              ${listing.utilities_note ? html`<tr><td>Utilities</td><td class="num">${listing.utilities_note}</td></tr>` : ""}
              <tr><td>Smoking</td><td class="num">${listing.smoking ? "Permitted" : "Not permitted"}</td></tr>
            </tbody></table></div>

            ${listing.description ? html`
              <p class="lede" style="margin-top:1.25rem;white-space:pre-wrap">${listing.description}</p>` : ""}

            ${listing.virtual_tour_url ? html`
              <p style="margin-top:1rem"><a class="pill outline" href="${listing.virtual_tour_url}"
                target="_blank" rel="noreferrer noopener">Virtual tour</a></p>` : ""}
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2>Ask about it</h2>
            <p>Or ask to see it</p>
          </div>
          <div class="panel__body">
            ${notice("info", "A viewing request is a request",
              "Nobody is booked in by this form. Somebody will read it and reply to arrange "
              + "a time — we would rather say that than show you a calendar that promises "
              + "something we have not agreed.")}

            <form method="post" action="${publicPath(company, `/listings/${listing.id}/enquire`)}"
                  class="formgrid" style="margin-top:1.25rem">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="name">Your name</label>
                  <input id="name" name="name" type="text" required maxlength="120" autocomplete="name" />
                </div>
                <div class="field">
                  <label for="email">Email</label>
                  <input id="email" name="email" type="email" required maxlength="200" autocomplete="email" />
                  <span class="field__help">So somebody can reply to you.</span>
                </div>
              </div>
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="phone">Phone <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
                  <input id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel" />
                </div>
                <div class="field">
                  <label for="move_in">When you would want it</label>
                  <input id="move_in" name="move_in" type="date"${attr("min", today())} />
                </div>
              </div>
              <div class="field">
                <label for="viewing">When could you see it</label>
                <input id="viewing" name="viewing" type="text" maxlength="200"
                       placeholder="Weekday evenings, or Saturday morning" />
                <span class="field__help">In your own words. Somebody will suggest a time.</span>
              </div>
              <div class="field">
                <label for="message">Anything else</label>
                <textarea id="message" name="message" rows="3" maxlength="2000"></textarea>
              </div>
              <button class="pill solid" type="submit">Send</button>
            </form>
          </div>
        </div>`,
    }));
  }

  /* --- the enquiry -------------------------------------------------------- */

  async function handleEnquiry(ctx) {
    const { company } = await resolvePublicCompany(ctx);
    if (!company) return sendHtml(ctx.res, whichCompany("unknown-slug"), 404);

    const back = (m) => redirect(ctx.res,
      `${publicPath(company, `/listings/${ctx.params.id}`)}?m=${encodeURIComponent(m)}`);

    const rate = await check("enquiry", clientIp(ctx.req));
    if (!rate.allowed) {
      return back("That is a lot of enquiries from one place. Try again in an hour, or "
        + "telephone us.");
    }

    const listing = await get(
      `SELECT l.*, u.label, p.line1, p.city
         FROM listing l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.id = ? AND l.company_id = ? AND l.status = 'active'`,
      ctx.params.id, company.id);
    if (!listing) return back("That one is no longer available.");

    const name = String(ctx.fields.name || "").trim();
    const email = String(ctx.fields.email || "").trim().toLowerCase();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return back("We need your name and an email address to reply to.");
    }

    const where = `${listing.line1}${listing.label ? `, unit ${listing.label}` : ""}`;
    const lines = [
      `${name} asked about ${where}.`,
      "",
    ];
    if (ctx.fields.phone) lines.push(`Phone: ${String(ctx.fields.phone).trim()}`);
    if (ctx.fields.move_in) lines.push(`Would want it from: ${String(ctx.fields.move_in).trim()}`);
    if (ctx.fields.viewing) lines.push(`Could view: ${String(ctx.fields.viewing).trim()}`);
    if (ctx.fields.message) {
      lines.push("");
      lines.push(String(ctx.fields.message).trim().slice(0, 2000));
    }

    /* Attached to the listing, so a conversation that started from a vacancy
       stays attached to it — the same rule as a conversation that started
       from a repair. */
    const thread = await openThread({
      companyId: company.id,
      subject: `Enquiry — ${where}`,
      channel: "email", fromContact: email,
      about: { type: "listing", id: listing.id },
    });

    await recordInbound({
      companyId: company.id, thread, channel: "email",
      body: lines.join("\n"),
      subject: `Enquiry — ${where}`,
      fromContact: email,
    });

    await insert("audit_log", {
      id: id(), company_id: company.id, at: stamp(), actor: name,
      entity: "listing", entity_id: listing.id, action: "enquiry",
      detail: `${email}${ctx.fields.viewing ? ` · could view ${String(ctx.fields.viewing).slice(0, 80)}` : ""}`,
    });

    back("Thank you — somebody will get back to you. Nothing is booked yet.");
  }
}

/* Names no company: listing every company on the platform so a visitor can
   pick is the portfolio-enumeration mistake one level up. */
function absolute(ctx, path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${ctx.url.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function listingBlurb(listing, where, companyName) {
  const rent = usd(listing.rent_cents);
  const extra = listing.description ? ` ${String(listing.description).replace(/\s+/g, " ").trim()}` : "";
  const text = `${where}. ${rent} a month, from ${companyName}.${extra}`;
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function listingJson(listing, { where, canonical, photo, company }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Apartment",
    name: listing.headline,
    url: canonical,
    address: {
      "@type": "PostalAddress",
      streetAddress: `${listing.line1}${listing.label ? `, unit ${listing.label}` : ""}`,
      addressLocality: listing.city,
      addressRegion: listing.state,
      postalCode: listing.zip,
    },
    offers: {
      "@type": "Offer",
      price: (Number(listing.rent_cents) / 100).toFixed(2),
      priceCurrency: company.currency || "USD",
      availability: "https://schema.org/InStock",
    },
  };
  if (listing.description) data.description = String(listing.description);
  else data.description = where;
  if (listing.unit_beds != null) data.numberOfRooms = Number(listing.unit_beds);
  if (photo) data.image = photo;
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function whichCompany(reason) {
  const message = reason === "none"
    ? "This installation has no company set up yet."
    : reason === "unknown-slug"
    ? "That web address does not match a company we know."
    : "This link is missing the company it belongs to.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex, nofollow"><title>Not found</title>`
    + `<link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/app-assets/app.css">`
    + `</head><body><div class="pub" style="max-width:32rem"><h1>We need a little more</h1>`
    + `<p class="lede">${message}</p></div></body></html>`;
}
