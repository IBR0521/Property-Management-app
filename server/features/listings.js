/* F11  Vacancy marketing and the syndication feed.

   A listing is a separate row from its unit on purpose. A unit is a fact about
   a building; a listing is a marketing claim with its own copy, its own
   lifecycle and its own decision about whether it goes out to the world.
   Folding them together would make every unit edit a potential publication.

   Syndication is opt-in per listing and off by default, because pushing an
   address to every aggregator on the internet is a decision somebody makes
   deliberately.

   On the format: there is no single "ILD" schema that every aggregator
   accepts. Zillow, Apartments.com and the ILS networks each take a dialect of
   the same idea — a provider envelope, then one element per property with
   nested units. This produces that common shape with correct escaping and
   stable identifiers, which is the part that is the same everywhere; expect to
   map field names when onboarding a specific network. */
import { all, get, one, insert, update } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { companyBySlug, publicPath } from "../lib/tenancy.js";
import { buildMits, feedsArePerCompany } from "../lib/listings/mits.js";

/* --- the feed ------------------------------------------------------------- */

/* The feed builder moved to `lib/listings/mits.js` when it became one
   document per company rather than one for the whole platform — see the
   routes below for why that was not a detail. */

/* --- routes --------------------------------------------------------------- */

export function registerListings(router) {
  /* The feeds. Public and unauthenticated by design: an aggregator crawls a
     URL hourly and does not hold an account.

     **One per company.** This used to be a single document containing every
     company on the platform, labelled with whichever one sorted first — so a
     manager who handed that URL to Zillow would have been publishing their
     competitors' listings under their own management id, and the network
     would have been right to believe them. Found by writing the MITS
     management block, which is the element a feed agreement is matched
     against.

     The platform-wide URL still answers, and carries no listings, because
     somebody will hand a network the obvious address and the obvious address
     should not publish everybody. */
  const feedHeaders = {
    "Content-Type": "application/xml; charset=utf-8",
    // Aggregators crawl hourly; this stops them paying for a rebuild each time.
    "Cache-Control": "public, max-age=900",
    "X-Robots-Tag": "noindex",
  };

  router.get("/feeds/listings.xml", async (ctx) => {
    ctx.res.writeHead(200, feedHeaders);
    ctx.res.end(feedsArePerCompany(`${ctx.url.protocol}//${ctx.url.host}`));
  });

  router.get("/feeds/:slug/listings.xml", async (ctx) => {
    const company = await companyBySlug(ctx.params.slug);
    if (!company) {
      ctx.res.writeHead(404, feedHeaders);
      return ctx.res.end(`<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<PhysicalProperty><Management><Comment>No company with that address.`
        + `</Comment></Management></PhysicalProperty>`);
    }
    const xml = await buildMits({
      companyId: company.id, origin: `${ctx.url.protocol}//${ctx.url.host}` });
    ctx.res.writeHead(200, feedHeaders);
    ctx.res.end(xml);
  });

  router.get("/app/listings", async (ctx) => {
    const cid = ctx.staff.company_id;
    const company = await one("SELECT * FROM company WHERE id = ?", cid);
    const rows = await all(
      `SELECT l.*, u.label, p.line1, p.city,
              (SELECT COUNT(*) FROM listing_photo ph WHERE ph.listing_id = l.id)::int AS photos
         FROM listing l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.company_id = ? ORDER BY l.status, p.line1, u.label`, cid);

    /* Vacant units with nothing advertising them. The most useful thing this
       page can show is the gap between "empty" and "being marketed". */
    const unlisted = await all(
      `SELECT u.id, u.label, u.market_rent_cents, p.line1, p.city
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ? AND u.status IN ('vacant','turn')
          AND NOT EXISTS (SELECT 1 FROM listing l WHERE l.unit_id = u.id)
        ORDER BY p.line1, u.label`, cid);

    const live = rows.filter((r) => r.status === "active" && r.syndicate).length;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "listings", counts: await navCounts(cid),
      title: "Vacancies",
      subtitle: `${rows.length} listing${rows.length === 1 ? "" : "s"} · ${live} syndicated`,
      actions: html`<a class="pill outline sm" href="${publicPath(company, "/listings")}"
        target="_blank">Your public page</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${unlisted.length ? notice("warn", `${unlisted.length} empty unit(s) not advertised`,
          "An empty unit with no listing is losing rent quietly.") : ""}

        <div class="panel">
          <div class="panel__head"><h2>Where these appear</h2>
            <p>One page that works today, one feed that needs somebody's approval first</p>
          </div>
          <div class="panel__body panel__body--flush">
            <!-- Two labelled rows, not tabular data. The presentation role
                 stops a screen reader announcing "table, 2 columns, row 1 of 2"
                 before every line of what is really a short list. -->
            <div class="tablewrap"><table class="data" role="presentation"><tbody>
              <tr>
                <td class="shrink"><b>Your page</b></td>
                <td><a href="${publicPath(company, "/listings")}" target="_blank">${publicPath(company, "/listings")}</a>
                  <span class="cellsub">Every active listing, with an enquiry form that lands in
                    your inbox. Needs nobody's permission — send somebody the link.</span></td>
              </tr>
              <tr>
                <td class="shrink"><b>Your feed</b></td>
                <td><code>/feeds/${company.slug || "\u2014"}/listings.xml</code>
                  <span class="cellsub">MITS, which is what both Zillow and Apartments.com read.
                    <b>Only the listings you ticked for syndication.</b> Give a network
                    <em>this</em> address — the one without your name in it carries no
                    listings on purpose, because a shared feed would publish other
                    companies' properties under yours.</span></td>
              </tr>
            </tbody></table></div>
            <div class="panel__body">
              ${notice("info", "Before a feed does anything",
                html`Zillow wants an integration request approved by their Rentals Integrations
                  team <b>before</b> a feed is worth pointing at them, then four to six weeks of
                  their own feed testing. Apartments.com will send you their guide and take the
                  XML by URL. Both are free. Neither will look at a feed from somebody who has
                  not asked, so that is an email you send rather than a setting here.`)}
            </div>
          </div>
        </div>

        ${unlisted.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Empty, not advertised</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap tablewrap--narrow"><table class="data">
                <tbody>${unlisted.map((u) => html`
                  <tr>
                    <td>${u.line1}${u.label ? ` · Unit ${u.label}` : ""}<span class="cellsub">${u.city}</span></td>
                    <td class="num">${u.market_rent_cents ? usd(u.market_rent_cents) : "—"}</td>
                    <td class="shrink">
                      <a class="pill solid sm" href="/app/listings/new?unit=${u.id}">Advertise it</a>
                    </td>
                  </tr>`)}</tbody>
              </table></div>
            </div>
          </div>` : ""}

        <div class="panel">
          <div class="panel__head"><h2>Listings</h2>
            <a class="pill outline sm" href="/feeds/listings.xml">View the feed</a></div>
          <div class="panel__body panel__body--flush">
            ${rows.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
              <thead><tr><th>Unit</th><th>Headline</th><th class="num">Rent</th>
                <th>Status</th><th>Syndicated</th><th class="shrink"></th></tr></thead>
              <tbody>${rows.map((l) => html`
                <tr>
                  <td>${l.line1}${l.label ? ` · ${l.label}` : ""}</td>
                  <td>${l.headline}<span class="cellsub">${l.photos} photo(s)</span></td>
                  <td class="num">${usd(l.rent_cents)}</td>
                  <td><span class="chip"${attr("data-tone", l.status === "active" ? "ok" : null)}>${l.status}</span></td>
                  <td>${l.syndicate
                    ? html`<span class="chip" data-tone="brand">live</span>`
                    : html`<span class="chip">private</span>`}</td>
                  <td class="shrink"><a class="pill outline sm" href="/app/listings/${l.id}"
                  ${attr("aria-label", `Edit the listing ${l.headline || ""}`)}>Edit</a></td>
                </tr>`)}</tbody></table></div>`
              : empty("No listings yet", "Advertise an empty unit to start.")}
          </div>
        </div>`,
    }));
  });

  router.get("/app/listings/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const units = await all(
      `SELECT u.id, u.label, u.market_rent_cents, p.line1, p.city
         FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.company_id = ?
          AND NOT EXISTS (SELECT 1 FROM listing l WHERE l.unit_id = u.id)
        ORDER BY p.line1, u.label`, cid);
    const chosen = units.find((u) => u.id === ctx.query.unit) || null;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "listings", counts: await navCounts(cid),
      title: "Advertise a unit", subtitle: "Copy, price, and whether it goes out to the networks",
      body: units.length
        ? listingForm({ csrf: ctx.csrf, listing: null, units, chosen, error: ctx.query.e })
        : empty("Every unit already has a listing.", "Edit an existing one instead."),
    }));
  });

  router.post("/app/listings/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const bad = (m) => redirect(ctx.res, `/app/listings/new?e=${encodeURIComponent(m)}`);
    const unit = await get("SELECT id FROM unit WHERE id = ? AND company_id = ?", String(f.unit_id || ""), cid);
    if (!unit) return bad("Pick which unit this is for.");
    const rent = parseMoney(f.rent);
    if (rent == null || rent <= 0) return bad("What is the asking rent?");
    const headline = String(f.headline || "").trim();
    if (headline.length < 4) return bad("Give it a headline people will read.");

    const lid = id();
    await insert("listing", {
      id: lid, company_id: cid, unit_id: unit.id,
      status: ["draft", "active", "paused", "leased"].includes(f.status) ? f.status : "draft",
      headline, description: String(f.description || "").trim() || null,
      rent_cents: rent, deposit_cents: parseMoney(f.deposit) ?? null,
      available_date: dateOrNull(f.available_date),
      lease_months: intOrNull(f.lease_months),
      pets: ["none", "cats", "dogs", "both", "case_by_case"].includes(f.pets) ? f.pets : null,
      smoking: f.smoking === "yes" ? 1 : 0,
      laundry: String(f.laundry || "").trim() || null,
      parking: String(f.parking || "").trim() || null,
      utilities_note: String(f.utilities || "").trim() || null,
      virtual_tour_url: String(f.virtual_tour_url || "").trim() || null,
      contact_name: String(f.contact_name || "").trim() || null,
      contact_phone: String(f.contact_phone || "").trim() || null,
      contact_email: String(f.contact_email || "").trim() || null,
      syndicate: f.syndicate === "yes" ? 1 : 0,
      created_at: stamp(), updated_at: stamp(),
    });
    redirect(ctx.res, `/app/listings?m=${encodeURIComponent("Listing created.")}`);
  });

  router.get("/app/listings/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const listing = await one(
      `SELECT l.*, u.label, p.line1, p.city FROM listing l
         JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.id = ? AND l.company_id = ?`, ctx.params.id, cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "listings", counts: await navCounts(cid),
      title: listing.headline,
      subtitle: `${listing.line1}${listing.label ? ` · Unit ${listing.label}` : ""}`,
      actions: html`<a class="pill outline sm" href="/app/listings">All listings</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${listingForm({ csrf: ctx.csrf, listing, units: [], chosen: null, error: ctx.query.e })}`,
    }));
  });

  router.post("/app/listings/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const listing = await one(
      "SELECT * FROM listing WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    const rent = parseMoney(f.rent);
    await update("listing", listing.id, {
      status: ["draft", "active", "paused", "leased"].includes(f.status) ? f.status : listing.status,
      headline: String(f.headline || listing.headline).trim(),
      description: String(f.description || "").trim() || null,
      rent_cents: rent != null && rent > 0 ? rent : listing.rent_cents,
      deposit_cents: parseMoney(f.deposit) ?? null,
      available_date: dateOrNull(f.available_date),
      lease_months: intOrNull(f.lease_months),
      pets: ["none", "cats", "dogs", "both", "case_by_case"].includes(f.pets) ? f.pets : null,
      smoking: f.smoking === "yes" ? 1 : 0,
      laundry: String(f.laundry || "").trim() || null,
      parking: String(f.parking || "").trim() || null,
      utilities_note: String(f.utilities || "").trim() || null,
      virtual_tour_url: String(f.virtual_tour_url || "").trim() || null,
      contact_name: String(f.contact_name || "").trim() || null,
      contact_phone: String(f.contact_phone || "").trim() || null,
      contact_email: String(f.contact_email || "").trim() || null,
      syndicate: f.syndicate === "yes" ? 1 : 0,
      updated_at: stamp(),
    });
    redirect(ctx.res, `/app/listings/${listing.id}?m=${encodeURIComponent("Listing updated.")}`);
  });
}

