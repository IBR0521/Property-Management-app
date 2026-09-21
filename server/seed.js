/* Demo data, for development only.

   This file drops nothing and creates a company from scratch, which is
   harmless on a laptop and unrecoverable against a live database. It is in a
   public repository, so a reader cannot tell from the code which one they are
   pointed at — the connection string is in an environment variable they set
   twenty minutes ago.

   Hence the refusal below. It is deliberately hard to bypass: SEED_ANYWAY has
   to be set on purpose, and the message says what would have happened. */
/* Demo data.
   One management company with a small Columbus portfolio, wired far enough
   that every feature has something real to show: rent partly collected so a
   delinquency opens, a repair over threshold waiting on an owner, a turn
   mid-flight, and two notice templates deliberately left unapproved so the
   send-gate is visible.

   Run: npm run seed   (npm run reset wipes the database first) */
import { migrate, db, insert, run, get, all } from "./lib/db.js";
import { id, token, ref } from "./lib/ids.js";
import { hashPassword } from "./lib/auth.js";
import { randomBytes } from "node:crypto";
import { stamp, today, addDays, monthKey, prevMonthRange } from "./lib/dates.js";
import { tick } from "./lib/scheduler.js";

/* Before migrate(), and before anything else opens a connection. A guard that
   runs after the database has already been touched is a guard that has
   already lost. */
await refuseAgainstProduction();

await migrate();

if (await get("SELECT id FROM company LIMIT 1")) {
  console.log("Already seeded. Use `npm run reset` to start over.");
  process.exit(0);
}

const now = stamp();
const T = today();
/* Generated per run, never hardcoded. A fixed password in a seed script is a
   published password the moment the repository is public — and this one was
   used to seed a live database before anyone noticed. It is printed once, at
   the end of the run, and never stored anywhere but the hash. */
const PASSWORD = randomBytes(15).toString("base64url");

const companyId = id();
await insert("company", {
  id: companyId, name: "Leafridge Property Management",
  phone: "(614) 655-8240", emergency_phone: "(614) 655-8241",
  timezone: "America/New_York", created_at: now,
});

/* --- staff ---------------------------------------------------------------- */
const staffId = id();
await insert("staff", {
  id: staffId, company_id: companyId, name: "Dana Whitfield",
  email: "dana@leafridgepm.test", password_hash: hashPassword(PASSWORD),
  role: "admin", active: 1, created_at: now,
});
await insert("staff", {
  id: id(), company_id: companyId, name: "Marcus Bell",
  email: "marcus@leafridgepm.test", password_hash: hashPassword(PASSWORD),
  role: "manager", active: 1, created_at: now,
});

/* --- owners --------------------------------------------------------------- */
const OWNER_SEED = [
  { name: "Ruth Calloway", email: "ruth@example.test", phone: "(614) 555-0113", threshold: 40000 },
  { name: "Okafor Holdings LLC", email: "admin@okaforholdings.test", phone: "(614) 555-0148", threshold: 75000 },
  { name: "Tomas Reyes", email: "tomas@example.test", phone: "(614) 555-0172", threshold: 25000 },
];
const owners = [];
for (const o of OWNER_SEED) {
  const oid = id();
  await insert("owner", {
    id: oid, company_id: companyId, name: o.name, email: o.email, phone: o.phone,
    approval_threshold_cents: o.threshold, statement_day: 1, created_at: now,
  });
  owners.push({ ...o, id: oid });
}

