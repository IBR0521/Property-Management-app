/* The syndication feed, as MITS.

   ## One standard, not two dialects

   Apartments.com's feed programme is MITS-based and Zillow accepts MITS
   alongside its own guide, so there is one document to produce rather than
   two bespoke dialects that drift apart the first time either network adds a
   field. MITS is a published XML standard from RETTC with public sample
   documents; what follows is the ILS subset both networks read.

   Neither will look at a feed from a platform that has not asked. Zillow
   requires an integration request and approval from their Rentals
   Integrations team *before* a feed is worth building, then four to six weeks
   of feed testing; Apartments.com will send their own guide on request and
   takes the XML by FTP or URL. Both are free. That is an email somebody sends,
   not a commit anybody makes — so what is verified here is that the document
   is well formed and carries what the standard specifies, and acceptance is
   left honestly unverified.

   ## One feed per company, and why that is not a detail

   The first version of this served **every company on the platform in one
   document**, labelled with whichever company happened to sort first. A
   manager who handed that URL to Zillow would have been publishing their
   competitors' listings under their own management id — and the network would
   have been right to believe them.

   So a feed is per company, always, and the platform-wide URL serves no
   listings at all. A URL that is dangerous by default is a URL somebody will
   eventually use. */
import { all, get } from "../db.js";

export const MITS_VERSION = "4.1";

/* Everything this company has marked for syndication. Opt-in per listing,
   off by default: publishing an address to every aggregator on the internet
   is a decision somebody makes on purpose. */
export async function feedRows(companyId) {
  return await all(
    `SELECT l.*, u.label, u.beds AS unit_beds, u.baths AS unit_baths, u.sqft AS unit_sqft,
            p.id AS property_id, p.line1, p.city, p.state, p.zip, p.year_built,
            c.name AS company_name, c.phone AS company_phone, c.slug AS company_slug,
            c.website AS company_website
       FROM listing l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN company c ON c.id = l.company_id
      WHERE l.company_id = ? AND l.status = 'active' AND l.syndicate = 1
      ORDER BY p.line1, u.label`, companyId);
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

/* Builds the document for one company.

   `origin` is needed because a feed carries absolute URLs — a photograph at
   `/uploads/...` means nothing to a crawler, and every network requires a
   reachable image and a reachable page about the listing. */
export async function buildMits({ companyId, origin, now = () => new Date() }) {
  const company = await get("SELECT * FROM company WHERE id = ?", companyId);
  if (!company) throw new Error("There is no company with that id.");

  const rows = await feedRows(companyId);
  const photos = await feedPhotos(rows.map((r) => r.id));
  const generated = now().toISOString();

  /* Grouped by property, so a building with eight vacancies is one Property
     with eight ILS_Units rather than the same address eight times in a
     search result. Keyed on the property's own id rather than on its address,
     because two companies can manage buildings on the same road and a shared
     key would merge them. */
  const byProperty = new Map();
  for (const r of rows) {
    if (!byProperty.has(r.property_id)) byProperty.set(r.property_id, []);
    byProperty.get(r.property_id).push(r);
  }

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<PhysicalProperty xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);

  /* The management company, in the shape MITS specifies rather than a single
     free-text id. This is what a network matches against the feed agreement,
     so getting it wrong is getting the whole document attributed to somebody
     else. */
  out.push(`  <Management>`);
  out.push(`    <Identification IDValue="${x(company.id)}" IDType="ManagementID" `
    + `OrganizationName="${x(company.name)}" />`);
  out.push(`    <CompanyName>${x(company.name)}</CompanyName>`);
  if (company.phone) out.push(`    <PhoneNumber>${x(company.phone)}</PhoneNumber>`);
  if (company.website) out.push(`    <WebSite>${x(company.website)}</WebSite>`);
  out.push(`    <GeneratedOn>${x(generated)}</GeneratedOn>`);
  out.push(`    <MITS_Version>${x(MITS_VERSION)}</MITS_Version>`);
  out.push(`  </Management>`);

  for (const [propertyId, group] of byProperty) {
    const p = group[0];
    const listingsUrl = `${origin}/c/${p.company_slug}/listings`;

    out.push(`  <Property>`);
    out.push(`    <PropertyID>`);
    out.push(`      <Identification IDValue="${x(propertyId)}" IDType="PropertyID" `
      + `OrganizationName="${x(p.company_name)}" />`);
    out.push(`      <MarketingName>${x(p.headline || p.line1)}</MarketingName>`);
    out.push(`      <WebSite>${x(listingsUrl)}</WebSite>`);
    /* A real, mappable street address on every listing. Both networks require
       it, and a feed of approximate locations is worse than no feed. */
    out.push(`      <Address AddressType="property">`);
    out.push(`        <AddressLine1>${x(p.line1)}</AddressLine1>`);
    out.push(`        <City>${x(p.city)}</City>`);
    out.push(`        <State>${x(p.state)}</State>`);
    out.push(`        <PostalCode>${x(p.zip)}</PostalCode>`);
    out.push(`        <Country>US</Country>`);
    out.push(`      </Address>`);
    out.push(`      <Phone PhoneType="office"><PhoneNumber>`
      + `${x(p.contact_phone || p.company_phone || "")}</PhoneNumber></Phone>`);
    if (p.contact_email) out.push(`      <Email>${x(p.contact_email)}</Email>`);
    out.push(`    </PropertyID>`);

    out.push(`    <Information>`);
    out.push(`      <UnitCount>${group.length}</UnitCount>`);
    if (p.year_built) out.push(`      <YearBuilt>${x(p.year_built)}</YearBuilt>`);
    out.push(`      <PropertyAvailabilityURL>${x(listingsUrl)}</PropertyAvailabilityURL>`);
    out.push(`      <Rents>`);
    out.push(`        <MarketRent Min="${cents(Math.min(...group.map((l) => l.rent_cents)))}" `
      + `Max="${cents(Math.max(...group.map((l) => l.rent_cents)))}" />`);
    out.push(`      </Rents>`);
    out.push(`    </Information>`);

    for (const l of group) {
      const unitUrl = `${origin}/c/${l.company_slug}/listings/${l.id}`;
      out.push(`    <ILS_Unit IDValue="${x(l.id)}">`);
      out.push(`      <Units>`);
      out.push(`        <Unit>`);
      out.push(`          <Identification IDValue="${x(l.id)}" IDType="UnitID" />`);
      out.push(`          <MarketingName>${x(l.label ? `Unit ${l.label}` : l.line1)}</MarketingName>`);
      if (l.unit_beds != null) out.push(`          <UnitBedrooms>${x(l.unit_beds)}</UnitBedrooms>`);
      if (l.unit_baths != null) out.push(`          <UnitBathrooms>${x(l.unit_baths)}</UnitBathrooms>`);
      if (l.unit_sqft) {
        out.push(`          <MinSquareFeet>${x(l.unit_sqft)}</MinSquareFeet>`);
        out.push(`          <MaxSquareFeet>${x(l.unit_sqft)}</MaxSquareFeet>`);
      }
      out.push(`          <UnitEconomicStatus>vacantAvailable</UnitEconomicStatus>`);
      out.push(`        </Unit>`);
      out.push(`      </Units>`);

      out.push(`      <Availability>`);
      if (l.available_date) out.push(`        <MadeReadyDate>${x(l.available_date)}</MadeReadyDate>`);
      out.push(`      </Availability>`);

      out.push(`      <Pricing>`);
      out.push(`        <MarketRent Min="${cents(l.rent_cents)}" Max="${cents(l.rent_cents)}" />`);
      if (l.deposit_cents != null) out.push(`        <Deposit Min="${cents(l.deposit_cents)}" />`);
      if (l.lease_months) out.push(`        <LeaseTerm>${x(l.lease_months)}</LeaseTerm>`);
      out.push(`      </Pricing>`);

      if (l.description) out.push(`      <Comment>${x(l.description)}</Comment>`);
      out.push(`      <ILS_UnitURL>${x(unitUrl)}</ILS_UnitURL>`);

      for (const amenity of amenities(l)) {
        out.push(`      <Amenity AmenityType="${x(amenity.type)}">`
          + `<Description>${x(amenity.text)}</Description></Amenity>`);
      }

      if (l.pets) {
        out.push(`      <Policy><Pet><PetType>${x(l.pets)}</PetType>`
          + `<PetsAllowed>${l.pets === "none" ? "No" : "Yes"}</PetsAllowed></Pet></Policy>`);
      }
      if (l.virtual_tour_url) {
        out.push(`      <VirtualTour><Src>${x(l.virtual_tour_url)}</Src></VirtualTour>`);
      }

      for (const ph of photos.get(l.id) || []) {
        out.push(`      <File>`);
        out.push(`        <FileID>${x(ph.id)}</FileID>`);
        out.push(`        <FileType>Photo</FileType>`);
        out.push(`        <Src>${x(absolute(origin, ph.path))}</Src>`);
        if (ph.caption) out.push(`        <Caption>${x(ph.caption)}</Caption>`);
        out.push(`        <Rank>${x(ph.rank)}</Rank>`);
        out.push(`        <Active>true</Active>`);
        out.push(`      </File>`);
      }
      out.push(`    </ILS_Unit>`);
    }
    out.push(`  </Property>`);
  }

  out.push(`</PhysicalProperty>`);
  return out.join("\n");
}