const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim()) ? String(v).trim() : null);
const intOrNull = (v) => {
  const n = parseInt(String(v || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* --- views ---------------------------------------------------------------- */

function listingForm({ csrf, listing, units, chosen, error }) {
  const action = listing ? `/app/listings/${listing.id}` : "/app/listings/new";
  const val = (k) => (listing && listing[k] != null ? listing[k] : "");
  const money = (k) => (listing && listing[k] != null ? (listing[k] / 100).toFixed(2) : "");
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <form method="post" action="${action}">
      <input type="hidden" name="_csrf" value="${csrf}" />

      <div class="panel">
        <div class="panel__head"><h2>${listing ? "Listing" : "New listing"}</h2></div>
        <div class="panel__body">
          ${listing ? "" : html`
            <div class="field">
              <label for="unit_id">Unit</label>
              <select id="unit_id" name="unit_id" required>
                <option value="">Which unit?</option>
                ${units.map((u) => html`
                  <option value="${u.id}"${attr("selected", chosen && chosen.id === u.id)}>
                    ${u.line1}${u.label ? ` · Unit ${u.label}` : ""}, ${u.city}
                  </option>`)}
              </select>
            </div>`}
          <div class="field">
            <label for="headline">Headline</label>
            <input id="headline" name="headline" type="text" required maxlength="160"
                   value="${val("headline")}" placeholder="Bright two-bed with off-street parking" />
          </div>
          <div class="field">
            <label for="description">Description</label>
            <textarea id="description" name="description" rows="6" maxlength="4000">${val("description")}</textarea>
            <span class="field__help">Plain text. This goes out to the networks exactly as typed.</span>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="rent">Asking rent</label>
              <input id="rent" name="rent" type="text" inputmode="decimal" required
                     value="${money("rent_cents") || (chosen && chosen.market_rent_cents ? (chosen.market_rent_cents / 100).toFixed(2) : "")}" /></div>
            <div class="field"><label for="deposit">Deposit</label>
              <input id="deposit" name="deposit" type="text" inputmode="decimal" value="${money("deposit_cents")}" /></div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="available_date">Available from</label>
              <input id="available_date" name="available_date" type="date" value="${val("available_date")}" /></div>
            <div class="field"><label for="lease_months">Lease length (months)</label>
              <input id="lease_months" name="lease_months" type="number" min="1" max="60" value="${val("lease_months")}" /></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Details renters ask about</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="pets">Pets</label>
              <select id="pets" name="pets">
                <option value="">Not stated</option>
                ${["none", "cats", "dogs", "both", "case_by_case"].map((p) => html`
                  <option value="${p}"${attr("selected", listing && listing.pets === p)}>${p.replace(/_/g, " ")}</option>`)}
              </select>
            </div>
            <div class="field"><label for="laundry">Laundry</label>
              <input id="laundry" name="laundry" type="text" maxlength="80" value="${val("laundry")}"
                     placeholder="In unit · shared · none" /></div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field"><label for="parking">Parking</label>
              <input id="parking" name="parking" type="text" maxlength="80" value="${val("parking")}" /></div>
            <div class="field"><label for="utilities">Utilities</label>
              <input id="utilities" name="utilities" type="text" maxlength="160" value="${val("utilities_note")}"
                     placeholder="Water and trash included" /></div>
          </div>
          <div class="field"><label for="virtual_tour_url">Virtual tour link</label>
            <input id="virtual_tour_url" name="virtual_tour_url" type="url" value="${val("virtual_tour_url")}" /></div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="smoking" value="yes"${attr("checked", listing && listing.smoking)} />
              <span>Smoking permitted</span>
            </label>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Who renters contact</h2></div>
        <div class="panel__body">
          <div class="formgrid formgrid--2">
            <div class="field"><label for="contact_name">Name</label>
              <input id="contact_name" name="contact_name" type="text" value="${val("contact_name")}" /></div>
            <div class="field"><label for="contact_phone">Phone</label>
              <input id="contact_phone" name="contact_phone" type="tel" value="${val("contact_phone")}" /></div>
          </div>
          <div class="field"><label for="contact_email">Email</label>
            <input id="contact_email" name="contact_email" type="email" value="${val("contact_email")}" /></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head"><h2>Publishing</h2></div>
        <div class="panel__body">
          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Status</span>
            <div class="radioset">
              ${["draft", "active", "paused", "leased"].map((s) => html`
                <label class="radiotile">
                  <input type="radio" name="status" value="${s}"${attr("checked",
                    listing ? listing.status === s : s === "draft")} />
                  <span>${s === "draft" ? "Draft" : s === "active" ? "Active" : s === "paused" ? "Paused" : "Leased"}
                    <small>${s === "draft" ? "Not visible anywhere"
                      : s === "active" ? "Ready to be advertised"
                      : s === "paused" ? "Held back for now" : "Taken — drops out of the feed"}</small></span>
                </label>`)}
            </div>
          </div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="syndicate" value="yes"${attr("checked", listing && listing.syndicate)} />
              <span>Publish to the syndication feed (Zillow, Apartments.com and other networks)</span>
            </label>
            <span class="field__help">
              Only active listings with this ticked appear in the feed. Everything else stays private to this app.
            </span>
          </div>
        </div>
      </div>

      <div class="btnrow">
        <button class="pill solid" type="submit">${listing ? "Save listing" : "Create listing"}</button>
        <a class="pill outline" href="/app/listings">Cancel</a>
      </div>
    </form>`;
}