/* --- properties and units -------------------------------------------------- */
const PROPERTIES = [
  { owner: 0, line1: "412 Maple Grove Dr", city: "Columbus", zip: "43232", kind: "single",
    units: [{ label: "", beds: 3, baths: 1.5, sqft: 1340, rent: 145000 }] },
  { owner: 0, line1: "88 Weyburn Ave", city: "Whitehall", zip: "43213", kind: "multi",
    units: [
      { label: "A", beds: 2, baths: 1, sqft: 880, rent: 112500 },
      { label: "B", beds: 2, baths: 1, sqft: 880, rent: 115000 },
    ] },
  { owner: 1, line1: "1507 Brice Rd", city: "Reynoldsburg", zip: "43068", kind: "multi",
    units: [
      { label: "1", beds: 1, baths: 1, sqft: 640, rent: 92500 },
      { label: "2", beds: 1, baths: 1, sqft: 640, rent: 92500 },
      { label: "3", beds: 2, baths: 1, sqft: 810, rent: 108000 },
    ] },
  { owner: 1, line1: "2291 Lockbourne Rd", city: "Columbus", zip: "43207", kind: "single",
    units: [{ label: "", beds: 4, baths: 2, sqft: 1710, rent: 178000 }] },
  { owner: 2, line1: "640 Kelton Ave", city: "Columbus", zip: "43205", kind: "single",
    units: [{ label: "", beds: 3, baths: 2, sqft: 1520, rent: 165000 }] },
];

const units = [];
for (const p of PROPERTIES) {
  const pid = id();
  await insert("property", {
    id: pid, company_id: companyId, owner_id: owners[p.owner].id,
    line1: p.line1, city: p.city, state: "OH", zip: p.zip, kind: p.kind,
    created_at: addDays(T, -400) + "T09:00:00.000Z",
  });
  for (const u of p.units) {
    const uid = id();
    await insert("unit", {
      id: uid, company_id: companyId, property_id: pid, label: u.label,
      beds: u.beds, baths: u.baths, sqft: u.sqft, market_rent_cents: u.rent,
      status: "occupied", created_at: now,
    });
    units.push({ id: uid, propertyId: pid, ownerId: owners[p.owner].id, ...u, line1: p.line1 });
  }
}

/* --- tenants and leases ---------------------------------------------------- */
const TENANTS = [
  "Priya Anand", "Lukas Brenner", "Nadia Osei", "Colin Hartley",
  "Maya Fitzgerald", "Devon Pike", "Ingrid Holloway", "Samir Qureshi",
];

const leases = [];
for (const [i, u] of units.entries()) {
  // The last unit is left vacant so the turn board and the application form
  // both have something to point at.
  if (i === units.length - 1) {
    await run("UPDATE unit SET status = 'vacant' WHERE id = ?", u.id);
    continue;
  }
  const tid = id();
  await insert("tenant", {
    id: tid, company_id: companyId, name: TENANTS[i],
    email: `${TENANTS[i].split(" ")[0].toLowerCase()}@example.test`,
    phone: `(614) 555-0${200 + i}`, created_at: now,
  });

  const lid = id();
  const start = addDays(T, -(200 + i * 30));
  await insert("lease", {
    id: lid, company_id: companyId, unit_id: u.id,
    start_date: start, end_date: addDays(start, 365),
    rent_cents: u.rent, deposit_cents: u.rent,
    rent_due_day: 1, grace_days: 5, status: "active", created_at: now,
  });
  await insert("lease_tenant", { lease_id: lid, tenant_id: tid });
  leases.push({ id: lid, unitId: u.id, ownerId: u.ownerId, propertyId: u.propertyId, rent: u.rent, tenant: TENANTS[i] });
}

