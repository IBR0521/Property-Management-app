/* Raising a work order, from wherever it is raised.

   This was inlined in the staff screen's POST handler, which was fine while
   the screen was the only way in. The API is the second way in, and two
   copies of "what happens when a job is raised" is how the routing rules get
   applied on one path and not the other — quietly, and only for the customer
   whose integration uses the new one.

   So it lives here, and the screen calls it.

   ## The tenant's own intake is deliberately not this function

   `/report` does something different: it asks triage questions, accepts
   photographs, and decides the severity from the answers rather than being
   told it. Folding the two together would mean a function with a triage
   branch and a not-triage branch, which is two functions wearing one name.

   ## An emergency is never queued

   That is the oldest invariant in this application and it has to survive the
   API. A machine raising an emergency is in some ways worse than a person
   doing it, because there is nobody at the screen — so an emergency is not
   routed to a contractor, and the on-call number is rung then and there,
   inside the request, exactly as the tenant intake does it. The caller is
   told whether that reached anybody. */
import { all, get, one, insert, update, run, tx } from "./db.js";
import { id, token, ref } from "./ids.js";
import { stamp } from "./dates.js";
import { category } from "./triage.js";

export const SEVERITIES = ["normal", "urgent", "emergency"];

export async function event(woId, actor, kind, note, tenantVisible = 1) {
  await insert("work_order_event", {
    id: id(), work_order_id: woId, at: stamp(), actor, kind,
    note: note || null, tenant_visible: tenantVisible,
  });
}

/* Routes by the company's rules, lowest rank first. Recording that no rule
   matched is more useful than silently leaving the field null. */
export async function autoRoute({ company, woId, cat }) {
  const rule = await get(
    `SELECT r.*, v.name, v.trade, v.after_hours FROM routing_rule r
       JOIN vendor v ON v.id = r.vendor_id
      WHERE r.company_id = ? AND r.category = ? AND v.active = 1
      ORDER BY r.rank LIMIT 1`, company.id, cat.key);

  if (!rule) {
    await event(woId, "system", "triaged",
      `No routing rule for ${cat.label} — needs a vendor picked by hand.`, 0);
    await update("work_order", woId, { status: "triaged" });
    return { routed: false };
  }
  await update("work_order", woId, { status: "triaged", vendor_id: rule.vendor_id });
  await event(woId, "system", "triaged",
    `Routed to ${rule.name} (${rule.trade}) by category rule.`, 0);
  return { routed: true, vendorId: rule.vendor_id, vendorName: rule.name };
}

/* Returns { workOrderId, reference, severity, routed, emergency }.

   `emergency` is null unless the severity is one, and then it says whether
   the on-call number was actually reached — because the one thing this must
   never do is report success for an alert that did not send. */
export async function raiseWorkOrder({
  companyId, unitId, category: categoryKey, severity = "normal",
  summary, detail = null,
  reportedByName = null, reportedByPhone = null,
  channel = "staff", actor = "system",
  /* The tenant intake sends its own alert and does its own routing, so it
     passes this off. Nothing else should. */
  alertOnCall = true,
  sendNow = null,
}) {
  const unit = await one(
    `SELECT u.*, p.line1, p.city, p.owner_id
       FROM unit u JOIN property p ON p.id = u.property_id
      WHERE u.id = ? AND u.company_id = ?`, String(unitId || ""), companyId);

  const cat = category(String(categoryKey || "")) || category("other");
  const level = SEVERITIES.includes(severity) ? severity : "normal";
  const company = await one("SELECT * FROM company WHERE id = ?", companyId);

  const lease = await get(
    `SELECT * FROM lease WHERE unit_id = ? AND status = 'active'
      ORDER BY start_date DESC LIMIT 1`, unit.id);

  const woId = id();
  const reference = ref("WO");
  let routed = false;

  await tx(async () => {
    await insert("work_order", {
      id: woId, company_id: companyId, unit_id: unit.id,
      lease_id: lease ? lease.id : null,
      reference, category: cat.key, severity: level,
      summary: String(summary || "").trim() || "Reported",
      detail: String(detail || "").trim() || null,
      reported_by_name: String(reportedByName || "").trim() || null,
      reported_by_phone: String(reportedByPhone || "").trim() || null,
      reported_channel: channel, status: "new",
      public_token: token(), created_at: stamp(),
    });

    await event(woId, actor, "reported",
      `${channel === "api" ? "Raised through the API" : "Logged by staff"} · ${cat.label} · ${level}`);

    /* Not routed when it is an emergency. A contractor rule is a queue, and
       an emergency that sits in a queue is the thing this application exists
       not to do. */
    if (level !== "emergency") {
      const result = await autoRoute({ company, woId, cat });
      routed = result.routed;
    }
  });

  let emergency = null;
  if (level === "emergency" && alertOnCall) {
    emergency = await ringOnCall({
      company, woId, reference, cat, unit,
      reportedByName, reportedByPhone, sendNow,
    });
  }

  return { workOrderId: woId, reference, severity: level, routed, emergency, unit, lease };
}

/* The on-call number, rung now rather than queued.

   The scheduler runs daily. An emergency alert delivered tomorrow is not an
   emergency alert, so this goes out inside the request — and whether it
   reached anybody is recorded on the work order and returned, because
   "we told somebody" is the claim that must never be made falsely. */
async function ringOnCall({
  company, woId, reference, cat, unit, reportedByName, reportedByPhone, sendNow,
}) {
  const to = company.emergency_phone || company.phone;

  await event(woId, "system", "escalated",
    `Emergency raised${to ? `, alerting ${to}` : ""}. Not routed to a contractor — `
    + "an emergency is never queued.");

  if (!to) {
    await event(woId, "system", "note",
      "NO ON-CALL NUMBER IS SET for this company, so nobody was rung. "
      + "Set one in Company settings.");
    return { alerted: false, to: null, reason: "no on-call number is set" };
  }

  const send = sendNow || (await import("./delivery/now.js")).sendNow;
  const alert = await send({
    companyId: company.id, channel: "sms", to,
    subject: `EMERGENCY ${reference}`,
    body: `${reference} ${cat.label} EMERGENCY at ${unit.line1}`
      + `${unit.label ? ` unit ${unit.label}` : ""}. Raised through the API`
      + `${reportedByName ? ` by ${reportedByName}` : ""}`
      + `${reportedByPhone ? ` ${reportedByPhone}` : ""}.`,
    aboutType: "work_order_emergency", aboutId: woId,
  });

  await event(woId, "system", "note",
    alert.ok
      ? `On-call alerted by SMS to ${to}.`
      : `ON-CALL SMS DID NOT SEND to ${to} — ${alert.reason}. `
        + "Nobody has been told by this system; confirm somebody has picked this up.");

  return { alerted: Boolean(alert.ok), to, reason: alert.ok ? null : alert.reason };
}
