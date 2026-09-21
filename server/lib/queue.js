/* The work queue.

   Everything that needs a person today, from every part of the system, in one
   ranked list. This exists because the previous design made a manager check
   six separate screens to find out whether anything was wrong — which is the
   same as not knowing.

   Ranking is by consequence, not by age:
     0  someone is unsafe or without heat, water or a lockable door
     1  money or a statutory clock is waiting on a decision
     2  a job is stalled and costing something
     3  someone is waiting on an answer from us

   Each item carries where it is, how long it has been sitting, and one link
   that goes straight to the thing that resolves it.

   Performance note. On SQLite this was eight sequential queries plus one more
   per overdue obligation, and none of it mattered because every call was
   microseconds. Against a network database it made this page take 31 seconds.
   So: the eight datasets are fetched concurrently, and subject labels are
   resolved from maps built in the same round rather than one query per row. */
import { all, get } from "./db.js";
import { today, daysBetween, human } from "./dates.js";
import { usd } from "./money.js";

export async function buildQueue(companyId) {
  const items = [];
  const age = (iso) => (iso ? daysBetween(iso.slice(0, 10), today()) : 0);

  /* Everything the queue needs, in one round of concurrent queries instead of
     a dozen sequential ones. */
  const [emergencies, approvals, overdue, unassigned, blockedRows,
         lateRent, lateTurns, waitingApps, labelFor] = await Promise.all([
    all(`SELECT w.*, u.label, p.line1 FROM work_order w
           JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
          WHERE w.company_id = ? AND w.severity = 'emergency'
            AND w.status NOT IN ('complete','cancelled') ORDER BY w.created_at`, companyId),
    all(`SELECT a.*, o.name AS owner_name, w.reference, w.summary, u.label, p.line1
           FROM owner_approval a JOIN owner o ON o.id = a.owner_id
           JOIN work_order w ON w.id = a.work_order_id
           JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
          WHERE a.company_id = ? AND a.status = 'pending' ORDER BY a.requested_at`, companyId),
    all(`SELECT o.*, r.label, r.kind FROM obligation o JOIN compliance_rule r ON r.id = o.rule_id
          WHERE o.company_id = ? AND o.status = 'overdue' ORDER BY o.due_date`, companyId),
    all(`SELECT w.*, u.label, p.line1, v.name AS vendor_name, v.trade FROM work_order w
           JOIN unit u ON u.id = w.unit_id JOIN property p ON p.id = u.property_id
           LEFT JOIN vendor v ON v.id = w.vendor_id
          WHERE w.company_id = ? AND w.severity != 'emergency'
            AND w.status IN ('new','triaged') ORDER BY w.created_at`, companyId),
    all(`SELECT * FROM outbox WHERE company_id = ? AND about_type = 'notice_blocked'
            AND status = 'queued' ORDER BY queued_at`, companyId),
    all(`SELECT d.*, u.label, p.line1 FROM delinquency d
           JOIN lease l ON l.id = d.lease_id JOIN unit u ON u.id = l.unit_id
           JOIN property p ON p.id = u.property_id
          WHERE d.company_id = ? AND d.status IN ('open','attorney') ORDER BY d.late_since`, companyId),
    all(`SELECT t.*, u.label, u.market_rent_cents, p.line1 FROM turn t
           JOIN unit u ON u.id = t.unit_id JOIN property p ON p.id = u.property_id
          WHERE t.company_id = ? AND t.status = 'open'
            AND t.target_ready_date IS NOT NULL AND t.target_ready_date < ?
          ORDER BY t.target_ready_date`, companyId, today()),
    all(`SELECT a.*, u.label, p.line1,
                (SELECT COUNT(*) FROM application_check c
                  WHERE c.application_id = a.id AND c.result = 'pending') AS pending
           FROM application a
           LEFT JOIN unit u ON u.id = a.unit_id LEFT JOIN property p ON p.id = u.property_id
          WHERE a.company_id = ? AND a.status IN ('received','incomplete','screening')
          ORDER BY a.received_at`, companyId),
    subjectMaps(companyId),
  ]);

  /* --- 0: emergencies ---------------------------------------------------- */
  for (const w of emergencies) {
    const reasons = safeReasons(w.triage_answers);
    items.push({
      rank: 0, kind: "emergency", tone: "danger",
      title: w.summary,
      why: reasons.length ? reasons[0] : "Flagged as an emergency at intake",
      where: place(w.line1, w.label),
      ref: w.reference, age: age(w.created_at),
      href: `/app/maintenance/${w.id}`,
      cta: w.reported_by_phone ? `Call ${w.reported_by_phone}` : "Open",
      tel: w.reported_by_phone,
    });
  }

  /* --- 1: money waiting on an owner -------------------------------------- */
  for (const a of approvals) {
    items.push({
      rank: 1, kind: "approval", tone: "warn",
      title: `${usd(a.amount_cents)} waiting on ${a.owner_name}`,
      why: a.summary, where: place(a.line1, a.label),
      ref: a.reference, age: age(a.requested_at),
      href: `/app/maintenance/${a.work_order_id}`,
      cta: "Chase the owner",
    });
  }

  /* --- 1: statutory clocks ------------------------------------------------ */
  for (const o of overdue) {
    items.push({
      rank: 1, kind: "deadline", tone: "danger",
      title: o.label,
      why: `Due ${human(o.due_date)} — ${Math.abs(daysBetween(today(), o.due_date))} day(s) past`,
      where: labelFor(o.subject_type, o.subject_id),
      age: Math.abs(daysBetween(today(), o.due_date)),
      href: "/app/compliance", cta: "Close it out",
    });
  }

  /* --- 1: repairs nobody has actually dispatched --------------------------
     A routing rule picks a likely vendor; it does not ring them. Until a
     person confirms the trade and the estimate, the job is a suggestion
     sitting in a table. */
  for (const w of unassigned) {
    items.push({
      rank: 1, kind: "unassigned", tone: w.severity === "urgent" ? "warn" : null,
      title: w.summary,
      why: w.vendor_name
        ? `${w.vendor_name} suggested by rule — nobody has confirmed or booked it`
        : "No vendor: no routing rule covers this category",
      where: place(w.line1, w.label),
      ref: w.reference, age: age(w.created_at),
      href: `/app/maintenance/${w.id}`,
      cta: w.vendor_name ? "Confirm and book" : "Assign someone",
    });
  }

  /* --- 1: notices the ladder could not send -------------------------------
     Collapsed per template: three identical lines saying the same template
     needs the same signature is noise, and one fix clears all of them. */
  if (blockedRows.length) {
    const byTemplate = new Map();
    for (const m of blockedRows) {
      const key = (/"([^"]+)"/.exec(m.subject || "") || [, "a template"])[1];
      const prev = byTemplate.get(key);
      byTemplate.set(key, prev
        ? { ...prev, n: prev.n + 1 }
        : { ...m, n: 1 });
    }
    for (const [key, m] of byTemplate) {
      items.push({
        rank: 1, kind: "blocked", tone: "danger",
        title: m.n === 1 ? "A rent notice could not be sent" : `${m.n} rent notices could not be sent`,
        why: `"${key}" has no recorded sign-off, so the ladder stopped rather than improvising`,
        where: "Notice templates", age: age(m.queued_at),
        href: "/app/setup", cta: "Record the sign-off",
      });
    }
  }

  /* --- 2: rent past grace ------------------------------------------------- */
  for (const d of lateRent) {
    items.push({
      rank: 2, kind: "rent", tone: d.status === "attorney" ? "danger" : "warn",
      title: `${usd(d.amount_cents)} unpaid`,
      why: d.status === "attorney"
        ? "Reached the stage your firm marked for attorney hand-off"
        : `Stage ${d.stage} · ${d.period}`,
      where: place(d.line1, d.label),
      age: daysBetween(d.late_since, today()),
      href: `/app/rent/${d.id}`,
      cta: d.status === "attorney" ? "Hand it over" : "Next step",
    });
  }

  /* --- 2: a turn running past its own target ------------------------------ */
  for (const t of lateTurns) {
    const over = daysBetween(t.target_ready_date, today());
    items.push({
      rank: 2, kind: "turn", tone: "warn",
      title: `Turn is ${over} day(s) past target`,
      why: t.market_rent_cents
        ? `Costing about ${usd(Math.round((t.market_rent_cents / 30) * over))} in lost rent so far`
        : "Still not ready to list",
      where: place(t.line1, t.label), age: over,
      href: `/app/turns/${t.id}`, cta: "Move it on",
    });
  }

  /* --- 3: people waiting on us -------------------------------------------- */
  for (const a of waitingApps) {
    const pending = Number(a.pending || 0);
    items.push({
      rank: 3, kind: "application", tone: null,
      title: `${a.applicant_name} is waiting`,
      why: pending ? `${pending} criteri${pending === 1 ? "on" : "a"} not checked yet` : "Ready for a decision",
      where: a.line1 ? place(a.line1, a.label) : "No unit chosen",
      age: age(a.received_at),
      href: `/app/applications/${a.id}`, cta: "Review",
    });
  }

  // Oldest first inside each rank: within equal consequence, waiting longer wins.
  items.sort((x, y) => x.rank - y.rank || y.age - x.age);
  return items;
}