/* --- vendors and routing --------------------------------------------------- */
const VENDORS = [
  { name: "Brice Plumbing & Drain", trade: "plumber", phone: "(614) 555-0301", afterHours: 1, cats: ["plumbing"] },
  { name: "Hartline Electric", trade: "electrician", phone: "(614) 555-0322", afterHours: 1, cats: ["electrical"] },
  { name: "Buckeye Heating & Air", trade: "hvac", phone: "(614) 555-0344", afterHours: 1, cats: ["hvac"] },
  { name: "Olde Towne Appliance", trade: "appliance", phone: "(614) 555-0366", afterHours: 0, cats: ["appliance"] },
  { name: "Gahanna Lock & Key", trade: "locksmith", phone: "(614) 555-0388", afterHours: 1, cats: ["locks"] },
  { name: "Franklin General Contracting", trade: "general", phone: "(614) 555-0390", afterHours: 0, cats: ["structural", "other"] },
  { name: "Capital Pest Control", trade: "pest", phone: "(614) 555-0399", afterHours: 0, cats: ["pest"] },
];
const vendors = [];
for (const v of VENDORS) {
  const vid = id();
  /* Compliance, because a demo where every contractor is blocked is a demo of
     a broken app. Most are in date; one is deliberately lapsed so the barrier
     is visible doing its job rather than only described in the README. */
  const lapsed = v.trade === "pest";
  await insert("vendor", {
    id: vid, company_id: companyId, name: v.name, trade: v.trade,
    phone: v.phone, email: `dispatch@${v.trade}.test`,
    after_hours: v.afterHours, active: 1, created_at: now,
    legal_name: `${v.name} LLC`,
    address: "Columbus, OH",
    license_no: `OH-${String(1000 + vendors.length * 7)}`,
    license_expires: lapsed ? "2025-04-30" : "2028-03-31",
    gl_carrier: "Buckeye Mutual", gl_expires: lapsed ? "2025-06-30" : "2028-01-31",
    wc_carrier: "Ohio Employers", wc_expires: lapsed ? "2025-02-28" : "2027-11-30",
    w9_received_at: "2025-01-10", tax_classification: "llc", is_1099: 1,
    onboarding_state: lapsed ? "documents_pending" : "approved",
  });
  for (const c of v.cats) {
    await insert("routing_rule", { id: id(), company_id: companyId, category: c, vendor_id: vid, rank: 1 });
  }
  vendors.push({ ...v, id: vid });
}

/* --- compliance rules ------------------------------------------------------ */
/* Windows here are placeholders with the basis field left honest: the real
   numbers are the company's to confirm with counsel. */
const RULES = [
  { kind: "deposit_return", label: "Security deposit return", window: 30, lead: [14, 7, 3, 0],
    basis: "PLACEHOLDER — confirm the statutory window with counsel" },
  { kind: "lease_renewal_notice", label: "Lease renewal notice", window: 60, lead: [30, 14, 0],
    basis: "Company policy: decide 60 days out" },
  { kind: "detector_check", label: "Smoke / CO detector check", window: 365, lead: [30, 0],
    basis: "Annual, company policy" },
  { kind: "inspection", label: "Annual interior inspection", window: 365, lead: [30, 7],
    basis: "Annual, company policy" },
];
for (const r of RULES) {
  await insert("compliance_rule", {
    id: id(), company_id: companyId, kind: r.kind, label: r.label,
    window_days: r.window, lead_days: JSON.stringify(r.lead),
    authority_note: r.basis, active: 1, created_at: now,
  });
}

/* --- delinquency ladder + templates ---------------------------------------- */
const TEMPLATES = [
  { key: "reminder_day1", name: "Day 1 — friendly reminder", approved: true,
    body: "Hello,\n\nRent of {{amount}} for {{period}} at {{address}} has not reached us yet. "
      + "If it is already on its way, thank you and please ignore this.\n\n"
      + "If something has come up, call us on {{company_phone}} — it is much easier to sort out early.\n\n{{company}}" },
  { key: "reminder_day5", name: "Day 5 — second reminder", approved: false,
    body: "PLACEHOLDER — replace with your attorney's wording.\n\n"
      + "{{amount}} for {{period}} at {{address}} is now {{days_late}} days late. Please call {{company_phone}}.\n\n{{company}}" },
  { key: "notice_day10", name: "Day 10 — formal notice", approved: false,
    body: "PLACEHOLDER — THIS MUST BE REPLACED BY YOUR ATTORNEY'S TEXT.\n\n"
      + "Formal notices are jurisdiction-specific and carry legal consequences if worded incorrectly. "
      + "This app will refuse to send this template until a sign-off name and date are recorded.\n\n"
      + "{{amount}} / {{period}} / {{address}} / {{days_late}} days" },
];
for (const t of TEMPLATES) {
  await insert("notice_template", {
    company_id: companyId, key: t.key, name: t.name, body: t.body,
    approved_by: t.approved ? "R. Okonkwo, counsel" : null,
    approved_at: t.approved ? addDays(T, -60) + "T00:00:00.000Z" : null,
  });
}
const STEPS = [
  { stage: 1, day: 0, key: "reminder_day1", channel: "email", attorney: 0 },
  { stage: 2, day: 5, key: "reminder_day5", channel: "email", attorney: 0 },
  { stage: 3, day: 10, key: "notice_day10", channel: "post", attorney: 0 },
  { stage: 4, day: 21, key: "notice_day10", channel: "hand", attorney: 1 },
];
for (const s of STEPS) {
  await insert("delinquency_step", {
    id: id(), company_id: companyId, stage: s.stage, day_offset: s.day,
    template_key: s.key, channel: s.channel, requires_attorney: s.attorney,
  });
}

