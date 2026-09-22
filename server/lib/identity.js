/* Who a person is, and what they are allowed to see.

   Two ideas, and keeping them apart is the whole design.

   **Identity is platform-level.** One verified email is one `person`, across
   every company on the platform, because the same landlord really can own
   property managed by two companies here and making them hold two logins to
   read two statements is what drives people back to the telephone.

   **Access is never platform-level.** Every question this module answers is
   of the form "what does this person hold *in this company*". There is no
   function here that returns records for a person without a company, and the
   portal has no merged view. A person with links in two companies picks one
   and sees one. That is the Phase 2 tenancy boundary applied to a new kind of
   actor, and the isolation sweep tries to cross it.

   The unit of access is the `person_link`: one row per role a person holds in
   one company. A returning tenant has two of them; a landlord who also rents
   has one of each. */
import { all, get, one, insert, update, run } from "./db.js";
import { id } from "./ids.js";
import { stamp } from "./dates.js";
import { log } from "./logger.js";

/* One address is one person, so the address has to be one thing. A stray
   capital or a trailing space from a pasted spreadsheet must not create a
   second human. */
export function normaliseEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export async function personByEmail(email) {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  return await get("SELECT * FROM person WHERE email = ?", normalised);
}

/* Find or create. Races are resolved by the unique index rather than by
   checking first: two move-ins processed at the same moment would both see no
   person and both insert. */
export async function ensurePerson({ email, name = null, phone = null }) {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;

  const existing = await personByEmail(normalised);
  if (existing) {
    /* Fill in what we did not know before, and never overwrite what we did.
       A person who set their own name in the portal outranks whatever a
       member of staff typed on a lease afterwards. */
    const patch = {};
    if (!existing.name && name) patch.name = name;
    if (!existing.phone && phone) patch.phone = phone;
    if (Object.keys(patch).length) await update("person", existing.id, patch);
    return await get("SELECT * FROM person WHERE id = ?", existing.id);
  }

  const personId = id();
  try {
    await insert("person", {
      id: personId, email: normalised, name: name || null,
      phone: phone || null, created_at: stamp(),
    });
  } catch (err) {
    if (!String(err.message).includes("duplicate key")) throw err;
    return await personByEmail(normalised);
  }
  return await get("SELECT * FROM person WHERE id = ?", personId);
}

/* --- links ------------------------------------------------------------------

   Created wherever a tenancy or a portfolio is. Idempotent, because the
   move-in path runs again when somebody corrects a typo and a second link to
   the same tenancy would be a second portal entry for one lease. */

export async function linkTenant({ tenantId, source = "movein" }) {
  const tenant = await get("SELECT * FROM tenant WHERE id = ?", tenantId);
  if (!tenant) return null;

  const person = await ensurePerson({
    email: tenant.email, name: tenant.name, phone: tenant.phone,
  });
  /* No email is not an error. Plenty of tenancies are held by somebody who
     has never given one, and they stay reachable by token exactly as they are
     today — the portal is an addition, not a replacement. */
  if (!person) return null;

  const existing = await get("SELECT * FROM person_link WHERE tenant_id = ?", tenantId);
  if (existing) {
    if (existing.person_id === person.id) {
      if (existing.revoked_at) {
        await update("person_link", existing.id, { revoked_at: null, revoked_by: null });
      }
      return existing.id;
    }
    /* The email on the tenancy changed to somebody else's. That is a
       different human, so the link moves rather than being duplicated. */
    await update("person_link", existing.id, { person_id: person.id, source });
    log.info("tenancy moved to another person", { tenantId, personId: person.id });
    return existing.id;
  }

  const linkId = id();
  await insert("person_link", {
    id: linkId, person_id: person.id, company_id: tenant.company_id,
    role: "tenant", tenant_id: tenantId, source, created_at: stamp(),
  });
  return linkId;
}

export async function linkOwner({ ownerId, source = "staff" }) {
  const owner = await get("SELECT * FROM owner WHERE id = ?", ownerId);
  if (!owner) return null;

  const person = await ensurePerson({
    email: owner.email, name: owner.name, phone: owner.phone,
  });
  if (!person) return null;

  const existing = await get("SELECT * FROM person_link WHERE owner_id = ?", ownerId);
  if (existing) {
    if (existing.person_id !== person.id) {
      await update("person_link", existing.id, { person_id: person.id, source });
    } else if (existing.revoked_at) {
      await update("person_link", existing.id, { revoked_at: null, revoked_by: null });
    }
    return existing.id;
  }

  const linkId = id();
  await insert("person_link", {
    id: linkId, person_id: person.id, company_id: owner.company_id,
    role: "owner", owner_id: ownerId, source, created_at: stamp(),
  });
  return linkId;
}

/* Taking access away without taking the history with it. A former tenant
   should stop being able to open the portal; the company should still be able
   to answer "did they have access in March" a year later. */
export async function revokeLink({ linkId, by }) {
  const link = await get("SELECT * FROM person_link WHERE id = ?", linkId);
  if (!link || link.revoked_at) return { ok: true };
  await update("person_link", linkId, { revoked_at: stamp(), revoked_by: by || null });
  return { ok: true };
}

/* --- what a person holds ----------------------------------------------------

   The only questions asked anywhere in the portal. Note that every one of
   them takes a company, except `companiesFor`, which exists solely so the
   person can choose one. */

