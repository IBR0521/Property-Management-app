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
import { stamp, human, today } from "../lib/dates.js";
import { usd, parseMoney } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";

/* --- the feed ------------------------------------------------------------- */

/* Everything publishable, for every company. The endpoint is unauthenticated
   and company-agnostic by design: an aggregator crawls one URL hourly and does
   not hold an account. Only listings explicitly marked for syndication appear. */
export async function feedRows() {
  return await all(
    `SELECT l.*, u.label, u.beds AS unit_beds, u.baths AS unit_baths, u.sqft AS unit_sqft,
            p.line1, p.city, p.state, p.zip, p.year_built,
            c.name AS company_name, c.phone AS company_phone
       FROM listing l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN company c ON c.id = l.company_id
      WHERE l.status = 'active' AND l.syndicate = 1
      ORDER BY p.line1, u.label`);
}

export async function feedPhotos(listingIds) {
  if (!listingIds.length) return new Map();
  const rows = await all(
    `SELECT * FROM listing_photo WHERE listing_id IN (${listingIds.map(() => "?").join(",")})
      ORDER BY listing_id, rank`, ...listingIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.listing_id)) map.set(r.listing_id, []);
    map.get(r.listing_id).push(r);
  }
  return map;
}

export async function buildListingsXml(origin) {
  const rows = await feedRows();
  const photos = await feedPhotos(rows.map((r) => r.id));
  const generated = new Date().toISOString();

  /* Grouped by property so a building with eight vacancies is one Property
     element with eight Units, which is what every aggregator expects and what
     stops the same address appearing eight times in search results. */
  const byProperty = new Map();
  for (const r of rows) {
    if (!byProperty.has(r.line1 + r.zip)) byProperty.set(r.line1 + r.zip, []);
    byProperty.get(r.line1 + r.zip).push(r);
  }

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<PhysicalProperty xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  out.push(`  <Management>`);
  out.push(`    <ManagementID>${x(rows[0] ? rows[0].company_name : "property-operations")}</ManagementID>`);
  out.push(`    <GeneratedOn>${x(generated)}</GeneratedOn>`);
  out.push(`  </Management>`);

  for (const [, group] of byProperty) {
    const p = group[0];
    out.push(`  <Property>`);
    out.push(`    <PropertyID>`);
    out.push(`      <Identification IDValue="${x(hashId(p.line1 + p.zip))}" OrganizationName="${x(p.company_name)}" />`);
    out.push(`      <MarketingName>${x(p.headline || p.line1)}</MarketingName>`);
    out.push(`      <Address AddressType="property">`);
    out.push(`        <AddressLine1>${x(p.line1)}</AddressLine1>`);
    out.push(`        <City>${x(p.city)}</City>`);
    out.push(`        <State>${x(p.state)}</State>`);
    out.push(`        <PostalCode>${x(p.zip)}</PostalCode>`);
    out.push(`        <Country>US</Country>`);
    out.push(`      </Address>`);
    out.push(`      <Phone><PhoneNumber>${x(p.contact_phone || p.company_phone || "")}</PhoneNumber></Phone>`);
    if (p.contact_email) out.push(`      <Email>${x(p.contact_email)}</Email>`);
    out.push(`    </PropertyID>`);
    if (p.year_built) out.push(`    <Information><YearBuilt>${x(p.year_built)}</YearBuilt></Information>`);

    for (const l of group) {
      const beds = l.unit_beds == null ? "" : String(l.unit_beds);
      const baths = l.unit_baths == null ? "" : String(l.unit_baths);
      out.push(`    <ILS_Unit IDValue="${x(l.id)}">`);
      out.push(`      <Units>`);
      out.push(`        <Unit>`);
      out.push(`          <Identification IDValue="${x(l.id)}" />`);
      out.push(`          <MarketingName>${x(l.label ? `Unit ${l.label}` : l.line1)}</MarketingName>`);
      if (beds) out.push(`          <UnitBedrooms>${x(beds)}</UnitBedrooms>`);
      if (baths) out.push(`          <UnitBathrooms>${x(baths)}</UnitBathrooms>`);
      if (l.unit_sqft) out.push(`          <MinSquareFeet>${x(l.unit_sqft)}</MinSquareFeet>`);
      out.push(`          <UnitEconomicStatus>vacantAvailable</UnitEconomicStatus>`);
      out.push(`        </Unit>`);
      out.push(`      </Units>`);
      out.push(`      <Availability>`);
      if (l.available_date) out.push(`        <MadeReadyDate>${x(l.available_date)}</MadeReadyDate>`);
      out.push(`        <VacateDate />`);
      out.push(`      </Availability>`);
      out.push(`      <Pricing>`);
      out.push(`        <MarketRent Min="${cents(l.rent_cents)}" Max="${cents(l.rent_cents)}" />`);
      if (l.deposit_cents != null) out.push(`        <Deposit Min="${cents(l.deposit_cents)}" />`);
      if (l.lease_months) out.push(`        <LeaseTerm>${x(l.lease_months)}</LeaseTerm>`);
      out.push(`      </Pricing>`);
      if (l.description) out.push(`      <Comment>${x(l.description)}</Comment>`);
      if (l.pets) out.push(`      <Policy><Pet><PetType>${x(l.pets)}</PetType></Pet></Policy>`);
      if (l.virtual_tour_url) out.push(`      <VirtualTour><Src>${x(l.virtual_tour_url)}</Src></VirtualTour>`);

      for (const ph of photos.get(l.id) || []) {
        out.push(`      <File>`);
        out.push(`        <FileType>Photo</FileType>`);
        out.push(`        <Src>${x(absolute(origin, ph.path))}</Src>`);
        if (ph.caption) out.push(`        <Caption>${x(ph.caption)}</Caption>`);
        out.push(`        <Rank>${x(ph.rank)}</Rank>`);
        out.push(`      </File>`);
      }
      out.push(`    </ILS_Unit>`);
    }
    out.push(`  </Property>`);
  }

  out.push(`</PhysicalProperty>`);
  return out.join("\n");
}