/* --- screening criteria ---------------------------------------------------- */
await insert("criteria_set", {
  id: id(), company_id: companyId, name: "Standard criteria (2026)",
  items: JSON.stringify([
    { key: "income", label: "Verifiable household income", how_checked: "Two most recent pay stubs or equivalent" },
    { key: "identity", label: "Government photo ID", how_checked: "Matches the name on the application" },
    { key: "references", label: "Prior landlord reference", how_checked: "One contactable reference where applicable" },
    { key: "occupancy", label: "Occupancy within the limit for the unit", how_checked: "Against the unit's bedroom count" },
  ]),
  active: 1,
  reviewed_by: null, reviewed_at: null,
  created_at: now,
});

/* --- ledger: last month paid in full, this month partly ------------------- */
const last = prevMonthRange(T);
const period = monthKey(T);
for (const [i, l] of leases.entries()) {
  const fee = Math.round(l.rent * 0.09);

  await insert("ledger_entry", {
    id: id(), company_id: companyId, owner_id: l.ownerId, property_id: l.propertyId,
    unit_id: l.unitId, lease_id: l.id, date: addDays(last.start, 2),
    kind: "rent_payment", amount_cents: l.rent,
    memo: `Rent ${monthKey(last.start)} — ${l.tenant}`, source: "import", created_at: now,
  });
  await insert("ledger_entry", {
    id: id(), company_id: companyId, owner_id: l.ownerId, property_id: l.propertyId,
    unit_id: l.unitId, lease_id: l.id, date: addDays(last.start, 2),
    kind: "management_fee", amount_cents: -fee,
    memo: `Management fee ${monthKey(last.start)} (9%)`, source: "system", created_at: now,
  });

  // Two leases are left unpaid this month so the ladder has real work, and
  // one pays short so a partial balance is visible.
  if (i < leases.length - 2) {
    await insert("ledger_entry", {
      id: id(), company_id: companyId, owner_id: l.ownerId, property_id: l.propertyId,
      unit_id: l.unitId, lease_id: l.id, date: `${period}-03`,
      kind: "rent_payment", amount_cents: i === 0 ? l.rent - 30000 : l.rent,
      memo: `Rent ${period} — ${l.tenant}`, source: "import", created_at: now,
    });
  }
}