function place(line1, label) {
  return `${line1}${label ? ` · unit ${label}` : ""}`;
}

function safeReasons(json) {
  try {
    const v = JSON.parse(json || "{}");
    return Array.isArray(v.reasons) ? v.reasons : [];
  } catch {
    return [];
  }
}

/* Obligations point at a lease, unit or property by id; the queue shows an
   address instead. Three queries build the lookup for the whole page, rather
   than one query per obligation. */
async function subjectMaps(companyId) {
  const [leases, units, props] = await Promise.all([
    all(`SELECT l.id, p.line1, u.label FROM lease l
           JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
          WHERE l.company_id = ?`, companyId),
    all(`SELECT u.id, p.line1, u.label FROM unit u
           JOIN property p ON p.id = u.property_id WHERE u.company_id = ?`, companyId),
    all("SELECT id, line1 FROM property WHERE company_id = ?", companyId),
  ]);
  const m = {
    lease: new Map(leases.map((r) => [r.id, place(r.line1, r.label)])),
    unit: new Map(units.map((r) => [r.id, place(r.line1, r.label)])),
    property: new Map(props.map((r) => [r.id, r.line1])),
  };
  return (type, sid) =>
    (m[type] && m[type].get(sid)) || (type === "company" ? "the company" : `${type} ${String(sid).slice(0, 8)}`);
}