export async function companiesFor(personId) {
  return await all(
    `SELECT c.id, c.name, c.slug, c.phone,
            COUNT(*) FILTER (WHERE l.role = 'tenant')::int AS tenancies,
            COUNT(*) FILTER (WHERE l.role = 'owner')::int  AS portfolios
       FROM person_link l JOIN company c ON c.id = l.company_id
      WHERE l.person_id = ? AND l.revoked_at IS NULL
      GROUP BY c.id, c.name, c.slug, c.phone
      ORDER BY c.name`, personId);
}

/* Every role this person holds in one company. The portal shell reads this
   once and shapes itself around it: a person with only tenancies never sees
   an owner tab, and one with both sees both. */
export async function rolesIn(personId, companyId) {
  const links = await all(
    `SELECT * FROM person_link
      WHERE person_id = ? AND company_id = ? AND revoked_at IS NULL`,
    personId, companyId);
  return {
    isTenant: links.some((l) => l.role === "tenant"),
    isOwner: links.some((l) => l.role === "owner"),
    tenantIds: links.filter((l) => l.role === "tenant").map((l) => l.tenant_id),
    ownerIds: links.filter((l) => l.role === "owner").map((l) => l.owner_id),
    links,
  };
}

/* The leases a person may see: theirs, in this company, and nothing else.

   Ordered with the live one first, because a returning tenant opening the
   portal wants this month's balance rather than a tenancy that ended in
   2023 — but the old one is still there, which is the entire point of
   identity. */
export async function leasesFor(personId, companyId) {
  return await all(
    `SELECT l.*, u.label, p.line1, p.city, p.state, p.zip, p.id AS property_id
       FROM person_link pl
       JOIN lease_tenant lt ON lt.tenant_id = pl.tenant_id
       JOIN lease l ON l.id = lt.lease_id
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE pl.person_id = ? AND pl.company_id = ? AND pl.role = 'tenant'
        AND pl.revoked_at IS NULL AND l.company_id = ?
      ORDER BY CASE WHEN l.status = 'active' THEN 0 ELSE 1 END, l.start_date DESC`,
    personId, companyId, companyId);
}

export async function propertiesFor(personId, companyId) {
  return await all(
    `SELECT p.*, o.name AS owner_name, o.id AS owner_id,
            (SELECT COUNT(*)::int FROM unit u WHERE u.property_id = p.id) AS units,
            (SELECT COUNT(*)::int FROM unit u WHERE u.property_id = p.id AND u.status = 'occupied') AS occupied
       FROM person_link pl
       JOIN owner o ON o.id = pl.owner_id
       JOIN property p ON p.owner_id = o.id
      WHERE pl.person_id = ? AND pl.company_id = ? AND pl.role = 'owner'
        AND pl.revoked_at IS NULL AND p.company_id = ?
      ORDER BY p.line1`,
    personId, companyId, companyId);
}

/* --- the gate's questions ---------------------------------------------------

   A portal handler that has a lease id from a URL asks one of these before it
   reads anything. They return the row or null, never a boolean, so a caller
   cannot check and then fetch something else by mistake — and null rather
   than undefined, because `=== null` is what a caller will write. */

export async function leaseIfHeld({ personId, companyId, leaseId }) {
  return (await get(
    `SELECT l.* FROM person_link pl
       JOIN lease_tenant lt ON lt.tenant_id = pl.tenant_id
       JOIN lease l ON l.id = lt.lease_id
      WHERE pl.person_id = ? AND pl.company_id = ? AND pl.role = 'tenant'
        AND pl.revoked_at IS NULL AND l.id = ? AND l.company_id = ?`,
    personId, companyId, leaseId, companyId)) ?? null;
}

export async function propertyIfHeld({ personId, companyId, propertyId }) {
  return (await get(
    `SELECT p.* FROM person_link pl
       JOIN owner o ON o.id = pl.owner_id
       JOIN property p ON p.owner_id = o.id
      WHERE pl.person_id = ? AND pl.company_id = ? AND pl.role = 'owner'
        AND pl.revoked_at IS NULL AND p.id = ? AND p.company_id = ?`,
    personId, companyId, propertyId, companyId)) ?? null;
}

export async function ownerIfHeld({ personId, companyId, ownerId }) {
  return (await get(
    `SELECT o.* FROM person_link pl JOIN owner o ON o.id = pl.owner_id
      WHERE pl.person_id = ? AND pl.company_id = ? AND pl.role = 'owner'
        AND pl.revoked_at IS NULL AND o.id = ? AND o.company_id = ?`,
    personId, companyId, ownerId, companyId)) ?? null;
}

/* --- keeping it in step -----------------------------------------------------

   Called after a move-in or after an owner is created or edited. Cheap, and
   the alternative is a portal that silently lacks whoever was added last
   Tuesday. */
export async function syncPeopleFor(companyId) {
  const tenants = await all(
    `SELECT t.id FROM tenant t
      WHERE t.company_id = ? AND t.email IS NOT NULL AND trim(t.email) <> ''
        AND NOT EXISTS (SELECT 1 FROM person_link l WHERE l.tenant_id = t.id)`, companyId);
  for (const t of tenants) await linkTenant({ tenantId: t.id, source: "sync" });

  const owners = await all(
    `SELECT o.id FROM owner o
      WHERE o.company_id = ? AND o.email IS NOT NULL AND trim(o.email) <> ''
        AND NOT EXISTS (SELECT 1 FROM person_link l WHERE l.owner_id = o.id)`, companyId);
  for (const o of owners) await linkOwner({ ownerId: o.id, source: "sync" });

  return { tenants: tenants.length, owners: owners.length };
}