/* --- work orders ----------------------------------------------------------- */
async function wo({ leaseIdx, category, severity, summary, detail, status, vendorTrade, estimate, actual, ageDays, answers, reasons }) {
  const l = leases[leaseIdx];
  const u = units.find((x) => x.id === l.unitId);
  const woId = id();
  const created = addDays(T, -ageDays) + "T14:20:00.000Z";
  const vendor = vendorTrade ? vendors.find((v) => v.trade === vendorTrade) : null;

  await insert("work_order", {
    id: woId, company_id: companyId, unit_id: l.unitId, lease_id: l.id,
    reference: ref("WO"), category, severity, summary, detail: detail || null,
    triage_answers: JSON.stringify({ answers: answers || {}, reasons: reasons || [] }),
    reported_by_name: l.tenant, reported_by_phone: "(614) 555-0201",
    reported_channel: "web", entry_permission: "call_first",
    status, vendor_id: vendor ? vendor.id : null,
    estimate_cents: estimate ?? null, actual_cents: actual ?? null,
    public_token: token(), created_at: created,
    closed_at: status === "complete" ? addDays(T, -(ageDays - 2)) + "T16:00:00.000Z" : null,
  });
  await insert("work_order_event", {
    id: id(), work_order_id: woId, at: created, actor: "tenant", kind: "reported",
    note: `${category} · ${severity}`, tenant_visible: 1,
  });
  if (vendor) {
    await insert("work_order_event", {
      id: id(), work_order_id: woId, at: addDays(T, -(ageDays - 1)) + "T09:15:00.000Z",
      actor: "system", kind: "triaged", note: `Routed to ${vendor.name} by category rule.`, tenant_visible: 0,
    });
  }
  if (status === "complete") {
    await insert("work_order_event", {
      id: id(), work_order_id: woId, at: addDays(T, -(ageDays - 2)) + "T16:00:00.000Z",
      actor: "Marcus Bell", kind: "completed", note: `${detail || "Repaired"}`, tenant_visible: 1,
    });
    if (actual) {
      await insert("ledger_entry", {
        id: id(), company_id: companyId, owner_id: l.ownerId, property_id: l.propertyId,
        unit_id: l.unitId, lease_id: l.id, date: addDays(T, -(ageDays - 2)),
        kind: "expense", amount_cents: -actual, memo: `${summary}`,
        source: "work_order", work_order_id: woId, created_at: now,
      });
    }
  }
  return { id: woId, ownerId: l.ownerId, summary };
}

await wo({ leaseIdx: 1, category: "hvac", severity: "emergency", ageDays: 0,
  summary: "No heat, unit is cold", detail: "Furnace not firing",
  status: "triaged", vendorTrade: "hvac",
  answers: { no_heat_cold: "yes", vulnerable: "yes" },
  reasons: ["Is the heat out and the unit uncomfortably cold?", "Is an infant, an elderly person or someone with a medical condition in the unit?"] });

await wo({ leaseIdx: 2, category: "plumbing", severity: "normal", ageDays: 3,
  summary: "Kitchen tap drips constantly", status: "scheduled", vendorTrade: "plumber", estimate: 18500,
  answers: { one_fixture: "yes" } });

await wo({ leaseIdx: 3, category: "appliance", severity: "urgent", ageDays: 6,
  summary: "Fridge not holding temperature", detail: "Replaced thermostat and door seal",
  status: "complete", vendorTrade: "appliance", estimate: 24000, actual: 27350,
  answers: { fridge: "yes" } });

const bigJob = await wo({ leaseIdx: 4, category: "structural", severity: "urgent", ageDays: 2,
  summary: "Water staining spreading on bathroom ceiling", detail: "Suspected failed shower pan above",
  status: "awaiting_owner", vendorTrade: "general", estimate: 128000,
  answers: { damp: "yes" } });

/* The over-threshold job waiting on its owner. */
const apprToken = token();
await insert("owner_approval", {
  id: id(), company_id: companyId, owner_id: bigJob.ownerId, work_order_id: bigJob.id,
  amount_cents: 128000, status: "pending", token: apprToken,
  requested_at: addDays(T, -1) + "T11:00:00.000Z",
});
await insert("work_order_event", {
  id: id(), work_order_id: bigJob.id, at: addDays(T, -1) + "T11:00:00.000Z",
  actor: "Dana Whitfield", kind: "owner_asked",
  note: "$1,280.00 is over the $750.00 threshold — Okafor Holdings LLC asked to approve.", tenant_visible: 0,
});

/* --- a turn in flight ------------------------------------------------------ */
const vacant = units[units.length - 1];
const turnId = id();
await insert("turn", {
  id: turnId, company_id: companyId, unit_id: vacant.id, lease_id: null,
  stage: "in_progress",
  notice_date: addDays(T, -34), moveout_date: addDays(T, -12),
  target_ready_date: addDays(T, -2), status: "open", created_at: now,
});
await run("UPDATE unit SET status = 'turn' WHERE id = ?", vacant.id);
for (const [stage, d] of [["notice", -34], ["moveout", -12], ["inspected", -11], ["scoped", -9], ["in_progress", -7]]) {
  await insert("turn_stage_event", {
    id: id(), turn_id: turnId, stage, entered_at: addDays(T, d) + "T10:00:00.000Z",
    actor: "Marcus Bell", note: null,
  });
}
const TURN_TASKS = [["Final inspection", 0, -11], ["Clean", 32000, -8], ["Paint touch-up", 48000, -6],
 ["Carpet / flooring", 92000, null], ["Keys and locks re-keyed", null, null], ["Photos for listing", null, null]];
