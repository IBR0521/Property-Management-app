/* The tick.

   Compliance deadlines and the delinquency ladder are the two features that
   have to happen without anyone opening the app, so they live here. Every job
   is idempotent — it is safe to run the tick twice in the same minute, and
   safe to run it after the process was down for a week, because each job
   works from current state rather than from "what happened since".

   Jobs run in dependency order: obligations are created before they are aged,
   delinquencies are opened before they are advanced. */
import { all, get, run, insert, tx } from "./db.js";
import { id } from "./ids.js";
import { today, addDays, stamp, monthKey, dueDateFor, human, daysBetween } from "./dates.js";
import { usd } from "./money.js";
import { pruneSessions } from "./auth.js";
import { prune as pruneRateHits } from "./ratelimit.js";
import { DELIVERY_MODE } from "./config.js";
import { drains, reachesRecipients } from "./delivery/mode.js";
import { deliver } from "./delivery/index.js";
import { outcomeFor, MAX_ATTEMPTS } from "./delivery/retry.js";
import { log } from "./logger.js";

const EVERY_MS = 10 * 60 * 1000;

/* Delivery is off until someone wires a provider. Queued messages stay queued
   and the app says so, rather than marking them sent and quietly dropping a
   late-rent notice. See setup screen. */
export const DELIVERY = {
  mode: DELIVERY_MODE,
  /* Asked, never compared against a literal. The last time this was a string
     comparison it silently went false in three files at once. */
  get reaching() { return reachesRecipients(DELIVERY_MODE); },
  get draining() { return drains(DELIVERY_MODE); },
};

export async function startScheduler() {
  const result = await tick("boot");
  console.log(`  scheduler: ${summarise(result)}\n`);
  // Fire and forget on a timer: an unhandled rejection here would take the
  // process down, and a failed tick should be logged and retried next time.
  setInterval(() => {
    tick("interval").catch((err) => console.error("[scheduler] tick failed", err));
  }, EVERY_MS).unref();
}

/* The name the scheduler records its runs under, and the age past which the
   dashboard calls it stale. 26 hours rather than 24 so a daily cron that
   drifts by an hour does not cry wolf every morning. */
export const TICK_JOB = "scheduler-tick";
export const STALE_AFTER_HOURS = 26;

/* When the tick last finished, or null if it never has. The dashboard turns
   this into a warning; without it, "is the scheduler running" is a question
   nobody can answer from inside the app. */
export async function lastTickAt() {
  const row = await get(
    "SELECT finished_at, outcome FROM job_run WHERE name = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
    TICK_JOB);
  return row || null;
}

export function tickIsStale(lastRun, now = new Date()) {
  if (!lastRun || !lastRun.finished_at) return true;
  const ageHours = (now - new Date(lastRun.finished_at)) / 3_600_000;
  return ageHours > STALE_AFTER_HOURS;
}

export async function tick(reason = "manual") {
  const out = {
    reason,
    obligationsCreated: 0,
    obligationsOverdue: 0,
    remindersQueued: 0,
    delinquenciesOpened: 0,
    delinquenciesAdvanced: 0,
    noticesQueued: 0,
    promisesJudged: 0,
    delivered: 0,
    sessionsPruned: 0,
  };

  for (const company of await all("SELECT * FROM company")) {
    Object.assign(out, sumInto(out, await generateObligations(company)));
    Object.assign(out, sumInto(out, await ageObligations(company)));
    Object.assign(out, sumInto(out, await queueObligationReminders(company)));
    Object.assign(out, sumInto(out, await openDelinquencies(company)));
    Object.assign(out, sumInto(out, await advanceDelinquencies(company)));
    Object.assign(out, sumInto(out, await judgePromises(company)));
  }

  const drained = await drainOutbox();
  out.delivered = drained.sent;
  out.deliveryFailed = drained.failed;
  out.deliveryDead = drained.dead;
  out.deliverySuppressed = drained.suppressed;
  out.sessionsPruned = await pruneSessions();
  out.rateHitsPruned = await pruneRateHits();

  /* Recorded last, and only on success, so "last run" means "last run that
     completed" rather than "last run that started and may have died". */
  await recordTickRun(reason, out);
  return out;
}

