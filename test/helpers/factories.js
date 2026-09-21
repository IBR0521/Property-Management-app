/* Minimal, deterministic fixtures.

   Not server/seed.js. That builds a demo portfolio with a story in it —
   overdue obligations, a delinquency ladder mid-walk, work orders at every
   stage — which is exactly right for looking at the app and exactly wrong for
   a test, where every one of those rows is a variable somebody has to hold in
   their head to know why an assertion failed.

   Each factory makes the smallest row that satisfies its constraints and
   returns its id. Tests add only what they are actually about. */
import { insert, run, get } from "../../server/lib/db.js";
import { id, token, stickerToken, ref } from "../../server/lib/ids.js";
import { hashPassword } from "../../server/lib/auth.js";
import { uniqueSlug } from "../../server/lib/slug.js";

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

export const PASSWORD = "test-password-correct-horse";

export async function makeCompany(name = "Test Property Co", extra = {}) {
  const cid = id();
  await insert("company", {
    id: cid, name, phone: "(614) 555-0100",
    emergency_phone: "(614) 555-0911",
    slug: extra.slug || await uniqueSlug(name),
    /* Fixtures are verified by default. A test about verification says so
       explicitly; every other test would otherwise be testing the unverified
       path by accident. */
    verified_at: now(),
    created_at: now(), ...extra,
  });
  return cid;
}

export async function makeStaff(companyId, { email, role = "admin", name = "Test Staff", active = 1 } = {}) {
  const sid = id();
  await insert("staff", {
    id: sid, company_id: companyId, name,
    email: email || `${role}-${sid.slice(-6)}@test.invalid`,
    password_hash: hashPassword(PASSWORD),
    role, active, created_at: now(),
  });
  return { id: sid, email: email || `${role}-${sid.slice(-6)}@test.invalid`, role };
}

export async function makeOwner(companyId, { name = "Test Owner", thresholdCents = 40000, email } = {}) {
  const oid = id();
  await insert("owner", {
    id: oid, company_id: companyId, name,
    email: email || `owner-${oid.slice(-6)}@test.invalid`,
    approval_threshold_cents: thresholdCents, statement_day: 1, created_at: now(),
  });
  return oid;
}

export async function makeProperty(companyId, ownerId, { line1 = "100 Test Street", city = "Columbus", state = "OH", zip = "43201" } = {}) {
  const pid = id();
  await insert("property", {
    id: pid, company_id: companyId, owner_id: ownerId,
    line1, city, state, zip, kind: "multi", created_at: now(),
  });
  return pid;
}

export async function makeUnit(companyId, propertyId, { label = "", beds = 2, baths = 1, rentCents = 100000, status = "vacant" } = {}) {
  const uid = id();
  await insert("unit", {
    id: uid, company_id: companyId, property_id: propertyId, label,
    beds, baths, market_rent_cents: rentCents, status,
    report_token: stickerToken(), created_at: now(),
  });
  return uid;
}

export async function makeLease(companyId, unitId, {
  rentCents = 100000, dueDay = 1, graceDays = 5, startDate = "2026-01-01",
  endDate = null, status = "active", tenantName = "Test Tenant", lateFeeCents = null,
} = {}) {
  const lid = id();
  await insert("lease", {
    id: lid, company_id: companyId, unit_id: unitId,
    start_date: startDate, end_date: endDate,
    rent_cents: rentCents, deposit_cents: rentCents,
    rent_due_day: dueDay, grace_days: graceDays, status,
    late_fee_cents: lateFeeCents, created_at: now(),
  });
  const tid = id();
  await insert("tenant", {
    id: tid, company_id: companyId, name: tenantName,
    email: `tenant-${tid.slice(-6)}@test.invalid`, phone: "6145550142", created_at: now(),
  });
  await insert("lease_tenant", { lease_id: lid, tenant_id: tid });
  await run("UPDATE unit SET status = 'occupied' WHERE id = ?", unitId);
  return { leaseId: lid, tenantId: tid };
}

export async function makeVendor(companyId, {
  name = "Test Trades", trade = "plumbing",
  wcExpires = "2030-01-01", glExpires = "2030-01-01", licenseExpires = "2030-01-01",
  wcExempt = 0, payoutHold = 0,
} = {}) {
  const vid = id();
  await insert("vendor", {
    id: vid, company_id: companyId, name, trade,
    email: `vendor-${vid.slice(-6)}@test.invalid`, phone: "6145550163",
    after_hours: 1, active: 1, created_at: now(),
    wc_expires: wcExpires, gl_expires: glExpires, license_expires: licenseExpires,
    wc_exempt: wcExempt, payout_hold: payoutHold,
    onboarding_state: "approved", is_1099: 1,
  });
  return vid;
}

export async function makeWorkOrder(companyId, unitId, { leaseId = null, severity = "normal", category = "plumbing", status = "triaged", summary = "Test issue" } = {}) {
  const wid = id();
  await insert("work_order", {
    id: wid, company_id: companyId, unit_id: unitId, lease_id: leaseId,
    reference: ref("WO"), category, severity, summary,
    triage_answers: JSON.stringify({}), reported_channel: "web",
    status, public_token: token(), created_at: now(),
  });
  return wid;
}

/* One company, fully furnished, in a single call. Most tests want this and
   then one specific thing on top. */
export async function makeWorld({ name = "Test Property Co", staffRoles = ["admin"] } = {}) {
  const companyId = await makeCompany(name);
  const staff = {};
  for (const role of staffRoles) {
    staff[role] = await makeStaff(companyId, { email: `${role}@${slug(name)}.invalid`, role });
  }
  const ownerId = await makeOwner(companyId, { name: `${name} Owner` });
  const propertyId = await makeProperty(companyId, ownerId, { line1: `${1 + name.length} ${slug(name)} Road` });
  const unitId = await makeUnit(companyId, propertyId, { label: "1" });
  const { leaseId, tenantId } = await makeLease(companyId, unitId);
  const vendorId = await makeVendor(companyId, { name: `${name} Trades` });
  const workOrderId = await makeWorkOrder(companyId, unitId, { leaseId });
  const unit = await get("SELECT report_token FROM unit WHERE id = ?", unitId);
  return {
    companyId, staff, ownerId, propertyId, unitId, leaseId, tenantId, vendorId, workOrderId,
    reportToken: unit.report_token,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