/* The document served at the platform-wide URL: no listings, and a pointer at
   the per-company feeds. Somebody will hand a network the obvious URL, and
   the obvious URL should not publish everybody. */
export function feedsArePerCompany(origin) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<PhysicalProperty>`,
    `  <Management>`,
    `    <CompanyName>Feeds are per management company</CompanyName>`,
    `    <Comment>This URL carries no listings on purpose. Each management company `
      + `has its own feed, at ${x(origin)}/feeds/&lt;company&gt;/listings.xml, because a `
      + `feed agreement is between one network and one company and a shared document `
      + `would publish other companies' listings under whoever's name came first. `
      + `The address for a given company is on its Vacancies screen.</Comment>`,
    `  </Management>`,
    `</PhysicalProperty>`,
  ].join("\n");
}

/* The fields that are amenities in MITS terms rather than columns of ours.
   Only what was actually filled in — an empty Amenity element is noise a
   network has to filter. */
function amenities(listing) {
  const out = [];
  if (listing.laundry) out.push({ type: "Laundry", text: listing.laundry });
  if (listing.parking) out.push({ type: "Parking", text: listing.parking });
  if (listing.utilities_note) out.push({ type: "Utilities", text: listing.utilities_note });
  if (listing.smoking) out.push({ type: "Other", text: "Smoking permitted" });
  return out;
}

/* XML has five characters that must never appear raw, and a listing
   description is typed by a person. */
export function x(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* MITS prices are decimal currency, not cents. */
function cents(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

function absolute(origin, stored) {
  if (!stored) return "";
  return /^https?:\/\//.test(stored) ? stored : `${origin}/uploads/${stored}`;
}