/* XML has five characters that must never appear raw, and a listing
   description is typed by a person. Escaping here rather than trusting the
   input is the difference between a feed and an injection. */
function x(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters are not legal in XML 1.0 at all, escaped or otherwise.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

const cents = (v) => (v == null ? "0.00" : (Number(v) / 100).toFixed(2));

/* A stable identifier for a property across crawls. Aggregators de-duplicate on
   it, so it must not change between runs — which rules out anything random. */
function hashId(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `P${Math.abs(h).toString(36)}`;
}

function absolute(origin, path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

/* --- routes --------------------------------------------------------------- */

export function registerListings(router) {
  /* The feed, also served from the app origin so it works without the
     Vercel-specific api/ file. Public and unauthenticated by design. */
  router.get("/feeds/listings.xml", async (ctx) => {
    const xml = await buildListingsXml(`${ctx.url.protocol}//${ctx.url.host}`);
    ctx.res.writeHead(200, {
      "Content-Type": "application/xml; charset=utf-8",
      // Aggregators crawl hourly; this stops them paying for a rebuild each time.
      "Cache-Control": "public, max-age=900",
      "X-Robots-Tag": "noindex",
    });
    ctx.res.end(xml);
  });

  router.get("/app/listings", async (ctx) => {
    const cid = ctx.staff.company_id;
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
      title: "Vacancy marketing",
      subtitle: `${rows.length} listing${rows.length === 1 ? "" : "s"} · ${live} syndicated`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${unlisted.length ? notice("warn", `${unlisted.length} empty unit(s) not advertised`,
          "An empty unit with no listing is losing rent quietly.") : ""}

        ${unlisted.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Empty, not advertised</h2></div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap"><table class="data">
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
            ${rows.length ? html`<div class="tablewrap"><table class="data">
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
                  <td class="shrink"><a class="pill outline sm" href="/app/listings/${l.id}">Edit</a></td>
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