for (const [i, [label, cost, doneOffset]] of TURN_TASKS.entries()) {
  await insert("turn_task", {
    id: id(), turn_id: turnId, label, cost_cents: cost,
    done_at: doneOffset == null ? null : addDays(T, doneOffset) + "T12:00:00.000Z", sort: i,
  });
}

/* --- an application -------------------------------------------------------- */
const crit = await get("SELECT * FROM criteria_set WHERE company_id = ? AND active = 1", companyId);
const appId = id();
await insert("application", {
  id: appId, company_id: companyId, unit_id: vacant.id, criteria_set_id: crit.id,
  applicant_name: "Adaeze Nwosu", email: "adaeze@example.test", phone: "(614) 555-0455",
  desired_move_in: addDays(T, 21), occupants: 2, monthly_income_cents: 520000,
  employer: "Nationwide Children's Hospital", status: "received",
  received_at: addDays(T, -2) + "T08:40:00.000Z", token: token(),
});
for (const item of JSON.parse(crit.items)) {
  await insert("application_check", {
    id: id(), application_id: appId, criteria_item_key: item.key,
    result: "pending", checked_by: "—", checked_at: now,
  });
}

/* --- let the engines catch up ---------------------------------------------- */
const result = await tick("seed");

console.log(`
  Seeded Leafridge Property Management

  Sign in at  http://localhost:4300/app
    dana@leafridgepm.test    ${PASSWORD}   (admin)
    marcus@leafridgepm.test  ${PASSWORD}   (manager)

  ^ generated for this run only. Write it down now — it is not stored
    anywhere, and nothing in this repository knows it.

  Public pages
    /report   tenant maintenance intake
    /apply    rental application

  ${units.length} units · ${leases.length} active leases · ${vendors.length} vendors
  scheduler: ${Object.entries(result).filter(([, v]) => typeof v === "number" && v > 0).map(([k, v]) => `${k}=${v}`).join(" ") || "nothing due"}
`);

/* --- the guard ------------------------------------------------------------ */

async function refuseAgainstProduction() {
  const { APP_ENV, IS_SERVERLESS, DATABASE_URL, NODE_ENV } = await import("./lib/config.js");

  const reasons = [];
  if (APP_ENV === "production") reasons.push("APP_ENV is production");
  if (IS_SERVERLESS) reasons.push("this is a deployed environment");
  /* A pooler host is a hosted database. Local development points at
     localhost, and anything else is somebody else's data until proven
     otherwise. */
  if (DATABASE_URL && /pooler\.|\.supabase\.|amazonaws\.com|neon\.tech|render\.com/i.test(DATABASE_URL)) {
    reasons.push("DATABASE_URL points at a hosted database, not localhost");
  }

  if (!reasons.length) return;

  if (process.env.SEED_ANYWAY === "yes-i-mean-it") {
    console.warn(
      `\n  Seeding anyway, against: ${reasons.join("; ")}.\n` +
      `  You set SEED_ANYWAY. This creates a demo company with demo tenants,\n` +
      `  demo work orders and a demo portfolio in that database.\n`);
    return;
  }

  console.error(
    `\n  Refusing to seed.\n\n` +
    `  ${reasons.map((r) => `- ${r}`).join("\n  ")}\n\n` +
    `  This script creates a demo company with invented tenants, leases and work\n` +
    `  orders. In a real database that is somebody else's portfolio with fiction\n` +
    `  mixed into it, and there is no undo.\n\n` +
    `  For a real customer, add their company through /signup and their portfolio\n` +
    `  through the app.\n\n` +
    `  If you genuinely want demo data here:\n` +
    `    SEED_ANYWAY=yes-i-mean-it npm run seed\n`);
  process.exit(1);
}