async function recordTickRun(reason, result) {
  try {
    const runId = id();
    const at = stamp();
    await insert("job_run", {
      id: runId, name: TICK_JOB, started_at: at, finished_at: at,
      outcome: "ok", detail: JSON.stringify({ reason, ...result }).slice(0, 900),
    });
  } catch (err) {
    /* Never let bookkeeping fail a tick that already did its work. */
    log.warn("could not record scheduler run", { reason: String(err.message).slice(0, 120) });
  }
}

function sumInto(acc, delta) {
  const merged = { ...acc };
  for (const k of Object.keys(delta || {})) merged[k] = (merged[k] || 0) + delta[k];
  return merged;
}

function summarise(r) {
  const bits = Object.entries(r)
    .filter(([k, v]) => typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}=${v}`);
  return bits.length ? bits.join(" ") : "nothing due";
}

/* ==========================================================================
   F3  Compliance: turn rules into dated obligations
   --------------------------------------------------------------------------
   Each rule kind has a trigger in the portfolio data. The UNIQUE constraint on
   (rule, subject, trigger_date) is what makes this idempotent — a second run
   attempts the same insert and is ignored.
   ========================================================================== */
async function generateObligations(company) {
  const out = { obligationsCreated: 0 };
  const rules = await all("SELECT * FROM compliance_rule WHERE company_id = ? AND active = 1", company.id);

  for (const rule of rules) {
    let subjects = [];

    if (rule.kind === "deposit_return") {
      // Trigger: keys handed back. This is the clock with statutory teeth.
      subjects = (await all(
        `SELECT id AS subject_id, moveout_date AS trigger_date FROM lease
          WHERE company_id = ? AND moveout_date IS NOT NULL`, company.id
      )).map((r) => ({ ...r, subject_type: "lease" }));
    } else if (rule.kind === "lease_renewal_notice") {
      // Trigger counts backwards from lease end: the obligation is to decide
      // and notify before the notice window closes.
      subjects = (await all(
        `SELECT id AS subject_id, end_date AS trigger_date FROM lease
          WHERE company_id = ? AND status = 'active' AND end_date IS NOT NULL`, company.id
      )).map((r) => ({ ...r, subject_type: "lease" }));
    } else if (rule.kind === "inspection" || rule.kind === "detector_check") {
      subjects = (await all(
        `SELECT u.id AS subject_id, l.start_date AS trigger_date
           FROM unit u JOIN lease l ON l.unit_id = u.id AND l.status = 'active'
          WHERE u.company_id = ?`, company.id
      )).map((r) => ({ ...r, subject_type: "unit" }));
    } else if (rule.kind === "registration_renewal" || rule.kind === "insurance_expiry") {
      subjects = (await all(
        `SELECT id AS subject_id, created_at AS trigger_date FROM property WHERE company_id = ?`, company.id
      )).map((r) => ({ ...r, subject_type: "property", trigger_date: r.trigger_date.slice(0, 10) }));
    }

    for (const s of subjects) {
      if (!s.trigger_date) continue;
      // Renewal notice is due BEFORE the end date; everything else is due a
      // window AFTER its trigger.
      const due = rule.kind === "lease_renewal_notice"
        ? addDays(s.trigger_date, -rule.window_days)
        : addDays(s.trigger_date, rule.window_days);

      const exists = await get(
        `SELECT id FROM obligation WHERE rule_id = ? AND subject_type = ? AND subject_id = ? AND trigger_date = ?`,
        rule.id, s.subject_type, s.subject_id, s.trigger_date
      );
      if (exists) continue;

      await insert("obligation", {
        id: id(), company_id: company.id, rule_id: rule.id,
        subject_type: s.subject_type, subject_id: s.subject_id,
        trigger_date: s.trigger_date, due_date: due,
        status: "open", created_at: stamp(),
      });
      out.obligationsCreated++;
    }
  }
  return out;
}

async function ageObligations(company) {
  const r = await run(
    `UPDATE obligation SET status = 'overdue'
      WHERE company_id = ? AND status = 'open' AND due_date < ?`,
    company.id, today()
  );
  return { obligationsOverdue: r.changes };
}

/* Queues a nudge at each lead_days offset, once. The outbox row's about_id
   plus subject is the dedupe key. */
async function queueObligationReminders(company) {
  const out = { remindersQueued: 0 };
  const rows = await all(
    `SELECT o.*, r.label, r.lead_days, r.kind, r.authority_note
       FROM obligation o JOIN compliance_rule r ON r.id = o.rule_id
      WHERE o.company_id = ? AND o.status IN ('open','overdue')`,
    company.id
  );
  const staff = await all("SELECT email, name FROM staff WHERE company_id = ? AND active = 1", company.id);
  if (!staff.length) return out;

  for (const o of rows) {
    let leads;
    try { leads = JSON.parse(o.lead_days); } catch { leads = [7, 0]; }
    const days = daysBetween(today(), o.due_date); // negative once overdue

    for (const lead of leads) {
      if (days > lead) continue;                 // not close enough yet
      const key = `obligation:${o.id}:lead:${lead}`;
      if (await get("SELECT id FROM outbox WHERE about_type = 'obligation_lead' AND about_id = ?", key)) continue;

      const when = days < 0 ? `${Math.abs(days)} day(s) overdue` : days === 0 ? "due today" : `due in ${days} day(s)`;
      for (const s of staff) {
        await insert("outbox", {
          id: id(), company_id: company.id, channel: "email", to_contact: s.email,
          subject: `${o.label} — ${when}`,
          body: `${o.label} for ${o.subject_type} ${o.subject_id} is ${when} (due ${human(o.due_date)}).`
            + (o.authority_note ? `\n\nBasis on file: ${o.authority_note}` : ""),
          about_type: "obligation_lead", about_id: key, status: "queued", queued_at: stamp(),
        });
      }
      out.remindersQueued++;
    }
  }
  return out;
}

/* ==========================================================================
   F4  Rent: open a delinquency once rent is late, then walk the ladder
   ========================================================================== */
async function openDelinquencies(company) {
  const out = { delinquenciesOpened: 0 };
  const now = today();
  const leases = await all(
    "SELECT * FROM lease WHERE company_id = ? AND status = 'active'", company.id
  );

  for (const lease of leases) {
    const period = monthKey(now);
    const due = dueDateFor(period, lease.rent_due_day);
    const lateFrom = addDays(due, lease.grace_days);
    if (now <= lateFrom) continue;               // still inside grace

    // Charges and payments both live in the reporting ledger; the balance for
    // the period is what decides whether this is late.
    const paid = (await get(
      `SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger_entry
        WHERE lease_id = ? AND kind = 'rent_payment' AND date >= ? AND date <= ?`,
      lease.id, `${period}-01`, addDays(`${period}-01`, 45)
    )).c;
    const owed = lease.rent_cents - paid;
    if (owed <= 0) continue;

    const existing = await get("SELECT * FROM delinquency WHERE lease_id = ? AND period = ?", lease.id, period);
    if (existing) {
      if (existing.status === "open" && existing.amount_cents !== owed) {
        await run("UPDATE delinquency SET amount_cents = ? WHERE id = ?", owed, existing.id);
      }
      continue;
    }

    await insert("delinquency", {
      id: id(), company_id: company.id, lease_id: lease.id, period,
      late_since: lateFrom, amount_cents: owed, stage: 0,
      status: "open", opened_at: stamp(),
    });
    out.delinquenciesOpened++;
  }
  return out;
}

async function advanceDelinquencies(company) {
  const out = { delinquenciesAdvanced: 0, noticesQueued: 0 };
  const steps = await all(
    "SELECT * FROM delinquency_step WHERE company_id = ? ORDER BY stage", company.id
  );
  if (!steps.length) return out;

  const open = await all(
    `SELECT d.*, l.rent_cents, u.label AS unit_label, p.line1, p.city
       FROM delinquency d
       JOIN lease l ON l.id = d.lease_id
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE d.company_id = ? AND d.status IN ('open','promised')`,
    company.id
  );

  for (const d of open) {
    const lateDays = daysBetween(d.late_since, today());
    // The furthest rung whose day_offset has been reached.
    const target = steps.filter((s) => s.day_offset <= lateDays).pop();
    if (!target || target.stage <= d.stage) continue;

    // A rung marked requires_attorney is a stop, not a send: the app records
    // that it is time to hand over and waits for a human.
    if (target.requires_attorney) {
      await run("UPDATE delinquency SET stage = ?, status = 'attorney' WHERE id = ?", target.stage, d.id);
      out.delinquenciesAdvanced++;
      for (const s of await all("SELECT email FROM staff WHERE company_id = ? AND active = 1", company.id)) {
        await insert("outbox", {
          id: id(), company_id: company.id, channel: "email", to_contact: s.email,
          subject: `Hand to attorney: ${d.line1}${d.unit_label ? " " + d.unit_label : ""}`,
          body: `${usd(d.amount_cents)} unpaid for ${d.period}, ${lateDays} days late. `
            + `The ladder has reached the stage your firm marked as attorney hand-off. No notice was sent.`,
          about_type: "delinquency_attorney", about_id: d.id, status: "queued", queued_at: stamp(),
        });
      }
      continue;
    }

    await run("UPDATE delinquency SET stage = ? WHERE id = ?", target.stage, d.id);
    out.delinquenciesAdvanced++;

    /* A notice is only queued from a template the firm's attorney signed off.
       An unapproved template is skipped and flagged, never improvised. */
    const tpl = await get(
      "SELECT * FROM notice_template WHERE company_id = ? AND key = ?", company.id, target.template_key
    );
    if (!tpl || !tpl.approved_at) {
      await insert("outbox", {
        id: id(), company_id: company.id, channel: "email",
        to_contact: (await get("SELECT email FROM staff WHERE company_id = ? AND active = 1", company.id) || {}).email || "",
        subject: `Notice not sent — template "${target.template_key}" is not approved`,
        body: `Stage ${target.stage} was reached for ${d.line1} but the template is `
          + `${tpl ? "awaiting sign-off" : "missing"}. Nothing was sent to the tenant.`,
        about_type: "notice_blocked", about_id: `${d.id}:${target.stage}`, status: "queued", queued_at: stamp(),
      });
      continue;
    }
    out.noticesQueued += await queueNotice({ company, delinquency: d, step: target, template: tpl, lateDays });
  }
  return out;
}

export async function queueNotice({ company, delinquency, step, template, lateDays, sentBy = "system" }) {
  const tenants = await all(
    `SELECT t.* FROM tenant t JOIN lease_tenant lt ON lt.tenant_id = t.id WHERE lt.lease_id = ?`,
    delinquency.lease_id
  );
  if (!tenants.length) return 0;

  const body = renderTemplate(template.body, {
    amount: usd(delinquency.amount_cents),
    period: delinquency.period,
    days_late: String(lateDays),
    address: `${delinquency.line1 || ""}${delinquency.unit_label ? " " + delinquency.unit_label : ""}`.trim(),
    company: company.name,
    company_phone: company.phone || "",
  });

  let n = 0;
  await tx(async () => {
    for (const t of tenants) {
      const to = step.channel === "sms" ? t.phone : t.email;
      if (!to) continue;
      await insert("outbox", {
        id: id(), company_id: company.id, channel: step.channel === "sms" ? "sms" : "email",
        to_contact: to, subject: template.name, body,
        about_type: "delinquency_notice", about_id: `${delinquency.id}:${step.stage}`,
        status: "queued", queued_at: stamp(),
      });
      await insert("notice_log", {
        id: id(), company_id: company.id, delinquency_id: delinquency.id,
        stage: step.stage, template_key: template.key, channel: step.channel,
        to_name: t.name, to_contact: to, rendered_body: body,
        sent_at: stamp(), sent_by: sentBy,
      });
      n++;
    }
  });
  return n;
}

/* {{placeholder}} only. No expressions, no logic — a template language in a
   legal notice is a way to produce a notice nobody reviewed. */
export function renderTemplate(body, vars) {
  return String(body).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m
  );
}

async function judgePromises(company) {
  const out = { promisesJudged: 0 };
  const due = await all(
    `SELECT p.*, d.lease_id, d.period FROM payment_promise p
       JOIN delinquency d ON d.id = p.delinquency_id
      WHERE p.company_id = ? AND p.kept IS NULL AND p.promised_date < ?`,
    company.id, today()
  );
  for (const p of due) {
    const paid = (await get(
      `SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger_entry
        WHERE lease_id = ? AND kind = 'rent_payment' AND date >= ?`,
      p.lease_id, p.created_at.slice(0, 10)
    )).c;
    const kept = paid >= p.promised_cents ? 1 : 0;
    await run("UPDATE payment_promise SET kept = ? WHERE id = ?", kept, p.id);
    // A broken promise puts the case back on the ladder.
    if (!kept) await run("UPDATE delinquency SET status = 'open' WHERE id = ? AND status = 'promised'", p.delinquency_id);
    out.promisesJudged++;
  }
  return out;
}

/* ==========================================================================
   Outbox
   ========================================================================== */
/* TODO(delivery): nothing is actually sent yet. Messages are composed,
   addressed and stored, and this function drops them. Wiring a provider is the
   single blocker on running this for real, and the emergency path is the reason
   it matters: the on-call SMS never fires, so that guarantee currently rests on
   the tenant dialling the number on the stop card. Providers are plain HTTP
   APIs, so this stays dependency-free. See the checklist in server/README.md. */
/* `send` and `now` are parameters rather than imports so the drainer can be
   driven by a provider that fails on demand and a clock that does not have to
   be waited out. The drainer does not care who sends — that is the whole point
   of the provider interface — so taking it as an argument costs nothing and
   makes the retry behaviour testable in milliseconds instead of hours. */
export async function drainOutbox({ send = deliver, now = () => new Date(), mode = DELIVERY.mode } = {}) {
  /* The mode is a parameter for the same reason the clock is: a test needs to
     exercise both "delivery is off, touch nothing" and "delivery is on, here
     is a provider that fails", and neither should depend on how the process
     happened to be started. */
  if (!drains(mode)) return { sent: 0, failed: 0, dead: 0, suppressed: 0 };

  /* Due means queued and either never attempted or past its backoff. Retrying
     everything on every tick is how a provider outage becomes a rate-limit
     ban. */
  const nowIso = now().toISOString();
  const due = await all(
    `SELECT * FROM outbox
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY queued_at LIMIT 50`, nowIso);

  const out = { sent: 0, failed: 0, dead: 0, suppressed: 0 };

  for (const m of due) {
    const result = await send({
      channel: m.channel, to: m.to_contact, subject: m.subject,
      body: m.body, companyId: m.company_id, kind: m.kind || "transactional",
    });

    const attempts = Number(m.attempts || 0) + 1;

    if (result.suppressed) {
      /* Not a failure. The recipient said no and the system listened, which is
         a different fact from "we could not reach them" and is recorded as
         one. */
      await run(
        `UPDATE outbox SET status = 'suppressed', attempts = ?, last_error = ?,
                failed_at = ?, provider = ? WHERE id = ?`,
        attempts, result.error, nowIso, result.provider, m.id);
      out.suppressed++;
      continue;
    }

    const outcome = outcomeFor(result, attempts, now());

    if (outcome.status === "sent") {
      await run(
        `UPDATE outbox SET status = 'sent', sent_at = ?, attempts = ?,
                provider = ?, provider_message_id = ?, last_error = NULL,
                next_attempt_at = NULL WHERE id = ?`,
        nowIso, attempts, result.provider, result.providerMessageId || null, m.id);
      out.sent++;
    } else if (outcome.status === "dead") {
      await run(
        `UPDATE outbox SET status = 'dead', attempts = ?, last_error = ?,
                failed_at = ?, provider = ?, next_attempt_at = NULL WHERE id = ?`,
        attempts, String(result.error || "send failed").slice(0, 300),
        nowIso, result.provider, m.id);
      out.dead++;
      log.error("message dead-lettered", {
        outboxId: m.id, channel: m.channel, attempts,
        reason: outcome.permanent ? "permanent rejection" : "attempts exhausted",
        error: String(result.error || "").slice(0, 200),
      });
    } else {
      await run(
        `UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ?,
                provider = ? WHERE id = ?`,
        attempts, String(result.error || "send failed").slice(0, 300),
        outcome.nextAttemptAt, result.provider, m.id);
      out.failed++;
    }
  }
  return out;
}


export async function outboxPending(companyId) {
  return (await get("SELECT COUNT(*) AS n FROM outbox WHERE company_id = ? AND status = 'queued'", companyId)).n;
}
